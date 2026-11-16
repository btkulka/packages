#!/usr/bin/env node
// btkulka-runpod: look before renting, and clean up after.
//
//   btkulka-runpod account                      the key works (whose account)
//   btkulka-runpod gpus [--min-memory 24] [--cloud community|secure] [--min-cuda 13.0]
//   btkulka-runpod plan [--min-memory 40] [--minutes 45] [--budget 2] [--min-cuda 13.0]
//   btkulka-runpod pods                         every pod on the account, with its rate
//   btkulka-runpod terminate <pod id>
//   btkulka-runpod sweep                        terminate every pod this package started (named btkulka-…)
//
// Nothing here starts a pod: renting is the caller's (trellis-client's `rent`, with its own --yes).
import { parseArgs } from "node:util";

import { createRunPodClient, type Cloud } from "./client.js";
import { isRunPodError } from "./errors.js";
import { DEFAULT_CREDENTIAL, KEY_ENV, loadRunPodKey } from "./key.js";
import { planRental, POD_PREFIX, sweep } from "./rental.js";

const USAGE = `btkulka-runpod account|gpus|plan|pods|terminate <id>|sweep
  gpus  [--min-memory GB] [--cloud community|secure] [--min-cuda X.Y]
  plan  [--min-memory GB] [--minutes N] [--budget USD] [--min-cuda X.Y]
  --credential <id>   the Benhäus credential (default ${DEFAULT_CREDENTIAL}; env ${KEY_ENV} as the fallback)`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      "min-memory": { type: "string" },
      cloud: { type: "string" },
      "min-cuda": { type: "string" },
      minutes: { type: "string" },
      budget: { type: "string" },
      credential: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const cmd = positionals[0];
  if (!cmd || values.help) {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  const apiKey = await loadRunPodKey({ credential: values.credential, app: "btkulka-runpod" });
  if (!apiKey) {
    console.error(`No RunPod key. Add one in Benhäus › Settings › Credentials as ${values.credential ?? DEFAULT_CREDENTIAL} (or set ${KEY_ENV}).`);
    return 1;
  }
  const client = createRunPodClient({ apiKey });
  const cloud = values.cloud ? (values.cloud.toUpperCase() as Cloud) : undefined;
  switch (cmd) {
    case "account": {
      const a = await client.account();
      console.log(`RunPod account ${a.id}${a.email ? ` (${a.email})` : ""}: the key works.`);
      return 0;
    }
    case "gpus": {
      const min = Number(values["min-memory"] ?? 0);
      for (const c of cloud ? [cloud] : (["COMMUNITY", "SECURE"] as Cloud[])) {
        const gpus = (await client.gpus({ cloud: c, minCudaVersion: values["min-cuda"] })).filter((g) => g.memory >= min);
        const price = (g: (typeof gpus)[number]) => (c === "SECURE" ? g.price?.secure : g.price?.community) ?? 0;
        console.log(`-- ${c.toLowerCase()}`);
        for (const g of gpus.sort((a, b) => price(a) - price(b))) if (price(g) > 0) console.log(`$${price(g).toFixed(2)}/h  ${String(g.memory).padStart(3)} GB  ${(g.availability ?? "").padEnd(6)}  ${g.id}`);
      }
      return 0;
    }
    case "plan": {
      const plan = await planRental(client, {
        minMemoryGb: Number(values["min-memory"] ?? 24),
        maxMinutes: Number(values.minutes ?? 45),
        budgetUsd: Number(values.budget ?? 2),
        minCudaVersion: values["min-cuda"],
      });
      for (const c of plan.candidates.slice(0, 8)) console.log(`$${c.pricePerHour.toFixed(2)}/h  ${c.memory} GB  ${c.cloud.toLowerCase().padEnd(9)}  ${c.name}`);
      console.log(plan.ok ? `Worst case $${plan.maxCostUsd.toFixed(2)} (cheapest $${plan.minCostUsd.toFixed(2)}) over ${plan.maxMinutes} min, within the $${plan.budgetUsd.toFixed(2)} budget.` : `Not within budget: ${plan.reason}`);
      return plan.ok ? 0 : 1;
    }
    case "pods": {
      const pods = await client.pods();
      if (!pods.length) console.log("No pods.");
      for (const p of pods) console.log(`${p.id}  ${p.status.padEnd(12)}  $${(p.cost ?? 0).toFixed(2)}/h  ${p.name}${p.name.startsWith(POD_PREFIX) ? "" : "  (not ours)"}`);
      return 0;
    }
    case "terminate": {
      const id = positionals[1];
      if (!id) {
        console.error(USAGE);
        return 2;
      }
      console.log((await client.terminate(id)) ? `Terminated ${id}.` : `${id} wasn't there.`);
      return 0;
    }
    case "sweep": {
      const ended = await sweep(client);
      console.log(ended.length ? `Terminated ${ended.join(", ")}.` : "No pods of ours were running.");
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error(isRunPodError(e) ? `${e.category}: ${e.message}` : ((e as Error).stack ?? String(e)));
    process.exit(1);
  });
