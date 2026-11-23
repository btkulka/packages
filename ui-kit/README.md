# @btkulka/ui-kit

The controls Ben's web apps share, in React, themed by CSS variables. Built for Gourmet Guru and meant for any app of Ben's that wants the same feel. It looks like Benhäus out of the box; each app gives it its own design system.

**The feel:** things settle and never bounce: a press sinks to 97% in 120ms, thumbs and sheets glide over 240–280ms on one easing (`cubic-bezier(0.2, 0.8, 0.2, 1)`), leaving uses a quicker ease-in. Swipes and sheet drags follow the finger 1:1 and then settle. Under reduced motion nothing moves; there are only fades. Everything tappable is 44px or more. Inputs are 16px so iOS never zooms, hover styles apply only where a pointer can hover (iOS keeps `:hover` on after a tap), and long press is a pointer timer, because Safari never fires `contextmenu` on touch.

## Use

```json
"dependencies": { "@btkulka/ui-kit": "file:../packages/ui-kit" }
```

```ts
import "@btkulka/ui-kit/styles.css"; // before the app's own CSS
import { Button, Sheet, Segmented, ToastProvider } from "@btkulka/ui-kit";
```

React is a peer. An app on Vite linking this folder needs one copy of React: `resolve: { dedupe: ["react", "react-dom"] }` (Gourmet Guru adds it in `vite.config.ts`, and as a tiny plugin in its dev server). The kit's types are React 19's, so the app should be on React 19 too.

In dev, Vite serves only files it resolved itself from outside the app's folder, and the stylesheet's `url()`s (the `midnight` and `daylight` fonts) aren't among them: allow the packages folder, `server: { fs: { allow: [appRoot, "../packages"] } }` (album-choice-ranker passes it from its app-server plugin). `vite build` needs nothing.

## Themes

Every piece reads `--ui-*` variables. The stylesheet ships four stock themes, each a `[data-ui-theme="<id>"]` block that sets every token, named for how they look rather than whose they are:

