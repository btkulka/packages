import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createLogger, type Log } from "./log.js";
import { installParentWatchdog } from "./watchdog.js";

/** A low-level `Server` or an `McpServer`: anything that connects to a transport and closes. */
export interface Connectable {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

export interface StdioOptions {
  /**
   * Shut down when the parent goes away (stdin EOF, or the parent pid is gone).
   * Default true. Pass `{ intervalMs }` to change the poll, `false` for none.
   */
  watchdog?: boolean | { intervalMs?: number };
  /** Shut down on SIGINT and SIGTERM. Default true. */
  signals?: boolean;
  /** Clean-up to run before the server closes (close a database, a browser). Awaited, up to `shutdownTimeoutMs`. */
  onShutdown?: (reason: string) => void | Promise<void>;
  /** How long `onShutdown` plus `server.close()` may take before the process exits anyway. Default 5000 ms. */
  shutdownTimeoutMs?: number;
  /** `process.exit(0)` once shut down. Default true; `false` only resolves `closed` (the caller decides). */
  exit?: boolean;
  /** Where the shutdown line goes. Default: stderr with an `[mcp]` prefix. */
  log?: Log;
}

export interface StdioHandle {
  transport: StdioServerTransport;
  /** Resolves with the reason once shut down. */
  closed: Promise<string>;
  /** Shut down now: onShutdown, server.close(), then exit unless `exit: false`. Runs once. */
  shutdown(reason?: string): Promise<void>;
}

/**
 * Serve `server` over stdio: connect a StdioServerTransport, then shut down
 * cleanly when stdin ends, the parent dies, or SIGINT/SIGTERM arrives.
 * Rejects if the transport can't connect.
 */
export async function serveStdio(server: Connectable, opts: StdioOptions = {}): Promise<StdioHandle> {
  const log = opts.log ?? createLogger("mcp");
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let resolveClosed!: (reason: string) => void;
  const closed = new Promise<string>((r) => (resolveClosed = r));
  let running: Promise<void> | undefined;
  const cleanups: Array<() => void> = [];

  const shutdown = (reason = "shutdown") => {
    if (running) return running;
    running = (async () => {
      for (const c of cleanups) c();
      log(`${reason}; shutting down`);
      const work = (async () => {
        try {
          await opts.onShutdown?.(reason);
        } catch (e) {
          log("shutdown hook failed:", e);
        }
        await server.close().catch(() => undefined);
      })();
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<void>((r) => {
        timer = setTimeout(() => {
          log(`shutdown took over ${opts.shutdownTimeoutMs ?? 5000} ms; exiting anyway`);
          r();
        }, opts.shutdownTimeoutMs ?? 5000);
      });
      await Promise.race([work, limit]);
      clearTimeout(timer);
      resolveClosed(reason);
      if (opts.exit !== false) process.exit(0);
    })();
    return running;
  };

  if (opts.watchdog !== false) {
    const intervalMs = typeof opts.watchdog === "object" ? opts.watchdog.intervalMs : undefined;
    cleanups.push(installParentWatchdog({ intervalMs, onOrphan: (reason) => void shutdown(`parent gone (${reason})`) }));
  }
  if (opts.signals !== false) {
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      const on = () => void shutdown(sig);
      process.on(sig, on);
      cleanups.push(() => process.off(sig, on));
    }
  }
  return { transport, closed, shutdown };
}

/**
 * Run an async entry point; if it rejects, log `<label> failed to start:` with
 * the error and exit 1. Replaces the `main().catch(...)` each server had.
 */
export function runMain(main: () => Promise<unknown>, opts: { label?: string; log?: Log } = {}): void {
  const log = opts.log ?? ((...parts: unknown[]) => console.error(...parts));
  main().catch((e) => {
    log(`${opts.label ?? "MCP server"} failed to start:`, e);
    process.exit(1);
  });
}
