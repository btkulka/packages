// The API key, from the first place that has one:
//   1. Benhäus › Settings › Credentials (the `runpod/shared` credential),
//   2. RUNPOD_API_KEY in the environment,
//   3. the Runpod CLI's own config, ~/.runpod/config.toml (what `runpod login --agent` writes: the email sign-in of
//      https://agents.runpod.io/), its default profile or the one named.
// The key is never printed or logged.

import { loadCredential } from "@btkulka/benhaus-client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CREDENTIAL = "runpod/shared";
export const KEY_ENV = "RUNPOD_API_KEY";
export const CLI_CONFIG = path.join(os.homedir(), ".runpod", "config.toml");

/**
 * The api_key from a Runpod CLI config: the profile's table ([default], [profiles.default] or [<profile>]) when
 * there is one, else a top-level api_key. Undefined when the file or the key isn't there.
 */
export function readCliConfigKey(file = CLI_CONFIG, profile = process.env.RUNPOD_PROFILE || "default"): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let section = "";
  let topLevel: string | undefined;
  let inProfile: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) {
      section = head[1].trim().replace(/^"|"$/g, "");
      continue;
    }
    const kv = /^api_key\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (!kv) continue;
    const value = kv[1] ?? kv[2];
    if (!value) continue;
    if (section === "") topLevel ??= value;
    else if (section === profile || section === `profiles.${profile}` || section === `profiles."${profile}"`) inProfile ??= value;
  }
  return inProfile ?? topLevel;
}

export async function loadRunPodKey(o: { credential?: string; app?: string; cliConfig?: string | false } = {}): Promise<string | undefined> {
  const c = await loadCredential(o.credential ?? DEFAULT_CREDENTIAL, { app: o.app ?? "runpod-client", env: { apiKey: KEY_ENV }, required: ["apiKey"] });
  if (c?.fields.apiKey) return c.fields.apiKey;
  if (o.cliConfig === false) return undefined;
  return readCliConfigKey(o.cliConfig ?? CLI_CONFIG);
}
