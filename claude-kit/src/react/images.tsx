import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { swipe } from "@btkulka/chat-blocks/swipe";
import { asBytes } from "../bytes.js";
import type { ClaudeTransport } from "../types.js";
import { useTransport, useUi } from "./context.js";
import { pickedAt, type Pic } from "./picks.js";
import { DownloadIcon, ImageIcon } from "./primitives.js";
import { useStar } from "./stars.js";

// A chat's images (the host keeps them, host/images.ts): what's attached,
// what a tool hands back, what Claude shows as markdown. Each draws as a
// thumbnail; a click opens the lightbox (←/→ through the chat's images, or a
// swipe: a finger, a mouse drag or a trackpad; Esc closes), and Download saves a copy: through the host's
// Save dialog when it has one, else as the browser's own download. Two or more
// in a row in a reply are a carousel instead, its lightbox stepping through
// just those: something to look at. A carousel picks only in a pick block
// (onPick); a star (the transport's, Gallery's in Benhäus) marks files on either.

export type { Pic };

/** What an image is called: its caption, its name, else its file's name (not a data: address's). */
const label = (p: Pic) => p.alt || p.name || (/^data:/i.test(p.ref) ? "" : (p.ref.split(/[\\/]/).pop() ?? "")) || "Image";

/** Addresses the window can draw as they are. */
const direct = (ref: string) => /^(https?:|data:image\/|blob:)/i.test(ref);

/** A thumbnail's size ("md" a row's, "lg" one a reply shows), which main scales it down to; none for the lightbox's whole image. */
type Size = "md" | "lg";

/** Images read through the host, as object URLs, the most recently used last, with how many images on screen draw each. */
const loaded = new Map<string, { url: Promise<string>; users: number }>();
/** Past this many, the ones nothing on screen draws are let go (their bytes with them) and read again if they come back. */
const KEEP_URLS = 30;

/** Something to put in <img src> for a kept id or a path, read once through the host while it's used; let it go with release(). */
function acquire(t: ClaudeTransport, ref: string, folder?: string, size?: Size): { key: string; url: Promise<string> } {
  const key = `${size ?? ""}|${folder ?? ""}|${ref}`;
  let e = loaded.get(key);
  if (e) loaded.delete(key);
  else {
    const entry = {
      url: t.image(ref, folder, size).then((r) => URL.createObjectURL(new Blob([asBytes(r.bytes) as BlobPart], { type: r.type }))),
      users: 0,
    };
    entry.url.catch(() => loaded.get(key) === entry && loaded.delete(key));
    e = entry;
  }
  loaded.set(key, e);
  e.users++;
  return { key, url: e.url };
}

function release(key: string) {
  const e = loaded.get(key);
  if (e) e.users--;
  for (const [k, x] of loaded) {
    if (loaded.size <= KEEP_URLS) break;
    if (x.users > 0) continue;
    loaded.delete(k);
    x.url.then(
      (u) => URL.revokeObjectURL(u),
      () => undefined,
    );
  }
}

function useImageUrl(ref: string, folder?: string, size?: Size) {
  const t = useTransport();
  const { errorText } = useUi();
  const [state, setState] = useState<{ url?: string; error?: string }>(() => (direct(ref) ? { url: ref } : {}));
  useEffect(() => {
    if (direct(ref)) return void setState({ url: ref });
    let live = true;
    const { key, url } = acquire(t, ref, folder, size);
    url.then(
      (u) => live && setState({ url: u }),
      (e) => live && setState({ error: errorText(e) }),
    );
    return () => {
      live = false;
      release(key);
    };
  }, [ref, folder, size]);
  return state;
}

/** Download: the host's Save dialog when it has one (it says where it went), else the browser's own download, which says so itself. */
export function useDownload() {
  const t = useTransport();
  const ui = useUi();
  return (p: Pic, folder?: string) => {
    if (t.saveImage)
      return void t.saveImage(p.ref, { folder, name: p.name }).then(
        (path) => path && ui.toast(`Saved to ${ui.showPath(path)}`),
        (e) => ui.toast(ui.errorText(e)),
      );
    void t.image(p.ref, folder).then(
      (img) => {
        const url = URL.createObjectURL(new Blob([asBytes(img.bytes) as BlobPart], { type: img.type }));
        const a = document.createElement("a");
        a.href = url;
        a.download = p.name || img.name;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      },
      (e) => ui.toast(ui.errorText(e)),
    );
  };
}

