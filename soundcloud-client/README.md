# @btkulka/soundcloud-client

SoundCloud's API over the client-credentials flow, plus the public api-v2 track search that needs no credentials, with only the calls Ben's apps make:

- a token from the documented endpoint (`https://secure.soundcloud.com/oauth/token`, credentials in a Basic header), cached in memory, refreshed a minute before expiry and requested once however many calls are waiting. SoundCloud rate-limits that endpoint hard, so keep one client alive rather than one per call where you can;
- a 401 refreshes the token and retries once; a 429 waits out `Retry-After` (capped at 60 s, up to 5 times);
- track and user search, a user by id, `/resolve`, a reachability ping;
- public track search with a `client_id` scraped from soundcloud.com's scripts, cached for 6 hours and re-scraped once when SoundCloud rejects it.

Global `fetch` (or one you pass in), no `node:*` imports, no `Buffer`. No runtime dependencies. Independent of `@btkulka/spotify-client` on purpose, even though the token pattern is the same.

```json
"dependencies": { "@btkulka/soundcloud-client": "file:../packages/soundcloud-client" }
```

## API

```ts
import { createSoundCloudClient, SoundCloudApiError } from "@btkulka/soundcloud-client";

const sc = createSoundCloudClient({ clientId, clientSecret }); // both optional: public calls work without them

sc.hasCredentials;                                  // both id and secret given
await sc.search("query", { type: ["track", "user"], limit: 20 }); // { tracks: SoundCloudTrack[], users: SoundCloudUser[] }
await sc.getUser(90210);                            // raw user: followers_count, username, permalink_url…
await sc.resolve("https://soundcloud.com/nhi");     // raw object the URL points at
await sc.testConnection();                          // true when the credentials get a token; never throws
await sc.get("/tracks/123");                        // any other OAuth GET, same token/401/429 handling

await sc.ping();                                    // is api.soundcloud.com answering at all? (HEAD, 5 s, any status = true)
await sc.searchPublicTracks("query", 10);           // { tracks, users: [] } via api-v2 and a scraped client_id
await sc.getPublicClientId();
```

`createSoundCloudClient(options?)`

| Option | Default | |
|---|---|---|
| `clientId`, `clientSecret` | none | Needed for `getAccessToken`, `get`, `search`, `getUser`, `resolve`, `testConnection`. Without them those fail with status 0 before any request. |
| `fetch` | global `fetch` | `(url, init) => Promise<{ ok, status, statusText?, headers?, text() }>`. Stubs need no `headers` or `json()`. |
| `timeoutMs` | 15 000 | Per request (the ping always uses 5 000). |
| `refreshMarginMs` | 60 000 | |
| `maxRateLimitRetries` | 5 | |
| `maxRetryAfterSeconds` | 60 | |
| `publicClientIdTtlMs` | 6 h | How long a scraped `client_id` is reused. |
| `userAgent` | desktop Chrome | Sent on the public calls; soundcloud.com serves an emptier page to unknown agents. |

Other exports: `toTrack` / `toUser` (the flatteners), `SOUNDCLOUD_TOKEN_URL`, `SOUNDCLOUD_API_URL`, `SOUNDCLOUD_PUBLIC_API_URL`, and the types `SoundCloudTrack`, `SoundCloudUser`, `SoundCloudSearchResult`, `SoundCloudTrackObject`, `SoundCloudUserObject`, `SoundCloudCredentials`, `SoundCloudClientOptions`, `SoundCloudClient`, `FetchLike`.

**Errors.** Everything throws `SoundCloudApiError` with `status` (0 for timeouts, network errors, missing credentials and a failed scrape) and `body`. Messages carry SoundCloud's own text: `SoundCloud auth failed (500): server_error`, `SoundCloud API error (401): invalid_token`, `SoundCloud public API error (404): …`, `Could not extract SoundCloud public client_id`.

**Shapes.** `search` and `searchPublicTracks` return candybar-manager's flattened `SoundCloudTrack` (`user` is the uploader's username, `duration_ms` comes from `duration`) and `SoundCloudUser`. List endpoints are read whether they answer with an array or with `{ collection }`. `getUser` and `resolve` return SoundCloud's own objects.

## Replaces

