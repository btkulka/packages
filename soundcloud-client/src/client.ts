import {
  SoundCloudApiError,
  base64,
  defaultFetch,
  errorFrom,
  retryAfterSeconds,
  send,
  sleep,
  type FetchLike,
  type FetchLikeInit,
} from "./http.js";

export const SOUNDCLOUD_TOKEN_URL = "https://secure.soundcloud.com/oauth/token";
export const SOUNDCLOUD_API_URL = "https://api.soundcloud.com";
export const SOUNDCLOUD_PUBLIC_API_URL = "https://api-v2.soundcloud.com";
const HOME_URL = "https://soundcloud.com/";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface SoundCloudCredentials {
  clientId: string;
  clientSecret: string;
}

export interface SoundCloudClientOptions extends Partial<SoundCloudCredentials> {
  /** Defaults to the global fetch. Inject a stub in tests. */
  fetch?: FetchLike;
  /** Per-request timeout. Default 15 000. */
  timeoutMs?: number;
  /** Refresh the token this long before it expires. Default 60 000. */
  refreshMarginMs?: number;
  /** How many 429s one call may wait out before failing. Default 5. */
  maxRateLimitRetries?: number;
  /** Ceiling on a Retry-After wait. Default 60. */
  maxRetryAfterSeconds?: number;
  /** How long a scraped public client_id is reused. Default 6 hours. */
  publicClientIdTtlMs?: number;
  /** User-Agent for the public (no-credentials) calls. Defaults to a desktop Chrome string. */
  userAgent?: string;
}

/** Flattened track (candybar-manager's shape). */
export interface SoundCloudTrack {
  id: number;
  title: string;
  /** The uploader's username. */
  user: string;
  duration_ms: number;
  permalink_url: string;
  artwork_url: string | null;
  genre: string | null;
  playback_count: number;
}

/** Flattened user (candybar-manager's shape). */
export interface SoundCloudUser {
  id: number;
  username: string;
  permalink_url: string;
  avatar_url: string | null;
  track_count: number;
  followers_count: number;
}

export interface SoundCloudSearchResult {
  tracks: SoundCloudTrack[];
  users: SoundCloudUser[];
}

/** A user as /users/{id} and /resolve return it (the fields the apps read; there are more). */
export interface SoundCloudUserObject {
  id: number;
  username: string;
  permalink_url?: string;
  avatar_url?: string | null;
  followers_count?: number | null;
  track_count?: number | null;
  [key: string]: unknown;
}

