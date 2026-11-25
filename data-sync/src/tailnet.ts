import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/** A machine on Ben's tailnet. */
export interface Peer {
  /** Its host name: zagreus. */
  name: string;
  /** Its first Tailscale address (IPv4 when it has one). */
  ip: string;
  os?: string;
  online: boolean;
  /** The Tailscale user it's signed in as (a tagged node has the tagged-devices user). */
  userId?: number;
  /** Its ACL tags: a tagged node belongs to the tailnet, not to a person. */
  tags?: string[];
  /** It's in the netmap because this machine was shared with its owner (another tailnet's user), not because it's ours. */
  sharee?: boolean;
}

export interface Tailnet {
  self: Peer | null;
  peers: Peer[];
  /** The Tailscale user this machine is signed in as. */
  userId?: number;
  /** Tailscale's backend state: "Running", "NeedsLogin", "Stopped", "Starting", "NoState"; absent when the CLI didn't answer. */
  state?: string;
  /** The tailnet's name, and the account this machine is signed in as. */
  name?: string;
  user?: string;
  /** Where to sign in, while it needs a login. */
  authUrl?: string;
}

/** The Tailscale CLI: TAILSCALE_CLI, the Mac app's own binary when it isn't on PATH, else `tailscale`. */
export function tailscaleCli(): string {
  if (process.env.TAILSCALE_CLI) return process.env.TAILSCALE_CLI;
  const mac = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  return process.platform === "darwin" && existsSync(mac) ? mac : "tailscale";
}

interface RawNode {
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  OS?: string;
  Online?: boolean;
  UserID?: number;
  Tags?: string[] | null;
  ShareeNode?: boolean;
}

const toPeer = (n: RawNode, online: boolean): Peer | null => {
  const ips = n.TailscaleIPs ?? [];
  const ip = ips.find((a) => !a.includes(":")) ?? ips[0];
  if (!ip) return null;
  const tags = Array.isArray(n.Tags) ? n.Tags.filter((t) => typeof t === "string") : [];
  return {
    name: (n.HostName || n.DNSName?.split(".")[0] || ip).toLowerCase(),
    ip,
    os: n.OS,
    online,
    ...(typeof n.UserID === "number" ? { userId: n.UserID } : {}),
    ...(tags.length ? { tags } : {}),
    ...(n.ShareeNode ? { sharee: true } : {}),
  };
};

/** Parse `tailscale status --json`. */
export function parseTailscaleStatus(json: string): Tailnet {
  const s = JSON.parse(json) as {
    Self?: RawNode;
    Peer?: Record<string, RawNode>;
    BackendState?: string;
    AuthURL?: string;
    CurrentTailnet?: { Name?: string } | null;
    User?: Record<string, { LoginName?: string }>;
  };
  // This machine's user is the tailnet's userId; its own entry stays as it was.
  const self = s.Self ? toPeer({ HostName: s.Self.HostName, DNSName: s.Self.DNSName, TailscaleIPs: s.Self.TailscaleIPs, OS: s.Self.OS }, true) : null;
  const peers = Object.values(s.Peer ?? {})
    .map((p) => toPeer(p, Boolean(p.Online)))
    .filter((p): p is Peer => p !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const user = s.Self?.UserID !== undefined ? s.User?.[String(s.Self.UserID)]?.LoginName : undefined;
  const userId = typeof s.Self?.UserID === "number" ? s.Self.UserID : undefined;
  return { self, peers, state: s.BackendState, name: s.CurrentTailnet?.Name || undefined, user, authUrl: s.AuthURL || undefined, ...(userId !== undefined ? { userId } : {}) };
}

/**
 * This machine and its peers, from the Tailscale CLI. No Tailscale, or it's off: no peers (and the app serves on
 * its own). `socket` asks a Benhäus-run userspace tailscaled (another tailnet) instead of the system one.
 */
export function tailnet(options: { cli?: string; socket?: string; timeoutMs?: number } = {}): Promise<Tailnet> {
  const args = [...(options.socket ? ["--socket", options.socket] : []), "status", "--json"];
  return new Promise((resolve) => {
    execFile(options.cli ?? tailscaleCli(), args, { timeout: options.timeoutMs ?? 4000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve({ self: null, peers: [] });
      try {
        resolve(parseTailscaleStatus(String(stdout)));
      } catch {
        resolve({ self: null, peers: [] });
      }
    });
  });
}

/** Phones and tablets don't run Ben's app servers; skip probing them. */
export const runsServers = (p: Peer) => !/^(ios|android)$/i.test(p.os ?? "");

/**
 * Whether a peer is one of this machine's owner's own: signed in to Tailscale as the same user, not a tagged node
 * and not in the netmap through a share. A guest invited to the tailnet, a node shared in from another tailnet and
 * a tagged server are all reachable, but none of them is the owner's machine. Unknown users never match.
 */
export const ownPeer = (t: Pick<Tailnet, "userId" | "self">, p: Peer): boolean =>
  t.userId !== undefined && p.userId === t.userId && !p.tags?.length && !p.sharee && p.ip !== t.self?.ip;