| Theme | Look |
| --- | --- |
| `midnight` (default) | Benhäus's night look: black ground, quiet surfaces, gold for the primary action and focus, navy for what's selected (the tab bar's pill), Inter and Inter Tight (shipped in `dist/fonts/`). Plain `:root` gets it too, so an app that sets nothing looks like Benhäus. |
| `daylight` | Benhäus's day look: the same gold and navy on light grey and white. |
| `graphite` | Graphite with a blue accent: the kit's first look, before themes. |
| `ember` | A warm room after dark (Gourmet Guru's Hearth): walnut, terracotta, candle amber, sage, berry; Figtree and Newsreader when the app loads them. |

Pick one with `<html data-ui-theme="graphite">` in `index.html`, or in code:

```ts
import { setUiTheme, UI_THEMES } from "@btkulka/ui-kit";
setUiTheme("daylight");                                 // data-ui-theme on <html>
setUiTheme("ember", document.querySelector("#preview")!); // or on one part of the page
```

`UI_THEMES` lists them (id, label, light or dark, a line about it), `getUiTheme()` reads the current one, `DEFAULT_UI_THEME` is `"midnight"`, `UI_TOKENS` lists every token.

### Customizing a theme for an app

Any app can make a stock theme its own. Set tokens in the app's stylesheet, after the kit's:

```css
/* src/theme.css: graphite, in this app's violet */
:root {
  --ui-accent: #8b5cf6;
  --ui-accent-hi: #a78bfa;
  --ui-accent-ink: #ffffff;
  --ui-accent-text: #ddd6fe;
  --ui-focus: #a78bfa;
}
```

- Put them on `:root` to change whatever theme is chosen, or on `[data-ui-theme="graphite"]` to change only that one (an app offering day and night can tune each).
- The `-soft` and `-line` tints are mixed from their base colour (`color-mix`), so `--ui-accent` alone re-tints soft fills and outlines. Set `-hi`, `-ink` (text on a filled control) and `-text` too when the new colour needs them; `-ink` especially, when the new accent is light where the old was dark or the other way round.
- Anything can be changed: surfaces, ink, fonts, radii, shadows, the tab bar. Gourmet Guru maps its whole Hearth palette this way.
- For what changes while the app runs (a user's colour, a settings screen), `customizeUiTheme({ "--ui-accent": "#8b5cf6" })` sets the tokens on `<html>` (or a given element) over the theme, and `null` takes one off again.

The tokens: `--ui-bg`, `--ui-surface`(`-2`, `-3`), `--ui-field`, `--ui-line`(`-2`), `--ui-ink`(`-2`, `-3`), `--ui-label`, `--ui-placeholder`, `--ui-accent` (`-hi`, `-ink`, `-soft`, `-line`, `-text`), the same but `-hi` for `good`, `warn` and `danger`, `--ui-font`, `--ui-display` (and `-weight`, `-tracking`), the radii `--ui-r-sheet`/`-card`/`-field`, `--ui-highlight`, `--ui-shadow`(`-lift`), `--ui-focus`, `--ui-backdrop`, `--ui-sheet-bg`, `--ui-toast-bg`, `--ui-toast-error`, `--ui-tabbar-bg`/`-pill`/`-ink`, `--ui-compact-bg`, and `color-scheme`. `--ui-toast-bottom` and the easings are mechanics, the same under every theme; an app may still move the toasts.

## Adding it to an app

Installing the kit means giving the app a design system of its own. Until it has one, it looks like Benhäus, which is fine for a first run and wrong for a finished app.

1. Add the dependency, `import "@btkulka/ui-kit/styles.css"` before the app's own CSS, and dedupe React (above).
2. **Create the app's design system.** Claude does this as part of installing the kit, without being asked. Make it on Claude Design: a Design System artifact built from the app's look as it stands, or from the Benhäus design system for a new app (tokens, type, the controls as cards). Then bring it into the app: pick the stock theme nearest to it and customize that in the app's own stylesheet (above), with `data-ui-theme` on `<html>`. The customization lives in the app.
3. Record both in the app's CLAUDE.md: the design system's link, the base theme, and that a token or control changed in one is changed in the other.
4. Use the kit's controls in place of the app's own buttons, switches, fields, segmented choices, banners and confirm steps.

The app's own classes (Tailwind, CSS modules) can read the same tokens (`var(--ui-accent)`), so the app and the kit never drift apart.

## What's in it

| Piece | What it does |
|---|---|
| `Button` | primary, secondary, quiet, good, danger; sm/md/lg; an icon; `busy` keeps its width and swaps the icon for a spinner |
| `IconButton` | round, icon only, still named (`label`) |
| `ConfirmButton` | destructive without a dialog: the first tap arms it ("Delete?", filled, a bar draining 3s), the second does it; leaving or Escape disarms. With no words of its own it's just its icon until armed |
| `Check` | the round checkbox: the tick draws itself, a little pop, a 44px target around 30px |
| `Switch`, `SwitchRow` | a switch whose thumb squishes while pressed; a whole row that flips one |
| `Segmented` | choices (or tabs) with a thumb that slides; arrow keys; scrolls sideways and keeps the pick in view |
| `TileGroup` | big drawn choices in a grid, one lit |
| `Chip`, `RemovableChip` | filter, toggle (tick slides in) or quick add (`pop="+1"` floats up from the tap) |
| `TagInput` | tags as chips: Enter, comma or Tab adds; paste "a, b, c" adds three; Backspace lights the last, then removes it; suggestions with arrow keys |
| `Stepper` | a number without the number keyboard: − and + (hold to repeat, faster), arrow keys, typing "1 1/2" or "½" |
| `TextField`, `SearchField`, `TextArea`, `Select`, `Field` | icon, clear button, `onCommit` (blur or Enter, only when changed); Escape empties a search; a text area that grows; a native select dressed to match (phones keep their wheel) |
| `TokenField` | a field for lists ("2 avocados, spin") that finishes the word after the last comma from your suggestions; a tap keeps the keyboard up |
| `DateStrip` | a day in one tap: the next two weeks as chips, a calendar chip for later, past or far days shown as their own chip |
| `Sheet` | bottom sheet on phones, centred panel on wide screens; follows a drag down from its handle or title (past 120px or a flick closes it); sinks out however it closes; focus stays inside; Escape closes the top one only; keyboard-aware (fits the space above the phone's keyboard and keeps the focused field in view); Enter on a field marked `enterKeyHint="next"` moves on; an optional `hero` picture; `initialFocus` only on desktop by default, so phones keep their keyboard down |
| `Menu`, `useContextMenu`, `useLongPress`, `MenuButton` | one menu for long press (a finger, 450ms), right-click and the menu key or Shift+F10: an action sheet on touch, a popover with a mouse; arrow keys, first-letter jumps, ticks, headings, separators, danger tones |
| `SwipeRow` | swipe right for one action, left for another; buzzes when it would commit, flies off or springs back; leaves vertical scrolling alone; takes a `menu` too |
| `AnimatedList` | rows unfold in, fold their height away when they go, and glide to new places on a re-sort; leaving rows can't be tapped; a big swap (a filter) just swaps |
| `ToastProvider`, `useToasts` | toasts that rise in and fold away, an action (Undo) with a draining timer that pauses on touch, hover or focus; swipe one aside to dismiss |
| `TabBar` | a floating bar on phones, a rail from 900px, with a pill that glides to the current section; hides while a phone's keyboard is up |
| `PageHeader` | a screen's big title, and a slim sticky bar that slides down with the title and key actions once it scrolls away; tap the bar to go back to the top |
| `Disclosure` | opens by height, folds away |
| `Spinner`, `Skeleton`, `Banner`, `Tag`, `EmptyState`, `Avatar`, `Row` | the small things, all toned (neutral, accent, good, warn, danger) |
| `SvgIcon`, `IconBadge`, `IconPicker` | icons as data (`IconDef`: SVG for a 24px box), a tinted badge, and a searchable, grouped picker sheet with "automatic" first |
| `useKeyboardAware`, `useHotkey`, `useRepeat`, `useLatest`, `useResize`, `cx`, `mergeRefs` | the plumbing: `ui-keyboard-open` on the body while a phone's keyboard is up; page shortcuts ("/" to search) that stay quiet while typing or under a sheet; press-and-hold |
| `motion`, `fold`, `unfold`, `haptic`, `reducedMotion`, `EASE` | Web Animations that respect reduced motion; a light vibration where the device has one |
| `parseAmount`, `stepValue`, `splitTags`, `addTags`, `swipeOutcome`, `mergePresence`, `currentToken`, `completeToken`, `rankSuggestions`, ISO day helpers, `initials`, `hueFor` | the decisions as plain functions, tested on their own (`src/logic.test.ts`) |

## Working on it

`npm run build` (dual ESM and CommonJS, plus `dist/styles.css` and `dist/fonts/`), `npm test` (the logic tests, and the theme checks: every theme listed and in the stylesheet, every theme setting every token). Inter and Inter Tight are under the SIL Open Font License, copied from the Benhäus design system. Apps load `dist/`, so build after a change. The look is drawn on the Gourmet Guru canvas's Controls board in Claude Design.
