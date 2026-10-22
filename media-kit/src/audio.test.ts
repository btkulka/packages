import { test } from "node:test";
import assert from "node:assert/strict";
import { audioConvertArgs, pcmCodec } from "./audio.js";

test("pcmCodec: WAV little-endian, AIFF big-endian, depth rounded to 16/24/32", () => {
  assert.equal(pcmCodec("wav"), "pcm_s16le");
  assert.equal(pcmCodec("wav", 24), "pcm_s24le");
  assert.equal(pcmCodec("aiff", 16), "pcm_s16be");
  assert.equal(pcmCodec("aiff", 24), "pcm_s24be");
  assert.equal(pcmCodec("aiff", 32), "pcm_s32be");
});

test("mp3 defaults: 192k CBR, video (cover art) dropped, overwrite", () => {
  assert.deepEqual(audioConvertArgs("in.wav", "out.mp3"), ["-y", "-i", "in.wav", "-vn", "-codec:a", "libmp3lame", "-b:a", "192k", "out.mp3"]);
});

test("mp3 VBR, sample rate, channels and a filter chain", () => {
  assert.deepEqual(
    audioConvertArgs("raw.wav", "sfx.mp3", { vbrQuality: 3, sampleRate: 44100, channels: 1, filters: ["afade=t=in:st=0:d=0.003", "volume=2dB"] }),
    ["-y", "-i", "raw.wav", "-vn", "-af", "afade=t=in:st=0:d=0.003,volume=2dB", "-codec:a", "libmp3lame", "-q:a", "3", "-ar", "44100", "-ac", "1", "sfx.mp3"],
  );
});

test("wav and aiff by extension, with depth; .aif and .AIFF both count", () => {
  assert.deepEqual(audioConvertArgs("a.mp3", "a.wav", { sampleRate: 24000, channels: 1 }), ["-y", "-i", "a.mp3", "-vn", "-codec:a", "pcm_s16le", "-ar", "24000", "-ac", "1", "a.wav"]);
  assert.ok(audioConvertArgs("a.flac", "a.aif", { bitDepth: 24 }).includes("pcm_s24be"));
  assert.ok(audioConvertArgs("a.flac", "B.AIFF").includes("pcm_s16be"));
});

test("an unknown output extension needs an explicit format, which also sets the muxer", () => {
  assert.throws(() => audioConvertArgs("a.wav", "a.tmp"), /pass opts.format/);
  const args = audioConvertArgs("a.wav", "pipe:1", { format: "mp3", quiet: true });
  assert.deepEqual(args.slice(0, 3), ["-hide_banner", "-loglevel", "error"]);
  assert.deepEqual(args.slice(-3), ["-f", "mp3", "pipe:1"]);
});

test("metadata skips empty values; AIFF tags are written as ID3v2.3", () => {
  const aiff = audioConvertArgs("a.wav", "a.aiff", { bitDepth: 24, metadata: { title: "T", artist: "A & B", album: undefined, track: 3, genre: null } });
  assert.deepEqual(aiff.slice(aiff.indexOf("-metadata")), [
    "-metadata", "title=T",
    "-metadata", "artist=A & B",
    "-metadata", "track=3",
    "-write_id3v2", "1", "-id3v2_version", "3",
    "a.aiff",
  ]);
  assert.ok(!audioConvertArgs("a.wav", "a.aiff").includes("-write_id3v2"));
  assert.ok(!audioConvertArgs("a.wav", "a.mp3", { metadata: { title: "T" } }).includes("-write_id3v2"));
});

test("dropVideo: false keeps cover art; extraArgs sit just before the output", () => {
  const args = audioConvertArgs("a.flac", "a.mp3", { dropVideo: false, bitrateKbps: 320, extraArgs: ["-map_metadata", "0"] });
  assert.ok(!args.includes("-vn"));
  assert.deepEqual(args.slice(-4), ["320k", "-map_metadata", "0", "a.mp3"]);
});
