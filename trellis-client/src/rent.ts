// TRELLIS.2 on a rented GPU (RunPod, through @btkulka/runpod-client): for the subjects an 8 GB card can't hold
// (boxy closed objects need 7 GB and more for one tensor at the 1024 minimum; Microsoft states 24 GB).
//
// rentPlan() says what it would rent and the worst-case cost, spending nothing. rentAndGenerate() rents the
// cheapest fitting GPU, installs the same ComfyUI (the commit the local install runs) with torch for CUDA 13 and
// the TRELLIS.2 weights, puts it behind a token on the pod's HTTPS proxy, runs each image through generate()
// (results fetched over HTTP), and terminates the pod: when the jobs are done, on an error, and at the deadline
// at the latest (a detached watchdog here, and the pod's own timer there). Once the pod is terminated, a run
// record (rent-<stamp>.json: the GPU, its price, start and end, the seconds billed, the dollars, the models made)
// goes into the out folder beside the models, whether the run worked or not: toejam's Spend page reads it.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createRunPodClient, planRental, rent, waitForPodHttp, type Candidate, type Cloud, type Plan, type RunPodClient } from "@btkulka/runpod-client";

import { generate, type GenerateResult } from "./generate.js";
import { PIXAL3D_WEIGHTS, TRELLIS2_WEIGHTS } from "./weights.js";

/** The ComfyUI commit the local 3D install runs (D:/tools/comfyui-3d, ComfyUI 0.45 with TRELLIS.2 in core). */
export const COMFY_REV = "a592c0a654af22f75d97f214d6e3e34eb13cd9db";
/** A RunPod base image with Python 3.12, git and curl; torch is replaced by the version below. */
export const RENT_IMAGE = "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404";
/** The local install's torch, which ships only for CUDA 13.0: the host's driver has to be CUDA 13+. */
export const RENT_TORCH = { torch: "2.14.1", torchvision: "0.29.1", index: "https://download.pytorch.org/whl/cu130", minCuda: "13.0" };
/** How long a pod's container may go without starting (no runtime uptime) before the rental gives up on it. */
export const NO_START_S = 8 * 60;
/** The proxy on the pod; ComfyUI listens behind it on 127.0.0.1:8189. */
export const RENT_PORT = 8188;

/** The token proxy the pod runs in front of ComfyUI (aiohttp comes with ComfyUI's requirements). */
export const PROXY_PY = `import hmac, os
import aiohttp
from aiohttp import web

TOKEN = os.environ["RENT_TOKEN"].encode()
UP = "http://127.0.0.1:8189"
HOP = {"host", "authorization", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "te", "trailer", "proxy-authorization", "content-encoding"}
state = {}

async def handle(req):
    auth = req.headers.get("Authorization", "")
    tok = auth[7:] if auth.startswith("Bearer ") else req.query.get("token", "")
    if not hmac.compare_digest(tok.encode(), TOKEN):
        return web.Response(status=401, text="unauthorized")
    rel = req.rel_url.with_query([(k, v) for k, v in req.rel_url.query.items() if k != "token"])
    body = await req.read()
    hdrs = {k: v for k, v in req.headers.items() if k.lower() not in HOP}
    async with state["s"].request(req.method, UP + str(rel), data=body or None, headers=hdrs, allow_redirects=False) as r:
        data = await r.read()
        out = {k: v for k, v in r.headers.items() if k.lower() not in HOP}
        return web.Response(status=r.status, body=data, headers=out)

async def start(app):
    state["s"] = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=900))

async def stop(app):
    await state["s"].close()

app = web.Application(client_max_size=512 * 1024 * 1024)
app.on_startup.append(start)
app.on_cleanup.append(stop)
app.router.add_route("*", "/{tail:.*}", handle)
web.run_app(app, host="0.0.0.0", port=${RENT_PORT}, print=None)
`;

