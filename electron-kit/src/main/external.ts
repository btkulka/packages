/** Electron's shell, or the one method of it used here. */
export interface ShellLike {
  openExternal(url: string): Promise<void>;
}

export interface ExternalOptions {
  /** Schemes allowed out, with the colon. Default http:, https: and mailto:. */
  protocols?: readonly string[];
}

export const DEFAULT_EXTERNAL_PROTOCOLS: readonly string[] = ["http:", "https:", "mailto:"];

/** The URL, normalized, when it parses and its scheme is allowed; otherwise undefined. */
export function externalUrl(url: unknown, opts: ExternalOptions = {}): string | undefined {
  if (typeof url !== "string" || !url.trim()) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  const allowed = (opts.protocols ?? DEFAULT_EXTERNAL_PROTOCOLS).map((p) => p.toLowerCase());
  return allowed.includes(parsed.protocol) ? parsed.toString() : undefined;
}

/**
 * Open a link in the user's browser (or mail client), but only for allowed
 * schemes. On Windows shell.openExternal hands any string to whatever
 * protocol handler claims it, so an unchecked URL from a page or a search
 * result can launch arbitrary registered applications (file:, ms-msdt:,
 * search-ms:…). Resolves true when opened, false when refused; a failing
 * shell (no handler) still rejects.
 */
export async function openExternal(shell: ShellLike, url: unknown, opts?: ExternalOptions): Promise<boolean> {
  const safe = externalUrl(url, opts);
  if (!safe) return false;
  await shell.openExternal(safe);
  return true;
}

/** A webContents, or the one method of it used here. */
export interface WindowOpener {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" } | { action: "allow" }): void;
}

/**
 * Links that would open a new Electron window (target=_blank, window.open)
 * open in the browser instead, through openExternal's scheme check. Refused
 * and failed opens are dropped quietly. Call it for each window, and for
 * webviews from app.on("web-contents-created").
 */
export function routeNewWindowsToBrowser(contents: WindowOpener, shell: ShellLike, opts?: ExternalOptions): void {
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(shell, url, opts).catch(() => undefined);
    return { action: "deny" };
  });
}
