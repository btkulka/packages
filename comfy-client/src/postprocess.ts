import sharp from "sharp";
import { Buffer } from "node:buffer";

export interface PixelateOptions {
  /** Target pixel-grid size (long edge), in px. Typically 64–128. */
  size: number;
  /** Palette colour count for quantization. Typically 16–32. 0 disables quantize. */
  colors?: number;
  /**
   * If set, scales the quantized grid back UP by this integer factor with
   * nearest-neighbor, so the export reads crisp at display size while staying
   * true to the small grid. Omit to return at the small `size`.
   */
  upscale?: number;
  /** Square-crop to `size`×`size` (cover) instead of aspect-preserving fit. */
  square?: boolean;
  /**
   * Thicken dark line work by growing dark/high-contrast pixels by N px on the
   * FULL-RES input BEFORE the downscale, so outlines survive the shrink and read
   * heavier. Conservative (only genuinely dark pixels dilate). 0 = off. 1 = subtle.
   */
  lineThicken?: number;
}

/**
 * Turn a full-res render into pixel art: nearest-neighbor downscale to a small
 * grid, then optional palette quantization, then optional integer upscale.
 *
 * This is the generic "make it pixel art" post-process recommended for the
 * SDXL/Illustrious → pixel sprite pipeline (downscale to ~64–128px + quantize
 * to ~16–32 colours). Output is always PNG.
 */
/**
 * LINE-THICKEN: grow dark line work on a full-res render by `radius` px before the
 * downscale. Operates on raw RGBA: a pixel takes the DARKEST value found in its
 * (2r+1)² neighbourhood, but ONLY where that darkest neighbour is genuinely dark
 * (luma < `darkLuma`). So black/near-black outlines spread into adjacent lighter
 * pixels (thicker lines) while mid-tone fills and highlights are left alone. Alpha
 * is preserved. Cheap separable-ish box min over the small radius.
 */
async function thickenLines(input: Buffer, radius: number, darkLuma = 96): Promise<Buffer> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const src = new Uint8Array(data);
  const out = new Uint8Array(src); // copy; we only darken
  const luma = (i: number) => 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = (y * width + x) * channels;
      if (src[c + 3] === 0) continue; // skip fully transparent
      // Find the darkest opaque neighbour within the radius.
      let bestLuma = luma(c);
      let bi = c;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const n = (ny * width + nx) * channels;
          if (src[n + 3] === 0) continue;
          const nl = luma(n);
          if (nl < bestLuma) { bestLuma = nl; bi = n; }
        }
      }
      // Only spread if the darkest neighbour is genuinely a line (dark), and it's
      // darker than the current pixel — paint this pixel that line colour.
      if (bi !== c && bestLuma < darkLuma) {
        out[c] = src[bi];
        out[c + 1] = src[bi + 1];
        out[c + 2] = src[bi + 2];
        // keep this pixel's own alpha
      }
    }
  }
  return sharp(Buffer.from(out), { raw: { width, height, channels } }).png().toBuffer();
}

export async function pixelate(input: Buffer, opts: PixelateOptions): Promise<Buffer> {
  const colors = opts.colors ?? 16;
  // Optional line-thickening on the full-res render BEFORE downscale.
  const lineThicken = Math.max(0, Math.floor(opts.lineThicken ?? 0));
  const source = lineThicken > 0 ? await thickenLines(input, lineThicken) : input;
  let img = sharp(source).resize(
    opts.size,
    opts.size,
    opts.square
      ? { fit: "cover", position: "attention", kernel: sharp.kernel.nearest }
      : { fit: "inside", kernel: sharp.kernel.nearest },
  );

  if (opts.upscale && opts.upscale > 1) {
    // Re-read the small grid's actual dimensions isn't needed — nearest scale
    // by an integer factor preserves the grid regardless of fit mode.
    img = sharp(await img.png().toBuffer()).resize({
      width: opts.size * opts.upscale,
      height: opts.size * opts.upscale,
      fit: opts.square ? "cover" : "inside",
      kernel: sharp.kernel.nearest,
    });
  }

  // Palette quantization via PNG palette mode (colours = max palette entries).
  const png =
    colors > 0
      ? img.png({ palette: true, colours: Math.max(2, Math.min(256, colors)), compressionLevel: 9 })
      : img.png({ compressionLevel: 9 });
  return png.toBuffer();
}

