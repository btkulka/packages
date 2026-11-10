import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase, type SqliteDriver, type SqliteHandle } from "@btkulka/sqlite-store";
import { dumpDatabase, type Dump } from "./dump.js";
import { backupDatabase, conflictCopies, peekManifest, readSnapshot, restoreSnapshot, snapshotName, writeSnapshot, type Manifest } from "./snapshot.js";
import { defaultSyncDir, tailnetFor } from "./tailnets.js";
import { recordHistory, type HistoryEntry, type HistoryEvent } from "./history.js";
import { decideVerdict, type Agreement, type Verdict } from "./verdict.js";

/**
 * The default Syncthing folder: BENHAUS_SYNC_DIR, else ~/.benhaus-sync. An app on another tailnet uses that
 * tailnet's folder instead (tailnets.ts); each app keeps its snapshot in a folder of its own there.
 */
export const syncDir = defaultSyncDir;

export interface DataSyncOptions<D extends SqliteHandle> {
  /** The app's id, and its folder in the sync folder: "habit-tracker". */
  app: string;
  dbPath: string;
  /** The driver the app opens its database with: better-sqlite3's Database or node:sqlite's DatabaseSync. */
  driver: SqliteDriver<D>;
  /** The sync folder. Default: the app's tailnet's (tailnetFor(app).syncDir). */
  dir?: string;
  /** This machine's name in manifests and messages. Default the host name. */
  machine?: string;
  /**
   * The newest user_version this app's code knows. A snapshot from newer code is never pulled (this
   * machine's app is behind: update it first). Default: no limit.
   */
  schemaVersion?: number;
  /** Tables whose rows stay on each machine: never pushed, and kept through a pull. */
  exclude?: readonly string[];
  /** Where backups go. Default `backups/` beside the database. */
  backupDir?: string;
  /** This machine's sync state. Default `<dbPath>.sync.json`. */
  stateFile?: string;
  /** Each thing it does, as a line. Default console.log with a [data-sync] prefix. */
  log?: (line: string) => void;
  /** Something needs Ben: both machines changed, or newer data arrived while this one was serving. */
  notify?: (message: string, status: SyncStatus) => void;
}

/** Held when both machines changed: nothing is pushed or pulled for this app until Ben picks a side. */
export interface Conflict {
  since: string;
  reason: string;
  /** The other machine's snapshot when it was found. */
  remote: Manifest | null;
  /** This machine's copy as it was then. */
  backup: string | null;
}

interface State {
  agreed: Agreement;
  at: string | null;
  conflict: Conflict | null;
  /** "remote": Ben chose the other machine's data; the next prepare() restores it. */
  pending: "remote" | null;
}

export interface LocalInfo {
  sha: string;
  total: number;
  rows: Record<string, number>;
  schemaVersion: number;
}

export interface SyncStatus {
  app: string;
  machine: string;
  verdict: Verdict;
  /** The snapshot file in the sync folder. */
  file: string;
  local: LocalInfo | null;
  remote: Manifest | null;
  agreed: Agreement & { at: string | null };
  conflict: Conflict | null;
  /** Syncthing's conflict copies of the snapshot: two machines pushed at once. */
  conflictCopies: string[];
  pending: "remote" | null;
}

export type PrepareAction = "pulled" | "pushed" | "held" | "none" | "behind";
export type PushAction = "pushed" | "up-to-date" | "held" | "remote-ahead";

