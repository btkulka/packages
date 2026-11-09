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
}

export interface Tailnet {
  self: Peer | null;
  peers: Peer[];
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
}

const toPeer = (n: RawNode, online: boolean): Peer | null => {
  const ips = n.TailscaleIPs ?? [];
  const ip = ips.find((a) => !a.includes(":")) ?? ips[0];
  if (!ip) return null;
  return { name: (n.HostName || n.DNSName?.split(".")[0] || ip).toLowerCase(), ip, os: n.OS, online };
};

/** Parse `tailscale status --json`. */
export function parseTailscaleStatus(json: string): Tailnet {
  const s = JSON.parse(json) as { Self?: RawNode; Peer?: Record<string, RawNode> };
  const self = s.Self ? toPeer(s.Self, true) : null;
  const peers = Object.values(s.Peer ?? {})
    .map((p) => toPeer(p, Boolean(p.Online)))
    .filter((p): p is Peer => p !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { self, peers };
}

/** This machine and its peers, from the Tailscale CLI. No Tailscale, or it's off: no peers (and the app serves on its own). */
export function tailnet(options: { cli?: string; timeoutMs?: number } = {}): Promise<Tailnet> {
  return new Promise((resolve) => {
    execFile(options.cli ?? tailscaleCli(), ["status", "--json"], { timeout: options.timeoutMs ?? 4000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
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
