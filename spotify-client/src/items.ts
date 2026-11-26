// One flat shape for anything Spotify's search returns (tracks, albums, artists,
// playlists, podcasts and episodes), so a results list can show every kind the
// same way: a name, one line under it, a short bit at the end and a thumbnail.

import type { SpotifyIdKind } from "./ids.js";
import type { SpotifyImageObject } from "./types.js";

/** What search can look for. The same kinds parseSpotifyId and parseSpotifyLink know. */
export type SpotifySearchType = SpotifyIdKind;

/** Every kind, in the order a results list shows them. */
export const SPOTIFY_SEARCH_TYPES: readonly SpotifySearchType[] = ["track", "album", "artist", "playlist", "show", "episode"];

/** What each kind is called on screen. Spotify's "show" is a podcast. */
export const SPOTIFY_TYPE_LABELS: Readonly<Record<SpotifySearchType, { one: string; many: string }>> = {
  track: { one: "Track", many: "Tracks" },
  album: { one: "Album", many: "Albums" },
  artist: { one: "Artist", many: "Artists" },
  playlist: { one: "Playlist", many: "Playlists" },
  show: { one: "Podcast", many: "Podcasts" },
  episode: { one: "Episode", many: "Episodes" },
};

export interface SpotifyItem {
  type: SpotifySearchType;
  id: string;
  /** `spotify:album:4m28…` */
  uri: string;
  /** `https://open.spotify.com/album/4m28…` */
  url: string;
  name: string;
  /** The line under the name: "Daft Punk, Pharrell Williams · Random Access Memories", "By Red Franzen". */
  subtitle: string;
  /** Short text for the end of a row: "4:08", "Single · 2013", "50 tracks", "34 min". Empty when there's nothing. */
  meta: string;
  /** The smallest image at least 64 px wide, for a row's thumbnail. */
  imageUrl: string | null;
  /** The largest image, for a cover. */
  coverUrl: string | null;
  /** Track, album. */
  artists?: string[];
  /** Track: its album's name. */
  album?: string;
  /** Album: "album", "single" or "compilation". */
  albumType?: string;
  /** Track (its album's), album, episode: as Spotify gives it, "2013-05-20", "2013-05" or "2013". */
  releaseDate?: string;
  /** Track, episode. */
  durationMs?: number;
  /** Album, playlist. */
  trackCount?: number;
  /** Playlist: the owner's display name. */
  owner?: string;
  /** Artist. */
  followers?: number | null;
  /** Artist. */
  genres?: string[];
  /** Podcast. */
  publisher?: string;
  /** Podcast. */
  episodeCount?: number;
  explicit?: boolean;
  popularity?: number;
}

/** One kind's results: a page of items, Spotify's total and whether another page follows. */
export interface SpotifyItemPage {
  items: SpotifyItem[];
  total: number;
  offset: number;
  hasMore: boolean;
}

/** searchItems' answer: a page for each kind asked for. */
export type SpotifyItemSearchResult = Partial<Record<SpotifySearchType, SpotifyItemPage>>;

export interface SpotifySearchItemsOptions {
  /** Default: all six. */
  types?: readonly SpotifySearchType[];
  /** Per kind, 1–50. Default 10. */
  limit?: number;
  /** Default 0. Spotify stops at 1000. */
  offset?: number;
  /** An ISO country code ("US"): only what's playable there. */
  market?: string;
}

type Raw = Record<string, any>;

