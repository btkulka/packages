import { test } from "node:test";
import assert from "node:assert/strict";
import { compact } from "./items.js";
import { createSpotifyClient, parseSpotifyLink, toItem, type FetchLike } from "./index.js";

const TOKEN_BODY = { access_token: "tok", token_type: "Bearer", expires_in: 3600 };

/** Token first, then the given answers by URL substring. */
function stub(routes: [match: string, status: number, body: unknown][]) {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const hit = url.includes("accounts.spotify.com") ? ([url, 200, TOKEN_BODY] as const) : routes.find(([m]) => url.includes(m));
    const [, status, body] = hit ?? [url, 404, { error: { status: 404, message: "Non existing id" } }];
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  return { fetch, urls };
}

const images = [
  { url: "big", width: 640, height: 640 },
  { url: "mid", width: 300, height: 300 },
  { url: "tiny", width: 64, height: 64 },
];

test("toItem: a track has its artists, album, length and the album's cover", () => {
  const item = toItem("track", {
    id: "t1",
    uri: "spotify:track:t1",
    name: "Get Lucky",
    artists: [{ name: "Daft Punk" }, { name: "Pharrell Williams" }],
    album: { name: "Random Access Memories", images, release_date: "2013-05-20" },
    duration_ms: 248_413,
    explicit: false,
    external_urls: { spotify: "https://open.spotify.com/track/t1" },
  });
  assert.equal(item.subtitle, "Daft Punk, Pharrell Williams · Random Access Memories");
  assert.equal(item.meta, "4:08");
  assert.equal(item.imageUrl, "tiny");
  assert.equal(item.coverUrl, "big");
  assert.equal(item.url, "https://open.spotify.com/track/t1");
  assert.equal(item.releaseDate, "2013-05-20");
});

test("toItem: albums say Single or Compilation and the year; a plain album only the year", () => {
  const album = toItem("album", { id: "a", name: "RAM", album_type: "album", artists: [{ name: "Daft Punk" }], release_date: "2013-05-20", total_tracks: 13, images });
  assert.equal(album.subtitle, "Daft Punk");
  assert.equal(album.meta, "2013");
  assert.equal(album.trackCount, 13);
  assert.equal(toItem("album", { id: "s", name: "x", album_type: "single", artists: [], release_date: "2024" }).meta, "Single · 2024");
});

test("toItem: artists, playlists, podcasts and episodes", () => {
  assert.equal(toItem("artist", { id: "a", name: "Daft Punk", followers: { total: 11_962_786 }, genres: ["french house"] }).subtitle, "12M followers");
  assert.equal(toItem("artist", { id: "a", name: "x", genres: ["french house", "electro", "disco"] }).subtitle, "French house, electro");

  const playlist = toItem("playlist", { id: "p", name: "Hits", owner: { display_name: "Red Franzen" }, tracks: { total: 50 }, images: [{ url: "mosaic", width: null }] });
  assert.equal(playlist.subtitle, "By Red Franzen");
  assert.equal(playlist.meta, "50 tracks");
  assert.equal(playlist.imageUrl, "mosaic");
  assert.equal(toItem("playlist", { id: "p", name: "x", items: { total: 1 } }).meta, "1 track", "reads the renamed items.total too");

  const show = toItem("show", { id: "s", name: "Pod", publisher: "Gabo Jolly", total_episodes: 2 });
  assert.equal(show.subtitle, "Gabo Jolly");
  assert.equal(show.meta, "2 episodes");

  const episode = toItem("episode", { id: "e", name: "E1", release_date: "2026-03-17", duration_ms: 2_061_909 });
  assert.equal(episode.subtitle, "17 Mar 2026");
  assert.equal(episode.meta, "34 min");
  assert.equal(episode.uri, "spotify:episode:e");
  assert.equal(episode.url, "https://open.spotify.com/episode/e");
});

test("compact numbers", () => {
  assert.equal(compact(950), "950");
  assert.equal(compact(1530), "1.5K");
  assert.equal(compact(48_210), "48K");
  assert.equal(compact(11_962_786), "12M");
  assert.equal(compact(2_400_000_000), "2.4B");
});

