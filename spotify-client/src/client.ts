import {
  SpotifyApiError,
  base64,
  defaultFetch,
  errorFrom,
  retryAfterSeconds,
  send,
  sleep,
  type FetchLike,
} from "./http.js";
import { parseSpotifyId } from "./ids.js";
import type {
  SpotifyAlbumObject,
  SpotifyArtist,
  SpotifyArtistObject,
  SpotifyPlaylistInfo,
  SpotifySearchResult,
  SpotifyTrack,
  SpotifyTrackObject,
} from "./types.js";

export const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
export const SPOTIFY_API_URL = "https://api.spotify.com/v1";

export interface SpotifyCredentials {
  clientId: string;
  clientSecret: string;
}

/** A client-credentials access token and when it stops working (epoch ms). */
export interface SpotifyToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Somewhere to keep the token between page loads or restarts, e.g. localStorage.
 * Both calls are wrapped in try/catch, so a throwing store just means no cache.
 */
export interface SpotifyTokenStore {
  load(): SpotifyToken | null | undefined;
  /** Called with the new token, or with null when the token is cleared (a 401, or clearToken()). */
  save(token: SpotifyToken | null): void;
}

export interface SpotifyClientOptions extends SpotifyCredentials {
  /** Defaults to the global fetch. Inject a stub in tests. */
  fetch?: FetchLike;
  /** Per-request timeout. Default 15 000. */
  timeoutMs?: number;
  /** Refresh the token this long before it expires. Default 60 000. */
  refreshMarginMs?: number;
  /** Optional persistence for the token; the client always caches it in memory too. */
  tokenStore?: SpotifyTokenStore;
  /** How many 429s one call may wait out before failing. Default 5. */
  maxRateLimitRetries?: number;
  /** Ceiling on a Retry-After wait. Default 60. */
  maxRetryAfterSeconds?: number;
  /** Pause between playlist pages, to stay clear of rate limits. Default 100. */
  pageDelayMs?: number;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface SpotifyClient {
  /** The cached token, fetching a new one when it is missing or about to expire. */
  getToken(): Promise<SpotifyToken>;
  getAccessToken(): Promise<string>;
  /** Forget the token (memory and store). The next call fetches a fresh one. */
  clearToken(): void;
  /** True when the credentials can get a token. Never throws. */
  testConnection(): Promise<boolean>;
  /**
   * Authorized GET against the Web API. `path` is relative to /v1 ("/artists/x") or a
   * full https URL. A 401 refreshes the token once; a 429 waits out Retry-After.
   */
  get<T = unknown>(path: string, query?: Record<string, QueryValue>): Promise<T>;
  /** GET /search, flattened. Defaults: tracks and artists, 20 each. */
  search(query: string, options?: { type?: ("track" | "artist")[]; limit?: number }): Promise<SpotifySearchResult>;
  /** GET /artists/{id}: the raw artist object (followers.total, popularity, name…). */
  getArtist(id: string): Promise<SpotifyArtistObject>;
  /** GET /albums in batches of 20. Unknown IDs are dropped, so the result can be shorter. */
  getAlbums(ids: string[]): Promise<SpotifyAlbumObject[]>;
  /**
   * Every track of a public playlist, 50 per page. `playlist` is a URL, URI or bare ID.
   * Items without a track (removed or unavailable) are skipped.
   */
  getPlaylistTracks(
    playlist: string,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<{ playlist: SpotifyPlaylistInfo; tracks: SpotifyTrack[] }>;
}

export function createSpotifyClient(options: SpotifyClientOptions): SpotifyClient {
  const clientId = (options.clientId ?? "").trim();
  const clientSecret = (options.clientSecret ?? "").trim();
  const fetchImpl = options.fetch ?? defaultFetch();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const marginMs = options.refreshMarginMs ?? 60_000;
  const store = options.tokenStore;
  const maxRateLimitRetries = options.maxRateLimitRetries ?? 5;
  const maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? 60;
  const pageDelayMs = options.pageDelayMs ?? 100;

  let token: SpotifyToken | null = null;
  let pending: Promise<SpotifyToken> | null = null;

  const usable = (t: SpotifyToken | null | undefined): t is SpotifyToken =>
    !!t &&
    typeof t.accessToken === "string" &&
    t.accessToken.length > 0 &&
    typeof t.expiresAt === "number" &&
    Date.now() < t.expiresAt - marginMs;

  async function requestToken(): Promise<SpotifyToken> {
    if (!clientId || !clientSecret) {
      throw new SpotifyApiError(0, "Spotify client id and client secret are required.");
    }
    const r = await send(
      fetchImpl,
      SPOTIFY_TOKEN_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${base64(`${clientId}:${clientSecret}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      },
      timeoutMs,
    );
    if (!r.res.ok) throw errorFrom("Spotify auth failed", r);
    const j = (r.json ?? {}) as { access_token?: unknown; expires_in?: unknown };
    if (typeof j.access_token !== "string" || !j.access_token) {
      throw new SpotifyApiError(
        r.res.status,
        "Spotify did not return an access token. Check the client id and secret.",
        r.json ?? r.text,
      );
    }
    const expiresIn = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : 3600;
    const t: SpotifyToken = { accessToken: j.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    token = t;
    try {
      store?.save(t);
    } catch {
      /* a broken store only costs the cache */
    }
    return t;
  }

  async function getToken(): Promise<SpotifyToken> {
    if (usable(token)) return token;
    if (store) {
      let saved: SpotifyToken | null | undefined;
      try {
        saved = store.load();
      } catch {
        saved = null;
      }
      if (usable(saved)) {
        token = { accessToken: saved.accessToken, expiresAt: saved.expiresAt };
        return token;
      }
    }
    // One token request at a time, however many calls are waiting on it.
    pending ??= requestToken().finally(() => {
      pending = null;
    });
    return pending;
  }

  function clearToken(): void {
    token = null;
    try {
      store?.save(null);
    } catch {
      /* ignore */
    }
  }

  async function get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    const url = buildUrl(path, query);
    let refreshed = false;
    let rateLimited = 0;
    for (;;) {
      const t = await getToken();
      const r = await send(fetchImpl, url, { headers: { Authorization: `Bearer ${t.accessToken}` } }, timeoutMs);
      if (r.res.ok) return r.json as T;
      if (r.res.status === 401 && !refreshed) {
        refreshed = true;
        clearToken();
        continue;
      }
      if (r.res.status === 429 && rateLimited < maxRateLimitRetries) {
        rateLimited++;
        await sleep(retryAfterSeconds(r.res, 2, maxRetryAfterSeconds) * 1000);
        continue;
      }
      throw errorFrom("Spotify API error", r);
    }
  }

  async function search(
    query: string,
    opts: { type?: ("track" | "artist")[]; limit?: number } = {},
  ): Promise<SpotifySearchResult> {
    const { type = ["track", "artist"], limit = 20 } = opts;
    const data = await get<{
      tracks?: { items?: (SpotifyTrackObject | null)[] };
      artists?: { items?: (SpotifyArtistObject | null)[] };
    }>("/search", { q: query, type: type.join(","), limit });
    return {
      tracks: (data?.tracks?.items ?? []).filter(isPresent).map(toTrack),
      artists: (data?.artists?.items ?? []).filter(isPresent).map(toArtist),
    };
  }

  async function getArtist(id: string): Promise<SpotifyArtistObject> {
    return get<SpotifyArtistObject>(`/artists/${encodeURIComponent(id)}`);
  }

  async function getAlbums(ids: string[]): Promise<SpotifyAlbumObject[]> {
    const out: SpotifyAlbumObject[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20).map(encodeURIComponent).join(",");
      const data = await get<{ albums?: (SpotifyAlbumObject | null)[] }>(`/albums?ids=${batch}`);
      out.push(...(data?.albums ?? []).filter(isPresent));
    }
    return out;
  }

  async function getPlaylistTracks(
    playlist: string,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<{ playlist: SpotifyPlaylistInfo; tracks: SpotifyTrack[] }> {
    const id = parseSpotifyId(playlist, "playlist");
    if (!id) {
      throw new Error("Invalid Spotify playlist URL. Please use a link like: https://open.spotify.com/playlist/...");
    }

    let meta: {
      id: string;
      name: string;
      description?: string | null;
      external_urls?: { spotify?: string };
      images?: { url: string }[] | null;
      owner?: { display_name?: string | null };
      tracks?: { total?: number };
    };
    try {
      meta = await get(`/playlists/${id}`, {
        fields: "id,name,description,external_urls,images,owner(display_name),tracks(total)",
      });
    } catch (err) {
      if (err instanceof SpotifyApiError && err.status === 404) {
        throw new SpotifyApiError(404, "Playlist not found. Make sure the playlist exists and is public.", err.body, { cause: err });
      }
      if (err instanceof SpotifyApiError && err.status === 403) {
        throw new SpotifyApiError(403, "This playlist is private. Only public playlists are supported.", err.body, { cause: err });
      }
      throw err;
    }

    const total = meta.tracks?.total ?? 0;
    const info: SpotifyPlaylistInfo = {
      id: meta.id,
      name: meta.name,
      description: meta.description || "",
      trackCount: total,
      imageUrl: meta.images?.[0]?.url ?? null,
      externalUrl: meta.external_urls?.spotify ?? `https://open.spotify.com/playlist/${id}`,
      owner: meta.owner?.display_name ?? "",
    };

    const tracks: SpotifyTrack[] = [];
    const limit = 50;
    for (let offset = 0; offset < total; ) {
      const page = await get<{ items?: ({ track?: SpotifyTrackObject | null } | null)[] }>(`/playlists/${id}/tracks`, {
        offset,
        limit,
        fields: "items(track(id,name,artists,album,duration_ms,preview_url,external_urls,popularity)),total",
      });
      const items = page?.items ?? [];
      for (const item of items) {
        if (item?.track) tracks.push(toTrack(item.track));
      }
      offset += limit;
      onProgress?.(Math.min(offset, total), total);
      if (items.length === 0) break; // the total was stale; don't spin
      if (offset < total && pageDelayMs > 0) await sleep(pageDelayMs);
    }
    return { playlist: info, tracks };
  }

  return {
    getToken,
    getAccessToken: async () => (await getToken()).accessToken,
    clearToken,
    testConnection: () => getToken().then(
      () => true,
      () => false,
    ),
    get,
    search,
    getArtist,
    getAlbums,
    getPlaylistTracks,
  };
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const base = /^https?:\/\//i.test(path) ? path : `${SPOTIFY_API_URL}${path.startsWith("/") ? "" : "/"}${path}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params.append(k, String(v));
  }
  const qs = params.toString();
  if (!qs) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${qs}`;
}

function isPresent<T>(v: T | null | undefined): v is T {
  return v != null;
}

/** Flattens a Web API track object into candybar-manager's SpotifyTrack shape. */
export function toTrack(t: SpotifyTrackObject): SpotifyTrack {
  return {
    id: t.id ?? "",
    name: t.name ?? "",
    artists: (t.artists ?? []).map((a) => a.name),
    album: t.album?.name ?? "",
    album_image_url: t.album?.images?.[0]?.url ?? null,
    release_year: t.album?.release_date?.substring(0, 4) ?? null,
    duration_ms: t.duration_ms ?? 0,
    preview_url: t.preview_url ?? null,
    external_url: t.external_urls?.spotify ?? "",
    popularity: t.popularity ?? 0,
  };
}

/** Flattens a Web API artist object into candybar-manager's SpotifyArtist shape. */
export function toArtist(a: SpotifyArtistObject): SpotifyArtist {
  return {
    id: a.id,
    name: a.name,
    genres: a.genres ?? [],
    popularity: a.popularity ?? 0,
    external_url: a.external_urls?.spotify ?? "",
    image_url: a.images?.[0]?.url ?? null,
  };
}
