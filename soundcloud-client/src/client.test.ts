import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSoundCloudClient, SoundCloudApiError, type FetchLike, type FetchLikeInit } from "./index.js";
import { base64 } from "./http.js";

type Route = [match: string, status: number, body: unknown, headers?: Record<string, string>];

/** Answers by URL substring. Routes sharing a match string are used in order; the last one sticks. */
function stub(routes: Route[], opts: { noHeaders?: boolean } = {}) {
  const calls: { url: string; init?: FetchLikeInit }[] = [];
  const queue = [...routes];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const i = queue.findIndex(([m]) => url.includes(m));
    if (i === -1) return { ok: false, status: 404, statusText: "no stub", text: async () => JSON.stringify({ message: `no stub for ${url}` }) };
    const [m, status, body, headers] = queue[i]!;
    if (queue.findIndex(([n], j) => j > i && n === m) !== -1) queue.splice(i, 1);
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

const TOKEN: Route = ["secure.soundcloud.com/oauth/token", 200, { access_token: "sctok", expires_in: 3600, refresh_token: "r" }];
const creds = { clientId: "cid", clientSecret: "csecret" };

test("token: documented endpoint, Basic auth, client-credentials grant, cached", async () => {
  const s = stub([TOKEN, ["api.soundcloud.com/users/90210", 200, { id: 90210, username: "nhi", followers_count: 567 }]]);
  const c = createSoundCloudClient({ ...creds, fetch: s.fetch });
  assert.equal(c.hasCredentials, true);
  await c.getUser(90210);
  await c.getUser("90210");
  const tokenCalls = s.calls.filter((x) => x.url === "https://secure.soundcloud.com/oauth/token");
  assert.equal(tokenCalls.length, 1);
  const init = tokenCalls[0]!.init!;
  assert.equal(init.method, "POST");
  assert.equal(init.headers!.Authorization, `Basic ${Buffer.from("cid:csecret").toString("base64")}`);
  assert.equal(init.body, "grant_type=client_credentials");
  assert.equal(s.calls[1]!.init!.headers!.Authorization, "OAuth sctok");
});

test("getUser and resolve hit the endpoints nhi-dashboard uses (stubs without headers)", async () => {
  const s = stub(
    [
      TOKEN,
      ["api.soundcloud.com/users/90210", 200, { id: 1, username: "nhi", followers_count: 567, permalink_url: "https://soundcloud.com/nhi" }],
      ["api.soundcloud.com/resolve", 200, { id: 2, username: "nhi", followers_count: 42 }],
    ],
    { noHeaders: true },
  );
  const c = createSoundCloudClient({ ...creds, fetch: s.fetch });
  assert.equal((await c.getUser("90210")).followers_count, 567);
  const r = await c.resolve("https://soundcloud.com/nhi");
  assert.equal(r.followers_count, 42);
  assert.equal(s.calls[2]!.url, "https://api.soundcloud.com/resolve?url=https%3A%2F%2Fsoundcloud.com%2Fnhi");
});

test("token failures surface the provider message, and testConnection turns them into false", async () => {
  const s = stub([["secure.soundcloud.com/oauth/token", 500, { error: "server_error" }]]);
  const c = createSoundCloudClient({ ...creds, fetch: s.fetch });
  await assert.rejects(c.getUser(1), (e: unknown) => e instanceof SoundCloudApiError && e.status === 500 && /server_error/.test(e.message));
  assert.equal(await c.testConnection(), false);
  // 500 is not retried
  assert.equal(s.calls.length, 2);
});

test("OAuth error_description is included", async () => {
  const s = stub([["oauth/token", 401, { error: "invalid_client", error_description: "Client authentication failed" }]]);
  await assert.rejects(createSoundCloudClient({ ...creds, fetch: s.fetch }).getAccessToken(), /invalid_client: Client authentication failed/);
});

test("a 200 without access_token is an error", async () => {
  const s = stub([["oauth/token", 200, {}]]);
  await assert.rejects(createSoundCloudClient({ ...creds, fetch: s.fetch }).getAccessToken(), /did not return an access token/);
});

test("without credentials, OAuth calls fail before any request", async () => {
  const s = stub([TOKEN]);
  const c = createSoundCloudClient({ fetch: s.fetch });
  assert.equal(c.hasCredentials, false);
  await assert.rejects(c.search("x"), /client id and client secret are required/);
  assert.equal(await c.testConnection(), false);
  assert.equal(s.calls.length, 0);
});

test("testConnection is true when a token comes back", async () => {
  assert.equal(await createSoundCloudClient({ ...creds, fetch: stub([TOKEN]).fetch }).testConnection(), true);
});

test("a token within the refresh margin is replaced; concurrent callers share one request", async () => {
  const s = stub([["oauth/token", 200, { access_token: "short", expires_in: 30 }]]);
  const c = createSoundCloudClient({ ...creds, fetch: s.fetch });
  await Promise.all([c.getAccessToken(), c.getAccessToken()]);
  assert.equal(s.calls.length, 1);
  await c.getAccessToken();
  assert.equal(s.calls.length, 2);
});

test("a 401 refreshes the token once, a second 401 is thrown", async () => {
  const s = stub([
    TOKEN,
    ["/users/1", 401, { code: 401, message: "invalid_token", errors: [], status: "401 - Unauthorized" }],
    ["/users/1", 200, { id: 1, username: "ok" }],
  ]);
  const c = createSoundCloudClient({ ...creds, fetch: s.fetch });
  assert.equal((await c.getUser(1)).username, "ok");
  assert.equal(s.calls.filter((x) => x.url.includes("oauth/token")).length, 2);

  const always = stub([TOKEN, ["/users/1", 401, { code: 401, errors: [{ error_message: "nope" }] }]]);
  await assert.rejects(createSoundCloudClient({ ...creds, fetch: always.fetch }).getUser(1), (e: unknown) => e instanceof SoundCloudApiError && e.status === 401 && /nope/.test(e.message));
});

test("429 waits out Retry-After then gives up after maxRateLimitRetries", async () => {
  const s = stub([TOKEN, ["/users/1", 429, { message: "rate" }, { "retry-after": "0" }], ["/users/1", 200, { id: 1, username: "ok" }]]);
  assert.equal((await createSoundCloudClient({ ...creds, fetch: s.fetch }).getUser(1)).username, "ok");
  const always = stub([TOKEN, ["/users/1", 429, { message: "rate" }, { "retry-after": "0" }]]);
  await assert.rejects(createSoundCloudClient({ ...creds, fetch: always.fetch, maxRateLimitRetries: 1 }).getUser(1), (e: unknown) => e instanceof SoundCloudApiError && e.status === 429);
  assert.equal(always.calls.filter((x) => x.url.includes("/users/1")).length, 2);
});

test("search queries tracks and users in parallel and flattens them", async () => {
  const s = stub([
    TOKEN,
    ["api.soundcloud.com/tracks?", 200, [{ id: 5, title: "T", user: { username: "u" }, duration: 1234, permalink_url: "p", artwork_url: null, genre: "House", playback_count: 9 }]],
    ["api.soundcloud.com/users?", 200, { collection: [{ id: 6, username: "u", permalink_url: "pu", avatar_url: "a", track_count: 3, followers_count: 4 }] }],
  ]);
  const r = await createSoundCloudClient({ ...creds, fetch: s.fetch }).search("q x", { limit: 7 });
  assert.deepEqual(r.tracks, [{ id: 5, title: "T", user: "u", duration_ms: 1234, permalink_url: "p", artwork_url: null, genre: "House", playback_count: 9 }]);
  assert.deepEqual(r.users, [{ id: 6, username: "u", permalink_url: "pu", avatar_url: "a", track_count: 3, followers_count: 4 }]);
  const t = new URL(s.calls.find((x) => x.url.includes("/tracks?"))!.url);
  assert.equal(t.searchParams.get("q"), "q x");
  assert.equal(t.searchParams.get("limit"), "7");
});

test("search can be limited to tracks", async () => {
  const s = stub([TOKEN, ["/tracks?", 200, []]]);
  const r = await createSoundCloudClient({ ...creds, fetch: s.fetch }).search("q", { type: ["track"], limit: 10 });
  assert.deepEqual(r, { tracks: [], users: [] });
  assert.equal(s.calls.some((x) => x.url.includes("/users?")), false);
});

test("ping is true for any HTTP status and false on network errors", async () => {
  const calls: { url: string; init?: FetchLikeInit }[] = [];
  const up = createSoundCloudClient({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: false, status: 404, text: async () => { throw new Error("body is not read"); } };
    },
  });
  assert.equal(await up.ping(), true);
  assert.equal(calls[0]!.url, "https://api.soundcloud.com/");
  assert.equal(calls[0]!.init!.method, "HEAD");
  const down = createSoundCloudClient({ fetch: async () => { throw new TypeError("getaddrinfo ENOTFOUND"); } });
  assert.equal(await down.ping(), false);
});

