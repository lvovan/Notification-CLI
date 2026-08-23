import type { HttpRequest, HttpResponseInit } from "@azure/functions";

export const AUTHORIZED_USERS_ENV = "AUTHORIZED_USERS";
export const CLIENT_PRINCIPAL_HEADER = "x-ms-client-principal";

interface ClientPrincipalClaim {
  typ: string;
  val: string;
}

interface ClientPrincipal {
  identityProvider: string;
  userId: string;
  userDetails: string;
  userRoles: string[];
  claims?: ClientPrincipalClaim[];
}

export type BrowserAuthorization =
  | { authorized: true; email: string }
  | {
      authorized: false;
      authenticated: boolean;
      email?: string;
      status: 401 | 403 | 503;
      error: string;
    };

const emailClaimTypes = new Set([
  "email",
  "emails",
  "preferred_username",
  "upn",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
]);

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function parseAuthorizedUsers(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(";")
      .map(normalizeEmail)
      .filter((email) => email.length > 0),
  );
}

export function parseClientPrincipal(
  encodedPrincipal: string | null,
): ClientPrincipal | null {
  if (!encodedPrincipal) {
    return null;
  }

  try {
    const value = JSON.parse(
      Buffer.from(encodedPrincipal, "base64").toString("utf8"),
    ) as Partial<ClientPrincipal>;
    if (
      typeof value.identityProvider !== "string" ||
      typeof value.userId !== "string" ||
      typeof value.userDetails !== "string" ||
      !Array.isArray(value.userRoles) ||
      !value.userRoles.every((role) => typeof role === "string") ||
      (value.claims !== undefined &&
        (!Array.isArray(value.claims) ||
          !value.claims.every(
            (claim) =>
              typeof claim === "object" &&
              claim !== null &&
              typeof claim.typ === "string" &&
              typeof claim.val === "string",
          )))
    ) {
      return null;
    }
    return value as ClientPrincipal;
  } catch {
    return null;
  }
}

function principalEmail(principal: ClientPrincipal): string {
  const claim = principal.claims?.find((candidate) =>
    emailClaimTypes.has(candidate.typ.toLowerCase()),
  );
  return normalizeEmail(claim?.val ?? principal.userDetails);
}

export function authorizeBrowserRequest(
  request: Pick<HttpRequest, "headers">,
  env: NodeJS.ProcessEnv = process.env,
): BrowserAuthorization {
  const principal = parseClientPrincipal(
    request.headers.get(CLIENT_PRINCIPAL_HEADER),
  );
  if (
    !principal ||
    principal.identityProvider.toLowerCase() !== "aad" ||
    !principal.userRoles.some(
      (role) => role.toLowerCase() === "authenticated",
    )
  ) {
    return {
      authorized: false,
      authenticated: false,
      status: 401,
      error: "Microsoft account sign-in is required.",
    };
  }

  const email = principalEmail(principal);
  const authorizedUsers = parseAuthorizedUsers(env[AUTHORIZED_USERS_ENV]);
  if (authorizedUsers.size === 0) {
    return {
      authorized: false,
      authenticated: true,
      email,
      status: 503,
      error: `${AUTHORIZED_USERS_ENV} is not configured.`,
    };
  }
  if (!email || !authorizedUsers.has(email)) {
    return {
      authorized: false,
      authenticated: true,
      email,
      status: 403,
      error: "This Microsoft account is not authorized.",
    };
  }

  return { authorized: true, email };
}

export function browserAuthorizationError(
  authorization: Exclude<BrowserAuthorization, { authorized: true }>,
): HttpResponseInit {
  return {
    status: authorization.status,
    headers: { "Cache-Control": "no-store" },
    jsonBody: {
      authenticated: authorization.authenticated,
      authorized: false,
      email: authorization.email,
      error: authorization.error,
    },
  };
}