/** The pod's start script: ComfyUI at COMFY_REV, torch for CUDA 13, the weights, ComfyUI on localhost, the proxy. */
export function bootScript(): string {
  const weights = [...TRELLIS2_WEIGHTS, ...PIXAL3D_WEIGHTS].map((w) => `dl ${w.folder} ${w.file} ${w.repo} ${w.inRepo}`).join("\n");
  return `#!/bin/bash
# Written by @btkulka/trellis-client (rent): ComfyUI with TRELLIS.2 on a rented GPU, behind a token.
set -uo pipefail
step() { echo "[rent] $(date -u +%H:%M:%S) $*"; }
fail() { step "FAILED: $*"; sleep infinity & wait $!; }
trap 'step "stopping"; exit 0' TERM INT
# The pod's own deadline: the container stops then, whatever happens here.
( sleep "\${RENT_DEADLINE_S:-2700}"; step "deadline reached"; kill -TERM 1 ) &
mkdir -p /workspace && cd /workspace

step "ComfyUI \${COMFY_REV:0:7}"
git init -q comfy && cd comfy && git remote add origin https://github.com/comfyanonymous/ComfyUI.git \\
  && git fetch -q --depth 1 origin "$COMFY_REV" && git checkout -q FETCH_HEAD || fail "ComfyUI checkout"

step "torch ${RENT_TORCH.torch} (CUDA 13)"
pip install -q --no-cache-dir torch==${RENT_TORCH.torch} torchvision==${RENT_TORCH.torchvision} --index-url ${RENT_TORCH.index} || fail "torch"
python -c "import torch; assert torch.cuda.is_available(), 'no CUDA'; print('[rent] gpu', torch.cuda.get_device_name(0), round(torch.cuda.get_device_properties(0).total_memory / 2**30), 'GB')" || fail "CUDA"

step "ComfyUI requirements"
pip install -q --no-cache-dir -r requirements.txt || fail "requirements"

step "TRELLIS.2 and Pixal3D weights"
dl() { mkdir -p "models/$1"; curl -fsSL --retry 10 --retry-delay 3 -o "models/$1/$2" "https://huggingface.co/$3/resolve/main/$4" || fail "weights $2"; }
${weights}

step "starting ComfyUI"
python main.py --listen 127.0.0.1 --port 8189 --disable-auto-launch > /workspace/comfy.log 2>&1 &
COMFY=$!
for i in $(seq 1 240); do
  curl -fs http://127.0.0.1:8189/system_stats > /dev/null && break
  kill -0 $COMFY 2> /dev/null || { tail -40 /workspace/comfy.log; fail "ComfyUI exited"; }
  sleep 2
done
cat > /workspace/proxy.py <<'PY'
${PROXY_PY}PY
python /workspace/proxy.py &
PROXY=$!
step "ready"
wait -n $COMFY $PROXY
tail -40 /workspace/comfy.log
fail "a server stopped"
`;
}

/** The container command: write the script from the environment and run it as the container's first process. */
export const BOOT_CMD = `mkdir -p /workspace && echo "$BOOT_B64" | base64 -d > /workspace/boot.sh && exec bash /workspace/boot.sh`;

export interface RentJob {
  /** The reference image (one object, centred, plain background). */
  image: string;
  /** Letters, digits and dashes. */
  name: string;
  seed?: number;
  quality?: "standard" | "high";
  model?: "trellis2" | "pixal3d";
  textured?: boolean;
  maxFaces?: number;
}

export interface RentOptions {
  apiKey: string;
  jobs: RentJob[];
  outDir: string;
  /** GPUs with at least this much VRAM. Default 40 (48 GB cards: A40, A6000, L40S). */
  minMemoryGb?: number;
  /** Only these GPU type ids, in order. */
  gpus?: string[];
  clouds?: Cloud[];
  maxPricePerHour?: number;
  /** The pod ends by then at the latest. Default 15 + 5 a job, at least 30. */
  maxMinutes?: number;
  /** Refuse when the worst case is over this. Default 2. */
  budgetUsd?: number;
  onLog?: (line: string) => void;
  /** For tests: a client of your own. */
  client?: RunPodClient;
}

export interface RentResult {
  plan: Plan;
  podId?: string;
  gpu?: string;
  results: GenerateResult[];
  failures: { name: string; error: string }[];
  spentUsd: number;
  minutes: number;
  /** The run record written into the out folder after the pod ended (undefined when nothing was rented). */
  record?: string;
}

