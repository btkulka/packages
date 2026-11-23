import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_UI_THEME, UI_THEMES, UI_TOKENS, customizeUiTheme, getUiTheme, setUiTheme } from "./themes.js";

// Tests run from the package folder on the built dist/ (npm test builds first).
const css = readFileSync("dist/styles.css", "utf8");

/** The --ui-* tokens a theme block sets, by theme id. */
function themeBlocks(): Map<string, Set<string>> {
  const blocks = new Map<string, Set<string>>();
  for (const m of css.matchAll(/((?:[^{}]*\[data-ui-theme="[\w-]+"\][^{}]*))\{([^}]*)\}/g)) {
    const tokens = new Set([...m[2].matchAll(/(--ui-[\w-]+)\s*:/g)].map((t) => t[1]));
    for (const id of m[1].matchAll(/\[data-ui-theme="([\w-]+)"\]/g)) blocks.set(id[1], tokens);
  }
  return blocks;
}

test("every listed theme has a block in the stylesheet, and every block is listed", () => {
  assert.deepEqual([...themeBlocks().keys()].sort(), UI_THEMES.map((t) => t.id).sort());
});

test("every theme sets exactly the tokens UI_TOKENS lists, so a theme works on any element and any token can be customized", () => {
  const listed = new Set<string>(UI_TOKENS);
  for (const [id, tokens] of themeBlocks()) {
    const missing = [...listed].filter((t) => !tokens.has(t));
    const extra = [...tokens].filter((t) => !listed.has(t));
    assert.deepEqual({ id, missing, extra }, { id, missing: [], extra: [] });
  }
});

test("the default theme is also what plain :root gets", () => {
  assert.equal(DEFAULT_UI_THEME, "midnight");
  assert.match(css, /:root,\s*\[data-ui-theme="midnight"\]\s*\{/);
});

test("soft and line tints are mixed from their base colour, so customizing the base re-tints them", () => {
  for (const tone of ["accent", "good", "warn", "danger"]) {
    for (const kind of ["soft", "line"]) {
      const decls = [...css.matchAll(new RegExp(`--ui-${tone}-${kind}:\\s*([^;]+);`, "g"))].map((m) => m[1]);
      assert.equal(decls.length, UI_THEMES.length, `--ui-${tone}-${kind} in every theme`);
      for (const d of decls) assert.match(d, new RegExp(`^color-mix\\(in srgb, var\\(--ui-${tone}\\) \\d+%, `), d);
    }
  }
});

test("theme names say what they look like, not whose they are", () => {
  for (const t of UI_THEMES) assert.doesNotMatch(t.id, /benhaus|hearth|guru|fridge/i, t.id);
});

test("the Benhäus fonts ship beside the stylesheet", () => {
  for (const file of ["Inter-Variable.woff2", "InterTight-Variable.woff2"]) {
    assert.ok(readFileSync(`dist/fonts/${file}`).length > 10_000, file);
    assert.ok(css.includes(`./fonts/${file}`), `${file} is referenced`);
  }
});

function fakeElement() {
  const attrs = new Map<string, string>();
  const props = new Map<string, string>();
  const el = {
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    style: {
      setProperty: (k: string, v: string) => void props.set(k, v),
      removeProperty: (k: string) => void props.delete(k),
    },
  } as unknown as Element;
  return { el, attrs, props };
}

test("setUiTheme and getUiTheme read and write the attribute on an element", () => {
  const { el, attrs } = fakeElement();
  assert.equal(getUiTheme(el), "midnight");
  setUiTheme("daylight", el);
  assert.equal(attrs.get("data-ui-theme"), "daylight");
  assert.equal(getUiTheme(el), "daylight");
});

test("customizeUiTheme lays tokens over the theme and takes them off again", () => {
  const { el, props } = fakeElement();
  customizeUiTheme({ "--ui-accent": "#8b5cf6", "--ui-accent-ink": "#ffffff" }, el);
  assert.equal(props.get("--ui-accent"), "#8b5cf6");
  assert.equal(props.get("--ui-accent-ink"), "#ffffff");
  customizeUiTheme({ "--ui-accent": null }, el);
  assert.equal(props.has("--ui-accent"), false);
  assert.equal(props.get("--ui-accent-ink"), "#ffffff");
});
