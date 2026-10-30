// Playwright launching the way Ben's apps kept writing it: a persistent profile on the installed Google Chrome
// (Playwright's bundled Chrome for Testing is fingerprinted and blocked by Cloudflare and friends), the
// automation tells turned off, and the bundled Chromium as the fallback when Chrome isn't installed. The app
// passes in its own `chromium` (from playwright or playwright-core); this package never imports Playwright.
import { mkdirSync } from "node:fs";

/** The part of Playwright's `chromium` (a BrowserType) used here. */
export interface ChromiumLike<Context = unknown, Browser = unknown> {
  launch(options?: any): Promise<Browser>;
  launchPersistentContext(userDataDir: string, options?: any): Promise<Context>;
}

/** Turns off the "controlled by automated software" bar and `navigator.webdriver`, both fingerprints. */
export const STEALTH_ARGS: readonly string[] = ["--disable-blink-features=AutomationControlled"];
export const STEALTH_IGNORE_DEFAULT_ARGS: readonly string[] = ["--enable-automation"];

/** A desktop viewport; Playwright's 1280x720 default is itself a tell. */
export const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;

export type LaunchedChannel = "chrome" | "msedge" | "bundled" | "executable" | (string & {});

export interface ChannelOptions {
  /** "chrome" (default): the installed Google Chrome. "msedge" works too. null: Playwright's bundled Chromium. */
  channel?: string | null;
  /** A browser binary to run instead of a channel. */
  executablePath?: string;
  /**
   * When the channel's browser can't be launched: "missing" (default) falls back to the bundled Chromium only
   * when the channel isn't installed; "any" falls back on any launch error; false never falls back.
   */
  fallback?: "missing" | "any" | false;
  /** Turn off the automation tells (STEALTH_ARGS, no --enable-automation). Default true. */
  stealth?: boolean;
  /** Extra Chrome flags. */
  args?: string[];
  /** Told which channel launched, and why a fallback happened. */
  log?: (line: string) => void;
}

export interface PersistentLaunchOptions extends ChannelOptions {
  /** The profile folder (created when missing). One per site keeps logins apart. */
  userDataDir: string;
  /** Anything else Playwright's launchPersistentContext takes: headless, viewport, userAgent, locale… */
  [option: string]: unknown;
}

export interface BrowserLaunchOptions extends ChannelOptions {
  /** Anything else Playwright's launch takes: headless, slowMo… */
  [option: string]: unknown;
}

/** Whether a launch error means the channel's browser isn't installed (as opposed to, say, a locked profile). */
export function isMissingBrowserError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /is not found at|Executable doesn't exist|distribution '[^']*' is not found|Failed to launch: Error: spawn .* ENOENT/i.test(msg);
}

function launchOptions(opts: ChannelOptions, rest: Record<string, unknown>, channel: string | null): { options: Record<string, unknown>; how: LaunchedChannel } {
  const stealth = opts.stealth !== false;
  const args = [...(stealth ? STEALTH_ARGS : []), ...((rest.args as string[] | undefined) ?? []), ...(opts.args ?? [])];
  const options: Record<string, unknown> = { ...rest, args: [...new Set(args)] };
  delete options.userDataDir;
  if (stealth) {
    const ignore = Array.isArray(rest.ignoreDefaultArgs) ? (rest.ignoreDefaultArgs as string[]) : [];
    if (rest.ignoreDefaultArgs !== true) options.ignoreDefaultArgs = [...new Set([...STEALTH_IGNORE_DEFAULT_ARGS, ...ignore])];
  }
  if (opts.executablePath) {
    options.executablePath = opts.executablePath;
    return { options, how: "executable" };
  }
  if (channel) {
    options.channel = channel;
    return { options, how: channel };
  }
  return { options, how: "bundled" };
}

async function withFallback<T>(opts: ChannelOptions, launch: (channel: string | null) => Promise<T>): Promise<{ result: T; channel: LaunchedChannel }> {
  const channel = opts.executablePath ? null : opts.channel === undefined ? "chrome" : opts.channel;
  const first = opts.executablePath ? "executable" : channel ?? "bundled";
  try {
    const result = await launch(channel);
    opts.log?.(`launched ${first}`);
    return { result, channel: first };
  } catch (e) {
    const mode = opts.fallback === undefined ? "missing" : opts.fallback;
    const canFall = (channel || opts.executablePath) && mode !== false && (mode === "any" || isMissingBrowserError(e));
    if (!canFall) throw e;
    opts.log?.(`${first} could not be launched (${e instanceof Error ? e.message.split("\n")[0] : String(e)}); using Playwright's bundled Chromium`);
    const result = await launch(null);
    return { result, channel: "bundled" };
  }
}

/**
 * `chromium.launchPersistentContext` on the installed Chrome, with the bundled Chromium as the fallback.
 * Returns the BrowserContext (a persistent context has no separate Browser) and which browser it got.
 */
export async function launchPersistent<C>(chromium: Pick<ChromiumLike<C>, "launchPersistentContext">, opts: PersistentLaunchOptions): Promise<{ context: C; channel: LaunchedChannel }> {
  const { userDataDir, channel: _c, executablePath, fallback: _f, stealth: _s, args: _a, log: _l, ...rest } = opts;
  if (!userDataDir) throw new Error("launchPersistent needs a userDataDir.");
  mkdirSync(userDataDir, { recursive: true });
  const base = { ...opts, executablePath };
  const { result, channel } = await withFallback(base, (ch) => {
    const { options } = launchOptions(ch === null && executablePath ? { ...base, executablePath: undefined } : base, rest, ch);
    return chromium.launchPersistentContext(userDataDir, options);
  });
  return { context: result, channel };
}

/** `chromium.launch` on the installed Chrome, with the bundled Chromium as the fallback. */
export async function launchBrowser<B>(chromium: Pick<ChromiumLike<unknown, B>, "launch">, opts: BrowserLaunchOptions = {}): Promise<{ browser: B; channel: LaunchedChannel }> {
  const { channel: _c, executablePath, fallback: _f, stealth: _s, args: _a, log: _l, ...rest } = opts;
  const base = { ...opts, executablePath };
  const { result, channel } = await withFallback(base, (ch) => {
    const { options } = launchOptions(ch === null && executablePath ? { ...base, executablePath: undefined } : base, rest, ch);
    return chromium.launch(options);
  });
  return { browser: result, channel };
}

export interface ChromeUserAgentOptions {
  /** Chrome's version. Default "142.0.0.0". A UA far behind the real browser is a mismatch sites notice. */
  version?: string;
  /** Default "windows". */
  os?: "windows" | "mac" | "linux";
}

/** A desktop Chrome user agent, for a context that must send a fixed one. Prefer the real browser's own when it can be used. */
export function chromeUserAgent(opts: ChromeUserAgentOptions = {}): string {
  const version = opts.version ?? "142.0.0.0";
  const platform =
    opts.os === "mac" ? "Macintosh; Intel Mac OS X 10_15_7" : opts.os === "linux" ? "X11; Linux x86_64" : "Windows NT 10.0; Win64; x64";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

/** Headless Chrome says "HeadlessChrome/"; the same browser with that token turned back into "Chrome/". */
export function headfulUserAgent(ua: string): string {
  return ua.replace(/HeadlessChrome\//g, "Chrome/");
}
