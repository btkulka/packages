import type { AppEmitterLike } from "./types.js";

export type CrashKind = "uncaughtException" | "unhandledRejection" | "render-process-gone";

/** What a renderer's death is reported as. */
export interface RendererGone {
  reason: string;
  exitCode: number;
  url?: string;
}

export interface CrashLogOptions {
  /**
   * Pass Electron's app to also report renderers that die (crashed, killed,
   * out of memory, failed to launch). Clean exits aren't reported.
   */
  app?: AppEmitterLike;
}

/**
 * Report errors nothing caught, instead of Electron's crash dialog: uncaught
 * exceptions and unhandled rejections in main, and (with opts.app) dead
 * renderers. The app keeps running, as it did in every copy this replaces.
 * Returns a function that removes the listeners.
 *
 *   logCrashes((kind, err) => log.error(kind, err), { app });
 */
export function logCrashes(log: (kind: CrashKind, error: unknown) => void, opts: CrashLogOptions = {}): () => void {
  const report = (kind: CrashKind, error: unknown) => {
    try {
      log(kind, error);
    } catch (e) {
      // A logger that throws must not turn one crash into a loop of them.
      console.error(`[electron-kit] crash logger failed on ${kind}:`, e, error);
    }
  };
  const onException = (error: unknown) => report("uncaughtException", error);
  const onRejection = (reason: unknown) => report("unhandledRejection", reason);
  const onGone = (_event: unknown, contents: { getURL?: () => string } | undefined, details: { reason: string; exitCode: number }) => {
    if (!details || details.reason === "clean-exit") return;
    let url: string | undefined;
    try {
      url = contents?.getURL?.();
    } catch {
      url = undefined;
    }
    const gone: RendererGone = { reason: details.reason, exitCode: details.exitCode };
    if (url) gone.url = url;
    report("render-process-gone", gone);
  };
  // Plain EventEmitter view: Electron's d.ts adds `process` overloads that
  // hide Node's for these events in some Electron/@types/node pairings.
  const proc: NodeJS.EventEmitter = process;
  proc.on("uncaughtException", onException);
  proc.on("unhandledRejection", onRejection);
  opts.app?.on("render-process-gone", onGone);
  return () => {
    proc.removeListener("uncaughtException", onException);
    proc.removeListener("unhandledRejection", onRejection);
    opts.app?.removeListener?.("render-process-gone", onGone);
  };
}
