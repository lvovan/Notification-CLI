import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ConfidentialClientApplication,
  CryptoProvider,
  PublicClientApplication,
  type ClientAssertionCallback,
  type NodeAuthOptions,
} from "@azure/msal-node";
import { requireSetting } from "@notification-cli/core/configuration";
import { requestOrigin } from "./request.js";
import { GLOBAL_HEADERS } from "./response.js";
import { clientPrincipal, type SessionProvider } from "./session.js";

export const TENANT_ID_ENV = "NOTIFICATION_CLI_ENTRA_TENANT_ID";
export const CLIENT_ID_ENV = "NOTIFICATION_CLI_ENTRA_CLIENT_ID";
export const CLIENT_SECRET_ENV = "NOTIFICATION_CLI_ENTRA_CLIENT_SECRET";
export const SESSION_SECRET_ENV = "NOTIFICATION_CLI_SESSION_SECRET";

/** The audience Entra ID requires of a federated client assertion. */
const TOKEN_EXCHANGE_AUDIENCE = "api://AzureADTokenExchange";

const SESSION_COOKIE = "ncli_session";
const FLOW_COOKIE = "ncli_flow";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
// Long enough to survive consent, MFA and a password change without the reply
// arriving after the flow cookie has already lapsed.
const FLOW_TTL_SECONDS = 30 * 60;
const CALLBACK_PATH = "/.auth/login/aad/callback";

export interface EntraConfig {
  tenantId: string;
  clientId: string;
  /**
   * Omitted when the tenant forbids client secrets. The App Service managed
   * identity then supplies a federated assertion instead.
   */
  clientSecret?: string;
  sessionSecret: string;
}

export function readEntraConfig(env: NodeJS.ProcessEnv = process.env): EntraConfig {
  const clientSecret = env[CLIENT_SECRET_ENV]?.trim();
  return {
    tenantId: requireSetting(env, TENANT_ID_ENV),
    clientId: requireSetting(env, CLIENT_ID_ENV),
    ...(clientSecret ? { clientSecret } : {}),
    sessionSecret: requireSetting(env, SESSION_SECRET_ENV),
  };
}

/**
 * Proves the client's identity to the token endpoint, if it has to.
 *
 * Three arrangements work, and the first that is available is used:
 *
 * 1. A client secret, when one is configured.
 * 2. A federated assertion from the App Service managed identity, for a tenant
 *    whose policy blocks secrets. Nothing secret is stored and nothing expires.
 * 3. Nothing at all. The authorization code is already bound to this server by
 *    PKCE, so a public-client registration needs no credential — the simplest
 *    arrangement, and the only one needing no Azure-side plumbing.
 */
export type AssertionSource = () => Promise<string>;

const managedIdentityAssertion: AssertionSource = async () => {
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) {
    throw new Error("No managed identity is available to authenticate with.");
  }
  const url = new URL(endpoint);
  url.searchParams.set("resource", TOKEN_EXCHANGE_AUDIENCE);
  url.searchParams.set("api-version", "2019-08-01");

  const response = await fetch(url, { headers: { "X-IDENTITY-HEADER": header } });
  if (!response.ok) {
    throw new Error(`The managed identity returned ${response.status}.`);
  }
  const { access_token: token } = (await response.json()) as { access_token?: string };
  if (!token) {
    throw new Error("The managed identity returned no token.");
  }
  return token;
};

/** The credential half of the MSAL configuration, which may be empty. */
export function clientCredential(
  config: EntraConfig,
  assertion: AssertionSource = managedIdentityAssertion,
  env: NodeJS.ProcessEnv = process.env,
): Partial<Pick<NodeAuthOptions, "clientSecret" | "clientAssertion">> {
  if (config.clientSecret) {
    return { clientSecret: config.clientSecret };
  }
  if (env.IDENTITY_ENDPOINT && env.IDENTITY_HEADER) {
    const callback: ClientAssertionCallback = () => assertion();
    return { clientAssertion: callback };
  }
  return {};
}
function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Serialises a value with a signature, so the client cannot alter it. */
function seal(secret: string, value: unknown): string {
  const payload = base64url(JSON.stringify(value));
  return `${payload}.${sign(secret, payload)}`;
}