const HOME = `<html><script crossorigin src="https://a-v2.sndcdn.com/assets/0-aaaa.js"></script>
<script crossorigin src="https://a-v2.sndcdn.com/assets/49-bbbb.js"></script></html>`;

test("the public client_id is scraped from the last asset script that has one, and cached", async () => {
  const s = stub([
    ["https://soundcloud.com/", 200, HOME],
    ["assets/49-bbbb.js", 200, 'x={a:1};y={client_id:"ABCDEFGHIJKLMNOPQRSTUVWXyz012345",env:"prod"}'],
    ["assets/0-aaaa.js", 200, "nothing here"],
    ["api-v2.soundcloud.com/search/tracks", 200, { collection: [{ id: 1, title: "T", user: { username: "u" }, duration: 10, permalink_url: "p" }] }],
  ]);
  const c = createSoundCloudClient({ fetch: s.fetch });
  const r = await c.searchPublicTracks("song", 5);
  assert.deepEqual(r, { tracks: [{ id: 1, title: "T", user: "u", duration_ms: 10, permalink_url: "p", artwork_url: null, genre: null, playback_count: 0 }], users: [] });
  const search = new URL(s.calls.at(-1)!.url);
  assert.equal(search.searchParams.get("client_id"), "ABCDEFGHIJKLMNOPQRSTUVWXyz012345");
  assert.equal(search.searchParams.get("q"), "song");
  assert.equal(search.searchParams.get("limit"), "5");
  assert.match(s.calls[0]!.init!.headers!["User-Agent"]!, /Mozilla/);
  // the newest script is tried first and has the id, so the older one is never fetched
  assert.equal(s.calls.some((x) => x.url.includes("0-aaaa.js")), false);
  await c.searchPublicTracks("again");
  assert.equal(s.calls.filter((x) => x.url === "https://soundcloud.com/").length, 1);
});

