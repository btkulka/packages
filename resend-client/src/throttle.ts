// A client-side throttle: spaces request starts so a burst (a contact sync, say) stays under
// Resend's rate limit instead of collecting 429s. The client takes a slot before every attempt,
// retries included, and waits for it before the attempt's timeout starts, so a long queue never
// times out while it waits.

import { abortedError, sleep } from "@btkulka/http-kit";

/**
 * What a client uses when it isn't told. Resend's documented limit is 10 a second, but it's per team,
 * shared by every key and app on it; 2 leaves room for the others.
 */
export const DEFAULT_REQUESTS_PER_SECOND = 2;

export interface ThrottleOptions {
  /** Request starts a second. Default 2. Infinity: no spacing. */
  requestsPerSecond?: number;
}

export interface Throttle {
  readonly requestsPerSecond: number;
  /**
   * Resolves when the next request may start, and holds that slot for the caller. Rejects
   * (an HttpError of kind "aborted") when the signal fires first, and gives the slot back.
   */
  wait(signal?: AbortSignal): Promise<void>;
  /** `wait`, then `fn`. */
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/** One throttle can serve several clients (pass it as their `throttle`), so they share the rate. */
export function createThrottle(options: ThrottleOptions = {}): Throttle {
  const requestsPerSecond = options.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;
  if (!(requestsPerSecond > 0)) throw new RangeError(`requestsPerSecond must be above 0 (Infinity for no limit), not ${requestsPerSecond}`);
  const gapMs = 1000 / requestsPerSecond;
  // When the next slot opens, on performance.now()'s clock (monotonic, unlike Date.now()).
  let next = 0;

  async function wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortedError("The throttle wait was aborted", signal);
    const now = performance.now();
    const at = Math.max(now, next);
    next = at + gapMs;
    if (at <= now) return;
    try {
      await sleep(at - now, signal);
    } catch (err) {
      // Nobody has queued behind this slot: give it back, so an abort doesn't slow the next request.
      if (next === at + gapMs) next = at;
      throw err;
    }
  }

  return {
    requestsPerSecond,
    wait,
    run: async (fn, signal) => {
      await wait(signal);
      return fn();
    },
  };
}
