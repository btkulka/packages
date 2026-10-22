import { format } from "node:util";

// stdout carries the protocol on a stdio server, so logs go to stderr.

/** A stderr logger. Arguments are formatted like console.error (an Error prints its stack). */
export type Log = (...parts: unknown[]) => void;

export interface LoggerOptions {
  /** Add the time of day, HH:mm:ss.SSS (UTC), after the prefix: `[upscale 12:34:56.789] …`. */
  time?: boolean;
  /** Where lines go. Default: process.stderr. */
  stream?: { write(chunk: string): unknown };
}

/** `createLogger("benhaus")("ready")` writes `[benhaus] ready\n` to stderr. */
export function createLogger(prefix: string, opts: LoggerOptions = {}): Log {
  const stream = opts.stream ?? process.stderr;
  return (...parts: unknown[]) => {
    const tag = opts.time ? `${prefix} ${new Date().toISOString().slice(11, 23)}` : prefix;
    try {
      stream.write(`[${tag}] ${format(...parts)}\n`);
    } catch {
      /* stderr can be closed when the parent is gone */
    }
  };
}
