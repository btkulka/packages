# @btkulka/runpod-client

Rent a GPU by the minute on [RunPod](https://www.runpod.io), guarded so a forgotten machine can't run up a bill. Built for the jobs Ben's 8 GB RTX 3070 can't hold (TRELLIS.2 on boxy objects: see trellis-client's `rent`), usable by any app that needs a big card for a few minutes.

- **RunPod's REST API v2** (`https://api.runpod.io/v2`; v1 at rest.runpod.io was retired on Nov 15 2026): the GPU catalog with per-cloud prices, and pods (create, read, list, logs, run a command, stop, terminate).
- **A guarded rental on top:** a plan and its worst-case cost before anything is spent, a budget it won't exceed, a hard deadline, and three ways a pod ends: the caller's `terminate()`, a **detached watchdog** process that terminates it at the deadline even if the caller crashed or the terminal closed, and (for scripts that use it) the pod's own timer.
- **The key**, from the first place that has one: Benhäus › Settings › Credentials (`runpod/shared`, declared in this package’s `benhaus.credential`, so the credential form, its docs link and its Test come from here), then `RUNPOD_API_KEY`, then the Runpod CLI’s `~/.runpod/config.toml` (written by `runpod login --agent`, the email sign-in in [Runpod’s agent guide](https://agents.runpod.io/)). It is never printed.
- Node only, ESM and CommonJS. Depends on http-kit, proc-kit and benhaus-client.

```json
"dependencies": { "@btkulka/runpod-client": "file:../packages/runpod-client" }
```

## Getting a key

1. Make a RunPod account and add credit (it's prepaid; a 48 GB card runs about $0.35 to $0.80 an hour on Community Cloud, Nov 2026).
2. RunPod console › Settings › API Keys › Create API Key: a name (benhaus), **Restricted**, then Account: Read, Catalog: Read, Pods: Read/Write, the rest None. That is all this package calls (account:read, catalog:read, pods:read and pods:write); a key with All works too.
3. Benhäus › Settings › Credentials › Add › RunPod (rented GPUs), id `runpod/shared`, paste the key, Test.

`btkulka-runpod account` then says whose account it is.

## How a rental goes

```ts
import { createRunPodClient, loadRunPodKey, planRental, rent, waitForPodHttp } from "@btkulka/runpod-client";

const apiKey = (await loadRunPodKey())!;
const client = createRunPodClient({ apiKey });
const plan = await planRental(client, { minMemoryGb: 40, maxMinutes: 35, budgetUsd: 2, minCudaVersion: "13.0" });
if (!plan.ok) throw new Error(plan.reason);                       // nothing spent
console.log(`at most $${plan.maxCostUsd}`);                       // ask before going on
const r = await rent(client, { name: "job", plan, apiKey, image: "runpod/pytorch:…", ports: ["8188/http"], cmd: [...] });
try {
  await waitForPodHttp(`${r.url(8188)}/health`);
  // … use https://<pod id>-8188.proxy.runpod.net …
} finally {
  await r.terminate();                                             // and the watchdog ends it at the deadline anyway
}
```

- `planRental` reads the live catalog (filtered by the host's CUDA when asked), keeps the GPUs with enough VRAM and a price, cheapest first (or your `gpus` in your order), tries Community Cloud then Secure, and drops any whose worst case (rate x `maxMinutes`) is over `budgetUsd`. `ok: false` with a `reason` when nothing fits.
- `rent` creates the pod on the first candidate with a free machine (one without capacity is skipped), names it `btkulka-<name>-<time>`, starts the watchdog and returns `{ id, pod, candidate, url(port), spentUsd(), terminate(), deadline }`. It refuses a plan that isn't ok (a `RunPodError`, category `budget`).
- The watchdog is a detached `node -e` process (log in `%TEMP%\btkulka-runpod\watchdog-<pod>.log`) that sleeps until the deadline and terminates the pod, retrying. `terminate()` kills it. It doesn't survive this PC sleeping or restarting: a pod script should keep its own timer too (trellis-client's does), and `btkulka-runpod pods` shows what's running.
- `sweep()` terminates every pod named `btkulka-…` (strays).
- RunPod's HTTPS proxy (`proxyUrl(id, port)`) has a 100-second limit per request and no authentication: put a token in front of anything you serve (trellis-client's pod runs a small token proxy).

## API

```ts
createRunPodClient({ apiKey, base?, fetch?, timeoutMs? }): RunPodClient
  .account()  .gpus({ cloud?, minCudaVersion?, availability? })  .pods()  .pod(id)  .createPod(body)
  .terminate(id)  .action(id, "start"|"stop"|"restart"|"terminate")  .logs(id, { source?, tail? })  .exec(id, argv, { timeoutSeconds?, cwd?, env? })
proxyUrl(podId, port)
planRental(client, { minMemoryGb?, gpus?, clouds?, minCudaVersion?, maxPricePerHour?, maxMinutes?, budgetUsd?, count? }): Promise<Plan>
rent(client, { name, plan, image, apiKey, disk?, env?, ports?, entrypoint?, cmd?, minCudaVersion?, count?, logDir?, onLog? }): Promise<Rental>
sweep(client, prefix?)    waitForPodHttp(url, { headers?, timeoutMs?, intervalMs?, signal?, onWait? })
loadRunPodKey({ credential?, app? })
RunPodError { code, status, category: "auth" | "capacity" | "funds" | "request" | "budget" | "server" }
```

## CLI

```
btkulka-runpod account                  the key works
btkulka-runpod gpus [--min-memory 24] [--cloud community|secure] [--min-cuda 13.0]
btkulka-runpod plan [--min-memory 40] [--minutes 45] [--budget 2] [--min-cuda 13.0]
btkulka-runpod pods                     every pod on the account, with its rate
btkulka-runpod terminate <pod id>
btkulka-runpod sweep                    terminate every pod this package started
```

Nothing in this CLI starts a pod. Renting is the caller's, behind its own `--yes`.
