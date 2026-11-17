import { networkInterfaces } from "node:os";

// Where an app listens. Ben's apps have no login, so they don't answer on the Wi-Fi: only on this machine
// (127.0.0.1, where Benhäus and its tabs reach them) and on its Tailscale address (where data-sync finds a copy
// already serving on another of his machines). A phone opens them through Benhäus's phone remote, which passes
// the app's port through to the phone after checking who it is and what they may open. HOST overrides it:
// "all" (or 0.0.0.0) for every interface, "local" for this machine alone, or a comma list of addresses.

/** Tailscale hands out 100.64.0.0/10. */
const TAILSCALE_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

type Interfaces = ReturnType<typeof networkInterfaces>;

/** This machine's Tailscale IPv4 addresses (its own interface, or an address in Tailscale's range). */
export function tailscaleAddresses(ifaces: Interfaces = networkInterfaces()): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal) continue;
      if (/tailscale/i.test(name) || TAILSCALE_V4.test(i.address)) out.push(i.address);
    }
  }
  return [...new Set(out)];
}

/** This machine's other IPv4 addresses (the Wi-Fi, a VPN, WSL's): what an app no longer listens on. */
export function lanAddresses(ifaces: Interfaces = networkInterfaces()): string[] {
  const ts = new Set(tailscaleAddresses(ifaces));
  return Object.values(ifaces)
    .flat()
    .filter((i): i is NonNullable<typeof i> => Boolean(i && i.family === "IPv4" && !i.internal && !ts.has(i.address)))
    .map((i) => i.address);
}

/**
 * The addresses an app listens on: 127.0.0.1 and this machine's Tailscale address, or what HOST says ("all" or
 * 0.0.0.0, "local" or 127.0.0.1, or a comma list).
 */
export function appHosts(host: string | undefined = process.env.HOST, ifaces: Interfaces = networkInterfaces()): string[] {
  const h = host?.trim().toLowerCase();
  if (h === "all" || h === "0.0.0.0" || h === "::") return ["0.0.0.0"];
  if (h === "local" || h === "localhost" || h === "127.0.0.1") return ["127.0.0.1"];
  if (h) return [...new Set(h.split(",").map((s) => s.trim()).filter(Boolean))];
  return ["127.0.0.1", ...tailscaleAddresses(ifaces)];
}

/** Whether `appHosts` was left to choose (HOST unset): then a Tailscale address that comes up later is picked up. */
export const hostsAreDefault = (host: string | undefined = process.env.HOST) => !host?.trim();
