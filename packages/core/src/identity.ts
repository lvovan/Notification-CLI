import { createHash } from "node:crypto";
import { normalizeEmail } from "./auth.js";

/**
 * Every per-user partition key, and the Web PubSub group a browser is joined
 * to, derive from this one value. Hashing keeps email addresses out of storage
 * keys and out of the group names visible to a connected client.
 */
export function userKey(email: string): string {
  return createHash("sha256").update(normalizeEmail(email)).digest("hex");
}

/** The only group a user's connections are ever joined to. */
export function userGroup(email: string): string {
  return `u-${userKey(email)}`;
}

/** A resolved sender: an authorized email and the partition it owns. */
export interface NotificationOwner {
  email: string;
  userKey: string;
}

export function notificationOwner(email: string): NotificationOwner {
  const normalized = normalizeEmail(email);
  return { email: normalized, userKey: userKey(normalized) };
}

/**
 * Row key for one device's push endpoint. Endpoint URLs are case-sensitive in
 * their path, so this hashes the value verbatim rather than reusing userKey.
 */
export function endpointKey(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}
