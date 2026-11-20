// What an image-to-3D task costs in Meshy credits, per model, texture and geometry, and the models themselves.
// Read from Meshy's pages on PRICES_READ_ON; prices change, so check PRICES_SOURCE before a big run. A finished
// task's own `consumed_credits` is the truth (a failed task reports 0: Meshy refunds it).

/** When the credits and models below were read. */
export const PRICES_READ_ON = "2026-11-19";
/** Where the credits came from. */
export const PRICES_SOURCE = "https://docs.meshy.ai/api/pricing";
/** Where the models and options came from. */
export const API_SOURCE = "https://docs.meshy.ai/api/image-to-3d";
/** Where the plans came from (prices and credits a month; no price per credit is stated anywhere). */
export const PLANS_SOURCE = "https://www.meshy.ai/pricing";

export type ModelType = "standard" | "smart-topology";
export type TextureResolution = "2k" | "4k" | "8k";
export type GeometryResolution = "standard" | "2k" | "4k";

export interface AiModelInfo {
  id: string;
  label: string;
  /** The model_type it runs under; the Smart Topology models only under smart-topology. */
  modelType: ModelType;
  /** Credits: mesh only, then mesh and texture at each resolution (null: not offered). */
  mesh: number;
  texture: Readonly<Record<TextureResolution, number | null>>;
  /** Extra credits for Ultra geometry (geometry_resolution 2k or 4k); null: not offered. */
  ultra: number | null;
  /** The Ultra resolutions it takes. */
  ultraResolutions: readonly ("2k" | "4k")[];
  /** target_polycount's range and default (for standard models: only when remeshing). */
  polycount: { min: number; max: number; default: number };
  /** Meshy remeshes by default (should_remesh's default is true for meshy-6-lite, false for the rest). */
  remeshByDefault: boolean;
  /** Takes image_enhancement (meshy-6, meshy-7.1, latest only). */
  imageEnhancement: boolean;
  /** Takes topology "quad". */
  quad: boolean;
  /** Retiring: the date Meshy stops taking it. */
  retires?: string;
  note: string;
}

const STANDARD_POLY = { min: 100, max: 300_000, default: 30_000 };
const M71 = { mesh: 20, texture: { "2k": 30, "4k": 30, "8k": 35 }, ultra: 5 } as const;

/**
 * The ai_model values for image to 3D on PRICES_READ_ON (API_SOURCE) with their credits (PRICES_SOURCE).
 * `latest` is Meshy 7.1 since 2026-09-18. Meshy's own default for should_texture is true; this package's is false.
 * PBR maps and the remesh pass cost nothing extra (the pricing page lists no charge for either), and the
 * texture_model choice doesn't change the price.
 */
export const AI_MODELS: readonly AiModelInfo[] = [
  { id: "latest", label: "Meshy 7.1 (latest)", modelType: "standard", ...M71, ultraResolutions: ["2k", "4k"], polycount: STANDARD_POLY, remeshByDefault: false, imageEnhancement: true, quad: true, note: "Meshy's default; resolves to meshy-7.1." },
  { id: "meshy-7.1", label: "Meshy 7.1", modelType: "standard", ...M71, ultraResolutions: ["2k", "4k"], polycount: STANDARD_POLY, remeshByDefault: false, imageEnhancement: true, quad: true, note: "Added 2026-09-18." },
  { id: "meshy-7", label: "Meshy 7 (retiring)", modelType: "standard", ...M71, ultraResolutions: ["2k"], polycount: STANDARD_POLY, remeshByDefault: false, imageEnhancement: false, quad: true, retires: "2026-12-31", note: "Deprecated; a 400 from 2026-12-31. Use meshy-7.1." },
  { id: "meshy-6", label: "Meshy 6", modelType: "standard", mesh: 20, texture: { "2k": 30, "4k": 30, "8k": 35 }, ultra: null, ultraResolutions: [], polycount: STANDARD_POLY, remeshByDefault: false, imageEnhancement: true, quad: true, note: "" },
  { id: "meshy-6-lite", label: "Meshy 6 Lite", modelType: "standard", mesh: 5, texture: { "2k": 15, "4k": null, "8k": null }, ultra: null, ultraResolutions: [], polycount: STANDARD_POLY, remeshByDefault: true, imageEnhancement: false, quad: true, note: "The cheapest standard mesh; remeshes by default; 2K textures only." },
  { id: "meshy-t2", label: "Meshy T2 (Smart Topology)", modelType: "smart-topology", mesh: 5, texture: { "2k": 15, "4k": 15, "8k": 20 }, ultra: null, ultraResolutions: [], polycount: { min: 100, max: 15_000, default: 4_000 }, remeshByDefault: false, imageEnhancement: false, quad: false, note: "Clean low-poly triangles, parts kept apart." },
  { id: "meshy-t2.5", label: "Meshy T2.5 (Smart Topology)", modelType: "smart-topology", mesh: 5, texture: { "2k": 15, "4k": 15, "8k": 20 }, ultra: null, ultraResolutions: [], polycount: { min: 100, max: 30_000, default: 15_000 }, remeshByDefault: false, imageEnhancement: false, quad: false, note: "Smart Topology's default (2026-10-15): sharper detail." },
];

