import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { Library } from "./library.js";
import type { WatchInfo } from "./types.js";

// fs.watch on each enabled watched folder (recursive on Windows and macOS). Changes are debounced per path,
// then handed to the library, which files new images into the watch's collection and reads sidecars. A
// folder that doesn't exist yet is tried again whenever the watch list is synced (call sync() on a timer
// and after the watch list changes).

export function createWatchers(lib: Library, onChange: () => void, log: (...a: unknown[]) => void) {
  const live = new Map<number, { folder: string; recursive: boolean; w: FSWatcher }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const rescans = new Map<number, ReturnType<typeof setTimeout>>();

  function rescan(id: number) {
    clearTimeout(rescans.get(id));
    rescans.set(
      id,
      setTimeout(() => {
        rescans.delete(id);
        void lib
          .scanWatch(id)
          .then((r) => (r.added || r.updated || r.missing) && onChange())
          .catch((e) => log("rescan failed", e));
      }, 800),
    );
  }

  function changed(watchId: number, full: string) {
    clearTimeout(timers.get(full));
    timers.set(
      full,
      setTimeout(() => {
        timers.delete(full);
        let dir = false;
        try {
          dir = statSync(full).isDirectory();
        } catch {}
        // A folder moved or copied in brings no event per file: read the whole watch again.
        if (dir) return rescan(watchId);
        void lib
          .onDiskChange(full)
          .then((c) => c && onChange())
          .catch((e) => log("watch change failed", full, e));
      }, 450),
    );
  }

  function start(w: WatchInfo) {
    try {
      const fw = watch(w.folder, { recursive: w.recursive }, (_event, name) => name && changed(w.id, join(w.folder, String(name))));
      fw.on("error", (e) => {
        log("watcher error", w.folder, e);
        fw.close();
        live.delete(w.id);
      });
      live.set(w.id, { folder: w.folder, recursive: w.recursive, w: fw });
    } catch (e) {
      log("couldn't watch", w.folder, e);
    }
  }

  return {
    /** Starts, restarts and stops watchers to match the library's watch list. Returns watches that just started (to scan). */
    sync(): WatchInfo[] {
      const want = lib.listWatches().filter((w) => w.enabled);
      for (const [id, l] of live) {
        const w = want.find((x) => x.id === id);
        if (!w || w.folder !== l.folder || w.recursive !== l.recursive || !existsSync(w.folder)) {
          l.w.close();
          live.delete(id);
        }
      }
      const started: WatchInfo[] = [];
      for (const w of want) {
        if (live.has(w.id) || !existsSync(w.folder)) continue;
        start(w);
        if (live.has(w.id)) started.push(w);
      }
      return started;
    },
    close() {
      for (const l of live.values()) l.w.close();
      live.clear();
      timers.forEach(clearTimeout);
      rescans.forEach(clearTimeout);
    },
  };
}
