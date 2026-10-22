import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpotifyClient, SpotifyApiError, type FetchLike, type FetchLikeInit, type SpotifyToken } from "./index.js";

type Route = [match: string, status: number, body: unknown, headers?: Record<string, string>];

/** Answers by URL substring, first match wins; a route is consumed when `once` routes are listed first. */
function stub(routes: Route[], opts: { noHeaders?: boolean } = {}) {
  const calls: { url: string; init?: FetchLikeInit }[] = [];
  const queue = [...routes];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const i = queue.findIndex(([m]) => url.includes(m));
    if (i === -1) return { ok: false, status: 404, statusText: "no stub", text: async () => JSON.stringify({ error: { status: 404, message: `no stub for ${url}` } }) };
    const [, status, body, headers] = queue[i]!;
    // Routes with the same match string are used in order; the last one sticks.
    if (queue.findIndex(([m], j) => j > i && m === queue[i]![0]) !== -1) queue.splice(i, 1);
    const h = new Map(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      ...(opts.noHeaders ? {} : { headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null } }),
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
  return { fetch: fn, calls };
}

const TOKEN: Route = ["accounts.spotify.com/api/token", 200, { access_token: "tok", token_type: "Bearer", expires_in: 3600 }];
const creds = { clientId: "sid", clientSecret: "ssecret" };