/** What one rented run cost: rent-<stamp>.json in the out folder, written once the pod is terminated. */
export interface RentRecord {
  kind: "runpod-rent";
  tool: "@btkulka/trellis-client rent";
  pod: string;
  /** The card's name (A40, RTX PRO 5000…) and RunPod's id for it. */
  gpu: string;
  gpuId: string;
  cloud: Cloud;
  memoryGb: number;
  usdPerHour: number;
  /** ISO times: the pod's start, and its termination. */
  start: string;
  end: string;
  /** Seconds from start to end: what RunPod bills, by the second. */
  secs: number;
  /** secs at usdPerHour, to the cent: the same estimate the run prints (RunPod's bill is the truth). */
  usd: number;
  /** Every job made a model and nothing threw. */
  ok: boolean;
  /** Why the run stopped early, when it did. */
  error?: string;
  /** The models made, by name, and the ones that failed. */
  models: string[];
  failures: { name: string; error: string }[];
}

/** The record's file name for a run that ended at `end`: rent-20261118T231500Z.json (an ISO time a file name can hold). */
export function rentRecordName(end: number | Date): string {
  return `rent-${new Date(end).toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "")}.json`;
}

/** The record for a run on `candidate` from startedAt to endedAt (ms). */
export function rentRecord(o: {
  podId: string;
  candidate: Candidate;
  startedAt: number;
  endedAt: number;
  models: string[];
  failures: { name: string; error: string }[];
  error?: string;
}): RentRecord {
  const secs = Math.max(0, Math.round((o.endedAt - o.startedAt) / 1000));
  return {
    kind: "runpod-rent",
    tool: "@btkulka/trellis-client rent",
    pod: o.podId,
    gpu: o.candidate.name,
    gpuId: o.candidate.gpu,
    cloud: o.candidate.cloud,
    memoryGb: o.candidate.memory,
    usdPerHour: o.candidate.pricePerHour,
    start: new Date(o.startedAt).toISOString(),
    end: new Date(o.endedAt).toISOString(),
    secs,
    usd: Math.round(((o.candidate.pricePerHour * (o.endedAt - o.startedAt)) / 3_600_000) * 100) / 100,
    ok: !o.error && !o.failures.length,
    ...(o.error ? { error: o.error } : {}),
    models: [...o.models],
    failures: o.failures.map((f) => ({ ...f })),
  };
}

/** Writes the record into dir (made if missing) under rentRecordName(its end); returns the file's path. */
export function writeRentRecord(dir: string, record: RentRecord): string {
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, rentRecordName(Date.parse(record.end)));
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, rentRecordName(Date.parse(record.end)).replace(/\.json$/, `-${i}.json`));
  fs.writeFileSync(`${file}.part`, JSON.stringify(record, null, 1) + "\n");
  fs.renameSync(`${file}.part`, file);
  return file;
}

const defaultMinutes = (jobs: number) => Math.max(30, 15 + 5 * jobs);

/** What a rental for these jobs would use and cost. Spends nothing. */
export async function rentPlan(o: RentOptions): Promise<Plan> {
  const client = o.client ?? createRunPodClient({ apiKey: o.apiKey });
  return planRental(client, {
    minMemoryGb: o.minMemoryGb ?? 40,
    gpus: o.gpus,
    clouds: o.clouds,
    minCudaVersion: RENT_TORCH.minCuda,
    maxPricePerHour: o.maxPricePerHour,
    maxMinutes: o.maxMinutes ?? defaultMinutes(o.jobs.length),
    budgetUsd: o.budgetUsd ?? 2,
  });
}