/** The chat a thumbnail sits in: its folder (a reply's relative paths), its lightbox, and its carousels' picks. */
export const PicsContext = createContext<{
  folder?: string;
  open: (p: Pic) => void;
  /**
   * A carousel's image, large: the lightbox steps through its set only, with its Pick (`onPick`) and what's picked.
   * `toggle`: Pick picks and unpicks (a block's several to pick). Without it, open() does.
   */
  openSet?: (pics: Pic[], at: number, o?: { onPick?: (i: number) => void; picked?: readonly number[]; toggle?: boolean }) => void;
  /** Pick: sends Ben's choice from a carousel as his message. Without it, a carousel has no Pick. */
  pick?: (pics: Pic[], at: number) => void;
  /** Each carousel's pick so far (picks.ts's picksIn): its key to the picked image's address. */
  picks?: ReadonlyMap<string, string>;
}>({ open: () => undefined });

/** A thumbnail in the conversation: a click opens it large, the corner button saves a copy. */
export function Thumb({ pic, size = "md" }: { pic: Pic; size?: "md" | "lg" }) {
  const { folder, open } = useContext(PicsContext);
  const { url, error } = useImageUrl(pic.ref, folder, size);
  const download = useDownload();
  if (error)
    return (
      <span className="ck-pic is-broken" title={error}>
        <ImageIcon size={14} />
        {label(pic)}
      </span>
    );
  return (
    <span className={`ck-pic ck-pic--${size}`}>
      <button type="button" className="ck-pic__open" aria-label={`Open ${label(pic)} large`} title={label(pic)} onClick={() => open(pic)}>
        {url ? <img src={url} alt={label(pic)} draggable={false} /> : <span className="ck-pic__wait" />}
      </button>
      <button type="button" className="ck-pic__save" aria-label={`Download ${label(pic)}`} title="Download" onClick={() => download(pic, folder)}>
        <DownloadIcon />
      </button>
    </span>
  );
}

