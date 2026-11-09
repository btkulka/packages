import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Ben's machines can be on more than one tailnet at once: the system Tailscale on one account, and others that
// Benhäus runs itself as background (userspace) tailscaled daemons, each with its own sign-in. Each app syncs on
// one of them. Benhäus writes the map to ~/.benhaus/tailnets.json; this reads it.
//
//   { "tailnets": { "btkulka": { "primary": true, "syncDir": "C:/Users/ben/.benhaus-sync" },
//                   "stallionrapscallion": { "socket": "\\\\.\\pipe\\benhaus-ts-stallionrapscallion",
//                                            "proxy": "http://127.0.0.1:41055", "syncDir": "C:/Users/ben/.benhaus-sync-stallionrapscallion" } },
//     "apps": { "habit-tracker": "btkulka", "clipdrift": "stallionrapscallion" } }
//
// No file (or an app it doesn't name) means the system Tailscale and the one sync folder, as before.

export interface TailnetConfig {
  /** Its name: the account it's signed into ("btkulka"). */
  name: string;
  /** The system Tailscale (a real network interface). False for one Benhäus runs in userspace. */
  primary: boolean;
  /** The tailscaled socket for the CLI (`tailscale --socket <it>`); absent for the system Tailscale. */
  socket?: string;
  /** An HTTP proxy into this tailnet (a userspace tailscaled's outbound proxy); absent when its addresses are reachable directly. */
  proxy?: string;
  /** This tailnet's Syncthing folder. */
  syncDir: string;
}

interface TailnetsFile {
  tailnets?: Record<string, Partial<Omit<TailnetConfig, "name">>>;
  apps?: Record<string, string>;
}

/** BENHAUS_TAILNETS, else tailnets.json in BENHAUS_HOME (else ~/.benhaus). */
export const tailnetsFile = (): string => process.env.BENHAUS_TAILNETS || join(process.env.BENHAUS_HOME || join(homedir(), ".benhaus"), "tailnets.json");

/** The default sync folder: BENHAUS_SYNC_DIR, else ~/.benhaus-sync. */
export const defaultSyncDir = (): string => process.env.BENHAUS_SYNC_DIR || join(homedir(), ".benhaus-sync");

function readFile(): TailnetsFile {
  try {
    return JSON.parse(readFileSync(tailnetsFile(), "utf8")) as TailnetsFile;
  } catch {
    return {};
  }
}

const legacy = (): TailnetConfig => ({ name: "default", primary: true, syncDir: defaultSyncDir() });

/** Every tailnet Benhäus has set up on this machine (the primary first); just the system one when there's no map. */
export function listTailnets(): TailnetConfig[] {
  const f = readFile();
  const all = Object.entries(f.tailnets ?? {}).map(([name, t]) => ({ name, primary: Boolean(t.primary), socket: t.socket, proxy: t.proxy, syncDir: t.syncDir || defaultSyncDir() }));
  return all.length ? all.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name)) : [legacy()];
}

/**
 * The tailnet an app syncs on: the one the map assigns it, else the primary. BENHAUS_SYNC_DIR still wins for
 * the folder (tests point it at a temp dir).
 */
export function tailnetFor(app: string): TailnetConfig {
  const f = readFile();
  const all = listTailnets();
  const t = all.find((x) => x.name === f.apps?.[app]) ?? all.find((x) => x.primary) ?? all[0] ?? legacy();
  return process.env.BENHAUS_SYNC_DIR ? { ...t, syncDir: process.env.BENHAUS_SYNC_DIR } : t;
}