export interface RemoveBackgroundOptions {
  /** Per-channel colour distance (0–255) a pixel may differ from the corner seed
   *  and still count as background. ~24 suits flat pixel-art bg. */
  tolerance?: number;
  /** Width in px of a solid stroke painted around the subject silhouette after
   *  keying — the crisp "sticker" border. 0 disables. Default 0. */
  outline?: number;
  /** Outline colour as [r,g,b]. Default white [255,255,255]. */
  outlineColor?: [number, number, number];
  /** Smooth the keyed silhouette by 1px so the edge isn't jagged. Default true. */
  feather?: boolean;
  /**
   * EDGE-STOP (anti-bleed). When set, the flood ALSO stops at a strong local colour
   * edge even if the pixel is still within `tolerance` of the seed — so a thin
   * background-coloured bridge (a gap in hair, the seam between arm and torso) can't
   * tunnel the fill into the subject and eat interior regions. The value is the
   * gradient threshold (max per-channel jump to a neighbour, 0–255) that counts as an
   * edge; ~32 is a good start. 0/undefined disables (legacy plain flood).
   */
  edgeStop?: number;
  /**
   * SAFETY CAP. If the flood would key MORE than this fraction of the image (0–1),
   * the bg colour is too close to the subject and the fill is bleeding — the result
   * is discarded and the ORIGINAL (opaque) image is returned rather than a chewed-up
   * subject. Default 0 (disabled). ~0.92 is a sane guard for a centered portrait on
   * a plain bg (bg is usually <~85% of the frame).
   */
  maxFillRatio?: number;
  /**
   * AUTO TOLERANCE. When true, `tolerance` is derived PER IMAGE from how far the
   * corner (background) colour sits from the subject's average colour: tolerance =
   * clamp(distance * autoFraction, autoMin, autoMax). A distinct bg → a generous
   * tolerance (clean tight cut); a bg close to the subject → a small tolerance so
   * the flood errs toward KEEPING pixels (a thin fringe) rather than eating the
   * subject. The explicit `tolerance` becomes the UPPER clamp (autoMax) unless
   * autoMax is given. This is the robust default for plain (non-chroma) backgrounds.
   */
  autoTolerance?: boolean;
  /** Fraction of the bg↔subject colour distance used as tolerance. Default 0.35. */
  autoFraction?: number;
  /** Lower clamp for auto tolerance. Default 8. */
  autoMin?: number;
  /** Upper clamp for auto tolerance. Default = `tolerance` (or 40). */
  autoMax?: number;
  /**
   * DESPECKLE (background-noise cleanup). After keying, the corner flood only
   * removes background pixels CONNECTED to a corner — stray disconnected specks the
   * model invented (a fleck of bg-coloured noise in a pocket, an AA island, a
   * dust-mote artifact) survive and read as junk around the subject. This pass
   * labels the remaining OPAQUE connected components and clears every tiny island,
   * so only the real subject (and any substantial detached part — a raised hand, a
   * held item) is kept.
   *
   * An island is cleared when it is BOTH (a) absolutely small — below
   * `despeckleAreaFraction` of the whole frame (default 0.08%, resolution-aware so a
   * fixed speck size scales with the image) — AND (b) far smaller than the subject
   * (< 25% of the largest component), a hard guard so a genuine big detached part is
   * never deleted even on a small canvas. Set `despeckle:false` to disable, or pass
   * an explicit `despeckleAreaFraction`. Default ON.
   */
  despeckle?: boolean;
  /** Min island size to survive, as a fraction of the WHOLE frame (0..1). Default 0.0008. */
  despeckleAreaFraction?: number;
  /**
   * KEEP-LARGEST (subject isolation). A far more aggressive cousin of despeckle for
   * CENTERED PORTRAITS where the model painted scenery the corner-flood can't reach
   * (a night sky, side buildings, a floating detached horn). Instead of only clearing
   * TINY islands, this keeps the SUBJECT component — the largest opaque blob that also
   * overlaps the image centre — plus any island ≥ `keepLargestMinFraction` of it, and
   * clears everything else. So a whole dark-scenery block or a floating scrap is
   * dropped even when it's large, while a genuine big detached limb survives.
   *
   * Only enable for portrait/character cutouts (the centred-subject assumption is
   * load-bearing). Default OFF — set `keepLargest:true`. Ignores `despeckle` when on
   * (it's a superset). The subject blob must overlap the central window OR be the
   * outright largest, so a subject touching an edge is still kept.
   */
  keepLargest?: boolean;
  /** An island survives keep-largest if ≥ this fraction of the subject blob. Default 0.18. */
  keepLargestMinFraction?: number;
}