function unseal<T>(secret: string, token: string | undefined): T | null {
  if (!token) {
    return null;
  }
  const separator = token.lastIndexOf(".");
  if (separator <= 0) {
    return null;
  }
  const payload = token.slice(0, separator);
  const presented = Buffer.from(token.slice(separator + 1));
  const expected = Buffer.from(sign(secret, payload));
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) {
      cookies[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
    }
  }
  return cookies;
}

function cookie(name: string, value: string, maxAge: number): string {
  const attributes = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  return attributes.join("; ");
}

function redirect(response: ServerResponse, location: string, cookies: string[] = []): void {
  response.writeHead(302, {
    ...GLOBAL_HEADERS,
    Location: location,
    "Cache-Control": "no-store",
    ...(cookies.length > 0 ? { "Set-Cookie": cookies } : {}),
  });
  response.end();
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    ...GLOBAL_HEADERS,
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": String(payload.byteLength),
  });
  response.end(payload);
}

interface SessionClaims {
  email: string;
  exp: number;
}

interface FlowClaims {
  state: string;
  verifier: string;
  redirect: string;
  exp: number;
}

/** Only same-origin paths are accepted, so the flow cannot be used as an open redirect. */
function safeRedirect(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

/**
 * The address, preferring the claim that is actually an address.
 *
 * A work account without a `mail` attribute has no `email` claim, and a
 * personal account has no `upn`, so all three have to be tried.
 */
function emailFromClaims(claims: Record<string, unknown>): string | null {
  for (const name of ["email", "preferred_username", "upn"]) {
    const value = claims[name];
    if (typeof value === "string" && value.includes("@")) {
      return value.trim().toLowerCase();
    }
  }
  return null;
}

/**
 * The sign-in protocol, behind a port so tests never reach Entra ID.
 *
 * MSAL owns the protocol itself — the authorize URL, the code exchange, and
 * the validation of what comes back. This server only owns what MSAL does not:
 * correlating the two legs across a stateless process, which it does with the
 * sealed flow cookie below.
 */
export interface AuthClient {
  authorizeUrl(request: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
  }): Promise<string>;
  redeemCode(request: {
    redirectUri: string;
    code: string;
    state: string;
    codeVerifier: string;
  }): Promise<Record<string, unknown>>;
}

const SCOPES = ["openid", "profile", "email"];

export function createMsalAuthClient(
  config: EntraConfig,
  assertion: AssertionSource = managedIdentityAssertion,
): AuthClient {
  const auth: NodeAuthOptions = {
    clientId: config.clientId,
    authority: `https://login.microsoftonline.com/${config.tenantId}`,
    ...clientCredential(config, assertion),
  };
  // Without a credential the registration is a public client, and MSAL
  // refuses to be a confidential one — correctly, since it would then send an
  // empty secret and be rejected.
  const application =
    auth.clientSecret || auth.clientAssertion
      ? new ConfidentialClientApplication({ auth })
      : new PublicClientApplication({ auth });

  return {
    authorizeUrl: (request) =>
      application.getAuthCodeUrl({
        scopes: SCOPES,
        redirectUri: request.redirectUri,
        state: request.state,
        codeChallenge: request.codeChallenge,
        codeChallengeMethod: "S256",
      }),
    redeemCode: async (request) => {
      const result = await application.acquireTokenByCode({
        scopes: SCOPES,
        redirectUri: request.redirectUri,
        code: request.code,
        state: request.state,
        codeVerifier: request.codeVerifier,
      });
      const claims: Record<string, unknown> = { ...result.idTokenClaims };
      // MSAL normalizes the address onto the account even when the claim it
      // came from is one this code would not have looked at.
      claims["preferred_username"] ??= result.account?.username;
      return claims;
    },
  };
}
/**
 * Signs users in against Entra ID with MSAL.
 *
 * App Service Easy Auth cannot be used: it rejects any `Authorization` bearer
 * it cannot validate, including on excluded paths, which would break both the
 * OAuth tokens and the API keys the MCP endpoint accepts.
 */
