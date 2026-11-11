import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { asBytes } from "../bytes.js";
import type { ClaudeTransport } from "../types.js";
import { useTransport, useUi } from "./context.js";
import { DownloadIcon, ImageIcon } from "./primitives.js";

// A chat's images (the host keeps them, host/images.ts): what's attached,
// what a tool hands back, what Claude shows as markdown. Each draws as a
// thumbnail; a click opens the lightbox (←/→ through the chat's images, a
// swipe on a phone; Esc closes), and Download saves a copy: through the host's
// Save dialog when it has one, else as the browser's own download.

/** An image in the conversation: a kept image's id, or the path or address a reply named. */
export interface Pic {
  ref: string;
  /** Its file name, which Download starts from. */
  name?: string;
  /** What a reply called it (markdown's alt text). */
  alt?: string;
}

const label = (p: Pic) => p.alt || p.name || "Image";

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

/** The chat a thumbnail sits in: its folder (a reply's relative paths) and its lightbox. */
export const PicsContext = createContext<{ folder?: string; open: (p: Pic) => void }>({ open: () => undefined });

const MD_IMAGE = /!\[([^\]\n]*)\]\(([^)\n]+)\)/g;
/** A markdown image's address: without <…> around it or a "title" after it. */
export const mdSrc = (raw: string) => raw.trim().replace(/^<(.*)>$/, "$1").replace(/\s+"[^"]*"$/, "");
/** The images a reply shows, outside its code blocks. */
export const picsIn = (text: string): Pic[] => [...text.replace(/```[\s\S]*?```/g, "").matchAll(MD_IMAGE)].map((m) => ({ ref: mdSrc(m[2]), alt: m[1] || undefined }));

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

const Chevron = ({ left }: { left?: boolean }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={left ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
  </svg>
);

/** The lightbox: one image as large as the window allows, the chat's others a key away. */
export function Lightbox({ pics, at, folder, onClose }: { pics: Pic[]; at: number; folder?: string; onClose: () => void }) {
  const [i, setI] = useState(at);
  const pic = pics[i] ?? pics[0];
  const { url, error } = useImageUrl(pic.ref, folder);
  const close = useRef<HTMLButtonElement>(null);
  const ui = useUi();
  const download = useDownload();
  const Button = ui.c.Button;
  const done = useRef(onClose);
  done.current = onClose;
  const many = pics.length > 1;
  const go = (by: number) => setI((n) => (n + by + pics.length) % pics.length);

  useEffect(() => close.current?.focus({ preventScroll: true }), []);
  // Its keys come first: Esc here closes the lightbox, not the panel.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") done.current();
      else if (many && e.key === "ArrowLeft") go(-1);
      else if (many && e.key === "ArrowRight") go(1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [many, pics.length]);

  const away = (e: React.PointerEvent) => e.target === e.currentTarget && onClose();
  // A finger's ←/→: a sideways swipe across the picture steps through the chat's images.
  const from = useRef<{ x: number; y: number } | undefined>(undefined);
  const swipe = {
    onTouchStart: (e: React.TouchEvent) => void (from.current = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : undefined),
    onTouchEnd: (e: React.TouchEvent) => {
      const a = from.current;
      const b = e.changedTouches[0];
      from.current = undefined;
      if (!many || !a || !b) return;
      const dx = b.clientX - a.x;
      if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(b.clientY - a.y) * 1.5) go(dx < 0 ? 1 : -1);
    },
  };
  return createPortal(
    <div className="ck-root ck-lightbox" role="dialog" aria-modal="true" aria-label={label(pic)}>
      <div className="ck-lightbox__stage" onPointerDown={away} {...swipe}>
        {error ? <p className="ck-callout ck-ink2">{error}</p> : url ? <img src={url} alt={label(pic)} /> : <p className="ck-thinking">Loading…</p>}
      </div>
      {many && (
        <>
          <button type="button" className="ck-lightbox__nav is-prev" aria-label="Previous image" onClick={() => go(-1)}>
            <Chevron left />
          </button>
          <button type="button" className="ck-lightbox__nav is-next" aria-label="Next image" onClick={() => go(1)}>
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
        <Button variant="primary" size="sm" onClick={() => download(pic, folder)}>
          Download
        </Button>
        <button ref={close} type="button" className="ck-iconbtn" aria-label="Close" onClick={onClose}>
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
