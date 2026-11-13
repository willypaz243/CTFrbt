import { randomBytes } from "crypto";

/**
 * Per-team SSH credentials for SSH challenges (#17). The user is derived
 * from the team member's alias and the password is random; both travel
 * to the container as env (`SSH_USER`/`SSH_PASS`) and the container
 * entrypoint creates the non-root user at boot. The password rotates on
 * every start, like the token and the published port (#5/#7).
 */

export const SSH_PASS_LENGTH = 12;

const ALPHANUMERIC =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Derive a usable (non-root) container username from a player alias:
 * lowercase alphanumeric, max 32 chars. Empty or reserved results fall
 * back to `ctf`.
 */
export function sanitizeSshUser(alias: string): string {
  const cleaned = alias
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 32);
  if (!cleaned || cleaned === "root") return "ctf";
  return cleaned;
}

/**
 * Random alphanumeric password. Modulo bias over the 62-char set is
 * negligible for a CTF credential.
 */
export function generateSshPassword(length: number = SSH_PASS_LENGTH): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHANUMERIC[bytes[i]! % ALPHANUMERIC.length];
  }
  return out;
}
