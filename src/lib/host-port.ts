/**
 * The part of an instance access URL the player needs: `host:port`,
 * without scheme or path (#17). Credentials and connection details live
 * in the challenge description, not in the UI.
 */
export function hostPortFromUrl(url: string): string {
  return new URL(url).host;
}