test("token request uses Basic auth and the client-credentials grant, and is cached", async () => {
  const s = stub([TOKEN, ["/v1/artists/", 200, { id: "a", name: "NHI", followers: { total: 5 } }]]);
  const c = createSpotifyClient({ ...creds, fetch: s.fetch });
  await c.getArtist("a");
  await c.getArtist("a");
  const tokenCalls = s.calls.filter((x) => x.url.includes("accounts.spotify.com"));
  assert.equal(tokenCalls.length, 1);
  const init = tokenCalls[0]!.init!;
  assert.equal(init.method, "POST");
  assert.equal(init.headers!.Authorization, `Basic ${Buffer.from("sid:ssecret").toString("base64")}`);
  assert.equal(init.headers!["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(init.body, "grant_type=client_credentials");
  assert.equal(s.calls[1]!.init!.headers!.Authorization, "Bearer tok");
});

test("a token inside the refresh margin is replaced", async () => {
  const s = stub([["accounts.spotify.com/api/token", 200, { access_token: "short", expires_in: 30 }]]);
  const c = createSpotifyClient({ ...creds, fetch: s.fetch }); // margin 60s > 30s lifetime
  await c.getAccessToken();
  await c.getAccessToken();
  assert.equal(s.calls.length, 2);
});

test("a missing expires_in is treated as an hour", async () => {
  const s = stub([["accounts.spotify.com/api/token", 200, { access_token: "tok" }]]);
  const c = createSpotifyClient({ ...creds, fetch: s.fetch });
  const t = await c.getToken();
  assert.ok(t.expiresAt > Date.now() + 3500_000);
});

test("concurrent callers share one token request", async () => {
  const s = stub([TOKEN]);
  const c = createSpotifyClient({ ...creds, fetch: s.fetch });
  const tokens = await Promise.all([c.getAccessToken(), c.getAccessToken(), c.getAccessToken()]);
  assert.deepEqual(tokens, ["tok", "tok", "tok"]);
  assert.equal(s.calls.length, 1);
});

test("a failed token exchange surfaces the provider's error", async () => {
  const s = stub([["accounts.spotify.com/api/token", 401, { error: "invalid_client", error_description: "Invalid client" }]]);
  const c = createSpotifyClient({ ...creds, fetch: s.fetch });
  await assert.rejects(c.getArtist("a"), (e: unknown) => {
    assert.ok(e instanceof SpotifyApiError);
    assert.equal(e.status, 401);
    assert.match(e.message, /invalid_client: Invalid client/);
    return true;
  });
  assert.equal(await c.testConnection(), false);
});

test("a 200 without access_token is an error", async () => {
  const s = stub([["accounts.spotify.com/api/token", 200, { token_type: "Bearer" }]]);
  const c = createSpotifyClient({ ...creds, fetch: s.fetch });
  await assert.rejects(c.getAccessToken(), /did not return an access token/);
});

test("missing credentials fail before any request", async () => {
  const s = stub([TOKEN]);
  const c = createSpotifyClient({ clientId: "", clientSecret: " ", fetch: s.fetch });
  await assert.rejects(c.getAccessToken(), /client id and client secret are required/);
  assert.equal(s.calls.length, 0);
  assert.equal(await c.testConnection(), false);
});

test("testConnection is true when a token comes back", async () => {
  const c = createSpotifyClient({ ...creds, fetch: stub([TOKEN]).fetch });
  assert.equal(await c.testConnection(), true);
});

test("a token store is read first, written on refresh and cleared on 401", async () => {
  const saved: (SpotifyToken | null)[] = [];
  let current: SpotifyToken | null = { accessToken: "stored", expiresAt: Date.now() + 3600_000 };
  const store = {
    load: () => current,
    save: (t: SpotifyToken | null) => {
      saved.push(t);
      current = t;
    },
  };
  const s = stub([
    TOKEN,
    ["/v1/artists/", 401, { error: { status: 401, message: "The access token expired" } }],
    ["/v1/artists/", 200, { id: "a", name: "NHI" }],
  ]);
  const c = createSpotifyClient({ ...creds, fetch: s.fetch, tokenStore: store });
  const artist = await c.getArtist("a");
  assert.equal(artist.name, "NHI");
  assert.equal(s.calls[0]!.init!.headers!.Authorization, "Bearer stored");
  assert.ok(s.calls[1]!.url.includes("accounts.spotify.com"));
  assert.equal(s.calls[2]!.init!.headers!.Authorization, "Bearer tok");
  assert.equal(saved[0], null);
  assert.equal(saved[1]!.accessToken, "tok");
});

test("an expired or broken store entry is ignored", async () => {
  for (const load of [
    () => ({ accessToken: "old", expiresAt: Date.now() + 1000 }), // inside the margin
    () => ({ nope: true }) as unknown as SpotifyToken,
    () => {
      throw new Error("corrupt JSON");
    },
  ]) {
    const s = stub([TOKEN]);
    const c = createSpotifyClient({ ...creds, fetch: s.fetch, tokenStore: { load, save: () => {} } });
    assert.equal(await c.getAccessToken(), "tok");
  }
});

test("a second 401 in a row is thrown", async () => {
  const s = stub([TOKEN, ["/v1/artists/", 401, { error: { status: 401, message: "Invalid access token" } }]]);
  const c = createSpotifyClient({ ...creds, fetch: s.fetch });
  await assert.rejects(c.getArtist("a"), (e: unknown) => e instanceof SpotifyApiError && e.status === 401 && /Invalid access token/.test(e.message));
});

test("429 waits out Retry-After, then gives up after maxRateLimitRetries", async () => {
  const s = stub([
    TOKEN,
    ["/v1/artists/", 429, { error: { status: 429, message: "API rate limit exceeded" } }, { "Retry-After": "0" }],
    ["/v1/artists/", 200, { id: "a", name: "ok" }],
  ]);
  const c = createSpotifyClient({ ...creds, fetch: s.fetch });
  assert.equal((await c.getArtist("a")).name, "ok");

  const always = stub([TOKEN, ["/v1/artists/", 429, { error: { status: 429, message: "slow down" } }, { "Retry-After": "0" }]]);
  const c2 = createSpotifyClient({ ...creds, fetch: always.fetch, maxRateLimitRetries: 2 });
  await assert.rejects(c2.getArtist("a"), (e: unknown) => e instanceof SpotifyApiError && e.status === 429);
  assert.equal(always.calls.filter((x) => x.url.includes("/artists/")).length, 3);
});

test("stubs without headers or json() work (nhi-dashboard's test style)", async () => {
  const s = stub([TOKEN, ["api.spotify.com/v1/artists/", 200, { name: "NHI", followers: { total: 1234 }, popularity: 21 }]], { noHeaders: true });
  const c = createSpotifyClient({ ...creds, fetch: s.fetch });
  const a = await c.getArtist("4aAbCdEf12345");
  assert.equal(a.followers?.total, 1234);
  assert.match(s.calls[1]!.url, /artists\/4aAbCdEf12345$/);
});

test("Web API errors carry the message and status", async () => {
  const s = stub([TOKEN, ["/v1/artists/", 400, { error: { status: 400, message: "invalid id" } }]]);
  const c = createSpotifyClient({ ...creds, fetch: s.fetch });
  await assert.rejects(c.getArtist("bad"), (e: unknown) => e instanceof SpotifyApiError && e.status === 400 && /invalid id/.test(e.message));
});

test("a non-JSON error body is quoted", async () => {
  const s = stub([TOKEN, ["/v1/artists/", 502, "<html>Bad Gateway</html>"]]);
  const c = createSpotifyClient({ ...creds, fetch: s.fetch });
  await assert.rejects(c.getArtist("a"), /Bad Gateway/);
});

test("a hung request times out with status 0", async () => {
  const hang: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  const c = createSpotifyClient({ ...creds, fetch: hang, timeoutMs: 20 });
  await assert.rejects(c.getAccessToken(), (e: unknown) => e instanceof SpotifyApiError && e.status === 0 && /timed out after 20ms/.test(e.message));
});

test("network errors are wrapped", async () => {
  const c = createSpotifyClient({ ...creds, fetch: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(c.getAccessToken(), (e: unknown) => e instanceof SpotifyApiError && e.status === 0 && /fetch failed/.test(e.message));
});

test("search sends q/type/limit and flattens the results", async () => {
  const s = stub([
    TOKEN,
    [
      "/v1/search",
      200,
      {
        tracks: {
          items: [
            {
              id: "t1",
              name: "Song",
              artists: [{ name: "A" }, { name: "B" }],
              album: { name: "Record", images: [{ url: "img" }], release_date: "2019-05-01" },
              duration_ms: 1000,
              preview_url: null,
              external_urls: { spotify: "https://open.spotify.com/track/t1" },
              popularity: 7,
            },
            null,
          ],
        },
        artists: { items: [{ id: "a1", name: "A", genres: ["house"], popularity: 3, external_urls: { spotify: "u" }, images: [] }] },
      },
    ],
  ]);
  const c = createSpotifyClient({ ...creds, fetch: s.fetch });
  const r = await c.search("song a", { type: ["track", "artist"], limit: 5 });
  const url = new URL(s.calls[1]!.url);
  assert.equal(url.searchParams.get("q"), "song a");
  assert.equal(url.searchParams.get("type"), "track,artist");
  assert.equal(url.searchParams.get("limit"), "5");
  assert.deepEqual(r.tracks, [
    {
      id: "t1",
      name: "Song",
      artists: ["A", "B"],
      album: "Record",
      album_image_url: "img",
      release_year: "2019",
      duration_ms: 1000,
      preview_url: null,
      external_url: "https://open.spotify.com/track/t1",
      popularity: 7,
    },
  ]);
  assert.deepEqual(r.artists, [{ id: "a1", name: "A", genres: ["house"], popularity: 3, external_url: "u", image_url: null }]);
});

test("search with only artists returns an empty track list", async () => {
  const s = stub([TOKEN, ["/v1/search", 200, { artists: { items: [] } }]]);
  const r = await createSpotifyClient({ ...creds, fetch: s.fetch }).search("x", { type: ["artist"] });
  assert.deepEqual(r, { tracks: [], artists: [] });
  assert.equal(new URL(s.calls[1]!.url).searchParams.get("limit"), "20");
});

test("getAlbums batches by 20 and drops unknown IDs", async () => {
  const ids = Array.from({ length: 45 }, (_, i) => `id${i}`);
  const albums = (url: string) => {
    const batch = new URL(url).searchParams.get("ids")!.split(",");
    return batch.map((id) => (id === "id3" ? null : { id, name: `n-${id}`, artists: [{ id: "x", name: "X" }], images: [] }));
  };
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    if (url.includes("accounts.spotify.com")) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "t", expires_in: 3600 }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ albums: albums(url) }) };
  };
  const out = await createSpotifyClient({ ...creds, fetch }).getAlbums(ids);
  const albumCalls = calls.filter((u) => u.includes("/v1/albums"));
  assert.equal(albumCalls.length, 3);
  assert.match(albumCalls[0]!, /\/v1\/albums\?ids=id0,id1,/); // raw commas, as the API documents
  assert.equal(out.length, 44);
  assert.equal(out[0]!.name, "n-id0");
});

