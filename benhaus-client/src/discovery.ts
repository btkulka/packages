import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What Benhäus writes to ~/.benhaus/mcp.json each time its local endpoint starts. */
export interface BenhausDiscovery {
  /** The MCP endpoint, like http://127.0.0.1:4790/mcp. */
  url: string;
  port: number;
  /** Bearer token for every call except /health. */
  token: string;
  pid?: number;
  startedAt?: string;
  version?: string;
  appPath?: string;
}

export const defaultDiscoveryFile = (): string => join(homedir(), ".benhaus", "mcp.json");

/** The discovery file, or undefined when it is missing, unreadable or lacks an address and token. */
export function readDiscovery(file: string = defaultDiscoveryFile()): BenhausDiscovery | undefined {
  try {
    const d = JSON.parse(readFileSync(file, "utf8")) as Partial<BenhausDiscovery>;
    if (typeof d.url !== "string" || typeof d.token !== "string" || !d.url || !d.token) return undefined;
    return { ...d, url: d.url, token: d.token, port: Number(d.port ?? new URL(d.url).port) };
  } catch {
    return undefined;
  }
}