const Chevron = ({ left, size = 18 }: { left?: boolean; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={left ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
  </svg>
);

const CheckIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

const StarIcon = ({ on, size = 14 }: { on?: boolean; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9z" />
  </svg>
);

/** A file's star, as a small button: on a card, in the lightbox. Nothing where stars can't go. */
function StarButton({ pic, className }: { pic: Pic; className: string }) {
  const star = useStar(pic.ref);
  if (!star.can) return null;
  const name = label(pic);
  return (
    <button type="button" className={`${className}${star.on ? " is-on" : ""}`} aria-pressed={!!star.on} title={star.on ? "Starred: press to take the star off" : "Star it (kept in Gallery)"} aria-label={`${star.on ? "Unstar" : "Star"} ${name}`} onClick={star.toggle}>
      <StarIcon on={star.on} />
    </button>
  );
}

/** A card of a carousel: the image (a click opens the lightbox on the set), its caption, its place in the set, its star, and in a pick block Pick, or a check once it's the pick (with `toggle`, a press takes it back). */
function Card({ pic, nth, picked, onOpen, onPick, toggle }: { pic: Pic; nth: string; picked: boolean; onOpen: () => void; onPick?: () => void; toggle?: boolean }) {
  const { folder } = useContext(PicsContext);
  const { url, error } = useImageUrl(pic.ref, folder, "md");
  const download = useDownload();
  const name = label(pic);
  return (
    <figure className={`ck-card${picked ? " is-picked" : ""}`} role="group" aria-roledescription="slide" aria-label={`${nth}: ${name}${picked ? " (picked)" : ""}`}>
      <button type="button" className="ck-card__open" title={name} aria-label={`Open ${name} large, ${nth}`} onClick={onOpen}>
        {error ? (
          <span className="ck-card__broken" title={error}>
            <ImageIcon size={20} />
          </span>
        ) : url ? (
          <img src={url} alt={name} draggable={false} />
        ) : (
          <span className="ck-pic__wait" />
        )}
      </button>
      {picked && (
        <span className="ck-card__check" title="Picked" aria-hidden="true">
          <CheckIcon size={13} />
        </span>
      )}
      {!error && (
        <button type="button" className="ck-pic__save" aria-label={`Download ${name}`} title="Download" onClick={() => download(pic, folder)}>
          <DownloadIcon />
        </button>
      )}
      <figcaption className="ck-card__foot">
        <span className="ck-card__cap" title={name}>
          {name}
        </span>
        <span className="ck-row ck-card__meta">
          <span className="ck-caption ck-ink3">{nth}</span>
          <span className="ck-grow" />
          <StarButton pic={pic} className="ck-iconbtn ck-card__star" />
          {onPick &&
            (picked && toggle ? (
              <button type="button" className="ck-chip ck-card__pick is-on" title="Picked: press to take it back" aria-pressed="true" aria-label={`Picked ${nth}: ${name}. Unpick`} onClick={onPick}>
                <CheckIcon size={12} />
                Picked
              </button>
            ) : picked ? (
              <span className="ck-card__picked">
                <CheckIcon size={12} />
                Picked
              </span>
            ) : (
              <button type="button" className="ck-chip ck-card__pick" title={toggle ? "Pick this one (sent with Submit)" : "Pick this one: tells Claude it's your choice"} aria-pressed={toggle ? false : undefined} aria-label={`Pick ${nth}: ${name}`} onClick={onPick}>
                Pick
              </button>
            ))}
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * Two or more images in a row in a reply: a strip of cards (CarouselView), to
 * look at. A card opens the lightbox on this set alone. A host that passes
 * `pick` gets Pick there and on the cards, sent as Ben's message; Benhäus doesn't
 * (a pick that matters is a pick block), and a pick an older chat sent shows checked.
 */
export function Carousel({ pics }: { pics: Pic[] }) {
  const { pick, picks } = useContext(PicsContext);
  const at = pickedAt(pics, picks);
  return <CarouselView pics={pics} picked={at === undefined ? NONE : [at]} onPick={pick ? (i) => pick(pics, i) : undefined} />;
}

const NONE: readonly number[] = [];

/**
 * A strip of cards that scrolls and snaps sideways (‹ › a card at a time),
 * narrow enough for the panel, the `picked` ones outlined and checked. A card
 * opens the lightbox on this set alone; Pick, there or on a card, is `onPick`
 * (none: no Pick). `toggle`: a picked card's Pick takes it back.
 */
export function CarouselView({ pics, picked, onPick, toggle, label: name }: { pics: Pic[]; picked: readonly number[]; onPick?: (i: number) => void; toggle?: boolean; label?: string }) {
  const { open, openSet } = useContext(PicsContext);
  const strip = useRef<HTMLDivElement>(null);
  const [ends, setEnds] = useState({ start: true, end: true });
  const first = picked[0];
  const edges = () => {
    const el = strip.current;
    if (el) setEnds({ start: el.scrollLeft <= 2, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2 });
  };
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    edges();
    const ro = new ResizeObserver(edges);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pics.length]);
  // The pick in view when it's out of it (scrolled past, or drawn again from the start), without moving the conversation.
  useLayoutEffect(() => {
    const el = strip.current;
    const card = first === undefined ? undefined : (el?.children[first] as HTMLElement | undefined);
    if (!el || !card) return;
    if (card.offsetLeft < el.scrollLeft || card.offsetLeft + card.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = card.offsetLeft - 2;
  }, [first]);
  const step = (by: number) => {
    const el = strip.current;
    const card = el?.firstElementChild as HTMLElement | null | undefined;
    if (!el || !card) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: by * (card.offsetWidth + 8), behavior: still ? "auto" : "smooth" });
  };
  return (
    <div className="ck-carousel" role="group" aria-roledescription="carousel" aria-label={`${name ? `${name}: ` : ""}${pics.length} images${onPick ? (toggle ? ", pick any" : ", pick one") : ""}`}>
      <div ref={strip} className="ck-carousel__strip" onScroll={edges}>
        {pics.map((p, i) => (
          <Card
            key={`${p.ref}:${i}`}
            pic={p}
            nth={`${i + 1} of ${pics.length}`}
            picked={picked.includes(i)}
            toggle={toggle}
            onOpen={() => (openSet ? openSet(pics, i, { onPick, picked, toggle }) : open(p))}
            onPick={onPick ? () => onPick(i) : undefined}
          />
        ))}
      </div>
      <button type="button" className={`ck-carousel__nav is-prev${ends.start ? " is-off" : ""}`} title="Previous image" aria-label="Previous image" onClick={() => step(-1)}>
        <Chevron left size={14} />
      </button>
      <button type="button" className={`ck-carousel__nav is-next${ends.end ? " is-off" : ""}`} title="Next image" aria-label="Next image" onClick={() => step(1)}>
        <Chevron size={14} />
      </button>
    </div>
  );
}

/**
 * The lightbox: one image as large as the window allows, the chat's others (or a carousel's) a key away. With
 * `onPick` (a carousel's set) it offers Pick, which Enter presses too, and shows the set's `picked` one as picked.
 */
export function Lightbox({ pics, at, folder, onClose, onPick, picked, toggle }: { pics: Pic[]; at: number; folder?: string; onClose: () => void; onPick?: (i: number) => void; picked?: number | readonly number[]; toggle?: boolean }) {
  const [i, setI] = useState(at);
  const pic = pics[i] ?? pics[0];
  const { url, error } = useImageUrl(pic.ref, folder);
  const root = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const ui = useUi();
  const download = useDownload();
  const Button = ui.c.Button;
  const done = useRef(onClose);
  done.current = onClose;
  const isPicked = onPick !== undefined && (typeof picked === "number" ? [picked] : (picked ?? [])).includes(i);
  const pickNow = useRef<(() => void) | undefined>(undefined);
  pickNow.current = onPick && (!isPicked || toggle) ? () => onPick(i) : undefined;
  const many = pics.length > 1;
  const go = (by: number) => setI((n) => (n + by + pics.length) % pics.length);

  // Pick has the focus when there's one to press (Enter picks), else Close.
  useEffect(() => {
    const first = root.current?.querySelector<HTMLElement>("[data-ck-pick]:not(:disabled)") ?? close.current;
    first?.focus({ preventScroll: true });
  }, []);
  // Its keys come first: Esc here closes the lightbox, not the panel. Enter picks, unless it's on another of its buttons.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const onButton = e.target instanceof Element && e.target.closest("button, a, input, textarea, select");
      if (e.key === "Escape") done.current();
      else if (many && e.key === "ArrowLeft") go(-1);
      else if (many && e.key === "ArrowRight") go(1);
      else if (e.key === "Enter" && !onButton && !e.repeat && pickNow.current) pickNow.current();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [many, pics.length]);

  const away = (e: React.PointerEvent | React.MouseEvent) => e.target === e.currentTarget && onClose();
  // ←/→ by swiping across the picture: a finger, a mouse drag or a trackpad. The picture follows the drag. A
  // click on the dark around it closes (a click, so a drag that starts there swipes instead).
  const stage = useRef<HTMLDivElement>(null);
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    const el = stage.current;
    if (!el || !many) return;
    return swipe(el, { onSwipe: (d) => goRef.current(d), follow: el.firstElementChild as HTMLElement | null });
  }, [many, url]);
  return createPortal(
    <div ref={root} className="ck-root ck-lightbox" role="dialog" aria-modal="true" aria-label={label(pic)}>
      <div ref={stage} className="ck-lightbox__stage" onClick={away}>
        {error ? <p className="ck-callout ck-ink2">{error}</p> : url ? <img src={url} alt={label(pic)} /> : <p className="ck-thinking">Loading…</p>}
      </div>
      {many && (
        <>
          <button type="button" className="ck-lightbox__nav is-prev" title="Previous image (←)" aria-label="Previous image" onClick={() => go(-1)}>
            <Chevron left />
          </button>
          <button type="button" className="ck-lightbox__nav is-next" title="Next image (→)" aria-label="Next image" onClick={() => go(1)}>
            <Chevron />
          </button>
        </>
      )}
      <div className="ck-lightbox__bar" onPointerDown={away}>
        <span className="ck-callout ck-ell">{label(pic)}</span>
        {many && (
          <span className="ck-caption ck-ink3">
            {i + 1} of {pics.length}
          </span>
        )}
        <span className="ck-grow" />
        <StarButton pic={pic} className="ck-iconbtn ck-lightbox__star" />
        {onPick && (
          <Button
            variant="primary"
            size="sm"
            data-ck-pick=""
            disabled={isPicked && !toggle}
            aria-pressed={toggle ? isPicked : undefined}
            title={isPicked ? (toggle ? "Picked: press to take it back (Enter)" : "You picked this one") : toggle ? "Pick this one (Enter), sent with Submit" : "Pick this one (Enter): tells Claude it's your choice"}
            aria-label={isPicked ? `Picked: ${label(pic)}${toggle ? ". Unpick" : ""}` : `Pick ${i + 1} of ${pics.length}: ${label(pic)}`}
            onClick={() => pickNow.current?.()}
          >
            {isPicked ? "✓ Picked" : "Pick"}
          </Button>
        )}
        <Button variant={onPick ? "glass" : "primary"} size="sm" title="Save a copy" aria-label={`Download ${label(pic)}`} onClick={() => download(pic, folder)}>
          Download
        </Button>
        <button ref={close} type="button" className="ck-iconbtn" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>,
    ui.portal(),
  );
}