export interface DataSync<D extends SqliteHandle> {
  readonly app: string;
  readonly file: string;
  /** Where things stand. With the app's open handle, or none (it opens the file read-only). */
  status(db?: D): SyncStatus;
  /**
   * Before the app opens its database: restore the other machine's newer data, push this machine's if
   * it's the newer, or hold a conflict (backing this copy up) when both changed.
   */
  prepare(): { action: PrepareAction; status: SyncStatus; backup?: string | null };
  /** Snapshot the open database into the sync folder if it changed and nothing is held. `force` pushes over a conflict. */
  push(db: D, options?: { force?: boolean }): { action: PushAction; status: SyncStatus };
  /**
   * Push after writes: polls the connection's total_changes() and PRAGMA data_version (so writes from other
   * processes on this machine count too) and pushes once they've been quiet for `quietMs`; between writes it
   * looks for a newer snapshot from another machine. Pushes once at the start (after the app's migrations).
   * Returns stop, which pushes anything still pending.
   */
  watch(db: D, options?: { intervalMs?: number; quietMs?: number }): () => void;
  /**
   * Ben's choice in a conflict. "local" pushes this machine's data over the other's now (pass the open
   * handle when the app is running). "remote" takes the other machine's at the next prepare(), so the app
   * restarts to finish it.
   */
  resolve(choice: "local" | "remote", db?: D): { action: "pushed" | "restart"; status: SyncStatus };
}

const empty = (): State => ({ agreed: { local: null, remote: null }, at: null, conflict: null, pending: null });