/** Flattens one object from the Web API (a search result or a GET by ID) into a SpotifyItem. */
export function toItem(type: SpotifySearchType, raw: Raw): SpotifyItem {
  const id = String(raw.id ?? "");
  const images: SpotifyImageObject[] = (type === "track" ? raw.album?.images : raw.images) ?? [];
  const base: SpotifyItem = {
    type,
    id,
    uri: raw.uri || `spotify:${type}:${id}`,
    url: raw.external_urls?.spotify || `https://open.spotify.com/${type}/${id}`,
    name: String(raw.name ?? ""),
    subtitle: "",
    meta: "",
    imageUrl: thumbnail(images),
    coverUrl: cover(images),
  };
  const names = (list: unknown): string[] =>
    Array.isArray(list) ? list.map((a) => (a && typeof a.name === "string" ? a.name : "")).filter(Boolean) : [];

  switch (type) {
    case "track": {
      const artists = names(raw.artists);
      const album = String(raw.album?.name ?? "");
      return {
        ...base,
        artists,
        album,
        releaseDate: raw.album?.release_date || undefined,
        durationMs: num(raw.duration_ms),
        explicit: !!raw.explicit,
        popularity: num(raw.popularity),
        subtitle: [artists.join(", "), album].filter(Boolean).join(" · "),
        meta: clock(raw.duration_ms),
      };
    }
    case "album": {
      const artists = names(raw.artists);
      const albumType = String(raw.album_type ?? "album").toLowerCase();
      const year = String(raw.release_date ?? "").slice(0, 4);
      const kind = albumType === "album" ? "" : albumType === "compilation" ? "Compilation" : albumType === "single" ? "Single" : capitalize(albumType);
      return {
        ...base,
        artists,
        albumType,
        releaseDate: raw.release_date || undefined,
        trackCount: num(raw.total_tracks),
        popularity: num(raw.popularity),
        subtitle: artists.join(", "),
        meta: [kind, year].filter(Boolean).join(" · "),
      };
    }
    case "artist": {
      const followers = typeof raw.followers?.total === "number" ? raw.followers.total : null;
      const genres: string[] = Array.isArray(raw.genres) ? raw.genres : [];
      return {
        ...base,
        followers,
        genres,
        popularity: num(raw.popularity),
        subtitle: followers != null ? `${compact(followers)} ${followers === 1 ? "follower" : "followers"}` : capitalize(genres.slice(0, 2).join(", ")),
        meta: "",
      };
    }
    case "playlist": {
      // Spotify is renaming the playlist's `tracks` to `items`; read either.
      const count = num(raw.items?.total ?? raw.tracks?.total);
      const owner = String(raw.owner?.display_name ?? raw.owner?.id ?? "");
      return {
        ...base,
        owner,
        trackCount: count,
        subtitle: owner ? `By ${owner}` : "",
        meta: count != null ? plural(count, "track") : "",
      };
    }
    case "show": {
      const count = num(raw.total_episodes);
      const publisher = String(raw.publisher ?? "");
      return {
        ...base,
        publisher,
        episodeCount: count,
        explicit: !!raw.explicit,
        subtitle: publisher,
        meta: count != null ? plural(count, "episode") : "",
      };
    }
    case "episode": {
      const show = String(raw.show?.name ?? "");
      return {
        ...base,
        releaseDate: raw.release_date || undefined,
        durationMs: num(raw.duration_ms),
        explicit: !!raw.explicit,
        subtitle: [show, day(raw.release_date)].filter(Boolean).join(" · "),
        meta: minutes(raw.duration_ms),
      };
    }
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** The smallest image at least 64 px wide; with no sizes given, the first. */
function thumbnail(images: SpotifyImageObject[]): string | null {
  const sized = images.filter((i) => i?.url && typeof i.width === "number");
  const big = sized.filter((i) => i.width! >= 64).sort((a, b) => a.width! - b.width!);
  return big[0]?.url ?? cover(images);
}

function cover(images: SpotifyImageObject[]): string | null {
  const withUrl = images.filter((i) => i?.url);
  const sized = withUrl.filter((i) => typeof i.width === "number").sort((a, b) => b.width! - a.width!);
  return sized[0]?.url ?? withUrl[0]?.url ?? null;
}

function clock(ms: unknown): string {
  if (typeof ms !== "number" || !(ms > 0)) return "";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function minutes(ms: unknown): string {
  if (typeof ms !== "number" || !(ms > 0)) return "";
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60 ? `${m % 60} min` : ""}`.trim() : `${m} min`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-03-17" → "17 Mar 2026"; a year or year-month stays as it is. */
function day(date: unknown): string {
  const m = String(date ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(date ?? "");
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** 11962786 → "12M", 48210 → "48K", 1530 → "1.5K". */
export function compact(n: number): string {
  const fmt = (v: number) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, ""));
  if (n >= 1e9) return `${fmt(n / 1e9)}B`;
  if (n >= 1e6) return `${fmt(n / 1e6)}M`;
  if (n >= 1e3) return `${fmt(n / 1e3)}K`;
  return String(n);
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
