import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSpotifyId } from "./index.js";
import { base64 } from "./http.js";

test("playlist links, URIs and bare IDs", () => {
  const id = "37i9dQZF1DXcBWIGoYBM5M";
  assert.equal(parseSpotifyId(`https://open.spotify.com/playlist/${id}`, "playlist"), id);
  assert.equal(parseSpotifyId(`https://open.spotify.com/playlist/${id}?si=abc123`, "playlist"), id);
  assert.equal(parseSpotifyId(`  https://open.spotify.com/intl-de/playlist/${id}  `, "playlist"), id);
  assert.equal(parseSpotifyId(`https://open.spotify.com/embed/playlist/${id}`, "playlist"), id);
  assert.equal(parseSpotifyId(`spotify:playlist:${id}`, "playlist"), id);
  assert.equal(parseSpotifyId(id, "playlist"), id);
});

test("rejects other kinds, short bare IDs and junk", () => {
  assert.equal(parseSpotifyId("https://open.spotify.com/album/37i9dQZF1DXcBWIGoYBM5M", "playlist"), null);
  assert.equal(parseSpotifyId("spotify:album:37i9dQZF1DXcBWIGoYBM5M", "playlist"), null);
  assert.equal(parseSpotifyId("raw123", "artist"), null);
  assert.equal(parseSpotifyId("nonsense", "artist"), null);
  assert.equal(parseSpotifyId("", "artist"), null);
  assert.equal(parseSpotifyId(undefined, "artist"), null);
});

test("artist links (nhi-dashboard's artist_url)", () => {
  assert.equal(parseSpotifyId("https://open.spotify.com/artist/4aAbCdEf12345?si=x", "artist"), "4aAbCdEf12345");
  assert.equal(parseSpotifyId("spotify:artist:4aAbCdEf12345", "artist"), "4aAbCdEf12345");
});

test("base64 matches Buffer for ASCII and UTF-8", () => {
  for (const s of ["", "a", "ab", "abc", "sid:ssecret", "0123456789abcdef:fedcba9876543210", "héllo:wörld✓"]) {
    assert.equal(base64(s), Buffer.from(s, "utf8").toString("base64"), s);
  }
});

test("the built entry is browser-safe: no node: imports, Buffer, process or require", () => {
  const dir = resolve("dist/esm");
  const files = readdirSync(dir).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));
  assert.ok(files.includes("index.js"));
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(src, /from\s+["']node:|\brequire\(|\bBuffer\b|\bprocess\./, f);
  }
});
