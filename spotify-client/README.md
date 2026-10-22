# @btkulka/spotify-client

Spotify Web API over the client-credentials flow (public data, no user login), with only the calls Ben's apps make:

- a token that is cached in memory, optionally persisted through a store the app hands in (album-choice-ranker uses localStorage), refreshed a minute before it expires, and requested once however many calls are waiting on it;
- a 401 refreshes the token and retries once; a 429 waits out `Retry-After` (capped at 60 s, up to 5 times);
- search, one artist, albums in batches of 20, every track of a public playlist, and URL/URI/ID parsing.

It runs in Node and in the browser: global `fetch` (or one you pass in), no `node:*` imports, no `Buffer` (base64 is done by hand). A test checks the built files for that. No runtime dependencies.

```json
"dependencies": { "@btkulka/spotify-client": "file:../packages/spotify-client" }
```

## API

```ts
import { createSpotifyClient, parseSpotifyId, SpotifyApiError } from "@btkulka/spotify-client";

const spotify = createSpotifyClient({ clientId, clientSecret });

await spotify.search("artist song", { type: ["track", "artist"], limit: 20 }); // { tracks: SpotifyTrack[], artists: SpotifyArtist[] }
await spotify.getArtist("4Z8W4fKeB5YxbusRsdQVPb");   // raw artist object: followers.total, popularity, name…
await spotify.getAlbums(ids);                        // raw album objects, 20 per request, unknown IDs dropped
await spotify.getPlaylistTracks(url, (loaded, total) => {}); // { playlist: SpotifyPlaylistInfo, tracks: SpotifyTrack[] }
await spotify.testConnection();                      // true when the credentials get a token; never throws
await spotify.get("/artists/x/top-tracks", { market: "US" }); // any other GET, same token/401/429 handling

parseSpotifyId("https://open.spotify.com/intl-de/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x", "playlist"); // "37i9dQZF1DXcBWIGoYBM5M"
```

`createSpotifyClient(options)`

| Option | Default | |
|---|---|---|
| `clientId`, `clientSecret` | required | Checked when the first token is needed, so a client can be created before the app knows whether it's configured. |
| `fetch` | global `fetch` | `(url, init) => Promise<{ ok, status, statusText?, headers?, text() }>`. Stubs need no `headers` or `json()`. |
| `timeoutMs` | 15 000 | Per request. |
| `refreshMarginMs` | 60 000 | Fetch a new token this long before expiry. |
| `tokenStore` | none | `{ load(): SpotifyToken \| null, save(token \| null) }`. Read when memory is empty, written on every new token, cleared (`save(null)`) on a 401 or `clearToken()`. Both calls are wrapped in try/catch. |
| `maxRateLimitRetries` | 5 | 429s one call may wait out. |
| `maxRetryAfterSeconds` | 60 | Ceiling on one wait. |
| `pageDelayMs` | 100 | Pause between playlist pages. |

Client methods: `getToken(): Promise<SpotifyToken>` (`{ accessToken, expiresAt }`), `getAccessToken(): Promise<string>`, `clearToken()`, `testConnection()`, `get<T>(path, query?)`, `search(q, { type?, limit? })`, `getArtist(id)`, `getAlbums(ids)`, `getPlaylistTracks(urlOrUriOrId, onProgress?)`.

Other exports: `parseSpotifyId(input, kind)` (`kind`: track, album, artist, playlist, show, episode; accepts `open.spotify.com` links including `/intl-xx/` and `/embed/`, `spotify:kind:id` URIs, and bare 22-character IDs; otherwise null), `toTrack` / `toArtist` (the flatteners `search` uses), `SPOTIFY_TOKEN_URL`, `SPOTIFY_API_URL`, and the types `SpotifyTrack`, `SpotifyArtist`, `SpotifySearchResult`, `SpotifyPlaylistInfo`, `SpotifyArtistObject`, `SpotifyAlbumObject`, `SpotifyTrackObject`, `SpotifyImageObject`, `SpotifyToken`, `SpotifyTokenStore`, `SpotifyCredentials`, `SpotifyClientOptions`, `SpotifyClient`, `FetchLike`.

**Errors.** Everything throws `SpotifyApiError` with `status` (HTTP status; 0 for timeouts, network errors and missing credentials) and `body` (the parsed error JSON, or the text). Messages say what Spotify said: `Spotify auth failed (401): invalid_client: Invalid client`, `Spotify API error (404): Non existing id`, `Spotify request to api.spotify.com timed out after 15000ms`. `getPlaylistTracks` turns 404 into "Playlist not found. Make sure the playlist exists and is public." and 403 into "This playlist is private. Only public playlists are supported." An unparseable playlist link throws a plain `Error` before any request.

