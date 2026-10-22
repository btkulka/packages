/** A window or webContents: both load pages the same way. */
export interface Loadable {
  loadURL(url: string): Promise<void>;
  loadFile(filePath: string, options?: { query?: Record<string, string>; hash?: string }): Promise<void>;
}

export interface RendererSource {
  /**
   * The dev server, when there is one: electron-vite sets
   * process.env.ELECTRON_RENDERER_URL; other apps use their own variable or
   * a fixed http://localhost:5173 when NODE_ENV is "development". Empty or
   * unset means load the file.
   */
  devUrl?: string | null;
  /** The built index.html, absolute. */
  file: string;
  /** Query parameters for the page (?popout=…), on the dev URL and the file alike. Values are encoded. */
  query?: Record<string, string>;
  /** Hash for the page, without the "#". */
  hash?: string;
}

/**
 * The dev URL with the query and hash added (existing query parameters are
 * kept). Values are encoded with encodeURIComponent, as loadFile's are, so the
 * page reads the same thing in dev and packaged.
 */
export function devServerUrl(devUrl: string, query?: Record<string, string>, hash?: string): string {
  const url = new URL(devUrl);
  const extra = Object.entries(query ?? {})
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  if (extra) url.search = url.search ? `${url.search}&${extra}` : `?${extra}`;
  if (hash) url.hash = hash;
  return url.toString();
}

/**
 * Load the renderer: the dev server in development, the built file otherwise.
 * Resolves (or rejects) with Electron's load.
 *
 *   loadRenderer(win, { devUrl: process.env.ELECTRON_RENDERER_URL, file: join(__dirname, "../renderer/index.html") });
 */
export function loadRenderer(target: Loadable, source: RendererSource): Promise<void> {
  const { devUrl, file, query, hash } = source;
  if (devUrl) return target.loadURL(devServerUrl(devUrl, query, hash));
  const options: { query?: Record<string, string>; hash?: string } = {};
  if (query && Object.keys(query).length) options.query = query;
  if (hash) options.hash = hash;
  return Object.keys(options).length ? target.loadFile(file, options) : target.loadFile(file);
}
