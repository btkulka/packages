// Exit when the process that started this server is gone.
//
// A stdio MCP server is a child of its client (Electron, Claude Desktop, Claude
// Code). If the client dies without closing it, the SDK's StdioServerTransport
// keeps the child alive: it listens to stdin for data and errors but not for
// end/close, so EOF on the pipe goes unnoticed and the child lingers as an
// orphan holding database, LanceDB and network handles (orson found half a dozen
// after a crash). Two signals fire when the parent dies:
//   1. stdin reaches EOF (the OS closes the pipe from the dead parent);
//   2. the parent pid stops existing. On POSIX the child is re-parented, so
//      process.ppid changes (to 1 or a subreaper); on Windows ppid keeps the old
//      number, so the poll also asks whether that pid is still alive.

export interface WatchdogOptions {
  /** Called once, with the reason, when the parent is gone. Default: exit(0) after a stderr line. */
  onOrphan?: (reason: string) => void;
  /** How often to check the parent pid. Default 2000 ms. */
  intervalMs?: number;
  /** Treat stdin EOF/close as the parent going away. Default true. */
  stdin?: boolean;
  /** For tests: the stream to watch instead of process.stdin. */
  input?: NodeJS.EventEmitter;
  /** For tests: the current parent pid. Default: process.ppid. */
  ppid?: () => number;
  /** For tests: whether a pid is alive. Default: process.kill(pid, 0) (EPERM counts as alive). */
  alive?: (pid: number) => boolean;
}

/** Whether `pid` is a running process. EPERM means it exists but isn't ours to signal. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Watch for the parent going away and call `onOrphan` once when it does.
 * Install it after `server.connect(transport)`. Returns a function that stops watching.
 */
export function installParentWatchdog(opts: WatchdogOptions = {}): () => void {
  const getPpid = opts.ppid ?? (() => process.ppid);
  const alive = opts.alive ?? pidAlive;
  const initial = getPpid();
  const onOrphan =
    opts.onOrphan ??
    ((reason: string) => {
      try {
        process.stderr.write(`[parent-watchdog] parent gone (${reason}); exiting\n`);
      } catch {
        /* stderr may already be closed */
      }
      process.exit(0);
    });

  let done = false;
  const fire = (reason: string) => {
    if (done) return;
    stop();
    onOrphan(reason);
  };

  const input = opts.stdin === false ? undefined : (opts.input ?? process.stdin);
  const onEnd = () => fire("stdin EOF");
  const onClose = () => fire("stdin closed");
  input?.on("end", onEnd);
  input?.on("close", onClose);

  const timer = setInterval(() => {
    const ppid = getPpid();
    if (ppid !== initial) return fire(`ppid changed ${initial} -> ${ppid}`);
    if (!alive(ppid)) fire(`ppid ${ppid} no longer exists`);
  }, opts.intervalMs ?? 2000);
  timer.unref();

  function stop() {
    done = true;
    clearInterval(timer);
    input?.off("end", onEnd);
    input?.off("close", onClose);
  }
  return stop;
}