test("getAlbums with no ids makes no request", async () => {
  const s = stub([TOKEN]);
  assert.deepEqual(await createSpotifyClient({ ...creds, fetch: s.fetch }).getAlbums([]), []);
  assert.equal(s.calls.length, 0);
});

function track(i: number) {
  return { id: `t${i}`, name: `Track ${i}`, artists: [{ name: "A" }], album: { name: "Al", images: [], release_date: "2020" }, duration_ms: i, external_urls: { spotify: `u${i}` }, popularity: 1 };
}

test("getPlaylistTracks pages through every track and reports progress", async () => {
  const meta = { id: "PL", name: "List", description: null, external_urls: { spotify: "https://open.spotify.com/playlist/PL" }, images: [{ url: "cover" }], owner: { display_name: "ben" }, tracks: { total: 120 } };
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    if (url.includes("accounts.spotify.com")) return ok({ access_token: "t", expires_in: 3600 });
    const u = new URL(url);
    if (u.pathname.endsWith("/tracks")) {
      const offset = Number(u.searchParams.get("offset"));
      const n = Math.min(50, 120 - offset);
      const items = Array.from({ length: n }, (_, k) => (offset + k === 7 ? { track: null } : { track: track(offset + k) }));
      return ok({ items, total: 120 });
    }
    return ok(meta);
  };
  const progress: [number, number][] = [];
  const r = await createSpotifyClient({ ...creds, fetch, pageDelayMs: 0 }).getPlaylistTracks(
    "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc",
    (a, b) => progress.push([a, b]),
  );
  assert.deepEqual(r.playlist, {
    id: "PL",
    name: "List",
    description: "",
    trackCount: 120,
    imageUrl: "cover",
    externalUrl: "https://open.spotify.com/playlist/PL",
    owner: "ben",
  });
  assert.equal(r.tracks.length, 119);
  assert.equal(r.tracks[0]!.name, "Track 0");
  assert.deepEqual(progress, [[50, 120], [100, 120], [120, 120]]);
  assert.ok(calls[1]!.includes("/v1/playlists/37i9dQZF1DXcBWIGoYBM5M?fields="));
  const firstPage = new URL(calls[2]!);
  assert.equal(firstPage.searchParams.get("offset"), "0");
  assert.equal(firstPage.searchParams.get("limit"), "50");
});