/**
 * Background removal by CORNER FLOOD-FILL, with an optional white OUTLINE stroke.
 *
 * The dialogue/sprite prompts force a plain, flat background, so the four corners
 * are reliably the background colour. We flood-fill outward from each corner,
 * turning every pixel within `tolerance` of the seed colour transparent, stopping
 * at the subject's silhouette. CPU-only (sharp + a scanline fill) — no GPU/matte
 * node, so no VITMatte/RemBgUltra segfault risk on low-VRAM machines.
 *
 * Two refinements over a bare flood key, both aimed at the clean "sticker" cutout:
 *   • FEATHER — the boundary alpha is smoothed 1px so the silhouette edge reads
 *     crisp, not stair-stepped (the jagged look of a raw binary key).
 *   • OUTLINE — after keying, the opaque silhouette is dilated by `outline` px and
 *     the new ring is painted solid (white by default). This gives every cutout a
 *     uniform border AND hides any residual flood-fill fringe at the edge.
 *
 * Caveat: the flood only removes background CONNECTED to a corner. Disconnected,
 * non-background-coloured elements the model invented (a floating creature, a dark
 * ground band) are genuine content, not keyed out — keep the prompt's plain-bg
 * tags strong. The outline anchors the silhouette regardless.
 *
 * Back-compat: callable as removeBackground(buf, 24) (legacy tolerance number) or
 * removeBackground(buf, { tolerance, outline, outlineColor, feather }).
 */
