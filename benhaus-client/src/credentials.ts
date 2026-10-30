import { createBenhausClient, type BenhausClient } from "./client.js";
import { isBenhausError } from "./errors.js";

// Settings › Credentials from an app: read a credential from Benhäus, falling back to the environment when
// Benhäus is closed or doesn't have it, and fill process.env with what Benhäus would inject at start.

/** Benhäus isn't there to ask (closed, restarted with a new token, too old for /credentials): use the fallback. */
const unreachable = (e: unknown) =>
  isBenhausError(e, "offline") || isBenhausError(e, "timeout") || isBenhausError(e, "unauthorized") || (isBenhausError(e, "http") && e.status === 404);

let shared: BenhausClient | undefined;
const clientOf = (c?: BenhausClient) => c ?? (shared ??= createBenhausClient());

export interface LoadCredentialOptions {
  /** Your tool id in Benhäus: it shows on the credential's "Read by" line. */
  app?: string;
  /** The fallback: field → environment variable, read when Benhäus can't answer or lacks a field. */
  env?: Record<string, string>;
  /** Where the fallback reads. Default process.env. */
  source?: Record<string, string | undefined>;
  /** Fields that have to be there, from either place; without them the result is undefined. */
  required?: string[];
  /** Per call. Default 3 s, so a closed Benhäus doesn't hold up start. */
  timeoutMs?: number;
  client?: BenhausClient;
}

export interface LoadedCredential {
  id: string;
  fields: Record<string, string>;
  /** Where the fields came from: Benhäus for any it had, the environment for the rest. */
  source: "benhaus" | "env" | "both";
  updatedAt?: string;
}

/**
 * A credential's fields from Benhäus, with the environment filling whatever Benhäus doesn't have (or everything,
 * when it's closed). Undefined when a required field is still missing. Throws only for a real failure in
 * Benhäus (not for it being closed).
 *
 *     const tw = await loadCredential("twilio/honeycomber", {
 *       app: "honeycomber",
 *       env: { accountSid: "TWILIO_ACCOUNT_SID", authToken: "TWILIO_AUTH_TOKEN", from: "TWILIO_FROM" },
 *       required: ["accountSid", "authToken"],
 *     });
 */
export async function loadCredential(id: string, o: LoadCredentialOptions = {}): Promise<LoadedCredential | undefined> {
  let fromBenhaus: Record<string, string> = {};
  let updatedAt: string | undefined;
  try {
    const c = await clientOf(o.client).credentials.get(id, { app: o.app }, { timeoutMs: o.timeoutMs ?? 3000 });
    if (c) {
      fromBenhaus = c.fields;
      updatedAt = c.updatedAt;
    }
  } catch (e) {
    if (!unreachable(e)) throw e;
  }
  const source = o.source ?? process.env;
  const fromEnv: Record<string, string> = {};
  for (const [field, name] of Object.entries(o.env ?? {})) {
    const v = source[name]?.trim();
    if (v && fromBenhaus[field] === undefined) fromEnv[field] = v;
  }
  const fields = { ...fromEnv, ...fromBenhaus };
  if (!Object.keys(fields).length) return undefined;
  if (o.required?.some((f) => !fields[f])) return undefined;
  const b = Object.keys(fromBenhaus).length > 0;
  const env = Object.keys(fromEnv).length > 0;
  return { id, fields, source: b && env ? "both" : b ? "benhaus" : "env", updatedAt };
}

export interface ApplyEnvOptions {
  /** Your tool id in Benhäus: the variables it injects into that tool are the ones set. */
  app: string;
  /** Replace variables that are already set. Default false: the environment (a .env, a shell) wins. */
  override?: boolean;
  /** Default process.env. */
  target?: Record<string, string | undefined>;
  timeoutMs?: number;
  client?: BenhausClient;
}

export interface ApplyEnvResult {
  /** Variables set. */
  applied: string[];
  /** Already set, so left alone. */
  kept: string[];
  /** References Benhäus couldn't fill. */
  missing: string[];
  /** Benhäus couldn't be asked; nothing changed. */
  offline: boolean;
}

/**
 * For an app started outside Benhäus (a terminal, Claude Code, a scheduled task): sets the variables Benhäus
 * would have injected had it started the app. Call it first thing in main. Never throws for Benhäus being closed.
 */
export async function applyBenhausEnv(o: ApplyEnvOptions): Promise<ApplyEnvResult> {
  const target = o.target ?? process.env;
  let r: { env: Record<string, string>; missing: string[] };
  try {
    r = await clientOf(o.client).credentials.env({ app: o.app }, { timeoutMs: o.timeoutMs ?? 3000 });
  } catch (e) {
    if (unreachable(e)) return { applied: [], kept: [], missing: [], offline: true };
    throw e;
  }
  const applied: string[] = [];
  const kept: string[] = [];
  for (const [name, value] of Object.entries(r.env)) {
    if (!o.override && target[name]) {
      kept.push(name);
      continue;
    }
    target[name] = value;
    applied.push(name);
  }
  return { applied, kept, missing: r.missing, offline: false };
}
