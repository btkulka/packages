// The slices of Electron's main-process objects this package touches. The
// app passes in its own `app`, `BrowserWindow`, `screen`, `shell`…; these
// interfaces only name the members used, so any Electron from 28 up fits and
// tests can pass fakes. They deliberately avoid Electron's own types: those
// come from whichever Electron the package was built against, and an app on an
// older one would fail to type-check against them.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WebContentsLike {
  isDestroyed(): boolean;
  send(channel: string, ...args: any[]): void;
}

/** A window that can be sent to. */
export interface SendTarget {
  isDestroyed(): boolean;
  readonly webContents: WebContentsLike;
}

/** Something that lists every open window, like Electron's BrowserWindow class. */
export interface WindowList<W = SendTarget> {
  getAllWindows(): W[];
}

/** A window that can be brought forward. */
export interface RevealTarget {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export interface ScreenLike {
  getAllDisplays(): Array<{ workArea: Rect }>;
  getPrimaryDisplay(): { workArea: Rect };
}

export interface EmitterLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface AppEmitterLike extends EmitterLike {
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
}
