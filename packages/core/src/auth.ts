import type { CoreRequest, CoreResponse } from "./http.js";

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

/**
 * Authorizes browser requests using the Static Web Apps/App Service Entra ID
 * principal. Entra ID authentication is the authorization boundary: anyone with
 * a valid AAD principal and a resolvable email is allowed through.
 */
export function authorizeBrowserRequest(
  request: Pick<CoreRequest, "headers">,
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
      error: "Microsoft account sign-in is required.",
    };
  }

  const email = principalEmail(principal);
  if (!email) {
    return {
      authorized: false,
      authenticated: true,
      error:
        "The Microsoft account session did not include an email address.",
    };
  }

  return { authorized: true, email };
}

export function browserAuthorizationError(
  authorization: Exclude<BrowserAuthorization, { authorized: true }>,
): CoreResponse {
  return {
    status: 401,
    headers: { "Cache-Control": "no-store" },
    jsonBody: {
      authenticated: authorization.authenticated,
      error: authorization.error,
    },
  };
}