/** A track as the search endpoints return it. */
export interface SoundCloudTrackObject {
  id: number;
  title: string;
  user?: { username?: string; [key: string]: unknown };
  /** Milliseconds. */
  duration?: number;
  permalink_url?: string;
  artwork_url?: string | null;
  genre?: string | null;
  playback_count?: number | null;
  [key: string]: unknown;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface SoundCloudClient {
  /** True when both a client id and a secret were given. */
  readonly hasCredentials: boolean;
  /** The cached OAuth token, fetching a new one when missing or about to expire. */
  getAccessToken(): Promise<string>;
  clearToken(): void;
  /** True when the credentials can get a token. Never throws. */
  testConnection(): Promise<boolean>;
  /**
   * Authorized GET against api.soundcloud.com. `path` is relative ("/users/1") or a full
   * https URL. A 401 refreshes the token once; a 429 waits out Retry-After.
   */
  get<T = unknown>(path: string, query?: Record<string, QueryValue>): Promise<T>;
  /** OAuth search: /tracks and /users in parallel, flattened. Defaults: both, 20 each. */
  search(query: string, options?: { type?: ("track" | "user")[]; limit?: number }): Promise<SoundCloudSearchResult>;
  /** GET /users/{id}: the raw user (followers_count, username, permalink_url…). */
  getUser(id: string | number): Promise<SoundCloudUserObject>;
  /** GET /resolve?url=…: whatever the soundcloud.com URL points at. */
  resolve<T = SoundCloudUserObject>(url: string): Promise<T>;
  /**
   * Is SoundCloud's API answering at all? Any HTTP status counts; only a network error or a
   * 5 s timeout is false. Needs no credentials.
   */
  ping(): Promise<boolean>;
  /** A working public client_id scraped from soundcloud.com's scripts, cached. */
  getPublicClientId(): Promise<string>;
  /**
   * Track search on the public api-v2 with the scraped client_id: no credentials needed.
   * Same shape as search(), with no users.
   */
  searchPublicTracks(query: string, limit?: number): Promise<SoundCloudSearchResult>;
}

export function createSoundCloudClient(options: SoundCloudClientOptions = {}): SoundCloudClient {
  const clientId = (options.clientId ?? "").trim();
  const clientSecret = (options.clientSecret ?? "").trim();
  const fetchImpl = options.fetch ?? defaultFetch();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const marginMs = options.refreshMarginMs ?? 60_000;
  const maxRateLimitRetries = options.maxRateLimitRetries ?? 5;
  const maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? 60;
  const publicTtlMs = options.publicClientIdTtlMs ?? 6 * 3600_000;
  const userAgent = options.userAgent ?? BROWSER_UA;
  const hasCredentials = !!(clientId && clientSecret);

  let token: { accessToken: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;
  let publicId: { id: string; fetchedAt: number } | null = null;
  let publicPending: Promise<string> | null = null;

  async function requestToken(): Promise<string> {
    if (!hasCredentials) throw new SoundCloudApiError(0, "SoundCloud client id and client secret are required.");
    const r = await send(
      fetchImpl,
      SOUNDCLOUD_TOKEN_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${base64(`${clientId}:${clientSecret}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json; charset=utf-8",
        },
        body: "grant_type=client_credentials",
      },
      timeoutMs,
    );
    if (!r.res.ok) throw errorFrom("SoundCloud auth failed", r);
    const j = (r.json ?? {}) as { access_token?: unknown; expires_in?: unknown };
    if (typeof j.access_token !== "string" || !j.access_token) {
      throw new SoundCloudApiError(
        r.res.status,
        "SoundCloud did not return an access token. Check the client id and secret.",
        r.json ?? r.text,
      );
    }
    const expiresIn = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : 3600;
    token = { accessToken: j.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return token.accessToken;
  }

  function getAccessToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt - marginMs) return Promise.resolve(token.accessToken);
    // One token request at a time: SoundCloud rate-limits the token endpoint hard.
    pending ??= requestToken().finally(() => {
      pending = null;
    });
    return pending;
  }

  function clearToken(): void {
    token = null;
  }

  async function get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    const url = buildUrl(SOUNDCLOUD_API_URL, path, query);
    let refreshed = false;
    let rateLimited = 0;
    for (;;) {
      const t = await getAccessToken();
      const r = await send(
        fetchImpl,
        url,
        { headers: { Authorization: `OAuth ${t}`, Accept: "application/json; charset=utf-8" } },
        timeoutMs,
      );
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
      throw errorFrom("SoundCloud API error", r);
    }
  }

  async function search(
    query: string,
    opts: { type?: ("track" | "user")[]; limit?: number } = {},
  ): Promise<SoundCloudSearchResult> {
    const { type = ["track", "user"], limit = 20 } = opts;
    const [tracks, users] = await Promise.all([
      type.includes("track")
        ? get<unknown>("/tracks", { q: query, limit }).then((d) => listOf<SoundCloudTrackObject>(d).map(toTrack))
        : Promise.resolve([]),
      type.includes("user")
        ? get<unknown>("/users", { q: query, limit }).then((d) => listOf<SoundCloudUserObject>(d).map(toUser))
        : Promise.resolve([]),
    ]);
    return { tracks, users };
  }

  async function ping(): Promise<boolean> {
    try {
      await send(fetchImpl, `${SOUNDCLOUD_API_URL}/`, { method: "HEAD" }, 5_000, { readBody: false });
      return true;
    } catch {
      return false;
    }
  }

  async function scrapePublicClientId(): Promise<string> {
    const home = await send(fetchImpl, HOME_URL, { headers: { "User-Agent": userAgent } }, timeoutMs);
    if (!home.res.ok) throw errorFrom("SoundCloud home page", home);
    // Asset scripts look like https://a-v2.sndcdn.com/assets/0-abcd1234.js; the client_id
    // sits in one of the later ones, so walk them from the end.
    const scripts = Array.from(home.text.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^\s"'<>]+\.js/g), (m) => m[0]);
    for (const src of [...new Set(scripts)].reverse()) {
      try {
        const js = await send(fetchImpl, src, { headers: { "User-Agent": userAgent } }, timeoutMs);
        if (!js.res.ok) continue;
        const m = js.text.match(/client_id\s*:\s*"([a-zA-Z0-9]{20,})"/) ?? js.text.match(/client_id=([a-zA-Z0-9]{20,})/);
        if (m) return m[1]!;
      } catch {
        /* try the next script */
      }
    }
    throw new SoundCloudApiError(0, "Could not extract SoundCloud public client_id");
  }

  function getPublicClientId(): Promise<string> {
    if (publicId && Date.now() - publicId.fetchedAt < publicTtlMs) return Promise.resolve(publicId.id);
    publicPending ??= scrapePublicClientId()
      .then((id) => {
        publicId = { id, fetchedAt: Date.now() };
        return id;
      })
      .finally(() => {
        publicPending = null;
      });
    return publicPending;
  }

  async function publicGet<T>(path: string, query: Record<string, QueryValue>): Promise<T> {
    const init: FetchLikeInit = { headers: { "User-Agent": userAgent, Accept: "application/json" } };
    let rescraped = false;
    let rateLimited = 0;
    for (;;) {
      const id = await getPublicClientId();
      const r = await send(fetchImpl, buildUrl(SOUNDCLOUD_PUBLIC_API_URL, path, { ...query, client_id: id }), init, timeoutMs);
      if (r.res.ok) return r.json as T;
      // A rotated client_id answers 401/403: scrape a fresh one once.
      if ((r.res.status === 401 || r.res.status === 403) && !rescraped) {
        rescraped = true;
        publicId = null;
        continue;
      }
      if (r.res.status === 429 && rateLimited < maxRateLimitRetries) {
        rateLimited++;
        await sleep(retryAfterSeconds(r.res, 2, maxRetryAfterSeconds) * 1000);
        continue;
      }
      throw errorFrom("SoundCloud public API error", r);
    }
  }

  async function searchPublicTracks(query: string, limit = 10): Promise<SoundCloudSearchResult> {
    const data = await publicGet<unknown>("/search/tracks", { q: query, limit });
    return { tracks: listOf<SoundCloudTrackObject>(data).map(toTrack), users: [] };
  }

  return {
    hasCredentials,
    getAccessToken,
    clearToken,
    testConnection: () => getAccessToken().then(
      () => true,
      () => false,
    ),
    get,
    search,
    getUser: (id) => get<SoundCloudUserObject>(`/users/${encodeURIComponent(String(id))}`),
    resolve: <T>(url: string) => get<T>("/resolve", { url }),
    ping,
    getPublicClientId,
    searchPublicTracks,
  };
}

function buildUrl(base: string, path: string, query?: Record<string, QueryValue>): string {
  const full = /^https?:\/\//i.test(path) ? path : `${base}${path.startsWith("/") ? "" : "/"}${path}`;
  if (!query) return full;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params.append(k, String(v));
  }
  const qs = params.toString();
  if (!qs) return full;
  return `${full}${full.includes("?") ? "&" : "?"}${qs}`;
}

/** The API answers a list as an array, or as { collection } when linked_partitioning is on. */
function listOf<T>(data: unknown): T[] {
  const list = Array.isArray(data) ? data : (data as { collection?: unknown } | null)?.collection;
  return Array.isArray(list) ? (list.filter((x) => x != null) as T[]) : [];
}

/** Flattens an API track into candybar-manager's SoundCloudTrack shape. */
export function toTrack(t: SoundCloudTrackObject): SoundCloudTrack {
  return {
    id: t.id,
    title: t.title ?? "",
    user: t.user?.username ?? "",
    duration_ms: t.duration ?? 0,
    permalink_url: t.permalink_url ?? "",
    artwork_url: t.artwork_url ?? null,
    genre: t.genre ?? null,
    playback_count: t.playback_count ?? 0,
  };
}

/** Flattens an API user into candybar-manager's SoundCloudUser shape. */
export function toUser(u: SoundCloudUserObject): SoundCloudUser {
  return {
    id: u.id,
    username: u.username ?? "",
    permalink_url: u.permalink_url ?? "",
    avatar_url: u.avatar_url ?? null,
    track_count: u.track_count ?? 0,
    followers_count: u.followers_count ?? 0,
  };
}
