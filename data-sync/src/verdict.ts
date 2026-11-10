/** Where this machine's data stands against the snapshot in the sync folder. */
export type Verdict =
  /** No snapshot anywhere yet: this machine's data is the first. */
  | "no-remote"
  /** Same data, or nothing changed on either side since they last agreed. */
  | "in-sync"
  /** This machine changed since; the snapshot didn't. Push. */
  | "local-ahead"
  /** Another machine pushed since; this one didn't change. Pull. */
  | "remote-ahead"
  /** Both changed since they last agreed (or never agreed and differ). Ben chooses. */
  | "diverged";

/** What this machine last agreed with: its own dump's sha then, and the snapshot's. Null before the first sync. */
export interface Agreement {
  local: string | null;
  remote: string | null;
}

/**
 * The whole decision, free of files so each branch is testable. Each side is compared with what it was
 * when they last agreed, not with the other side: that is what tells "someone else moved on" from "we
 * both did". Keeping both shas (rather than one) means a restore that doesn't reproduce the snapshot's
 * exact bytes still reads as in sync.
 *
 * Empty is never data. A machine with no rows publishes nothing (a fresh machine once pushed its empty
 * database and every other machine read that as newer), and a snapshot with no rows never replaces rows
 * here: this machine's copy is pushed over it instead. `remoteTotal` is the snapshot's row count; left
 * out, the snapshot counts as having rows.
 */
export function decideVerdict(a: { localSha: string | null; localTotal: number; remoteSha: string | null; remoteTotal?: number; agreed: Agreement }): Verdict {
  const localEmpty = a.localSha === null || a.localTotal === 0;
  const remoteEmpty = a.remoteSha === null || a.remoteTotal === 0;
  // Nothing on either side, or nothing worth moving: there's no data to sync.
  if (localEmpty && remoteEmpty) return "in-sync";
  // No snapshot anywhere yet: this machine's rows are the first.
  if (a.remoteSha === null) return "no-remote";
  // No database here yet, or one with no rows: nothing of this machine's to lose.
  if (localEmpty) return "remote-ahead";
  // An empty snapshot carries nothing; this machine's rows go over it.
  if (remoteEmpty) return "local-ahead";
  if (a.localSha === a.remoteSha) return "in-sync";
  if (a.agreed.local === null && a.agreed.remote === null) return "diverged";
  const localMoved = a.localSha !== a.agreed.local;
  const remoteMoved = a.remoteSha !== a.agreed.remote;
  if (localMoved && remoteMoved) return "diverged";
  if (localMoved) return "local-ahead";
  if (remoteMoved) return "remote-ahead";
  return "in-sync";
}