export const DEFAULT_AI_MODEL = "latest";
/** What Meshy uses for smart-topology when no ai_model is given. */
export const DEFAULT_SMART_TOPOLOGY_MODEL = "meshy-t2.5";

/** The model for an id (case-insensitive), or undefined for one this table doesn't know. */
export function aiModel(id: string): AiModelInfo | undefined {
  const k = id.trim().toLowerCase();
  return AI_MODELS.find((m) => m.id === k);
}

export interface CreditInput {
  aiModel?: string;
  modelType?: ModelType;
  /** Default false (mesh only). */
  shouldTexture?: boolean;
  /** Default 2k when textured. */
  textureResolution?: TextureResolution;
  /** 2k or 4k is Ultra (+5 on Meshy 7.1); standard or none is not. */
  geometryResolution?: GeometryResolution;
}

export interface CreditCost {
  aiModel: string;
  textured: boolean;
  textureResolution?: TextureResolution;
  ultra: boolean;
  credits: number;
  /** The table has no price for this model, or for this combination (Meshy would refuse it): credits is 0 and means "unknown". */
  unknown: boolean;
  /** Why, when unknown. */
  note?: string;
}

/** The credits one image-to-3D task costs, from the table. */
export function estimateCredits(input: CreditInput = {}): CreditCost {
  const id = (input.aiModel ?? (input.modelType === "smart-topology" ? DEFAULT_SMART_TOPOLOGY_MODEL : DEFAULT_AI_MODEL)).trim().toLowerCase();
  const textured = input.shouldTexture === true;
  const textureResolution = textured ? (input.textureResolution ?? "2k") : undefined;
  const ultra = input.geometryResolution === "2k" || input.geometryResolution === "4k";
  const base = { aiModel: id, textured, textureResolution, ultra };
  const m = aiModel(id);
  if (!m) return { ...base, credits: 0, unknown: true, note: `no price for ${id} (prices read ${PRICES_READ_ON})` };
  const tex = textured ? m.texture[textureResolution!] : m.mesh;
  if (tex == null) return { ...base, credits: 0, unknown: true, note: `${m.id} has no ${textureResolution} texture` };
  if (ultra && m.ultra == null) return { ...base, credits: 0, unknown: true, note: `${m.id} has no Ultra geometry` };
  return { ...base, credits: tex + (ultra ? (m.ultra ?? 0) : 0), unknown: false };
}

export interface RunCredits {
  credits: number;
  tasks: CreditCost[];
  /** Some task's price isn't in the table. */
  unknown: boolean;
}

/** The credits for a run of tasks. */
export function estimateRunCredits(tasks: readonly CreditInput[]): RunCredits {
  const each = tasks.map(estimateCredits);
  return { credits: each.reduce((s, t) => s + t.credits, 0), tasks: each, unknown: each.some((t) => t.unknown) };
}

// ---- Dollars ----

export interface PlanInfo {
  id: "pro" | "premium" | "ultra" | "studio";
  label: string;
  /** US dollars a month (the first month is half). */
  usdPerMonth: number;
  creditsPerMonth: number;
  /** usdPerMonth / creditsPerMonth: the plan's own rate, worked out here (Meshy states none). */
  usdPerCredit: number;
  /** Tasks PENDING or IN_PROGRESS at once (docs.meshy.ai/api/rate-limits). */
  concurrentTasks: number;
}

const plan = (id: PlanInfo["id"], label: string, usdPerMonth: number, creditsPerMonth: number, concurrentTasks: number): PlanInfo => ({
  id,
  label,
  usdPerMonth,
  creditsPerMonth,
  usdPerCredit: Math.round((usdPerMonth / creditsPerMonth) * 1_000_000) / 1_000_000,
  concurrentTasks,
});

/**
 * The plans with API access, read PRICES_READ_ON from PLANS_SOURCE (monthly prices). Meshy states no price per
 * credit on its pricing page or in its API docs, so nothing here prices a run unless the app or the CLI asks
 * with a rate (`--usd-per-credit pro`). The Free plan (100 credits a month) has no API.
 */
export const PLANS: readonly PlanInfo[] = [
  plan("pro", "Pro", 20, 1_000, 10),
  plan("premium", "Premium", 40, 3_000, 30),
  plan("studio", "Studio", 70, 5_500, 60),
  plan("ultra", "Ultra", 100, 8_000, 100),
];

/** A rate from a number ("0.02") or a plan name ("pro"); undefined for anything else. */
export function usdPerCreditOf(value: string | number | undefined | null): number | undefined {
  if (value == null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(String(value).replace(/^\$/, ""));
  if (Number.isFinite(n) && n >= 0) return n;
  return PLANS.find((p) => p.id === String(value).trim().toLowerCase())?.usdPerCredit;
}

/** Credits at a rate, to the hundredth of a cent; undefined without a rate. */
export function usdOf(credits: number, usdPerCredit: number | undefined | null): number | undefined {
  return usdPerCredit == null ? undefined : Math.round(credits * usdPerCredit * 10_000) / 10_000;
}

/** `$0.40`, or `$0.0123` under a cent. */
export function formatUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
