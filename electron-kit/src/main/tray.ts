export interface ImageLike {
  isEmpty(): boolean;
}

export interface TrayLike {
  setToolTip(toolTip: string): void;
  setContextMenu(menu: any): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  destroy(): void;
  isDestroyed(): boolean;
}

/** Pass Electron's { Tray, Menu, nativeImage }. */
export interface TrayModules {
  Tray: new (image: any) => TrayLike;
  Menu: { buildFromTemplate(template: any[]): unknown };
  nativeImage: {
    createFromPath(path: string): ImageLike;
    createFromDataURL(dataURL: string): ImageLike;
  };
}

export interface TrayOptions {
  /**
   * The icon: a file path, candidate paths (the first that loads wins: the
   * packaged location, then the dev one), a data: URL, or a nativeImage.
   * Use an .ico on Windows for a sharp icon at every DPI.
   */
  icon: string | readonly string[] | ImageLike;
  /** Used when no `icon` loads (a missing file reads as an empty image). Without it, createTray returns null then. */
  fallbackIcon?: string | ImageLike;
  tooltip: string;
  /**
   * The context menu's items, handed to Menu.buildFromTemplate. Called again by
   * refresh(). Annotate the function as `(): MenuItemConstructorOptions[]` to
   * have Electron's types check the items.
   */
  menu: () => readonly object[];
  /** Single click (Windows opens the context menu on right-click by itself). */
  onClick?: () => void;
  onDoubleClick?: () => void;
}

export interface TrayHandle {
  readonly tray: TrayLike;
  /** Rebuild the context menu from options.menu(), after its labels changed. */
  refresh(): void;
  /** Remove the icon. Call it on quit, or Windows can leave a ghost icon in the tray. Safe to call twice. */
  destroy(): void;
}

function load(nativeImage: TrayModules["nativeImage"], source: string | ImageLike): ImageLike | undefined {
  try {
    const img =
      typeof source !== "string" ? source : /^data:/i.test(source) ? nativeImage.createFromDataURL(source) : nativeImage.createFromPath(source);
    return img && !img.isEmpty() ? img : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A notification-area icon with a tooltip, a context menu and click handlers.
 * Returns null when no icon loads and there is no fallback.
 */
export function createTray(electron: TrayModules, opts: TrayOptions): TrayHandle | null {
  const candidates: Array<string | ImageLike> =
    typeof opts.icon === "string" ? [opts.icon] : Array.isArray(opts.icon) ? [...(opts.icon as readonly string[])] : [opts.icon as ImageLike];
  if (opts.fallbackIcon) candidates.push(opts.fallbackIcon);
  let image: ImageLike | undefined;
  for (const c of candidates) if ((image = load(electron.nativeImage, c))) break;
  if (!image) return null;

  const tray = new electron.Tray(image);
  tray.setToolTip(opts.tooltip);
  const refresh = () => {
    if (!tray.isDestroyed()) tray.setContextMenu(electron.Menu.buildFromTemplate([...opts.menu()]));
  };
  refresh();
  if (opts.onClick) tray.on("click", opts.onClick);
  if (opts.onDoubleClick) tray.on("double-click", opts.onDoubleClick);
  return {
    tray,
    refresh,
    destroy: () => {
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
