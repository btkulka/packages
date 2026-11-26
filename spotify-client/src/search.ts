// A Spotify search box for any app's page: type a few letters and pick a track,
// album, artist, playlist, podcast or episode from the list, instead of pasting
// a link. Plain DOM, no framework, so a vanilla renderer (Track Lab) and a React
// page (through a ref) can both use it. Style it with "@btkulka/spotify-client/search.css".
//
// It never holds a key itself: it searches through a `source`, which is a
// SpotifyClient in a browser app that has the credentials, or an object whose
// searchItems asks the app's backend (an Electron renderer goes through IPC).

import { parseSpotifyLink } from "./ids.js";
import {
  SPOTIFY_SEARCH_TYPES,
  SPOTIFY_TYPE_LABELS,
  type SpotifyItem,
  type SpotifyItemSearchResult,
  type SpotifySearchType,
} from "./items.js";

/** Where results come from. A SpotifyClient fits as it is. */
export interface SpotifySearchSource {
  searchItems(
    query: string,
    options: { types: SpotifySearchType[]; limit: number; offset: number; market?: string },
  ): Promise<SpotifyItemSearchResult>;
  /** Resolves a pasted link to its item. Without it a pasted link picks a bare item (no name or image). */
  getItem?(type: SpotifySearchType, id: string, options?: { market?: string }): Promise<SpotifyItem | null>;
}

/** What a failed search shows: a sentence, and optionally a button (e.g. one that opens Settings). */
export type SpotifySearchErrorView = string | { message: string; action?: { label: string; run(): void } };

export interface SpotifySearchOptions {
  source: SpotifySearchSource;
  /** Called with what was picked from the list, or with the item a pasted link points at. */
  onSelect(item: SpotifyItem): void;
  /** The kinds this box offers. Default: all six. With more than one, chips above the list filter by kind. */
  types?: readonly SpotifySearchType[];
  /** The chip selected at the start: "all" (the default with several kinds) or one kind. */
  type?: SpotifySearchType | "all";
  /**
   * Use a field the page already has instead of drawing one. The chips and the list go
   * in the container; put it just under the field. The field's own listeners keep working:
   * the box only takes Enter, Escape and the arrow keys while its list is open.
   */
  input?: HTMLInputElement;
  /** The drawn field's placeholder. Default: "Search Spotify" or "Search Spotify playlists". */
  placeholder?: string;
  /** The drawn field's accessible name. Default: the placeholder. */
  label?: string;
  /** Results per page with one kind chosen. Default 10. */
  limit?: number;
  /** Results per kind under "All". Default 4. */
  previewLimit?: number;
  /** ISO country code: only what's playable there. */
  market?: string;
  /** Wait after the last keystroke. Default 250 ms. */
  debounceMs?: number;
  /** Shortest text that searches. Default 2. */
  minLength?: number;
  /** Text the box should leave alone (return true), e.g. a SoundCloud link the page handles itself. */
  ignore?(text: string): boolean;
  /** Put the picked item's name in the field. Default: true for the drawn field, false for one passed in. */
  fillOnSelect?: boolean;
  /** Turn a failed search into what the list says. Default: the error's message. */
  describeError?(error: unknown): SpotifySearchErrorView;
  /** Show "Results from Spotify" with the logo under the list, as Spotify's design guidelines ask. Default true. */
  attribution?: boolean;
}

export interface SpotifySearchHandle {
  /** The box's own element (field when drawn, chips, list). */
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  /** The chosen chip. */
  readonly type: SpotifySearchType | "all";
  /** Change the kinds offered (and the chips). */
  setTypes(types: readonly SpotifySearchType[]): void;
  /** Choose a chip, and search again for the current text. */
  setType(type: SpotifySearchType | "all"): void;
  /** Put text in the field and search for it now. */
  search(text: string): void;
  /** Empty the field and the list. */
  clear(): void;
  close(): void;
  focus(): void;
  /** Remove everything the box added and its listeners. A passed-in field stays. */
  destroy(): void;
}

let instances = 0;

const SPOTIFY_PATH =
  "M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z";

/** Line icons (24px grid) for a result without an image. */
const TYPE_ICON: Record<SpotifySearchType, string> = {
  track: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  album: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>',
  artist: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  playlist: '<path d="M3 6h13M3 12h13M3 18h8"/><path d="M17 18V10l4-1"/><circle cx="15" cy="18" r="2"/>',
  show: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/>',
  episode: '<circle cx="12" cy="12" r="10"/><path d="m10 8 6 4-6 4z"/>',
};

const SEARCH_ICON = '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>';
const CLEAR_ICON = '<path d="M18 6 6 18M6 6l12 12"/>';