test("parseSpotifyLink tells the kind from a link or URI, and not from a bare ID", () => {
  assert.deepEqual(parseSpotifyLink("https://open.spotify.com/intl-de/album/4m2880jivSbbyEGAKfITCa?si=x"), { type: "album", id: "4m2880jivSbbyEGAKfITCa" });
  assert.deepEqual(parseSpotifyLink("https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M"), { type: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
  assert.deepEqual(parseSpotifyLink("spotify:show:7BJuiIp6JWJa8HBVIZCGua"), { type: "show", id: "7BJuiIp6JWJa8HBVIZCGua" });
  assert.equal(parseSpotifyLink("4m2880jivSbbyEGAKfITCa"), null);
  assert.equal(parseSpotifyLink("https://open.spotify.com/user/brunejos"), null);
  assert.equal(parseSpotifyLink("daft punk"), null);
});

test("searchItems asks for the kinds given, flattens each page and drops Spotify's null padding", async () => {
  const s = stub([
    [
      "/v1/search",
      200,
      {
        playlists: { items: [null, { id: "p1", name: "Hits", owner: { display_name: "R" }, tracks: { total: 5 } }], total: 197, next: "https://api.spotify.com/v1/search?offset=2" },
        albums: { items: [{ id: "a1", name: "RAM", album_type: "album", artists: [{ name: "Daft Punk" }] }], total: 1, next: null },
      },
    ],
  ]);
  const c = createSpotifyClient({ clientId: "id", clientSecret: "secret", fetch: s.fetch });
  const r = await c.searchItems("  daft punk ", { types: ["playlist", "album"], limit: 2, offset: 0, market: "US" });
  const url = new URL(s.urls.find((u) => u.includes("/search"))!);
  assert.equal(url.searchParams.get("q"), "daft punk");
  assert.equal(url.searchParams.get("type"), "playlist,album");
  assert.equal(url.searchParams.get("limit"), "2");
  assert.equal(url.searchParams.get("market"), "US");
  assert.deepEqual(r.playlist!.items.map((i) => i.id), ["p1"]);
  assert.equal(r.playlist!.total, 197);
  assert.equal(r.playlist!.hasMore, true);
  assert.equal(r.album!.hasMore, false);
  assert.equal(r.album!.items[0]!.type, "album");
  assert.equal(r.track, undefined);
});

test("searchItems: a blank query makes no request; limits are clamped", async () => {
  const s = stub([["/v1/search", 200, {}]]);
  const c = createSpotifyClient({ clientId: "id", clientSecret: "secret", fetch: s.fetch });
  assert.deepEqual(await c.searchItems("   "), {});
  assert.equal(s.urls.length, 0);
  await c.searchItems("x", { limit: 500, offset: -3 });
  const url = new URL(s.urls.find((u) => u.includes("/search"))!);
  assert.equal(url.searchParams.get("limit"), "50");
  assert.equal(url.searchParams.get("offset"), "0");
  assert.equal(url.searchParams.get("type"), "track,album,artist,playlist,show,episode");
});

test("getItem fetches one by ID, asks a playlist for only what an item shows, and gives null for an unknown ID", async () => {
  const s = stub([
    ["/v1/playlists/p1", 200, { id: "p1", name: "Hits", owner: { display_name: "R" }, tracks: { total: 5 } }],
    ["/v1/albums/a1", 200, { id: "a1", name: "RAM", album_type: "album", artists: [] }],
  ]);
  const c = createSpotifyClient({ clientId: "id", clientSecret: "secret", fetch: s.fetch });
  const p = await c.getItem("playlist", "p1");
  assert.equal(p?.name, "Hits");
  assert.match(s.urls.find((u) => u.includes("/playlists/"))!, /fields=/);
  assert.equal((await c.getItem("album", "a1"))?.type, "album");
  assert.equal(await c.getItem("track", "nope"), null);
  assert.equal(await c.getItem("track", "bad/id"), null);
});