| Repo | File | What | Replaced by |
|---|---|---|---|
| nhi-dashboard | `src/platforms.js` | `soundcloudToken` (L84–93), `soundcloudFollowers` (L94–102), and the SoundCloud use of `fetchJson` (L39–60) | `createSoundCloudClient({ …, fetch, timeoutMs: 10000 })` then `.getUser(user_id)` or `.resolve(profile_url)` |
| candybar-manager | `src/lib/soundcloud.ts` | the whole file: `tokenCache`/`getAccessToken`, `searchSoundCloud`, `mapTrack`/`mapUser`, `pingSoundCloudPublic`, `publicClientIdCache`/`getPublicSoundCloudClientId`, `searchSoundCloudPublicTracks`, `testSoundCloudConnection`, the types | `sc.search`, `sc.ping`, `sc.getPublicClientId`, `sc.searchPublicTracks`, `sc.testConnection`, the exported types |
| candybar-manager | `src/lib/soundcloud.ts` | `searchSoundCloudPublic`, `getSoundCloudTrack`, `getSoundCloudDownloadUrl`, `SoundCloudPublicTrack`, `mapV2Track` | nothing: no file calls them. Delete. |

Checked and not copies: nhi-dashboard `src/publicstats.js` (reads the hydration JSON off public soundcloud.com profile and track pages: page scraping, a different job), nhi/nhi-website (links and icons). candybar-manager also lists the npm package `soundcloud.ts` in its dependencies, but no file imports it.

## Migrating

### candybar-manager (Electron main, CommonJS through electron-vite)

1. Add the dependency; change the import block in `src/main.ts` (L21–27).
2. Keep one client per credential pair, plus one without credentials for the public calls, so the token and the scraped `client_id` survive between calls:
   ```ts
   import { createSoundCloudClient, type SoundCloudClient, type SoundCloudCredentials } from "@btkulka/soundcloud-client";
   const publicSc = createSoundCloudClient();
   let oauth: { key: string; client: SoundCloudClient } | null = null;
   function soundcloudFor(c: SoundCloudCredentials): SoundCloudClient {
     const key = `${c.clientId}\n${c.clientSecret}`;
     if (oauth?.key !== key) oauth = { key, client: createSoundCloudClient(c) };
     return oauth.client;
   }
   ```
   - `searchSoundCloud(q, creds, opts)` → `soundcloudFor(creds).search(q, opts)` (main.ts L1390, L1562)
   - `searchSoundCloudPublicTracks(q, n)` → `publicSc.searchPublicTracks(q, n)` (L1395, L1563)
   - `testSoundCloudConnection(creds)` → `soundcloudFor(creds).testConnection()` (L1752)
   - `pingSoundCloudPublic()` → `publicSc.ping()` (L1759)
3. Delete `src/lib/soundcloud.ts`.

Watch for:
- The token now comes from `https://secure.soundcloud.com/oauth/token` with a Basic header, as SoundCloud documents. The old file posted the id and secret in the body to `https://api.soundcloud.com/oauth2/token`, which SoundCloud deprecated in favour of the `secure.soundcloud.com` endpoint (nhi-dashboard already used it).
- The package doesn't log; the old file logged every step at debug level.
- Error text changed (`SoundCloud API error (status): …` instead of `SoundCloud track search failed: <raw body>`).
- A stale public `client_id` (401/403 from api-v2) is now re-scraped once instead of failing for up to 6 hours.

### nhi-dashboard (CommonJS, Node; tests inject `fetch`)

In `src/platforms.js`:

```js
const { createSoundCloudClient } = require('@btkulka/soundcloud-client');

async function soundcloudFollowers(fetchImpl, c) {
  const sc = createSoundCloudClient({
    clientId: c.soundcloud.client_id, clientSecret: c.soundcloud.client_secret, fetch: fetchImpl, timeoutMs: 10000,
  });
  const user = c.soundcloud.user_id ? await sc.getUser(c.soundcloud.user_id) : await sc.resolve(c.soundcloud.profile_url);
  return { sc_followers: user.followers_count != null ? user.followers_count : null, meta: { username: user.username, permalink: user.permalink_url } };
}
```

Delete `soundcloudToken`, and `fetchJson` once Spotify has moved too. If syncs ever run often, hoist the client to module scope (keyed by credentials and `fetch`) so the token is reused: SoundCloud allows only a few dozen token requests per hour.

Watch for:
- `tests/platforms.test.js` keeps passing: the stubs match on `secure.soundcloud.com/oauth/token`, `api.soundcloud.com/users/90210` and `api.soundcloud.com/resolve` (the request is `…/resolve?url=<encoded>`), and the package reads only `ok`, `status`, `statusText`, `text()`.
- Credentials move from the request body to a Basic header (same endpoint).
- `errors.soundcloud` text gains a prefix: `SoundCloud auth failed (500): server_error` where it was `server_error`. The test's `/server_error/` still matches.
- A 500 is not retried (as before); a 429 is now waited out.

## Develop

`npm run build`, `npm run typecheck`, `npm test` (builds, then runs `dist/esm/**/*.test.js` on `node:test`; stubbed fetch, no network).
