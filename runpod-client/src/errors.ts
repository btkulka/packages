// RunPodError: a failed call with RunPod's status and message, and a category an app branches on.

/**
 * - `auth`: no key, or RunPod rejected it. Fix the key.
 * - `capacity`: that GPU has no free machine right now (try the next one).
 * - `funds`: the account has no credit left for this.
 * - `request`: RunPod didn't accept the request as written.
 * - `budget`: this package refused: the plan would cost more than the cap, or nothing fits.
 * - `server`: RunPod failed or didn't answer.
 */
export type RunPodErrorCategory = "auth" | "capacity" | "funds" | "request" | "budget" | "server";

export class RunPodError extends Error {
  readonly code: string;
  readonly status: number;
  readonly category: RunPodErrorCategory;
  readonly body?: unknown;
  constructor(code: string, status: number, message: string, body?: unknown, category?: RunPodErrorCategory) {
    super(message);
    this.name = "RunPodError";
    this.code = code;
    this.status = status;
    this.body = body;
    this.category = category ?? categorize(code, status, message);
  }

  static fromResponse(status: number, json: unknown, text: string, what: string): RunPodError {
    const j = (json ?? {}) as { error?: unknown; message?: unknown; code?: unknown; detail?: unknown; title?: unknown };
    const msg = String(j.message ?? j.detail ?? (typeof j.error === "string" ? j.error : "") ?? j.title ?? "").trim() || text.slice(0, 300) || `HTTP ${status}`;
    const code = String(j.code ?? (typeof j.error === "object" && j.error ? (j.error as { code?: unknown }).code : "") ?? "").trim() || `http_${status}`;
    return new RunPodError(code, status, `RunPod ${what}: ${msg} (${status})`, json ?? text);
  }
}

function categorize(code: string, status: number, message: string): RunPodErrorCategory {
  const m = `${code} ${message}`.toLowerCase();
  if (status === 402) return "funds";
  if (code === "missing_api_key" || status === 401 || status === 403) return "auth";
  if (/insufficient (funds|balance|credit)|balance|payment|billing/.test(m)) return "funds";
  if (/no (longer any )?(instances?|machines?|capacity)|not available|unavailable|out of stock|no gpus? (are )?available|could not find|capacity/.test(m)) return "capacity";
  if (code === "budget") return "budget";
  if (status >= 500 || status === 0) return "server";
  return "request";
}

export const isRunPodError = (e: unknown, category?: RunPodErrorCategory): e is RunPodError =>
  e instanceof RunPodError && (category === undefined || e.category === category);