export async function removeBackground(
  input: Buffer,
  opts: number | RemoveBackgroundOptions = {},
): Promise<Buffer> {
  const o: RemoveBackgroundOptions = typeof opts === "number" ? { tolerance: opts } : opts;
  let tolerance = o.tolerance ?? 24;
  const outline = Math.max(0, Math.floor(o.outline ?? 0));
  const [or, og, ob] = o.outlineColor ?? [255, 255, 255];
  const feather = o.feather !== false;
  const edgeStop = Math.max(0, Math.floor(o.edgeStop ?? 0));
  const maxFillRatio = Math.max(0, Math.min(1, o.maxFillRatio ?? 0));
  const despeckle = o.despeckle !== false; // default ON
  const despeckleAreaFraction = Math.max(0, Math.min(0.5, o.despeckleAreaFraction ?? 0.0008));
  const keepLargest = o.keepLargest === true; // opt-in (centred-portrait cutouts)
  const keepLargestMinFraction = Math.max(0, Math.min(1, o.keepLargestMinFraction ?? 0.18));

  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (channels !== 4 || width === 0 || height === 0) return input;
  const px = new Uint8ClampedArray(data); // mutable RGBA copy

  // AUTO TOLERANCE: derive per-image tolerance from the bg↔subject colour gap so a
  // bg close to the subject keys conservatively (keep pixels, thin fringe) and a
  // distinct bg keys tightly. bg = mean of the 4 corners; subject = mean of a small
  // central window (the subject is framed centre). tolerance = clamp(gap*frac,min,max).
  if (o.autoTolerance) {
    const frac = o.autoFraction ?? 0.35;
    const lo = o.autoMin ?? 8;
    const hi = o.autoMax ?? o.tolerance ?? 40;
    const at = (x: number, y: number) => { const i = (y * width + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
    const mean = (pts: number[][]) => {
      const s = [0, 0, 0];
      for (const p of pts) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
      return s.map((v) => v / pts.length);
    };
    const bg = mean([at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)]);
    // central window ~ the middle 20% box, sampled on a small grid.
    const subjPts: number[][] = [];
    const x0 = Math.floor(width * 0.4), x1 = Math.ceil(width * 0.6);
    const y0 = Math.floor(height * 0.4), y1 = Math.ceil(height * 0.6);
    const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 8));
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) subjPts.push(at(x, y));
    const subj = subjPts.length ? mean(subjPts) : [128, 128, 128];
    const gap = Math.max(Math.abs(bg[0] - subj[0]), Math.abs(bg[1] - subj[1]), Math.abs(bg[2] - subj[2]));
    tolerance = Math.round(Math.max(lo, Math.min(hi, gap * frac)));
  }

  const idx = (x: number, y: number) => (y * width + x) * 4;
  const isBg = (i: number, r: number, g: number, b: number) =>
    Math.abs(px[i] - r) <= tolerance &&
    Math.abs(px[i + 1] - g) <= tolerance &&
    Math.abs(px[i + 2] - b) <= tolerance;
  // EDGE-STOP: is there a strong colour jump between pixel `i` and `j`? Used to halt
  // the flood at a silhouette/interior edge even when both pixels are within
  // tolerance of the seed — this is what stops the fill tunnelling through a thin
  // bg-coloured bridge (hair gap, arm/torso seam) into the subject.
  const isEdge = (i: number, j: number) =>
    edgeStop > 0 &&
    (Math.abs(px[i] - px[j]) > edgeStop ||
      Math.abs(px[i + 1] - px[j + 1]) > edgeStop ||
      Math.abs(px[i + 2] - px[j + 2]) > edgeStop);

  const visited = new Uint8Array(width * height);
  const stack: number[] = [];
  let filled = 0; // count of pixels keyed transparent (for the safety cap)
  // Seed from all four corners — robust if the subject touches one edge.
  const corners: [number, number][] = [
    [0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1],
  ];
  for (const [cx, cy] of corners) {
    const ci = idx(cx, cy);
    if (px[ci + 3] === 0) continue; // already transparent corner
    const r = px[ci], g = px[ci + 1], b = px[ci + 2];
    stack.push(cy * width + cx);
    while (stack.length) {
      const p = stack.pop()!;
      if (visited[p]) continue;
      visited[p] = 1;
      const x = p % width, y = (p / width) | 0;
      const i = p * 4;
      if (!isBg(i, r, g, b)) continue; // hit the subject silhouette — stop here
      px[i + 3] = 0; // key to transparent
      filled++;
      // Push neighbours, but DON'T cross a strong colour edge (edge-stop guard):
      // the neighbour is only enqueued if the step to it isn't an edge. The neighbour
      // still has to pass isBg() when popped, so this only ADDS a stopping condition.
      if (x > 0 && !isEdge(i, i - 4)) stack.push(p - 1);
      if (x < width - 1 && !isEdge(i, i + 4)) stack.push(p + 1);
      if (y > 0 && !isEdge(i, i - width * 4)) stack.push(p - width);
      if (y < height - 1 && !isEdge(i, i + width * 4)) stack.push(p + width);
    }
  }

  // SAFETY CAP: if the flood ate more than maxFillRatio of the frame, the bg is too
  // close to the subject and the key is bleeding — bail and return the untouched
  // original rather than ship a chewed-up subject. (A no-op when maxFillRatio is 0.)
  if (maxFillRatio > 0 && filled > maxFillRatio * width * height) {
    return input;
  }

  const n = width * height;

  // ── DESPECKLE / KEEP-LARGEST: prune the OPAQUE islands the corner flood couldn't
  // reach. The flood only keys background CONNECTED to a corner, so disconnected
  // regions survive: tiny specks (bg-noise flecks, AA islands) AND — when the model
  // painted scenery — whole junk blobs (a night-sky rectangle, side buildings, a
  // floating detached horn). We label the opaque components (4-neighbour) once, then:
  //   • despeckle (default): clear only islands below a small area floor — keeps the
  //     subject and any substantial detached part (a raised hand, a held item).
  //   • keepLargest (portrait opt-in): keep the SUBJECT blob (largest that overlaps
  //     the centre) + any island ≥ keepLargestMinFraction of it; clear everything
  //     else, however large — this is what removes painted scenery.
  // Runs BEFORE outline/feather so we never draw a sticker border around junk.
  if (despeckle || keepLargest) {
    const label = new Int32Array(n).fill(-1);
    const sizes: number[] = [];
    const centerHits: number[] = []; // per-component: pixel count inside the central window
    const q = new Int32Array(n); // BFS scratch
    // Central window (middle 40%) — the character in a centred portrait always
    // overlaps it; scenery blobs rarely dominate it.
    const cx0 = Math.floor(width * 0.3), cx1 = Math.ceil(width * 0.7);
    const cy0 = Math.floor(height * 0.3), cy1 = Math.ceil(height * 0.7);
    for (let s = 0; s < n; s++) {
      if (px[s * 4 + 3] === 0 || label[s] !== -1) continue;
      const id = sizes.length;
      let head = 0, tail = 0, count = 0, hits = 0;
      q[tail++] = s; label[s] = id;
      while (head < tail) {
        const p = q[head++];
        count++;
        const x = p % width, y = (p / width) | 0;
        if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) hits++;
        if (x > 0)          { const np = p - 1;     if (px[np * 4 + 3] !== 0 && label[np] === -1) { label[np] = id; q[tail++] = np; } }
        if (x < width - 1)  { const np = p + 1;     if (px[np * 4 + 3] !== 0 && label[np] === -1) { label[np] = id; q[tail++] = np; } }
        if (y > 0)          { const np = p - width; if (px[np * 4 + 3] !== 0 && label[np] === -1) { label[np] = id; q[tail++] = np; } }
        if (y < height - 1) { const np = p + width; if (px[np * 4 + 3] !== 0 && label[np] === -1) { label[np] = id; q[tail++] = np; } }
      }
      sizes.push(count);
      centerHits.push(hits);
    }
    if (sizes.length > 1) {
      const largest = sizes.reduce((m, v) => (v > m ? v : m), 0);
      let keep: (id: number) => boolean;
      if (keepLargest) {
        // SUBJECT = the component with the most central-window overlap; ties → biggest.
        // Falls back to the outright largest if nothing overlaps the centre (edge case).
        let subj = 0;
        for (let i = 1; i < sizes.length; i++) {
          if (centerHits[i] > centerHits[subj] ||
              (centerHits[i] === centerHits[subj] && sizes[i] > sizes[subj])) subj = i;
        }
        if (centerHits[subj] === 0) for (let i = 0; i < sizes.length; i++) if (sizes[i] > sizes[subj]) subj = i;
        const minSize = Math.max(1, Math.floor(sizes[subj] * keepLargestMinFraction));
        keep = (id) => id === subj || sizes[id] >= minSize;
      } else {
        // Despeckle: absolute area floor, capped at 25% of the subject so a genuine
        // big detached part is never deleted even on a small canvas.
        const areaFloor = Math.floor(n * despeckleAreaFraction);
        const minSize = Math.max(1, Math.min(areaFloor, Math.floor(largest * 0.25)));
        keep = (id) => sizes[id] >= minSize;
      }
      let cleared = 0;
      for (let p = 0; p < n; p++) {
        const id = label[p];
        if (id >= 0 && !keep(id)) { px[p * 4 + 3] = 0; cleared++; }
      }
      if (cleared) filled += cleared;
    }
  }

  // Build an opacity mask (1 = subject, 0 = keyed bg) for feather + outline.
  const opaque = new Uint8Array(n);
  for (let p = 0; p < n; p++) opaque[p] = px[p * 4 + 3] > 0 ? 1 : 0;

  // ── OUTLINE: dilate the opaque silhouette by `outline` px; paint the grown
  // ring a solid colour. Chebyshev (square) dilation via a simple BFS distance.
  if (outline > 0) {
    const dist = new Int32Array(n).fill(-1);
    const q: number[] = [];
    for (let p = 0; p < n; p++) if (opaque[p]) { dist[p] = 0; q.push(p); }
    let head = 0;
    while (head < q.length) {
      const p = q[head++];
      const d = dist[p];
      if (d >= outline) continue;
      const x = p % width, y = (p / width) | 0;
      const neigh = [
        x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1,
        y > 0 ? p - width : -1, y < height - 1 ? p + width : -1,
      ];
      for (const np of neigh) {
        if (np < 0 || dist[np] !== -1) continue;
        dist[np] = d + 1; q.push(np);
      }
    }
    for (let p = 0; p < n; p++) {
      if (opaque[p]) continue;          // keep the subject
      if (dist[p] > 0 && dist[p] <= outline) { // the grown ring
        const i = p * 4;
        px[i] = or; px[i + 1] = og; px[i + 2] = ob; px[i + 3] = 255;
      }
    }
  }

  // ── FEATHER: smooth ONLY the alpha channel at the silhouette edge so the cut
  // (and the outline's outer rim) reads crisp, not stair-stepped. A 3×3 box blur
  // applied just to edge pixels (alpha neighbours that differ) — interior colours
  // are never touched, and no wide translucent halo is introduced.
  if (feather) {
    const a = new Uint8ClampedArray(n);
    for (let p = 0; p < n; p++) a[p] = px[p * 4 + 3];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        // Only touch boundary pixels (where a neighbour's alpha differs), so solid
        // interior and far background stay exactly 255/0.
        const up = y > 0 ? a[p - width] : a[p];
        const dn = y < height - 1 ? a[p + width] : a[p];
        const lf = x > 0 ? a[p - 1] : a[p];
        const rt = x < width - 1 ? a[p + 1] : a[p];
        if (up === a[p] && dn === a[p] && lf === a[p] && rt === a[p]) continue;
        const sum = a[p] + up + dn + lf + rt
          + (x > 0 && y > 0 ? a[p - width - 1] : a[p])
          + (x < width - 1 && y > 0 ? a[p - width + 1] : a[p])
          + (x > 0 && y < height - 1 ? a[p + width - 1] : a[p])
          + (x < width - 1 && y < height - 1 ? a[p + width + 1] : a[p]);
        px[p * 4 + 3] = Math.round(sum / 9);
      }
    }
  }

  return sharp(Buffer.from(px), { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function downscaleSquare(input: Buffer, size: number): Promise<Buffer> {
  return sharp(input)
    .resize(size, size, { fit: "cover", position: "attention", kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Aspect-preserving downscale; the long edge is clamped to `longEdge`, the
 * short edge is scaled proportionally. Used for landscape thumbnails where
 * cropping to a square would chop off whichever side carries the subject.
 */
export async function downscaleLongEdge(input: Buffer, longEdge: number): Promise<Buffer> {
  return sharp(input)
    .resize({ width: longEdge, height: longEdge, fit: "inside", kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * For dialogue art (transparent PNG): trim fully-transparent rows from the
 * top so the subject's head sits at y=0 regardless of how tightly the model
 * framed them. Side / bottom transparent margins are preserved — only the
 * top is cropped, because the renderer aligns by character height and a
 * consistent head-top is what makes "normalized to character height" work.
 *
 * Pixels with alpha ≤ `alphaThreshold` are considered transparent. The
 * threshold tolerates the soft halo that VITMatte sometimes leaves around
 * stray hair strands.
 */
export async function trimTransparentTop(
  input: Buffer,
  alphaThreshold: number = 8,
): Promise<Buffer> {
  const img = sharp(input);
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (channels !== 4) return input;

  const stride = width * channels;
  let firstOpaqueRow = 0;
  outer: for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    for (let x = 0; x < width; x++) {
      const alpha = data[rowStart + x * channels + 3];
      if (alpha > alphaThreshold) {
        firstOpaqueRow = y;
        break outer;
      }
    }
  }
  if (firstOpaqueRow === 0) return input;

  return sharp(input)
    .extract({ left: 0, top: firstOpaqueRow, width, height: height - firstOpaqueRow })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
