// The API key from Benhäus › Settings › Credentials (the `runpod` credential), with RUNPOD_API_KEY as the fallback.

import { loadCredential } from "@btkulka/benhaus-client";

export const DEFAULT_CREDENTIAL = "runpod/shared";
export const KEY_ENV = "RUNPOD_API_KEY";

export async function loadRunPodKey(o: { credential?: string; app?: string } = {}): Promise<string | undefined> {
  const c = await loadCredential(o.credential ?? DEFAULT_CREDENTIAL, { app: o.app ?? "runpod-client", env: { apiKey: KEY_ENV }, required: ["apiKey"] });
  return c?.fields.apiKey;
}
