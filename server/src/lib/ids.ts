import crypto from "node:crypto";

/** URL-safe, 16 chars, ~96 bits — these end up in `/d/:id` (D16). */
export const newDocumentId = () => crypto.randomBytes(12).toString("base64url");

export const newSessionToken = () =>
  crypto.randomBytes(32).toString("base64url");

/**
 * Sessions are stored hashed so a leaked database file (or a backup) does not
 * hand over live sessions. Not a slow KDF on purpose: the input is already
 * 256 bits of entropy, so there is nothing to brute-force.
 */
export const hashSessionToken = (token: string) =>
  crypto.createHash("sha256").update(token).digest("hex");
