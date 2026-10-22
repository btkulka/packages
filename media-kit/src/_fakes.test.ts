// Test fakes, no tests here. A Node script plays ffmpeg / yt-dlp so the spawn
// wrapper is exercised for real without any media binary: the "binary" is
// process.execPath and the first argument is this script.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FAKE = String.raw`
const [mode, ...rest] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  switch (mode) {
    case "stdout":
      process.stdout.write(rest[0] ?? "");
      break;
    case "stderr":
      process.stderr.write(rest[0] ?? "");
      process.exitCode = Number(rest[1] ?? 0);
      break;
    case "both":
      process.stdout.write(rest[0] ?? "");
      process.stderr.write(rest[1] ?? "");
      process.exitCode = Number(rest[2] ?? 0);
      break;
    case "progress": {
      // Banner split across writes, then ffmpeg's \r-redrawn stats line.
      process.stderr.write("Input #0, wav, from 'in.wav':\n  Dura");
      await sleep(5);
      process.stderr.write("tion: 00:00:10.00, bitrate: 1411 kb/s\n");
      process.stderr.write("size=       0kB time=-00:00:00.02 bitrate=N/A\r");
      for (const t of ["00:00:01.00", "00:00:01.00", "00:00:02.50", "00:00:02.40", "00:00:05.00", "00:00:09.99"]) {
        const line = "size=     12kB time=" + t + " bitrate= 128.0kbits/s speed=10x\r";
        process.stderr.write(line.slice(0, 20));
        await sleep(2);
        process.stderr.write(line.slice(20));
      }
      process.exitCode = Number(rest[0] ?? 0);
      break;
    }
    case "progress-pipe": {
      process.stderr.write("Duration: 00:00:04.00, start: 0\n");
      await sleep(50);
      for (const us of [500000, 1000000, 2000000, 3999000]) {
        process.stdout.write("frame=1\nout_time_us=" + us + "\nout_time_ms=" + us + "\nprogress=continue\n");
        await sleep(2);
      }
      process.stdout.write("progress=end\n");
      break;
    }
    case "no-duration":
      for (const t of ["00:00:01.00", "00:00:03.00"]) process.stderr.write("time=" + t + "\r");
      break;
    case "sleep":
      await sleep(Number(rest[0] ?? 60000));
      break;
    case "stdin-count": {
      let n = 0;
      process.stdin.on("data", (c) => (n += c.length));
      process.stdin.on("end", () => process.stdout.write(String(n)));
      break;
    }
    case "big":
      process.stdout.write(Buffer.alloc(Number(rest[0])));
      break;
    case "lines":
      process.stdout.write("a\r\nb\n");
      process.stderr.write("c\rd");
      break;
    case "grandchild": {
      const { spawn } = require("child_process");
      const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
      process.stdout.write(String(c.pid) + "\n");
      await sleep(60000);
      break;
    }
    default:
      process.stderr.write("unknown mode " + mode);
      process.exitCode = 2;
  }
})();
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "media-kit-fake-"));
/** Path of the fake script. Run it as `runMedia(NODE, [FAKE_SCRIPT, mode, ...])`. */
export const FAKE_SCRIPT = path.join(dir, "fake.cjs");
fs.writeFileSync(FAKE_SCRIPT, FAKE);
export const NODE = process.execPath;

export function tempDir(prefix = "media-kit-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Create an empty "binary" a resolver will accept (executable bit on POSIX). */
export function touchExe(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  if (process.platform !== "win32") fs.chmodSync(file, 0o755);
  return file;
}

/** The platform file name for a tool: ffmpeg.exe on Windows, ffmpeg elsewhere. */
export function exeName(tool: string): string {
  return process.platform === "win32" ? `${tool}.exe` : tool;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
