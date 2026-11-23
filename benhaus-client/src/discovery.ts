import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** What Benhäus writes to ~/.benhaus/mcp.json each time its local endpoint starts. */
export interface BenhausDiscovery {
  /** The MCP endpoint, like http://127.0.0.1:4790/mcp. */
  url: string;
  port: number;
  /** Bearer token for MCP tool calls (and, with a Benhäus from before Nov 2026, the /credentials routes). */
  token: string;
  /**
   * The token for the /credentials routes, read from credentials-token.json beside the discovery file (never in
   * mcp.json, so never in a Claude chat's MCP config). Absent with an older Benhäus, which takes `token` there.
   */
  credentialsToken?: string;
  pid?: number;
  startedAt?: string;
  version?: string;
  appPath?: string;
}

export const defaultDiscoveryFile = (): string => join(homedir(), ".benhaus", "mcp.json");

/** Where Benhäus keeps the /credentials token: credentials-token.json in the discovery file's folder. */
export const credentialsTokenFile = (discoveryFile: string = defaultDiscoveryFile()): string => join(dirname(discoveryFile), "credentials-token.json");

/** The credentials token, or undefined when there's no such file (an older Benhäus) or it's unreadable. */
function readCredentialsToken(file: string): string | undefined {
  try {
    const t = (JSON.parse(readFileSync(file, "utf8")) as { token?: unknown }).token;
    return typeof t === "string" && t ? t : undefined;
  } catch {
    return undefined;
  }
}

/** The discovery file (with the credentials token beside it, when there is one), or undefined when it is missing, unreadable or lacks an address and token. */
export function readDiscovery(file: string = defaultDiscoveryFile()): BenhausDiscovery | undefined {
  try {
    const d = JSON.parse(readFileSync(file, "utf8")) as Partial<BenhausDiscovery>;
    if (typeof d.url !== "string" || typeof d.token !== "string" || !d.url || !d.token) return undefined;
    const credentialsToken = readCredentialsToken(credentialsTokenFile(file));
    return { ...d, url: d.url, token: d.token, port: Number(d.port ?? new URL(d.url).port), ...(credentialsToken ? { credentialsToken } : {}) };
  } catch {
    return undefined;
  }
}
