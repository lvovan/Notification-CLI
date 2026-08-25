import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as signWith,
  verify as verifyWith,
  type JsonWebKey,
} from "node:crypto";

/** ES256 keeps the token small enough to sit comfortably in a header. */
const ALGORITHM = "ES256";
const DIGEST = "sha256";
const ENCODING = { dsaEncoding: "ieee-p1363" } as const;

export interface SigningKey {
  kid: string;
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

export interface AccessTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  /** The account the token acts for; re-checked against the allowlist on use. */
  email: string;
  scope: string;
  client_id: string;
  iat: number;
  exp: number;
  jti: string;
}

export function generateSigningKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    kid: randomUUID(),
    privateJwk: privateKey.export({ format: "jwk" }),
    publicJwk: publicKey.export({ format: "jwk" }),
  };
}

/** The public half, as the JWKS document publishes it. */
export function publicJwk(key: SigningKey): JsonWebKey & { kid: string; use: string; alg: string } {
  return { ...key.publicJwk, kid: key.kid, use: "sig", alg: ALGORITHM };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function signJwt(claims: AccessTokenClaims, key: SigningKey): string {
  const signingInput = `${encode({ alg: ALGORITHM, typ: "JWT", kid: key.kid })}.${encode(claims)}`;
  const signature = signWith(DIGEST, Buffer.from(signingInput), {
    key: createPrivateKey({ key: key.privateJwk, format: "jwk" }),
    ...ENCODING,
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

/**
 * Verifies the signature and the time window only. Audience and issuer are the
 * caller's business, because the resource server knows its own identity.
 */
export function verifyJwt(
  token: string,
  keys: readonly SigningKey[],
  now: () => Date = () => new Date(),
): AccessTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [rawHeader, rawClaims, rawSignature] = parts as [string, string, string];

  let header: { alg?: unknown; kid?: unknown };
  let claims: Partial<AccessTokenClaims>;
  try {
    header = JSON.parse(Buffer.from(rawHeader, "base64url").toString("utf8")) as typeof header;
    claims = JSON.parse(Buffer.from(rawClaims, "base64url").toString("utf8")) as typeof claims;
  } catch {
    return null;
  }
  if (header.alg !== ALGORITHM) {
    return null;
  }

  const key = keys.find((candidate) => candidate.kid === header.kid);
  if (!key) {
    return null;
  }

  const valid = verifyWith(
    DIGEST,
    Buffer.from(`${rawHeader}.${rawClaims}`),
    { key: createPublicKey({ key: key.publicJwk, format: "jwk" }), ...ENCODING },
    Buffer.from(rawSignature, "base64url"),
  );
  if (!valid) {
    return null;
  }

  const seconds = Math.floor(now().getTime() / 1000);
  if (
    typeof claims.exp !== "number" ||
    claims.exp <= seconds ||
    typeof claims.email !== "string" ||
    typeof claims.aud !== "string" ||
    typeof claims.iss !== "string"
  ) {
    return null;
  }
  return claims as AccessTokenClaims;
}