**Shapes.** `search` and `getPlaylistTracks` return candybar-manager's flattened `SpotifyTrack` / `SpotifyArtist` (snake_case: `album_image_url`, `release_year`, `external_url`…). `getArtist` and `getAlbums` return Spotify's own objects. Playlist items whose `track` is null are skipped; local files come through with `id: ""`.

## Replaces

| Repo | File | What | Replaced by |
|---|---|---|---|
| nhi-dashboard | `src/platforms.js` | `spotifyToken` (L64–73), `spotifyFollowers` (L74–80), and the Spotify use of `fetchJson` (L39–60) | `createSpotifyClient({ …, fetch, timeoutMs: 10000 }).getArtist(id)` |
| nhi-dashboard | `src/platforms.js` | the URL regex in `spotifyArtistId` (L32–37) | `parseSpotifyId(artist_url, "artist")` (keep the raw `artist_id` branch) |
| candybar-manager | `src/lib/spotify.ts` | the whole file: `tokenCache`/`getAccessToken`, `fetchWithTimeout`, `searchSpotify`, `mapTrack`/`mapArtist`, `parseSpotifyPlaylistUrl`, `getPlaylistTracks`, `testSpotifyConnection`, the types | `client.search`, `client.getPlaylistTracks`, `client.testConnection`, `parseSpotifyId`, the exported types |
| album-choice-ranker | `src/utils/spotify.ts` | `getAccessToken`, `getCachedAuth`, `clearAuth`, `fetchAlbumsBatch` (keep `hasCredentials`: it reads the Vite env) | a client with a localStorage `tokenStore`; `client.getAlbums`, `client.clearToken` |
| album-choice-ranker | `src/types.ts` | `SpotifyAuth`, `SpotifyAlbumData` | `SpotifyToken` (same two fields), `SpotifyAlbumObject` (a superset) |

Checked and not copies: nhi/nhi-website (`content.js`, `PlatformIcon.jsx`, `LinkList` tests, design-system files: profile links and icons), clipdrift `src/renderer/utils/normalization.ts` (a comment about streaming loudness), nhi/nhi-album-art-gen `GenerationDetail.tsx` (a 3000×3000 cover preset labelled Spotify), nhi-dashboard `src/publicstats.js` / `src/browserstats.js` (read the public artist page and a driven Chrome, not the Web API), album-choice-ranker `src/utils/parsing.ts` (`parseSpotifyLine` pulls several `spotify:album:` / `spotify:artist:` URIs out of a CSV line: app-specific, stays).

## Migrating

### candybar-manager (Electron main, CommonJS through electron-vite)

`externalizeDepsPlugin()` leaves the package external, so main `require`s `dist/cjs` at runtime.

1. Add the dependency. Point the imports in `src/main.ts` (L20), `src/lib/jobQueue/jobs/libraryCheck.ts` (L3) and `src/lib/musicLibraryCheck.ts` (L10, type only) at the package.
2. The old module kept one token for whatever credentials came first. Keep one client per credential pair instead:
   ```ts
   import { createSpotifyClient, type SpotifyClient, type SpotifyCredentials } from "@btkulka/spotify-client";
   let spotify: { key: string; client: SpotifyClient } | null = null;
   function spotifyFor(c: SpotifyCredentials): SpotifyClient {
     const key = `${c.clientId}\n${c.clientSecret}`;
     if (spotify?.key !== key) spotify = { key, client: createSpotifyClient(c) };
     return spotify.client;
   }
   ```
   Then `searchSpotify(q, creds)` → `spotifyFor(creds).search(q)`, `getPlaylistTracks(url, creds, onProgress)` → `spotifyFor(creds).getPlaylistTracks(url, onProgress)`, `testSpotifyConnection(creds)` → `spotifyFor(creds).testConnection()`.
3. Delete `src/lib/spotify.ts`. `SpotifyTrack`, `SpotifySearchResult`, `SpotifyCredentials` and `SpotifyPlaylistInfo` keep their field names.