test("the client_id=… form is found too, and a missing one is an error", async () => {
  const s = stub([["https://soundcloud.com/", 200, HOME], ["49-bbbb.js", 200, "?client_id=zyxwvutsrqponmlkjihgfedcba&x"]]);
  assert.equal(await createSoundCloudClient({ fetch: s.fetch }).getPublicClientId(), "zyxwvutsrqponmlkjihgfedcba");
  const none = stub([["https://soundcloud.com/", 200, HOME], ["sndcdn.com", 200, "no id"]]);
  await assert.rejects(createSoundCloudClient({ fetch: none.fetch }).getPublicClientId(), /Could not extract SoundCloud public client_id/);
});

test("a rejected public client_id is re-scraped once", async () => {
  const s = stub([
    ["https://soundcloud.com/", 200, HOME],
    ["49-bbbb.js", 200, 'client_id:"OLDOLDOLDOLDOLDOLDOLDOLD"'],
    ["49-bbbb.js", 200, 'client_id:"NEWNEWNEWNEWNEWNEWNEWNEW"'],
    ["search/tracks", 401, { error: "unauthorized" }],
    ["search/tracks", 200, { collection: [] }],
  ]);
  const r = await createSoundCloudClient({ fetch: s.fetch }).searchPublicTracks("x");
  assert.deepEqual(r.tracks, []);
  const searches = s.calls.filter((x) => x.url.includes("search/tracks")).map((x) => new URL(x.url).searchParams.get("client_id"));
  assert.deepEqual(searches, ["OLDOLDOLDOLDOLDOLDOLDOLD", "NEWNEWNEWNEWNEWNEWNEWNEW"]);
});

test("a hung request times out with status 0", async () => {
  const hang: FetchLike = (_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  await assert.rejects(
    createSoundCloudClient({ ...creds, fetch: hang, timeoutMs: 20 }).getAccessToken(),
    (e: unknown) => e instanceof SoundCloudApiError && e.status === 0 && /timed out after 20ms/.test(e.message),
  );
});

test("base64 matches Buffer", () => {
  for (const s of ["", "a", "ab", "abc", "cid:csecret", "ünïcode:✓"]) assert.equal(base64(s), Buffer.from(s).toString("base64"));
});

test("the built entry has no node: imports, Buffer, process or require", () => {
  const dir = resolve("dist/esm");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))) {
    const src = readFileSync(join(dir, f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(src, /from\s+["']node:|\brequire\(|\bBuffer\b|\bprocess\./, f);
  }
});