export function createDataSync<D extends SqliteHandle>(options: DataSyncOptions<D>): DataSync<D> {
  const { app, dbPath, driver } = options;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(app)) throw new Error(`data-sync: "${app}" isn't an app id (lowercase letters, digits, . _ -).`);
  const root = options.dir ?? tailnetFor(app).syncDir;
  const file = join(root, app, snapshotName);
  const machine = options.machine ?? hostname();
  const stateFile = options.stateFile ?? `${dbPath}.sync.json`;
  const backupDir = options.backupDir ?? join(dirname(dbPath), "backups");
  const exclude = options.exclude ?? [];
  const log = options.log ?? ((line: string) => console.log(`[data-sync] ${line}`));

  const readState = (): State => {
    try {
      return { ...empty(), ...(JSON.parse(readFileSync(stateFile, "utf8")) as Partial<State>) };
    } catch {
      return empty();
    }
  };
  const writeState = (s: State) => {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, `${JSON.stringify(s, null, 2)}\n`);
  };

  const info = (d: Dump): LocalInfo => ({ sha: d.sha, total: d.total, rows: d.rows, schemaVersion: d.schemaVersion });

  /** Dump with the app's handle, or a read-only one of our own; null when there's no database here yet. */
  const dumpLocal = (db?: D): Dump | null => {
    if (db) return dumpDatabase(db, { exclude });
    if (!existsSync(dbPath)) return null;
    const ro = openDatabase(driver, dbPath, { readOnly: true });
    try {
      return dumpDatabase(ro, { exclude });
    } finally {
      ro.close();
    }
  };

  const build = (state: State, local: Dump | null, remote: Manifest | null): SyncStatus => ({
    app,
    machine,
    verdict: decideVerdict({ localSha: local?.sha ?? null, localTotal: local?.total ?? 0, remoteSha: remote?.sha ?? null, remoteTotal: remote?.total, agreed: state.agreed }),
    file,
    local: local ? info(local) : null,
    remote,
    agreed: { ...state.agreed, at: state.at },
    conflict: state.conflict,
    conflictCopies: conflictCopies(file),
    pending: state.pending,
  });

  const agree = (state: State, local: string | null, remote: string | null): State => {
    const next: State = { ...state, agreed: { local, remote }, at: new Date().toISOString(), conflict: null, pending: null };
    writeState(next);
    return next;
  };

  const history = (event: HistoryEvent, extra: Partial<HistoryEntry> = {}) => recordHistory(root, { at: new Date().toISOString(), app, machine, event, ...extra });
  const facts = (d: { sha: string; total: number; rows: Record<string, number>; schemaVersion: number }) => ({ sha: d.sha, total: d.total, rows: d.rows, schemaVersion: d.schemaVersion });

  const publish = (state: State, d: Dump, event: "pushed" | "kept-local" = "pushed"): State => {
    const m = writeSnapshot(file, app, machine, d);
    for (const c of conflictCopies(file)) rmSync(c, { force: true });
    log(`${app}: pushed ${d.total} rows (${d.sha.slice(0, 8)}) from ${machine}`);
    history(event, facts(d));
    return agree(state, d.sha, m.sha);
  };

  const hold = (state: State, reason: string, remote: Manifest | null, backup: string | null): State => {
    const next: State = { ...state, conflict: { since: new Date().toISOString(), reason, remote, backup } };
    writeState(next);
    log(`${app}: held. ${reason}`);
    history("held", { from: remote?.machine, note: reason, sha: remote?.sha, total: remote?.total });
    return next;
  };

  const tell = (message: string, status: SyncStatus) => {
    try {
      options.notify?.(message, status);
    } catch (e) {
      log(`${app}: notify failed: ${(e as Error).message}`);
    }
  };

  const bothChanged = (remote: Manifest | null) =>
    `${machine} and ${remote?.machine ?? "another machine"} both changed ${app} since they last agreed. This machine keeps serving its own copy and nothing syncs until you choose whose data to keep.`;

  const status = (db?: D): SyncStatus => {
    const snap = readSnapshot(file);
    return build(readState(), dumpLocal(db), snap?.manifest ?? null);
  };

  const prepare: DataSync<D>["prepare"] = () => {
    let state = readState();
    const snap = readSnapshot(file);

    if (state.pending === "remote") {
      if (!snap) throw new Error(`${app}: Ben chose the other machine's data, but there's no snapshot in ${file} to restore.`);
      const { backup } = restoreSnapshot(driver, snap.sql, dbPath, { backupDir, keep: exclude });
      state = agree(state, dumpLocal()?.sha ?? null, snap.manifest.sha);
      log(`${app}: took ${snap.manifest.machine}'s data (${snap.manifest.total} rows); this machine's copy is in ${backup ?? "(none)"}`);
      history("took-remote", { ...facts(snap.manifest), from: snap.manifest.machine });
      return { action: "pulled", status: build(state, dumpLocal(), snap.manifest), backup };
    }

    const local = dumpLocal();
    const s = build(state, local, snap?.manifest ?? null);
    if (state.conflict) {
      log(`${app}: a conflict from ${state.conflict.since} is still held; serving this machine's copy.`);
      return { action: "held", status: s };
    }

    switch (s.verdict) {
      case "remote-ahead": {
        const remote = snap!.manifest;
        if (options.schemaVersion !== undefined && remote.schemaVersion > options.schemaVersion) {
          log(`${app}: ${remote.machine}'s data is from newer code (schema ${remote.schemaVersion}, this app knows ${options.schemaVersion}). Update the app here; serving this machine's copy for now.`);
          history("behind", { ...facts(remote), from: remote.machine });
          return { action: "behind", status: s };
        }
        const { backup } = restoreSnapshot(driver, snap!.sql, dbPath, { backupDir, keep: exclude });
        const restored = dumpLocal();
        state = agree(state, restored?.sha ?? null, remote.sha);
        log(`${app}: pulled ${remote.total} rows from ${remote.machine} (${remote.createdAt})`);
        history("pulled", { ...facts(remote), from: remote.machine });
        return { action: "pulled", status: build(state, restored, remote), backup };
      }
      case "local-ahead":
      case "no-remote":
        state = publish(state, local!);
        return { action: "pushed", status: build(state, local, readSnapshot(file)?.manifest ?? null) };
      case "diverged": {
        const backup = local ? backupDatabase(driver, dbPath, backupDir, "diverged") : null;
        state = hold(state, bothChanged(snap?.manifest ?? null), snap?.manifest ?? null, backup);
        const held = build(state, local, snap?.manifest ?? null);
        tell(held.conflict!.reason, held);
        return { action: "held", status: held, backup };
      }
      default:
        if (local && snap && (state.agreed.local !== local.sha || state.agreed.remote !== snap.manifest.sha)) state = agree(state, local.sha, snap.manifest.sha);
        return { action: "none", status: build(state, local, snap?.manifest ?? null) };
    }
  };

  const push: DataSync<D>["push"] = (db, { force = false } = {}) => {
    return pushAs(db, force, force ? "kept-local" : "pushed");
  };

  const pushAs = (db: D, force: boolean, event: "pushed" | "kept-local"): { action: PushAction; status: SyncStatus } => {
    let state = readState();
    const local = dumpDatabase(db, { exclude });
    const snap = readSnapshot(file);
    const s = build(state, local, snap?.manifest ?? null);

    if (force) {
      state = publish(state, local, event);
      return { action: "pushed", status: build(state, local, readSnapshot(file)?.manifest ?? null) };
    }
    if (state.conflict) return { action: "held", status: s };

    switch (s.verdict) {
      case "local-ahead":
      case "no-remote":
        state = publish(state, local);
        return { action: "pushed", status: build(state, local, readSnapshot(file)?.manifest ?? null) };
      case "remote-ahead": {
        const msg = `${snap!.manifest.machine} pushed newer ${app} data while ${machine} was serving it. Restart ${app} here to pick it up.`;
        log(`${app}: ${msg}`);
        tell(msg, s);
        return { action: "remote-ahead", status: s };
      }
      case "diverged": {
        let backup: string | null = null;
        try {
          backup = backupDatabase(driver, dbPath, backupDir, "diverged");
        } catch (e) {
          log(`${app}: couldn't back up before holding: ${(e as Error).message}`);
        }
        state = hold(state, bothChanged(snap?.manifest ?? null), snap?.manifest ?? null, backup);
        const held = build(state, local, snap?.manifest ?? null);
        tell(held.conflict!.reason, held);
        return { action: "held", status: held };
      }
      default:
        if (snap && (state.agreed.local !== local.sha || state.agreed.remote !== snap.manifest.sha)) state = agree(state, local.sha, snap.manifest.sha);
        return { action: "up-to-date", status: build(state, local, snap?.manifest ?? null) };
    }
  };

  const watch: DataSync<D>["watch"] = (db, { intervalMs = 2000, quietMs = 3000 } = {}) => {
    // total_changes() counts this connection's writes; data_version moves when another connection or
    // process (a CLI, an MCP server) commits to the same file.
    const one = (sql: string) => String(Object.values((db.prepare(sql).get() as Record<string, unknown>) ?? {})[0] ?? "");
    const changes = () => `${one("SELECT total_changes()")}:${one("PRAGMA data_version")}`;
    let seen = changes();
    let dirty = false;
    let lastWrite = 0;
    let lastRemote = peekManifest(file)?.sha ?? null;
    const safePush = () => {
      try {
        push(db);
      } catch (e) {
        log(`${app}: push failed: ${(e as Error).message}`);
      }
    };
    safePush();
    const timer = setInterval(() => {
      const n = changes();
      if (n !== seen) {
        seen = n;
        dirty = true;
        lastWrite = Date.now();
        return;
      }
      if (dirty && Date.now() - lastWrite >= quietMs) {
        dirty = false;
        safePush();
        lastRemote = peekManifest(file)?.sha ?? null;
        return;
      }
      // Quiet here: has another machine pushed? (Only if this one isn't the writer of what's there.)
      const remote = peekManifest(file);
      if (remote && remote.sha !== lastRemote) {
        lastRemote = remote.sha;
        if (remote.machine !== machine) safePush();
      }
    }, intervalMs);
    timer.unref?.();
    return () => {
      clearInterval(timer);
      let pending = dirty;
      try {
        pending ||= changes() !== seen;
      } catch {
        // The app closed its handle first: nothing more can be read from it.
        return;
      }
      if (pending) safePush();
    };
  };

  const resolve: DataSync<D>["resolve"] = (choice, db) => {
    if (choice === "local") {
      const handle = db ?? openDatabase(driver, dbPath, { fileMustExist: true });
      try {
        const r = push(handle, { force: true });
        log(`${app}: Ben kept ${machine}'s data; it's pushed.`);
        return { action: "pushed", status: r.status };
      } finally {
        if (!db) handle.close();
      }
    }
    const state = { ...readState(), pending: "remote" as const };
    writeState(state);
    log(`${app}: Ben chose the other machine's data; it's restored at the next start.`);
    return { action: "restart", status: build(state, dumpLocal(db), readSnapshot(file)?.manifest ?? null) };
  };

  return { app, file, status, prepare, push, watch, resolve };
}