function svg(paths: string, className: string): string {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  // Electron prefixes errors that crossed IPC; the person doesn't need that part.
  return message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "") || "Spotify search didn't work.";
}

/** Draws a Spotify search box in `container` and returns its controls. */
export function mountSpotifySearch(container: HTMLElement, options: SpotifySearchOptions): SpotifySearchHandle {
  const uid = `sps-${++instances}`;
  const ownInput = !options.input;
  const limit = Math.min(50, Math.max(1, options.limit ?? 10));
  const previewLimit = Math.min(50, Math.max(1, options.previewLimit ?? 4));
  const debounceMs = options.debounceMs ?? 250;
  const minLength = Math.max(1, options.minLength ?? 2);
  const fillOnSelect = options.fillOnSelect ?? ownInput;
  const describe = options.describeError ?? errorText;

  let types = cleanTypes(options.types);
  let filter: SpotifySearchType | "all" = pickFilter(options.type);

  // ---- elements ----
  const root = el("div", `sps${ownInput ? "" : " sps--attached"}`);
  root.id = uid;
  let input: HTMLInputElement;
  let clearBtn: HTMLButtonElement | null = null;
  if (options.input) {
    input = options.input;
  } else {
    const field = el("div", "sps-field");
    field.insertAdjacentHTML("afterbegin", svg(SEARCH_ICON, "sps-field-icon"));
    input = el("input", "sps-input");
    input.type = "search";
    input.autocomplete = "off";
    input.spellcheck = false;
    clearBtn = el("button", "sps-clear");
    clearBtn.type = "button";
    clearBtn.hidden = true;
    clearBtn.setAttribute("aria-label", "Clear the search");
    clearBtn.innerHTML = svg(CLEAR_ICON, "sps-clear-icon");
    field.append(input, clearBtn);
    root.append(field);
  }
  const chips = el("div", "sps-chips");
  chips.setAttribute("role", "radiogroup");
  chips.setAttribute("aria-label", "Search for");
  const panel = el("div", "sps-panel");
  panel.hidden = true;
  const list = el("div", "sps-list");
  list.id = `${uid}-list`;
  list.setAttribute("role", "listbox");
  const status = el("div", "sps-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.hidden = true;
  panel.append(status, list);
  if (options.attribution ?? true) {
    const credit = el("div", "sps-credit");
    credit.innerHTML = `<svg class="sps-credit-logo" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${SPOTIFY_PATH}"/></svg><span>Results from Spotify</span>`;
    panel.append(credit);
  }
  root.append(chips, panel);
  container.append(root);

  // Combobox semantics on whichever field it is; restored on destroy.
  const savedAttrs = ["role", "aria-autocomplete", "aria-expanded", "aria-controls", "aria-activedescendant", "placeholder", "aria-label"].map(
    (name) => [name, input.getAttribute(name)] as const,
  );
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", list.id);
  if (ownInput) {
    const placeholder = options.placeholder ?? defaultPlaceholder();
    input.placeholder = placeholder;
    input.setAttribute("aria-label", options.label ?? placeholder);
  } else if (options.placeholder) {
    input.placeholder = options.placeholder;
  }

  // ---- state ----
  type View = { text: string; filter: SpotifySearchType | "all"; result: SpotifyItemSearchResult; offsets: Partial<Record<SpotifySearchType, number>> };
  const cache = new Map<string, SpotifyItemSearchResult>();
  let view: View | null = null;
  /** The items in the list, in order; a row's data-index points in here. */
  let shown: SpotifyItem[] = [];
  let active = -1;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  renderChips();

  // ---- helpers ----
  function cleanTypes(t: readonly SpotifySearchType[] | undefined): SpotifySearchType[] {
    const out = (t ?? SPOTIFY_SEARCH_TYPES).filter((k, i, all) => SPOTIFY_SEARCH_TYPES.includes(k) && all.indexOf(k) === i);
    return out.length ? out : [...SPOTIFY_SEARCH_TYPES];
  }

  function pickFilter(t: SpotifySearchType | "all" | undefined): SpotifySearchType | "all" {
    if (types.length === 1) return types[0]!;
    return t && t !== "all" && types.includes(t) ? t : "all";
  }

  function defaultPlaceholder(): string {
    if (types.length === 1) return `Search Spotify ${SPOTIFY_TYPE_LABELS[types[0]!].many.toLowerCase()}`;
    return "Search Spotify";
  }

  function readable(list: readonly SpotifySearchType[]): string {
    const words = list.map((t) => SPOTIFY_TYPE_LABELS[t].many.toLowerCase());
    return words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}` : words[0] ?? "";
  }

  function renderChips() {
    chips.textContent = "";
    chips.hidden = types.length < 2;
    if (types.length < 2) return;
    const entries: [SpotifySearchType | "all", string][] = [["all", "All"], ...types.map((t) => [t, SPOTIFY_TYPE_LABELS[t].many] as [SpotifySearchType, string])];
    for (const [value, text] of entries) {
      const chip = el("button", "sps-chip", text);
      chip.type = "button";
      chip.dataset.type = value;
      chip.setAttribute("role", "radio");
      chip.setAttribute("aria-checked", String(value === filter));
      chip.tabIndex = value === filter ? 0 : -1;
      chips.append(chip);
    }
  }

  function open() {
    if (panel.hidden) {
      panel.hidden = false;
      input.setAttribute("aria-expanded", "true");
      root.classList.add("is-open");
    }
  }

  function close() {
    if (!panel.hidden) {
      panel.hidden = true;
      input.setAttribute("aria-expanded", "false");
      root.classList.remove("is-open");
    }
    setActive(-1);
  }

  function setStatus(text: string, tone: "" | "error" | "busy" = "", action?: { label: string; run(): void }) {
    status.textContent = "";
    status.className = `sps-status${tone ? ` is-${tone}` : ""}`;
    status.hidden = !text;
    if (!text) return;
    status.append(el("span", "sps-status-text", text));
    if (action) {
      const b = el("button", "sps-status-action", action.label);
      b.type = "button";
      b.addEventListener("click", () => action.run());
      status.append(b);
    }
  }

  function setActive(i: number) {
    const rows = list.querySelectorAll<HTMLElement>(".sps-option");
    rows.forEach((r, n) => r.classList.toggle("is-active", n === i));
    active = i >= 0 && i < rows.length ? i : -1;
    if (active >= 0) {
      const row = rows[active]!;
      input.setAttribute("aria-activedescendant", row.id);
      row.scrollIntoView?.({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function key(text: string, f: SpotifySearchType | "all", offset: number) {
    return `${f}|${offset}|${text.toLowerCase()}`;
  }

  function schedule() {
    clearTimeout(timer);
    const text = input.value.trim();
    clearBtn && (clearBtn.hidden = !input.value);
    if (!text || options.ignore?.(text)) {
      seq++;
      view = null;
      list.textContent = "";
      shown = [];
      setStatus("");
      close();
      return;
    }
    const link = parseSpotifyLink(text);
    if (link) {
      void pasted(link);
      return;
    }
    if (text.length < minLength) {
      seq++;
      close();
      return;
    }
    if (cache.has(key(text, filter, 0))) {
      void run(text, filter);
      return;
    }
    timer = setTimeout(() => void run(text, filter), debounceMs);
  }

  async function pasted(link: { type: SpotifySearchType; id: string }) {
    const mine = ++seq;
    list.textContent = "";
    shown = [];
    if (!types.includes(link.type)) {
      setStatus(`That's a link to a Spotify ${SPOTIFY_TYPE_LABELS[link.type].one.toLowerCase()}. This takes ${readable(types)}.`, "error");
      open();
      return;
    }
    if (!options.source.getItem) {
      close();
      select({
        type: link.type,
        id: link.id,
        uri: `spotify:${link.type}:${link.id}`,
        url: `https://open.spotify.com/${link.type}/${link.id}`,
        name: "",
        subtitle: "",
        meta: "",
        imageUrl: null,
        coverUrl: null,
      });
      return;
    }
    setStatus("Looking up the link…", "busy");
    open();
    try {
      const item = await options.source.getItem(link.type, link.id, { market: options.market });
      if (mine !== seq || destroyed) return;
      if (!item) {
        setStatus(`Spotify doesn't know that ${SPOTIFY_TYPE_LABELS[link.type].one.toLowerCase()}. Check the link.`, "error");
        return;
      }
      setStatus("");
      close();
      select(item);
    } catch (err) {
      if (mine !== seq || destroyed) return;
      showError(err);
    }
  }

  async function run(text: string, f: SpotifySearchType | "all", more?: SpotifySearchType) {
    const mine = ++seq;
    const kinds = f === "all" ? types : [f];
    const perPage = f === "all" ? previewLimit : limit;
    const offset = more ? (view?.offsets[more] ?? 0) + limit : 0;
    const k = more ? key(text, more, offset) : key(text, f, 0);
    let result = cache.get(k);
    if (!result) {
      // Results already showing stay (dimmed) until the new ones arrive.
      root.classList.add("is-busy");
      if (list.childElementCount === 0) setStatus("Searching…", "busy");
      open();
      try {
        result = await options.source.searchItems(text, {
          types: more ? [more] : kinds,
          limit: perPage,
          offset,
          market: options.market,
        });
        cache.set(k, result);
        if (cache.size > 60) cache.delete(cache.keys().next().value!);
      } catch (err) {
        if (mine !== seq || destroyed) return;
        root.classList.remove("is-busy");
        showError(err);
        return;
      }
    }
    if (mine !== seq || destroyed) return;
    root.classList.remove("is-busy");
    if (more && view) {
      const page = result[more];
      const prev = view.result[more];
      if (page && prev) {
        view.result = { ...view.result, [more]: { ...page, items: [...prev.items, ...page.items.filter((i) => !prev.items.some((p) => p.id === i.id))] } };
        view.offsets[more] = offset;
      }
    } else {
      view = { text, filter: f, result, offsets: {} };
    }
    render();
  }

  function showError(err: unknown) {
    const said = describe(err);
    list.textContent = "";
    shown = [];
    if (typeof said === "string") setStatus(said, "error");
    else setStatus(said.message, "error", said.action);
    open();
  }

  function render() {
    if (!view) return;
    const keepActive = active;
    list.textContent = "";
    shown = [];
    const kinds = view.filter === "all" ? types : [view.filter];
    let count = 0;
    for (const kind of kinds) {
      const page = view.result[kind];
      if (!page || page.items.length === 0) continue;
      const group = el("div", "sps-group");
      group.setAttribute("role", "group");
      if (view.filter === "all") {
        const head = el("div", "sps-group-head");
        const title = el("span", "sps-group-title", SPOTIFY_TYPE_LABELS[kind].many);
        title.id = `${uid}-g-${kind}`;
        group.setAttribute("aria-labelledby", title.id);
        head.append(title);
        if (page.hasMore || page.total > page.items.length) {
          const all = el("button", "sps-see-all", "See all");
          all.type = "button";
          all.tabIndex = -1;
          all.dataset.type = kind;
          head.append(all);
        }
        group.append(head);
      } else {
        group.setAttribute("aria-label", SPOTIFY_TYPE_LABELS[kind].many);
      }
      for (const item of page.items) {
        group.append(row(item, shown.length));
        shown.push(item);
        count++;
      }
      if (view.filter !== "all" && page.hasMore) {
        const moreBtn = el("button", "sps-more", `More ${SPOTIFY_TYPE_LABELS[kind].many.toLowerCase()}`);
        moreBtn.type = "button";
        moreBtn.tabIndex = -1;
        moreBtn.dataset.type = kind;
        group.append(moreBtn);
      }
      list.append(group);
    }
    if (count === 0) {
      const what = view.filter === "all" ? readable(types) : SPOTIFY_TYPE_LABELS[view.filter].many.toLowerCase();
      setStatus(`No ${what} found for “${view.text}”.`);
    } else {
      setStatus("");
    }
    open();
    setActive(keepActive >= 0 && keepActive < count ? keepActive : -1);
  }

  function row(item: SpotifyItem, index: number): HTMLElement {
    const r = el("div", `sps-option sps-option--${item.type}`);
    r.id = `${uid}-o-${index}`;
    r.setAttribute("role", "option");
    r.setAttribute("aria-selected", "false");
    r.dataset.index = String(index);
    const thumb = el("span", "sps-thumb");
    if (item.imageUrl) {
      const img = el("img");
      img.src = item.imageUrl;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("error", () => {
        img.remove();
        thumb.innerHTML = svg(TYPE_ICON[item.type], "sps-thumb-icon");
      });
      thumb.append(img);
    } else {
      thumb.innerHTML = svg(TYPE_ICON[item.type], "sps-thumb-icon");
    }
    const text = el("span", "sps-text");
    const name = el("span", "sps-name", item.name || item.id);
    if (item.explicit) {
      const e = el("span", "sps-explicit", "E");
      e.title = "Explicit";
      name.append(e);
    }
    text.append(name);
    if (item.subtitle) text.append(el("span", "sps-sub", item.subtitle));
    r.append(thumb, text);
    if (item.meta) r.append(el("span", "sps-meta", item.meta));
    return r;
  }

  function select(item: SpotifyItem) {
    if (fillOnSelect && item.name) {
      input.value = item.name;
      clearBtn && (clearBtn.hidden = false);
    }
    close();
    options.onSelect(item);
  }

  function chooseFilter(next: SpotifySearchType | "all", refocus: boolean) {
    if (!types.includes(next as SpotifySearchType) && next !== "all") return;
    if (types.length === 1) next = types[0]!;
    filter = next;
    renderChips();
    if (refocus) input.focus();
    const text = input.value.trim();
    if (text.length >= minLength && !options.ignore?.(text) && !parseSpotifyLink(text)) void run(text, filter);
  }

  // ---- events ----
  const onInput = () => schedule();
  const onFocus = () => {
    if (view && view.text === input.value.trim() && (shown.length > 0 || !status.hidden)) open();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    const isOpen = !panel.hidden;
    const take = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    switch (e.key) {
      case "ArrowDown":
        if (!isOpen) {
          if (view && shown.length) {
            take();
            open();
            setActive(0);
          }
          return;
        }
        take();
        setActive(shown.length ? (active + 1) % shown.length : -1);
        return;
      case "ArrowUp":
        if (!isOpen) return;
        take();
        setActive(shown.length ? (active <= 0 ? shown.length - 1 : active - 1) : -1);
        return;
      case "Enter":
        if (isOpen && active >= 0 && shown[active]) {
          take();
          select(shown[active]!);
        }
        return;
      case "Escape":
        if (isOpen) {
          take();
          close();
        }
        return;
      case "Tab":
        close();
        return;
    }
  };
  const onPointerDown = (e: PointerEvent) => {
    const t = e.target as Node | null;
    if (t && (root.contains(t) || t === input)) return;
    close();
  };

  // Keep the field focused while clicking inside the box.
  root.addEventListener("mousedown", (e) => {
    const t = e.target as HTMLElement;
    if (t !== input && !t.closest(".sps-status-action")) e.preventDefault();
  });
  list.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const option = t.closest<HTMLElement>(".sps-option");
    if (option) {
      const item = shown[Number(option.dataset.index)];
      if (item) select(item);
      return;
    }
    const seeAll = t.closest<HTMLElement>(".sps-see-all");
    if (seeAll) {
      chooseFilter(seeAll.dataset.type as SpotifySearchType, true);
      return;
    }
    const moreBtn = t.closest<HTMLButtonElement>(".sps-more");
    if (moreBtn && view) {
      moreBtn.disabled = true;
      moreBtn.textContent = "Loading…";
      void run(view.text, view.filter, moreBtn.dataset.type as SpotifySearchType);
    }
  });
  list.addEventListener("mousemove", (e) => {
    const option = (e.target as HTMLElement).closest<HTMLElement>(".sps-option");
    if (option && Number(option.dataset.index) !== active) setActive(Number(option.dataset.index));
  });
  chips.addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".sps-chip");
    if (chip) chooseFilter(chip.dataset.type as SpotifySearchType | "all", true);
  });
  chips.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const all: (SpotifySearchType | "all")[] = ["all", ...types];
    const i = all.indexOf(filter);
    const next = all[(i + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length]!;
    e.preventDefault();
    chooseFilter(next, false);
    chips.querySelector<HTMLElement>(`[data-type="${next}"]`)?.focus();
  });
  clearBtn?.addEventListener("click", () => {
    handle.clear();
    input.focus();
  });

  // Capture, so these run before a passed-in field's own Enter handler.
  input.addEventListener("keydown", onKeyDown, true);
  input.addEventListener("input", onInput);
  input.addEventListener("focus", onFocus);
  document.addEventListener("pointerdown", onPointerDown, true);

  const handle: SpotifySearchHandle = {
    element: root,
    input,
    get type() {
      return filter;
    },
    setTypes(next) {
      types = cleanTypes(next);
      filter = pickFilter(filter);
      if (ownInput && !options.placeholder) {
        input.placeholder = defaultPlaceholder();
        if (!options.label) input.setAttribute("aria-label", input.placeholder);
      }
      renderChips();
      view = null;
      schedule();
    },
    setType(next) {
      chooseFilter(next, false);
    },
    search(text) {
      input.value = text;
      clearTimeout(timer);
      const t = text.trim();
      clearBtn && (clearBtn.hidden = !text);
      if (t.length >= minLength && !options.ignore?.(t) && !parseSpotifyLink(t)) void run(t, filter);
      else schedule();
    },
    clear() {
      input.value = "";
      schedule();
    },
    close,
    focus() {
      input.focus();
    },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      input.removeEventListener("keydown", onKeyDown, true);
      input.removeEventListener("input", onInput);
      input.removeEventListener("focus", onFocus);
      document.removeEventListener("pointerdown", onPointerDown, true);
      if (!ownInput) {
        for (const [name, value] of savedAttrs) {
          if (value == null) input.removeAttribute(name);
          else input.setAttribute(name, value);
        }
      }
      root.remove();
    },
  };
  return handle;
}
