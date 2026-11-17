# @btkulka/ui-kit

The controls Ben's web apps share, in React, themed by CSS variables. Built for Gourmet Guru (its "Hearth" look is one theme) and meant for any app of Ben's that wants the same feel.

**The feel:** things settle and never bounce: a press sinks to 97% in 120ms, thumbs and sheets glide over 240–280ms on one easing (`cubic-bezier(0.2, 0.8, 0.2, 1)`), leaving uses a quicker ease-in. Swipes and sheet drags follow the finger 1:1 and then settle. Under reduced motion nothing moves; there are only fades. Everything tappable is 44px or more. Inputs are 16px so iOS never zooms, hover styles apply only where a pointer can hover (iOS keeps `:hover` on after a tap), and long press is a pointer timer, because Safari never fires `contextmenu` on touch.

## Use

```json
"dependencies": { "@btkulka/ui-kit": "file:../packages/ui-kit" }
```

```ts
import "@btkulka/ui-kit/styles.css"; // before the app's own CSS
import { Button, Sheet, Segmented, ToastProvider } from "@btkulka/ui-kit";
```

React is a peer. An app on Vite linking this folder needs one copy of React: `resolve: { dedupe: ["react", "react-dom"] }` (Gourmet Guru adds it in `vite.config.ts`, and as a tiny plugin in its dev server).

Theme it by setting the `--ui-*` variables after the kit's stylesheet: `--ui-bg`, `--ui-surface`(`-2`, `-3`), `--ui-field`, `--ui-line`(`-2`), `--ui-ink`(`-2`, `-3`), `--ui-label`, `--ui-accent` (`-hi`, `-ink`, `-soft`, `-line`, `-text`), the same five for `good`, `warn` and `danger`, `--ui-font`, `--ui-display` (and `-weight`, `-tracking`), the radii `--ui-r-sheet`/`-card`/`-field`, `--ui-tabbar-bg`, `--ui-sheet-bg`, `--ui-toast-bg`, `--ui-compact-bg`, `--ui-toast-bottom`. Gourmet Guru's `src/styles.css` maps its Hearth tokens onto all of them.

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

`npm run build` (dual ESM and CommonJS, plus `dist/styles.css`), `npm test` (the logic tests). Apps load `dist/`, so build after a change. The look is drawn on the Gourmet Guru canvas's Controls board in Claude Design.
