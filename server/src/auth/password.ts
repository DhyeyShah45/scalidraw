import { hash, verify } from "@node-rs/argon2";

// argon2id defaults from @node-rs/argon2 are OWASP-current; pinned here so a
// dependency bump cannot silently weaken (or invalidate) the stored hash.
const OPTIONS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export const hashPassword = (password: string) => hash(password, OPTIONS);

export const verifyPassword = async (storedHash: string, password: string) => {
  try {
    return await verify(storedHash, password, OPTIONS);
  } catch {
    // Malformed hash in config — treat as a failed login rather than a 500,
    // so a bad AUTH_PASSWORD_HASH never leaks its shape through error codes.
    return false;
  }
};
