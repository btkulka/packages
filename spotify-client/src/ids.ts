export type SpotifyIdKind = "track" | "album" | "artist" | "playlist" | "show" | "episode";

/**
 * Pulls a Spotify ID out of whatever a person pasted:
 *
 * - `https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=…`
 * - `https://open.spotify.com/intl-de/artist/4Z8W4fKeB5YxbusRsdQVPb` (localized share links)
 * - `spotify:album:4aawyAB9vmqN3uQ7FjRGTy`
 * - a bare ID: exactly 22 base62 characters
 *
 * Returns null for anything else, including a URL of a different kind.
 */
export function parseSpotifyId(input: string | null | undefined, kind: SpotifyIdKind): string | null {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;

  const url = s.match(new RegExp(`open\\.spotify\\.com/(?:intl-[a-z]{2,3}(?:-[a-z]{2,4})?/)?(?:embed/)?${kind}/([A-Za-z0-9]+)`, "i"));
  if (url) return url[1]!;

  const uri = s.match(new RegExp(`^spotify:${kind}:([A-Za-z0-9]+)$`));
  if (uri) return uri[1]!;

  if (/^[A-Za-z0-9]{22}$/.test(s)) return s;
  return null;
}
