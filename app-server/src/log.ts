import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Console output that is also appended to a log file, so a second `npm run dev` that finds the app already
// running can attach and tail what it is doing (running.ts). Under `node --test` nothing is written to the file.

export interface Logger {
  info: (...parts: unknown[]) => void;
  warn: (...parts: unknown[]) => void;
  error: (...parts: unknown[]) => void;
}

const text = (parts: unknown[]) => parts.map((p) => (typeof p === "string" ? p : p instanceof Error ? (p.stack ?? p.message) : JSON.stringify(p))).join(" ");

export function fileLog(path: string, options: { toFile?: boolean } = {}): Logger {
  const toFile = options.toFile ?? !process.env.NODE_TEST_CONTEXT;
  let ready = false;
  const write = (level: "info" | "warn" | "error", parts: unknown[]) => {
    const t = text(parts);
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(t);
    if (!toFile) return;
    try {
      if (!ready) {
        mkdirSync(dirname(path), { recursive: true });
        ready = true;
      }
      appendFileSync(path, `${new Date().toISOString()} ${level === "info" ? "" : `[${level}] `}${t}\n`);
    } catch {
      /* the log file is a convenience; never fail the app over it */
    }
  };
  return { info: (...p) => write("info", p), warn: (...p) => write("warn", p), error: (...p) => write("error", p) };
}