export function createEntraSessionProvider(
  config: EntraConfig,
  client: AuthClient = createMsalAuthClient(config),
): SessionProvider {
  const crypto = new CryptoProvider();

  const startLogin = async (
    message: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> => {
    const { verifier, challenge } = await crypto.generatePkceCodes();
    const flow: FlowClaims = {
      state: crypto.createNewGuid(),
      verifier,
      redirect: safeRedirect(url.searchParams.get("post_login_redirect_uri")),
      exp: Math.floor(Date.now() / 1000) + FLOW_TTL_SECONDS,
    };

    redirect(
      response,
      await client.authorizeUrl({
        redirectUri: `${requestOrigin(message)}${CALLBACK_PATH}`,
        state: flow.state,
        codeChallenge: challenge,
      }),
      [cookie(FLOW_COOKIE, seal(config.sessionSecret, flow), FLOW_TTL_SECONDS)],
    );
  };

  const completeLogin = async (
    message: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> => {
    const cookies = parseCookies(message.headers.cookie);
    const flow = unseal<FlowClaims>(config.sessionSecret, cookies[FLOW_COOKIE]);
    const now = Math.floor(Date.now() / 1000);
    // Each cause has a different remedy, so each says which one it is rather
    // than collapsing into one unactionable message.
    if (!flow) {
      json(response, 400, {
        error:
          "No sign-in was in progress in this browser. Start again from the application, and allow cookies for this site.",
      });
      return;
    }
    if (flow.exp < now) {
      json(response, 400, { error: "The sign-in took too long. Start again." });
      return;
    }
    if (flow.state !== url.searchParams.get("state")) {
      json(response, 400, { error: "The sign-in reply did not match this browser's request." });
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      json(response, 400, {
        error: url.searchParams.get("error_description") ??
          url.searchParams.get("error") ??
          "Sign-in was cancelled.",
      });
      return;
    }

    let claims: Record<string, unknown>;
    try {
      claims = await client.redeemCode({
        redirectUri: `${requestOrigin(message)}${CALLBACK_PATH}`,
        code,
        state: flow.state,
        codeVerifier: flow.verifier,
      });
    } catch (error) {
      // Entra ID's own description names the defect — a redirect URI under
      // the wrong platform, an expired secret, a rejected assertion — and it
      // is unreachable if this is left to the generic 500 handler.
      json(response, 502, { error: `Entra ID rejected the sign-in: ${String(error)}` });
      return;
    }

    const email = emailFromClaims(claims);
    if (!email) {
      json(response, 502, { error: "Entra ID did not return an email address." });
      return;
    }

    const session: SessionClaims = { email, exp: now + SESSION_TTL_SECONDS };
    redirect(response, flow.redirect, [
      cookie(SESSION_COOKIE, seal(config.sessionSecret, session), SESSION_TTL_SECONDS),
      cookie(FLOW_COOKIE, "", 0),
    ]);
  };
  const resolve = (message: IncomingMessage): string | null => {
    const cookies = parseCookies(message.headers.cookie);
    const session = unseal<SessionClaims>(config.sessionSecret, cookies[SESSION_COOKIE]);
    if (!session || session.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return session.email;
  };

  return {
    resolve,
    handle: async (message, response, pathname) => {
      const url = new URL(message.url ?? "/", requestOrigin(message));
      if (pathname === "/.auth/login/aad") {
        await startLogin(message, response, url);
        return true;
      }
      if (pathname === CALLBACK_PATH) {
        await completeLogin(message, response, url);
        return true;
      }
      if (pathname === "/.auth/logout") {
        redirect(response, safeRedirect(url.searchParams.get("post_logout_redirect_uri")), [
          cookie(SESSION_COOKIE, "", 0),
        ]);
        return true;
      }
      if (pathname === "/.auth/me") {
        const email = resolve(message);
        json(response, 200, {
          clientPrincipal: email
            ? JSON.parse(Buffer.from(clientPrincipal(email), "base64").toString("utf8"))
            : null,
        });
        return true;
      }
      return false;
    },
  };
}