Watch for:
- The package doesn't log. The old file logged auth/search failures and the playlist summary through `createScopedLogger('Spotify')`; log at the call site if you still want those lines.
- Error text changed from `Spotify search failed: <raw body>` to `Spotify API error (status): <message>`; anything matching the old strings breaks.
- A 401 now refreshes the token and retries once (before: cleared the cache and threw). 429 handling now covers every call, not only playlist pages.
- `/intl-xx/` share links now parse; before they were "Invalid Spotify playlist URL".
- Local files in a playlist get `id: ""` (before: `null` despite the `string` type).

### nhi-dashboard (CommonJS, Node; tests inject `fetch`)

In `src/platforms.js`:

```js
const { createSpotifyClient, parseSpotifyId } = require('@btkulka/spotify-client');

function spotifyArtistId(c) {
  const raw = (c.spotify.artist_id || '').trim();
  if (raw) return raw;                               // raw IDs pass through, as before
  return parseSpotifyId(c.spotify.artist_url, 'artist');
}

async function spotifyFollowers(fetchImpl, c) {
  const id = spotifyArtistId(c);
  if (!id) throw new Error('Spotify artist_id or artist_url is missing or malformed.');
  const spotify = createSpotifyClient({
    clientId: c.spotify.client_id, clientSecret: c.spotify.client_secret, fetch: fetchImpl, timeoutMs: 10000,
  });
  const artist = await spotify.getArtist(id);
  return { spotify_followers: artist.followers ? artist.followers.total : null, meta: { name: artist.name, popularity: artist.popularity } };
}
```

Delete `spotifyToken`. Delete `fetchJson` once SoundCloud has moved to `@btkulka/soundcloud-client` too. A client per sync is fine here: syncs are rare and the tests pass a different `fetch` each time.

Watch for:
- `tests/platforms.test.js` stubs keep working: the package reads only `ok`, `status`, `statusText` and `text()`, and `headers` is optional. The artist URL is still exactly `…/v1/artists/<id>`.
- `errors.spotify` text gains a prefix: `Spotify auth failed (401): invalid_client: Invalid client` where it was `invalid_client`. The test's `/invalid_client/` still matches; the UI and MCP show the longer text.
- `parseSpotifyId` also accepts `spotify:artist:` URIs and localized links, like the old regex; it rejects a bare string in `artist_url` that isn't 22 characters (the old regex rejected those too).

### album-choice-ranker (Vite + React, browser)

`src/utils/spotify.ts` shrinks to:

```ts
import { createSpotifyClient, type SpotifyToken } from '@btkulka/spotify-client';

const STORAGE_KEY_AUTH = 'spotify_auth';
const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID || '';
const CLIENT_SECRET = import.meta.env.VITE_SPOTIFY_CLIENT_SECRET || '';

export function hasCredentials(): boolean { /* unchanged */ }

const client = createSpotifyClient({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  refreshMarginMs: 5 * 60 * 1000, // the old 5-minute buffer
  tokenStore: {
    load: () => JSON.parse(localStorage.getItem(STORAGE_KEY_AUTH) ?? 'null') as SpotifyToken | null,
    save: (t) => (t ? localStorage.setItem(STORAGE_KEY_AUTH, JSON.stringify(t)) : localStorage.removeItem(STORAGE_KEY_AUTH)),
  },
});

export const clearAuth = (): void => client.clearToken();
export const fetchAlbums = (ids: string[]) => client.getAlbums(ids);
```

In `src/hooks/useSpotify.ts`, replace `const auth = await getAccessToken(); … fetchAlbumsBatch(albumIds, auth.accessToken)` with `fetchAlbums(albumIds)`. Replace `SpotifyAuth`/`SpotifyAlbumData` in `src/types.ts` with the package's `SpotifyToken`/`SpotifyAlbumObject` (or alias them).

Watch for:
- `import.meta.env` stays in the app; the package never reads env.
- The localStorage key and value shape (`{ accessToken, expiresAt }`) are unchanged, so tokens already saved keep working.
- A 401 now refreshes once and retries instead of throwing `Token expired`.
- Token failures read `Spotify auth failed (400): invalid_client: Invalid client secret` instead of only the `error_description`.
- The package lives outside the app folder and isn't pre-bundled (it is plain ESM, so it doesn't need to be). If the dev server refuses to serve it, allow the folder: `server: { fs: { allow: [searchForWorkspaceRoot(process.cwd()), '../packages/spotify-client'] } }`.

## Develop

`npm run build`, `npm run typecheck`, `npm test` (builds, then runs `dist/esm/**/*.test.js` on `node:test`; stubbed fetch, no network).
