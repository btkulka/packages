// A placeholder icon in the Benhäus app-icon style (the same plate, halo,
// pool and edge every package icon in BPM has), with the app's monogram in
// its vertical's tint. It's what Benhäus shows until the real icon is designed.

/** Each vertical's tint as the icons use it: highlight, face, shade. */
export const ICON_TINTS: Record<string, [string, string, string]> = {
  haus: ["#f6e3ae", "#e2bd68", "#8a6a22"],
  artifacts: ["#f6e3ae", "#e2bd68", "#8a6a22"],
  gt: ["#dfe6fb", "#7f9bf0", "#1f3270"],
  fm: ["#ffdbe3", "#ff7d96", "#b3304d"],
  delphi: ["#d9f6fa", "#5ad5e4", "#1a7f8c"],
  nhi: ["#f1e2ff", "#cf9dff", "#8545d6"],
  personal: ["#d6f6e7", "#62d9a0", "#1f8a5c"],
  ai: ["#f1f9cf", "#cdea7a", "#7f9c26"],
  games: ["#dcdaff", "#8e8aff", "#5149d0"],
  utilities: ["#f7f7fa", "#c9c9d1", "#82828c"],
};

const DEFAULT_TINT = ICON_TINTS.utilities;

/** Two letters for a name: the initials of its first two words, or its first two letters. */
export function monogram(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0] ?? "A";
  return (w.length > 1 ? w[0].toUpperCase() + w[1].toLowerCase() : w.toUpperCase()).slice(0, 2);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The icon as SVG text, 256×256, ready to save as icon.svg. */
export function appIconSvg({ name, title, vertical, glyph }: { name: string; title?: string; vertical?: string; glyph?: string }): string {
  const [hi, face, shade] = (vertical && ICON_TINTS[vertical]) || DEFAULT_TINT;
  const text = (glyph ?? monogram(name)).slice(0, 3);
  const size = text.length === 1 ? 150 : text.length === 2 ? 118 : 92;
  const y = 128 + Math.round(size * 0.36);
  const word = (dy: number, fill: string, extra = "") =>
    `<text x="128" y="${y + dy}" text-anchor="middle" font-family="Inter Tight, Inter, Segoe UI, Helvetica, Arial, sans-serif" font-weight="700" font-size="${size}" letter-spacing="-0.04em" fill="${fill}"${extra}>${esc(text)}</text>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">`,
    `  <title>${esc(title ?? name)}</title>`,
    `  <defs>`,
    `    <clipPath id="sq"><rect width="256" height="256" rx="57"/></clipPath>`,
    `    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">`,
    `      <stop offset="0" stop-color="#1d1d22"/><stop offset="1" stop-color="#040405"/>`,
    `    </linearGradient>`,
    `    <radialGradient id="halo" cx="128" cy="124" r="112" gradientUnits="userSpaceOnUse">`,
    `      <stop offset="0" stop-color="${face}" stop-opacity="0.30"/><stop offset="1" stop-color="${shade}" stop-opacity="0"/>`,
    `    </radialGradient>`,
    `    <radialGradient id="pool" cx="128" cy="62" r="84" gradientUnits="userSpaceOnUse">`,
    `      <stop offset="0" stop-color="${hi}" stop-opacity="0.22"/><stop offset="1" stop-color="${face}" stop-opacity="0"/>`,
    `    </radialGradient>`,
    `    <linearGradient id="face" x1="64" y1="56" x2="192" y2="204" gradientUnits="userSpaceOnUse">`,
    `      <stop offset="0" stop-color="${hi}"/><stop offset="0.5" stop-color="${face}"/><stop offset="1" stop-color="${shade}"/>`,
    `    </linearGradient>`,
    `    <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">`,
    `      <stop offset="0" stop-color="#ffffff" stop-opacity="0.38"/><stop offset="0.3" stop-color="#ffffff" stop-opacity="0.05"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.03"/>`,
    `    </linearGradient>`,
    `    <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>`,
    `  </defs>`,
    `  <g clip-path="url(#sq)">`,
    `    <rect width="256" height="256" fill="url(#bg)"/>`,
    `    <rect width="256" height="256" fill="url(#halo)"/>`,
    `    <ellipse cx="128" cy="214" rx="64" ry="10" fill="#000000" opacity="0.6" filter="url(#blur)"/>`,
    `    ${word(8, "#000000", ' opacity="0.45"')}`,
    `    ${word(0, "url(#face)")}`,
    `    <rect width="256" height="256" fill="url(#pool)"/>`,
    `    <rect x="0.5" y="0.5" width="255" height="255" rx="56.5" fill="none" stroke="url(#edge)" stroke-width="1"/>`,
    `  </g>`,
    `</svg>`,
    ``,
  ].join("\n");
}
