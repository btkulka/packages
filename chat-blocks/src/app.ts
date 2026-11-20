// App pages: a block an app draws itself, served from its MCP server as an MCP
// Apps (SEP-1865, spec 2026-01-26) ui:// resource and shown in a sandboxed
// iframe. The page and the chat talk JSON-RPC over postMessage: the page asks
// ui/initialize, the chat answers with its theme and what it can do, the page
// says initialized, and the chat sends the block's props as the tool input.
// Three methods beyond the spec, under hostCapabilities.experimental
// ["btkulka/blocks"]: answer (the page's answer resolves the waiting
// await_feedback call), image (a chat image's bytes, as a data: address) and
// file (a file the block names, or one beside it, as bytes: a 3D model, its
// textures); and star (the chat's star on files the block names: Benhäus keeps
// them in Gallery).
// Pure strings and types: the chat (host side) and the bridge (page side) both
// use them.

import type { RawAnswer } from "./blocks.js";

export const MCP_APP_MIME = "text/html;profile=mcp-app";
export const APPS_PROTOCOL = "2026-01-26";
/** hostCapabilities.experimental's key for this package's methods. */
export const BLOCKS_EXT = "btkulka/blocks";

/** The JSON-RPC methods the chat and a page use. */
export const M = {
  initialize: "ui/initialize",
  initialized: "ui/notifications/initialized",
  toolInput: "ui/notifications/tool-input",
  toolResult: "ui/notifications/tool-result",
  toolCancelled: "ui/notifications/tool-cancelled",
  contextChanged: "ui/notifications/host-context-changed",
  sizeChanged: "ui/notifications/size-changed",
  teardown: "ui/resource-teardown",
  openLink: "ui/open-link",
  message: "ui/message",
  modelContext: "ui/update-model-context",
  displayMode: "ui/request-display-mode",
  log: "notifications/message",
  ping: "ping",
  /** Beyond the spec: the page's answer. Params RawAnswer; result {}. */
  answer: `${BLOCKS_EXT}/answer`,
  /** Beyond the spec: an image the chat can read (a path, an address, a kept id) as { url: "data:…" }. */
  image: `${BLOCKS_EXT}/image`,
  /** Beyond the spec: a file the block's props name, or one in the folder of one (any depth). Params FileParams; result FileResult. */
  file: `${BLOCKS_EXT}/file`,
  /** Beyond the spec: the star on files the block's props name. Params StarParams; result StarResult. */
  star: `${BLOCKS_EXT}/star`,
} as const;