/** Rents, runs every job, terminates. Spends money: call rentPlan first and ask. */
export async function rentAndGenerate(o: RentOptions, signal?: AbortSignal): Promise<RentResult> {
  const log = o.onLog ?? (() => undefined);
  const client = o.client ?? createRunPodClient({ apiKey: o.apiKey });
  const plan = await rentPlan({ ...o, client });
  const result: RentResult = { plan, results: [], failures: [], spentUsd: 0, minutes: 0 };
  if (!plan.ok) {
    log(`Not renting: ${plan.reason}`);
    return result;
  }
  const token = crypto.randomBytes(24).toString("base64url");
  const rental = await rent(client, {
    name: "trellis",
    plan,
    apiKey: o.apiKey,
    image: RENT_IMAGE,
    disk: 60,
    ports: [`${RENT_PORT}/http`],
    minCudaVersion: RENT_TORCH.minCuda,
    entrypoint: ["bash", "-c"],
    cmd: [BOOT_CMD],
    env: {
      BOOT_B64: Buffer.from(bootScript()).toString("base64"),
      RENT_TOKEN: token,
      RENT_DEADLINE_S: String(plan.maxMinutes * 60),
      COMFY_REV,
    },
    onLog: log,
  });
  result.podId = rental.id;
  result.gpu = rental.candidate.name;
  const onAbort = () => void rental.terminate();
  signal?.addEventListener("abort", onAbort, { once: true });
  const made: string[] = [];
  let stopped: string | undefined;
  try {
    const url = rental.url(RENT_PORT);
    const headers = { Authorization: `Bearer ${token}` };
    let seen = "";
    let started = false;
    let failed = "";
    const ready = await waitForPodHttp(`${url}/system_stats`, {
      headers,
      signal,
      timeoutMs: Math.max(60_000, rental.deadline - Date.now() - 5 * 60_000),
      onWait: async (secs) => {
        const text = await client.logs(rental.id, { tail: 40 }).catch(() => "");
        const steps = text.split(/\r?\n/).filter((l) => l.includes("[rent]"));
        const last = steps.at(-1) ?? "";
        if (last && last !== seen) {
          seen = last;
          log(`  ${Math.round(secs / 60)} min: ${last.replace(/^.*\[rent\]\s*/, "")}`);
        }
        const f = steps.find((l) => l.includes("FAILED"));
        if (f) failed = f.replace(/^.*FAILED:\s*/, "");
        if (failed) throw new Error(`setup failed on the pod: ${failed}`);
        // A container that never starts (the host couldn't pull the image: its DNS or registry access was down) has
        // no runtime; the logs can't say, since that call often times out.
        if (!started) started = ((await client.pod(rental.id).catch(() => null))?.runtime?.uptime ?? 0) > 0;
        const pull = text.split(/\r?\n/).find((l) => /error creating container|failed to pull|pull access denied|ErrImagePull/i.test(l));
        if (!started && !seen && (pull || secs >= NO_START_S)) throw new Error(`the pod's container never started${pull ? `: ${pull.trim()}` : ` in ${Math.round(secs / 60)} min`}; another pod lands on another host, so run it again`);
      },
    }).catch((e: Error) => {
      failed ||= e.message;
      return false;
    });
    if (!ready) throw new Error(failed ? `The rented GPU didn't come up: ${failed}` : "The rented GPU didn't come up before its deadline.");
    log(`ComfyUI is up on the rented GPU (${Math.round((Date.now() - rental.startedAt) / 60_000)} min to set up).`);
    for (const job of o.jobs) {
      if (signal?.aborted) break;
      log(`Modelling ${job.name}…`);
      try {
        const r = await generate(
          { comfyDir: "", url, headers, remote: true },
          { image: job.image, name: job.name, outDir: o.outDir, seed: job.seed, quality: job.quality, model: job.model, textured: job.textured, maxFaces: job.maxFaces, onProgress: (stage, secs) => log(`  ${job.name}: ${stage}… ${secs}s`) },
        );
        result.results.push(r);
        made.push(job.name);
        log(`  ${job.name}: ${path.basename(r.glb)}${r.textured ? ` and ${path.basename(r.textured)}` : ""} in ${r.secs}s`);
      } catch (e) {
        result.failures.push({ name: job.name, error: (e as Error).message });
        log(`  ${job.name} failed: ${(e as Error).message}`);
      }
    }
    if (signal?.aborted && made.length + result.failures.length < o.jobs.length) stopped = "Stopped before every job ran.";
  } catch (e) {
    stopped = (e as Error).message;
    throw e;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await rental.terminate();
    const endedAt = Date.now();
    const record = rentRecord({ podId: rental.id, candidate: rental.candidate, startedAt: rental.startedAt, endedAt, models: made, failures: result.failures, error: stopped });
    result.spentUsd = record.usd;
    result.minutes = Math.round((endedAt - rental.startedAt) / 60_000);
    // What the run cost, beside its models; a record that can't be written never hides the run's own outcome.
    try {
      result.record = writeRentRecord(o.outDir, record);
      log(`Run record: ${result.record}`);
    } catch (e) {
      log(`Couldn't write the run record into ${o.outDir}: ${(e as Error).message}`);
    }
  }
  return result;
}
