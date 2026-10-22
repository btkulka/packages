// Internal: where Windows' own tools live, and how to run them.
//
// netstat, taskkill and PowerShell are called by absolute path under
// %SystemRoot%\System32 so a stripped or hijacked PATH (an Electron app started
// from Explorer, a child given a minimal env) can't break or redirect them.

import { execFile, execFileSync } from "node:child_process";
import { join } from "node:path";

export const isWindows = (): boolean => process.platform === "win32";

/** C:\Windows\System32\<exe>, from %SystemRoot%. */
export function system32(exe: string): string {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return join(root, "System32", exe);
}

export const POWERSHELL = (): string => system32(join("WindowsPowerShell", "v1.0", "powershell.exe"));

export interface RunResult {
  ok: boolean;
  /** Exit code; null when the command couldn't start or was killed by the timeout. */
  code: number | null;
  stdout: string;
  /** The spawn error code (ENOENT…), when the command couldn't start. */
  error?: string;
}

/** Run a command and collect its output. Never throws. */
export function run(file: string, args: string[], timeoutMs = 10_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const code = !e ? 0 : typeof e.code === "number" ? e.code : null;
        resolve({ ok: !e, code, stdout: String(stdout ?? ""), error: e && typeof e.code === "string" ? e.code : undefined });
      },
    );
  });
}

/** Synchronous twin of `run`. Never throws. */
export function runSync(file: string, args: string[], timeoutMs = 10_000): RunResult {
  try {
    const stdout = execFileSync(file, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, code: 0, stdout };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number | null; stdout?: string | Buffer };
    return {
      ok: false,
      code: typeof e.status === "number" ? e.status : null,
      stdout: String(e.stdout ?? ""),
      error: typeof e.code === "string" ? e.code : undefined,
    };
  }
}
