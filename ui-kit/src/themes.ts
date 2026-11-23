// The stock themes styles.css ships, each a [data-ui-theme="<id>"] block setting every --ui-* token, under
// names that say what they look like rather than whose they are. midnight (Benhäus's night look) is the
// default: plain :root gets it too, so an app that sets nothing looks like Benhäus.
//
// Any app can customize the theme it picks: tokens set in its own stylesheet after the kit's (on :root, or on
// [data-ui-theme="<base>"] for one theme only), or at run time with customizeUiTheme. The -soft and -line
// tints are mixed from their base colour, so changing --ui-accent alone re-tints the accent everywhere.

export interface UiTheme {
  id: string;
  label: string;
  scheme: "dark" | "light";
  description: string;
}

export const UI_THEMES = [
  {
    id: "midnight",
    label: "Midnight",
    scheme: "dark",
    description: "Benhäus's night look, the default: black ground, gold for the primary action and focus, navy for what's selected, Inter and Inter Tight.",
  },
  {
    id: "daylight",
    label: "Daylight",
    scheme: "light",
    description: "Benhäus's day look: the same gold and navy on light grey and white.",
  },
  {
    id: "graphite",
    label: "Graphite",
    scheme: "dark",
    description: "Graphite with a blue accent: the kit's first look.",
  },
  {
    id: "ember",
    label: "Ember",
    scheme: "dark",
    description: "A warm room after dark (Gourmet Guru's Hearth): walnut, terracotta, candle amber and sage.",
  },
] as const satisfies readonly UiTheme[];

export type UiThemeId = (typeof UI_THEMES)[number]["id"];

export const DEFAULT_UI_THEME: UiThemeId = "midnight";

/** The attribute the stylesheet's theme blocks key on. */
export const UI_THEME_ATTRIBUTE = "data-ui-theme";

const TONES = ["accent", "good", "warn", "danger"] as const;

/** Every token a theme sets: what an app can customize. */
export const UI_TOKENS = [
  "--ui-bg",
  "--ui-surface",
  "--ui-surface-2",
  "--ui-surface-3",
  "--ui-field",
  "--ui-line",
  "--ui-line-2",
  "--ui-ink",
  "--ui-ink-2",
  "--ui-ink-3",
  "--ui-label",
  "--ui-placeholder",
  "--ui-accent-hi",
  ...TONES.flatMap((t) => [`--ui-${t}`, `--ui-${t}-ink`, `--ui-${t}-soft`, `--ui-${t}-line`, `--ui-${t}-text`] as const),
  "--ui-font",
  "--ui-display",
  "--ui-display-weight",
  "--ui-display-tracking",
  "--ui-r-sheet",
  "--ui-r-card",
  "--ui-r-field",
  "--ui-highlight",
  "--ui-shadow",
  "--ui-shadow-lift",
  "--ui-focus",
  "--ui-backdrop",
  "--ui-sheet-bg",
  "--ui-toast-bg",
  "--ui-toast-error",
  "--ui-tabbar-bg",
  "--ui-tabbar-pill",
  "--ui-tabbar-ink",
  "--ui-compact-bg",
] as const;

export type UiToken = (typeof UI_TOKENS)[number];

/** Token values to lay over a theme; null takes an earlier customization off again. */
export type UiTokenOverrides = Partial<Record<UiToken, string | null>>;

const pageRoot = (el?: Element): Element | undefined => el ?? (typeof document === "undefined" ? undefined : document.documentElement);

/**
 * Puts a theme on an element: the whole page by default (<html>). Without a document (server rendering) it
 * does nothing. A name the kit doesn't ship falls back to midnight's tokens (plain :root).
 */
export function setUiTheme(theme: UiThemeId | (string & {}), el?: Element): void {
  pageRoot(el)?.setAttribute(UI_THEME_ATTRIBUTE, theme);
}

/** The theme on an element (the page by default), or the default when none is set. */
export function getUiTheme(el?: Element): string {
  return pageRoot(el)?.getAttribute(UI_THEME_ATTRIBUTE) || DEFAULT_UI_THEME;
}

/**
 * Customizes the theme at run time (a settings screen, a user's colour): sets the given tokens as inline custom
 * properties on the element (the page by default), over whichever theme it has. null removes one. For an app's
 * fixed look, set the tokens in its stylesheet instead; this is for what changes while it runs.
 */
export function customizeUiTheme(tokens: UiTokenOverrides, el?: Element): void {
  const style = (pageRoot(el) as HTMLElement | undefined)?.style;
  if (!style) return;
  for (const [token, value] of Object.entries(tokens)) {
    if (value == null) style.removeProperty(token);
    else style.setProperty(token, value);
  }
}
