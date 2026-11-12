import path from "path";

export const PUBLIC_DIR = path.resolve(process.cwd(), "public");
export const UPLOADS_DIR = path.join(PUBLIC_DIR, "uploads");

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_CHALLENGE = 20;
export const MAX_TOTAL_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Flat name for a file inside the build context. Spaces are replaced (not
 * kept) so the Dockerfile can always `COPY` the name without quoting —
 * podman's buildah parser does not accept quoted COPY sources.
 */
export function sanitizeUploadName(name: string): string {
  // Strip any directory part, POSIX or Windows style.
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  // Fall back when nothing meaningful (no alphanumerics) remains.
  return /[a-zA-Z0-9]/.test(cleaned) ? cleaned : "upload";
}

export function uploadDirFor(challengeId: string): string {
  return path.join(UPLOADS_DIR, challengeId);
}

/**
 * Name a file is stored on disk under (and the name it appears as in the
 * Docker build context). Derived from the stored path so it is always
 * unique within the challenge and safe to reference in `COPY`.
 */
export function storedFileName(file: { path: string }): string {
  return path.basename(file.path);
}

/**
 * Validates a batch of incoming uploads against the per-file size, per-
 * challenge count, and total size limits, taking into account what the
 * challenge already has. Returns an error message, or null when acceptable.
 */
export function checkUploadLimits(
  incoming: Array<{ size: number }>,
  existingCount: number,
  existingTotalBytes: number,
): string | null {
  if (incoming.length === 0) return null;
  for (const file of incoming) {
    if (file.size > MAX_UPLOAD_BYTES) {
      return `File is too large (max 25 MB)`;
    }
  }
  if (existingCount + incoming.length > MAX_FILES_PER_CHALLENGE) {
    return `Too many files (max ${MAX_FILES_PER_CHALLENGE} per challenge)`;
  }
  const total =
    existingTotalBytes + incoming.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_TOTAL_UPLOAD_BYTES) {
    return `Total file size exceeds the 100 MB limit`;
  }
  return null;
}