/* ------------------------------------------------------ attaching images */

/** An image waiting in the composer, already within what Claude takes. */
export interface Pending {
  key: string;
  url: string;
  data: string;
  type: string;
  name: string;
}

const SENDABLE = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** Claude's API takes up to 5 MB of base64 and 8000 px a side per image. */
const MAX_BYTES = Math.floor(3.7 * 1024 * 1024);
const MAX_SIDE = 8000;
/** How large a re-encoded image starts; it shrinks from here until it fits. */
const FIT_SIDE = 4096;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** A decoded image to measure and draw: createImageBitmap, or an <img> for what it can't decode (SVG). */
async function decode(blob: Blob): Promise<{ img: CanvasImageSource; w: number; h: number; done: () => void }> {
  try {
    const bm = await createImageBitmap(blob);
    return { img: bm, w: bm.width, h: bm.height, done: () => bm.close() };
  } catch {
    const url = URL.createObjectURL(blob);
    const el = new Image();
    el.src = url;
    await el.decode();
    return { img: el, w: el.naturalWidth || 1024, h: el.naturalHeight || 1024, done: () => URL.revokeObjectURL(url) };
  }
}

/** Redrawn as PNG (or JPEG, when PNG is too heavy), scaled down until it fits. */
async function reencode(blob: Blob): Promise<Blob> {
  const d = await decode(blob);
  try {
    let scale = Math.min(1, FIT_SIDE / Math.max(d.w, d.h));
    for (let tries = 0; tries < 6; tries++, scale *= 0.75) {
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(d.w * scale)), Math.max(1, Math.round(d.h * scale)));
      canvas.getContext("2d")!.drawImage(d.img, 0, 0, canvas.width, canvas.height);
      const png = await canvas.convertToBlob({ type: "image/png" });
      if (png.size <= MAX_BYTES) return png;
      const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
      if (jpeg.size <= MAX_BYTES) return jpeg;
    }
  } finally {
    d.done();
  }
  throw new Error("That image is too big to send, even scaled down.");
}

const base64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

let seq = 0;

/** A file Ben pasted, dropped or picked, made ready to send: a kind Claude reads, within its size limits. */
export async function prepare(file: File): Promise<Pending> {
  if (!file.type.startsWith("image/")) throw new Error(`${file.name || "That file"} isn't an image.`);
  let blob: Blob = file;
  let fits = SENDABLE.includes(file.type) && file.size <= MAX_BYTES;
  if (fits) {
    const d = await decode(file);
    fits = Math.max(d.w, d.h) <= MAX_SIDE;
    d.done();
  }
  if (!fits) blob = await reencode(file);
  const stem = file.name ? file.name.replace(/\.[^.]+$/, "") : "pasted image";
  return { key: `p${Date.now().toString(36)}${++seq}`, url: URL.createObjectURL(blob), data: await base64(blob), type: blob.type, name: `${stem}.${EXT[blob.type] ?? "png"}` };
}

/** A drag that carries files. */
export const carriesFiles = (e: { dataTransfer: DataTransfer | null }) => Boolean(e.dataTransfer?.types.includes("Files"));
