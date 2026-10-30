// One step from "a Chrome should be listening here" to an open DevTools connection.
import { connectCdp, type CdpConnection, type ConnectCdpOptions } from "./cdp.js";
import { devToolsEndpoint, discoverDevTools, type DevToolsInfo, type FetchLike } from "./devtools.js";

export interface ConnectChromeOptions extends ConnectCdpOptions {
  fetch?: FetchLike;
  /** How long /json/version may take. Default 2000. */
  timeoutMs?: number;
}

/** Discover the browser at the endpoint and open a connection to it. Throws when nothing answers there. */
export async function connectChrome(endpoint: string | number, opts: ConnectChromeOptions = {}): Promise<{ connection: CdpConnection; devtools: DevToolsInfo }> {
  const base = devToolsEndpoint(endpoint);
  const devtools = await discoverDevTools(base, { fetch: opts.fetch, timeoutMs: opts.timeoutMs });
  if (!devtools) throw new Error(`No Chrome with remote debugging is answering at ${base}.`);
  const connection = connectCdp(devtools.wsUrl, opts);
  await connection.open;
  return { connection, devtools };
}
