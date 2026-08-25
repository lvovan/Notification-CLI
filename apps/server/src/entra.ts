import { createHmac, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { requireSetting } from "@notification-cli/core/configuration";
import { requestOrigin } from "./request.js";
import { GLOBAL_HEADERS } from "./response.js";
import { clientPrincipal, type SessionProvider } from "./session.js";

export const TENANT_ID_ENV = "NOTIFICATION_CLI_ENTRA_TENANT_ID";
export const CLIENT_ID_ENV = "NOTIFICATION_CLI_ENTRA_CLIENT_ID";
export const CLIENT_SECRET_ENV = "NOTIFICATION_CLI_ENTRA_CLIENT_SECRET";
export const SESSION_SECRET_ENV = "NOTIFICATION_CLI_SESSION_SECRET";

const SESSION_COOKIE = "ncli_session";
const FLOW_COOKIE = "ncli_flow";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const FLOW_TTL_SECONDS = 10 * 60;
const CALLBACK_PATH = "/.auth/login/aad/callback";

export interface EntraConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
}

export function readEntraConfig(env: NodeJS.ProcessEnv = process.env): EntraConfig {
  return {
    tenantId: requireSetting(env, TENANT_ID_ENV),
    clientId: requireSetting(env, CLIENT_ID_ENV),
    clientSecret: requireSetting(env, CLIENT_SECRET_ENV),
    sessionSecret: requireSetting(env, SESSION_SECRET_ENV),
  };
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

function emailFromIdToken(idToken: string): string | null {
  const payload = idToken.split(".")[1];
  if (!payload) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    for (const name of ["email", "preferred_username", "upn"]) {
      const value = claims[name];
      if (typeof value === "string" && value.includes("@")) {
        return value.trim().toLowerCase();
      }
    }
  } catch {
    return null;
  }
  return null;
}

export type TokenExchange = (
  config: EntraConfig,
  body: URLSearchParams,
) => Promise<{ id_token?: string }>;

const exchangeWithEntra: TokenExchange = async (config, body) => {
  const response = await fetch(
    `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  if (!response.ok) {
    throw new Error(`Entra token exchange failed with ${response.status}.`);
  }
  return (await response.json()) as { id_token?: string };
};

/**
 * Signs users in against Entra ID directly.
 *
 * App Service Easy Auth cannot be used: it rejects any `Authorization` bearer
 * it cannot validate, including on excluded paths, which would break both the
 * OAuth tokens and the API keys the MCP endpoint accepts.
 *
 * The id token is read without verifying its signature because it is received
 * over TLS straight from the token endpoint in a confidential-client code
 * exchange, which OpenID Connect Core allows.
 */
export function createEntraSessionProvider(
  config: EntraConfig,
  exchange: TokenExchange = exchangeWithEntra,
): SessionProvider {
  const startLogin = (message: IncomingMessage, response: ServerResponse, url: URL): void => {
    const verifier = base64url(randomBytes(32));
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const flow: FlowClaims = {
      state: base64url(randomBytes(16)),
      verifier,
      redirect: safeRedirect(url.searchParams.get("post_login_redirect_uri")),
      exp: Math.floor(Date.now() / 1000) + FLOW_TTL_SECONDS,
    };

    const authorize = new URL(
      `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/authorize`,
    );
    authorize.search = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: `${requestOrigin(message)}${CALLBACK_PATH}`,
      response_mode: "query",
      scope: "openid profile email",
      state: flow.state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

    redirect(response, authorize.toString(), [
      cookie(FLOW_COOKIE, seal(config.sessionSecret, flow), FLOW_TTL_SECONDS),
    ]);
  };

  const completeLogin = async (
    message: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> => {
    const cookies = parseCookies(message.headers.cookie);
    const flow = unseal<FlowClaims>(config.sessionSecret, cookies[FLOW_COOKIE]);
    const now = Math.floor(Date.now() / 1000);
    if (!flow || flow.exp < now || flow.state !== url.searchParams.get("state")) {
      json(response, 400, { error: "The sign-in attempt could not be verified." });
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      json(response, 400, { error: url.searchParams.get("error") ?? "Sign-in was cancelled." });
      return;
    }

    const tokens = await exchange(
      config,
      new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: `${requestOrigin(message)}${CALLBACK_PATH}`,
        code_verifier: flow.verifier,
      }),
    );
    const email = tokens.id_token ? emailFromIdToken(tokens.id_token) : null;
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
        startLogin(message, response, url);
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
