// ffmpeg time strings: formatting seek arguments and reading the times ffmpeg prints.

/**
 * Seconds as ffmpeg's `HH:MM:SS.mmm`, for `-ss`, `-t` and `-to`.
 *
 * Rounds to whole milliseconds before splitting into fields, so 59.9996s becomes
 * `00:01:00.000` rather than `00:00:60.000`, which ffmpeg refuses to parse. A
 * malformed seek doesn't make ffmpeg fail; it seeks somewhere else, so the format
 * is exact. Negative input clamps to zero.
 */
export function formatFfmpegTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const ms = totalMs % 60_000;
  const secs = Math.floor(ms / 1000);
  const frac = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(frac).padStart(3, "0")}`;
}

/**
 * Parse `HH:MM:SS(.frac)`, `MM:SS(.frac)` or plain seconds into seconds. Returns
 * null for `N/A`, empty or malformed input. A leading minus is kept: ffmpeg prints
 * `time=-00:00:00.02` before the first frame, and callers skip negatives.
 */
export function parseFfmpegTime(text: string): number | null {
  const s = String(text ?? "").trim();
  const m = /^(-)?(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(s);
  if (!m) return null;
  const [, neg, a, b, c] = m;
  let h = 0;
  let min = 0;
  if (a !== undefined && b !== undefined) {
    h = Number(a);
    min = Number(b);
  } else if (a !== undefined) {
    min = Number(a);
  }
  const value = h * 3600 + min * 60 + Number(c);
  if (!Number.isFinite(value)) return null;
  return neg ? -value : value;
}

/**
 * The first `Duration: HH:MM:SS.xx` in ffmpeg's banner, in seconds. That is the
 * first input's duration; with several inputs, pass the real total yourself.
 * `Duration: N/A` (live or raw streams) gives null.
 */
export function parseFfmpegDuration(stderr: string): number | null {
  const m = /Duration:\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)/.exec(stderr ?? "");
  return m ? parseFfmpegTime(m[1]) : null;
}
