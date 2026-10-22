/** Pieces the HTTP chat backends share. Internal. */
import { LlmError } from "./errors.js";
import type { ChatMessage, ChatRequest, ChatResult } from "./types.js";

/** `system` (if any) as a leading system message, then the messages as given. */
export function withSystem(req: Pick<ChatRequest, "system" | "messages">): ChatMessage[] {
  return req.system ? [{ role: "system", content: req.system }, ...req.messages] : [...req.messages];
}

/** Total characters of the prompt, for a usage estimate. */
export const promptChars = (messages: ChatMessage[]): number => messages.reduce((n, m) => n + m.content.length, 0);

/**
 * Runs `attempt` until it returns text, up to `emptyRetries` extra times, nudging the temperature
 * up each time. Then returns "" (allowEmpty) or throws an `empty` LlmError.
 */
export async function withEmptyRetries(
  req: ChatRequest,
  label: string,
  attempt: (temperature: number | undefined) => Promise<ChatResult>,
): Promise<ChatResult> {
  const retries = Math.max(0, req.emptyRetries ?? 0);
  const step = req.retryTemperatureStep ?? 0.15;
  let last: ChatResult | undefined;
  for (let i = 0; i <= retries; i++) {
    // With no temperature set there's nothing to nudge: the server's default stays.
    const temperature = req.temperature === undefined ? undefined : req.temperature + step * i;
    last = await attempt(temperature);
    if (last.text) return last;
  }
  if (req.allowEmpty && last) return last;
  throw new LlmError("empty", `${label} returned no content${retries ? ` (after ${retries} ${retries === 1 ? "retry" : "retries"})` : ""}`);
}