export type JsonRpcId = number | string;
export type RpcMessage =
  | { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: unknown }
  | { jsonrpc: "2.0"; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

export const isRpc = (v: unknown): v is RpcMessage => typeof v === "object" && v !== null && (v as { jsonrpc?: unknown }).jsonrpc === "2.0";

/** What the chat tells a page about itself (the spec's HostContext, the parts this chat fills). */
export interface HostContext {
  toolInfo?: { id?: JsonRpcId; tool: { name: string; inputSchema?: Record<string, unknown> } };
  theme?: "light" | "dark";
  styles?: { variables?: Record<string, string | undefined>; css?: { fonts?: string } };
  displayMode?: "inline" | "fullscreen" | "pip";
  availableDisplayModes?: string[];
  containerDimensions?: { maxHeight?: number; maxWidth?: number; width?: number; height?: number };
  locale?: string;
  timeZone?: string;
  userAgent?: string;
  platform?: "web" | "desktop" | "mobile";
  /** Beyond the spec: the block's title and body, which the chat draws above the page. */
  block?: { title?: string; body?: string; app?: string };
}

export interface InitializeResult {
  protocolVersion: string;
  hostInfo: { name: string; version: string };
  hostCapabilities: { openLinks?: Record<string, never>; logging?: Record<string, never>; experimental?: Record<string, unknown> };
  hostContext: HostContext;
}

/** The answer method's params. */
export type AnswerParams = RawAnswer;

/** The file method's params: a path or file: address the block's props name, or one beside such a path. */
export interface FileParams {
  ref: string;
}

/** The file method's result: the file's bytes (transferred, not copied), its type from its extension, its name and size. */
export interface FileResult {
  bytes: ArrayBuffer;
  type: string;
  name: string;
  size: number;
}

/** What hostCapabilities.experimental["btkulka/blocks"] says the chat can do for a page. */
/** The star method's params: paths the block's props name; `on` stars or unstars them all, left out it only asks. */
export interface StarParams {
  refs: string[];
  on?: boolean;
}
/** The star method's result: whether each is starred now, in the order asked. */
export interface StarResult {
  starred: boolean[];
}

export interface BlocksCapabilities {
  answer?: boolean;
  image?: boolean;
  file?: boolean;
  star?: boolean;
}

/** A resource's _meta.ui.csp (the domains its page may reach). */
export interface PageCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

const DOMAIN = /^(https?|wss?):\/\/[\w.*-]+(:\d+|:\*)?$/i;
const domains = (list: string[] | undefined) => (list ?? []).filter((d) => DOMAIN.test(d)).join(" ");

/**
 * The policy a page runs under: the spec's defaults (inline script and style,
 * images as data:, nothing else) plus the domains its resource declared, and
 * blob: images so the bridge's image() addresses draw. connect-src takes the
 * page's own blob: and data: addresses (nothing on the network), so a loader
 * that fetches what it unpacked itself (three.js's GLTFLoader, a model's
 * textures) works. Never wider.
 */
export function pagePolicy(csp?: PageCsp): string {
  const res = domains(csp?.resourceDomains);
  const plus = (base: string) => (res ? `${base} ${res}` : base);
  return [
    "default-src 'none'",
    `script-src ${plus("'self' 'unsafe-inline'")}`,
    `style-src ${plus("'self' 'unsafe-inline'")}`,
    `img-src ${plus("'self' data: blob:")}`,
    `font-src ${plus("'self' data:")}`,
    `media-src ${plus("'self' data: blob:")}`,
    `connect-src ${["blob: data:", domains(csp?.connectDomains)].filter(Boolean).join(" ")}`,
    `frame-src ${domains(csp?.frameDomains) || "'none'"}`,
    `base-uri ${domains(csp?.baseUriDomains) || "'self'"}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ");
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** A page's HTML with its policy at the top of its head, so nothing in it runs or loads before the policy holds. */
export function withPolicy(html: string, csp?: PageCsp): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escAttr(pagePolicy(csp))}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${meta}</head>`);
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

/** The spec's standard style variables, from the chat's --ck-* ones; the --ck-* ones go along too, so a page built on frame.css matches exactly. */
export function styleVariables(ck: Record<string, string>): Record<string, string> {
  const v = (k: string) => ck[`--ck-${k}`];
  const std: Record<string, string | undefined> = {
    "--color-background-primary": v("surface"),
    "--color-background-secondary": v("surface-2"),
    "--color-background-tertiary": v("surface-3"),
    "--color-text-primary": v("ink"),
    "--color-text-secondary": v("ink-2"),
    "--color-text-tertiary": v("ink-3"),
    "--color-text-danger": v("alert"),
    "--color-text-info": v("live"),
    "--color-border-primary": v("stroke-strong"),
    "--color-border-secondary": v("stroke"),
    "--color-ring-primary": v("focus"),
    "--font-sans": v("font"),
    "--font-mono": v("mono"),
    "--border-radius-md": v("radius"),
  };
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(std)) if (x) out[k] = x;
  for (const [k, x] of Object.entries(ck)) if (k.startsWith("--ck-") && x) out[k] = x;
  return out;
}

/** The --ck-* variables a page gets, read from an element under .ck-root. */
export const CK_VARIABLES = [
  "ink", "ink-2", "ink-3", "surface", "surface-2", "surface-3", "stroke", "stroke-strong", "field", "field-border",
  "selected", "selected-border", "picked", "picked-ink", "accent", "accent-ink", "focus", "live", "alert", "font", "mono", "radius", "quick", "ease",
].map((k) => `--ck-${k}`);