test("getPlaylistTracks stops when a page comes back empty", async () => {
  const s = stub([
    TOKEN,
    ["/tracks?", 200, { items: [] }],
    ["/v1/playlists/", 200, { id: "P", name: "n", external_urls: {}, images: [], owner: {}, tracks: { total: 500 } }],
  ]);
  const r = await createSpotifyClient({ ...creds, fetch: s.fetch, pageDelayMs: 0 }).getPlaylistTracks("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M");
  assert.equal(r.tracks.length, 0);
  assert.equal(s.calls.length, 3);
});

test("getPlaylistTracks explains 404, 403 and a bad URL", async () => {
  const id = "37i9dQZF1DXcBWIGoYBM5M";
  const notFound = createSpotifyClient({ ...creds, fetch: stub([TOKEN, ["/v1/playlists/", 404, { error: { status: 404, message: "Not found." } }]]).fetch });
  await assert.rejects(notFound.getPlaylistTracks(id), (e: unknown) => e instanceof SpotifyApiError && e.status === 404 && /exists and is public/.test(e.message));
  const priv = createSpotifyClient({ ...creds, fetch: stub([TOKEN, ["/v1/playlists/", 403, { error: { status: 403, message: "Forbidden" } }]]).fetch });
  await assert.rejects(priv.getPlaylistTracks(id), /private/);
  const s = stub([TOKEN]);
  await assert.rejects(createSpotifyClient({ ...creds, fetch: s.fetch }).getPlaylistTracks("https://example.com/x"), /Invalid Spotify playlist URL/);
  assert.equal(s.calls.length, 0);
});

test("get accepts a full URL and drops empty query values", async () => {
  const s = stub([TOKEN, ["api.spotify.com/v1/me/x", 200, { ok: 1 }]]);
  const c = createSpotifyClient({ ...creds, fetch: s.fetch });
  assert.deepEqual(await c.get("https://api.spotify.com/v1/me/x", { a: undefined, b: null, c: 1 }), { ok: 1 });
  assert.equal(s.calls[1]!.url, "https://api.spotify.com/v1/me/x?c=1");
});

test("the default fetch is the global one, never called as a method of another object", async () => {
  const original = globalThis.fetch;
  let seenThis: unknown = "unset";
  globalThis.fetch = async function (this: unknown, input: unknown) {
    seenThis = this;
    assert.equal(String(input), "https://accounts.spotify.com/api/token");
    return new Response(JSON.stringify({ access_token: "g", expires_in: 3600 }), { status: 200 });
  } as typeof fetch;
  try {
    assert.equal(await createSpotifyClient(creds).getAccessToken(), "g");
    assert.notEqual(seenThis, "unset");
    assert.equal(typeof seenThis === "object" && seenThis !== null && seenThis !== globalThis, false);
  } finally {
    globalThis.fetch = original;
  }
});
