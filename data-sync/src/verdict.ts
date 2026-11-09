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
 */
export function decideVerdict(a: { localSha: string | null; localTotal: number; remoteSha: string | null; agreed: Agreement }): Verdict {
  if (a.remoteSha === null) return a.localSha === null ? "in-sync" : "no-remote";
  // No database here yet, or one with no rows: nothing of this machine's to lose.
  if (a.localSha === null || a.localTotal === 0) return a.localSha !== null && a.localSha === a.remoteSha ? "in-sync" : "remote-ahead";
  if (a.localSha === a.remoteSha) return "in-sync";
  if (a.agreed.local === null && a.agreed.remote === null) return "diverged";
  const localMoved = a.localSha !== a.agreed.local;
  const remoteMoved = a.remoteSha !== a.agreed.remote;
  if (localMoved && remoteMoved) return "diverged";
  if (localMoved) return "local-ahead";
  if (remoteMoved) return "remote-ahead";
  return "in-sync";
}
