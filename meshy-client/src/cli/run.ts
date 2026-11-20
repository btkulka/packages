// meshy-3d's work, with its input and output passed in so tests can run it on a fake fetch.
// Node-only (files, the key from Benhäus); the browser-safe index never imports this.
//
// Spending is opt-in, as with gemini-image: the plan (jobs, credits, balance) prints first, --dry-run prints the
// requests and sends nothing, and without --yes nothing is sent at all. Each model lands as <name>.glb
// (<name>-textured.glb when textured) with <name>.meta.json (or <name>-textured.meta.json) beside it, and the run
// leaves meshy-<stamp>.json in the out folder for toejam's Spend page. A created task's id waits in
// <out>/.meshy/<base>.json until its files are written, so a run that stops picks it up next time at no new charge.

import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { dataUri, imageTypeOf, MAX_IMAGE_BYTES, shortDataUri } from "../bytes.js";
import { createMeshyClient, type Balance, type MeshyClient, type MeshyFetch } from "../client.js";
import { isMeshyError, type MeshyError } from "../errors.js";
import { imageTo3dBody, type ModelFormat, type Task } from "../image-to-3d.js";
import { DEFAULT_APP, DEFAULT_CREDENTIAL, KEY_ENV, loadMeshyKey } from "../key.js";
import { formatUsd, PLANS, PRICES_READ_ON, PRICES_SOURCE, usdOf, usdPerCreditOf, type CreditCost } from "../pricing.js";
import { creditsOf, DEFAULTS, formatsOf, JobError, jobRequestOf, nameFrom, outBase, parseJobs, type JobDefaults, type MeshyJob } from "./jobs.js";
import { newRecord, runRecordName, settle, writeRunRecord, type RunJob } from "./record.js";

export { DEFAULT_APP, DEFAULT_CREDENTIAL, KEY_ENV };
export const DEFAULT_CONCURRENCY = 4;

export const USAGE = `meshy-3d: concept images to 3D models with Meshy, into <name>.glb files.

  meshy-3d --image <file> [--name <name>] [--image <file> --name <name>]... --out <folder> [options]
  meshy-3d --jobs <jobs.json> --out <folder> [options]

A jobs file is a JSON array (or { "jobs": [...] }) of
  { "name", "image", "model"?, "smartTopology"?, "texture"?, "pbr"?, "textureResolution"?, "texturePrompt"?,
    "topology"?, "polycount"?, "remesh"?, "pose"?, "ultra"?, "enhance"?, "formats"? }
(image relative to the jobs file). The flags below are the defaults for every job. Without --name a model is
named after its image file.

  --out, -o <folder>         where the models go (made if missing)
  --model <id>               latest (default: Meshy 7.1, 20 credits a mesh), meshy-7.1, meshy-6, meshy-6-lite
                             (5), meshy-t2 or meshy-t2.5 (Smart Topology: clean low-poly triangles, 5)
  --smart-topology           Meshy's Smart Topology (meshy-t2.5 unless --model says)
  --texture                  texture it too (+10 credits; default mesh only, for your own shaders)
  --pbr                      metallic, roughness and normal maps as well (needs --texture; no extra credits)
  --texture-resolution <r>   2k (default), 4k, 8k (+5 credits)
  --texture-prompt <text>    steer the texture (up to 800 characters)
  --topology triangle|quad   the remesh's faces (implies --remesh; quad not on Smart Topology)
  --polycount <n>            the remesh's target (implies --remesh; 100 to 300000, Smart Topology less)
  --remesh, --no-remesh      Meshy's remesh pass (its default: on for meshy-6-lite only; no extra credits)
  --pose a-pose|t-pose       for characters
  --ultra 2k|4k              Ultra geometry (+5 credits; latest or meshy-7.1)
  --no-enhance               keep the image exactly as it is (Meshy cleans it up by default)
  --formats <list>           more formats beside the GLB: obj, fbx, stl, usdz, 3mf (comma-separated)
  --concurrency <n>          tasks at once (default ${DEFAULT_CONCURRENCY}; the Pro plan runs 10)
  --usd-per-credit <n|plan>  record dollars at this rate: a number, or ${PLANS.map((p) => p.id).join(", ")} (Meshy
                             states no price per credit; without it the records hold credits only)
  --dry-run                  print the requests it would make; send nothing
  --yes, -y                  spend: without it nothing is sent (the plan prints either way)
  --force                    make models again even when <name>.glb is there
  --credential <id>          the Benhäus credential (default ${DEFAULT_CREDENTIAL}; env ${KEY_ENV} as the fallback)
  --app <id>                 the tool id Benhäus shows as the reader (default ${DEFAULT_APP})

Exit codes: 0 done, 1 a failure, 2 needs --yes.`;

export interface MeshyCliIo {
  out(line: string): void;
  err(line: string): void;
  fetch?: MeshyFetch;
  loadKey?(credential: string, app: string): Promise<string | undefined>;
  /** Fired by the first Ctrl+C: no new tasks start; the ones running are waited for and saved. */
  signal?: AbortSignal;
  cwd?: string;
  /** Attempts for a 429 (and, on reads, a 5xx). Default 6. */
  attempts?: number;
  /** The first wait before a retry, doubled each time. Default 5 000. */
  baseDelayMs?: number;
  /** The first wait between polls. Default 5 000. */
  pollIntervalMs?: number;
  /** The longest wait between polls. Default 20 000. */
  pollMaxIntervalMs?: number;
  /** How long to wait for one task. Default 60 minutes. */
  pollTimeoutMs?: number;
  now?(): number;
}

interface Work {
  job: MeshyJob;
  base: string;
  cost: CreditCost;
  /** A task an earlier run created and didn't finish: picked up, not paid for again. */
  pending?: string;
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const slash = (p: string) => p.replace(/\\/g, "/");
const credits = (n: number) => `${n.toLocaleString("en-US")} credit${n === 1 ? "" : "s"}`;

function describe(job: MeshyJob): string {
  const bits = [job.aiModel + (job.modelType === "smart-topology" && !job.aiModel.startsWith("meshy-t") ? " (Smart Topology)" : "")];
  bits.push(job.texture ? `textured ${job.textureResolution ?? "2k"}${job.pbr ? " + PBR" : ""}` : "mesh only");
  if (job.ultra) bits.push(`Ultra ${job.ultra}`);
  const remesh = [job.topology, job.polycount ? `${job.polycount.toLocaleString("en-US")} faces` : ""].filter(Boolean).join(", ");
  if (remesh) bits.push(`remesh ${remesh}`);
  else if (job.remesh !== undefined) bits.push(job.remesh ? "remesh" : "no remesh");
  if (job.pose) bits.push(job.pose);
  if (job.enhance === false) bits.push("image as is");
  if (job.formats.length > 1) bits.push(job.formats.join("+"));
  return bits.join(", ");
}

function balanceLine(b: Balance): string {
  const parts: string[] = [];
  if (typeof b.monthly_credits === "number") parts.push(`${b.monthly_credits.toLocaleString("en-US")} monthly${b.monthly_resets_at ? `, renewing ${new Date(b.monthly_resets_at).toISOString().slice(0, 10)}` : ""}`);
  if (typeof b.permanent_credits === "number") parts.push(`${b.permanent_credits.toLocaleString("en-US")} permanent`);
  return `Balance: ${credits(b.balance)}${parts.length ? ` (${parts.join("; ")})` : ""}.`;
}

function hint(err: MeshyError, credential: string): string {
  switch (err.category) {
    case "auth":
      return `Meshy refused the key: check ${credential} in Benhäus › Settings › Credentials (or ${KEY_ENV}).`;
    case "credits":
      return "Not enough credits, a credit limit on the key, or a plan without the API: top up at meshy.ai › Settings › Subscription.";
    case "forbidden":
      return "Meshy refused it: content moderation, the key's IP allowlist, or the plan (its message above says which).";
    case "rate_limit":
      return "Too many tasks at once for the plan: try a lower --concurrency (Pro runs 10).";
    case "task_failed":
      if (err.worthRetrying) return "Meshy says this may work the second time: run the same command again (a failed task is refunded).";
      if (err.taskError?.type === "invalid_input") return `Meshy couldn't use this image: one object, centred, on a plain background works best${err.taskError.doc_url ? ` (${err.taskError.doc_url})` : ""}.`;
      return "The task's credits are refunded.";
    default:
      return "";
  }
}

/** A texture or model URL's extension (".png"), from its path (the signature is in the query). */
function extOf(url: string, fallback: string): string {
  try {
    const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
    return m ? `.${m[1]!.toLowerCase()}` : fallback;
  } catch {
    return fallback;
  }
}

function defaultsFrom(v: Values): JobDefaults {
  const d: JobDefaults = { ...DEFAULTS };
  if (v.model) d.aiModel = v.model.trim().toLowerCase();
  if (v["smart-topology"]) {
    d.modelType = "smart-topology";
    if (!v.model) d.aiModel = "meshy-t2.5";
  }
  d.texture = !!v.texture;
  d.pbr = !!v.pbr;
  if (v["texture-resolution"]) d.textureResolution = v["texture-resolution"].toLowerCase() as JobDefaults["textureResolution"];
  if (v["texture-prompt"] !== undefined) d.texturePrompt = v["texture-prompt"];
  if (v.topology) d.topology = v.topology.toLowerCase() as JobDefaults["topology"];
  if (v.polycount !== undefined) {
    const n = Number(v.polycount);
    if (!Number.isInteger(n)) throw new JobError("--polycount is a whole number.");
    d.polycount = n;
  }
  if (v.remesh && v["no-remesh"]) throw new JobError("--remesh or --no-remesh, not both.");
  if (v.remesh) d.remesh = true;
  if (v["no-remesh"]) d.remesh = false;
  if (v.pose) d.pose = v.pose.toLowerCase() as JobDefaults["pose"];
  if (v.ultra) {
    const u = v.ultra.toLowerCase();
    if (u !== "2k" && u !== "4k") throw new JobError("--ultra is 2k or 4k.");
    d.ultra = u;
  }
  if (v["no-enhance"]) d.enhance = false;
  d.formats = formatsOf(v.formats);
  return d;
}

export async function runMeshy(argv: string[], io: MeshyCliIo): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const now = io.now ?? Date.now;
  let v: Values;
  try {
    v = parse(argv).values;
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${USAGE}`);
    return 1;
  }
  if (v.help) {
    io.out(USAGE);
    return 0;
  }
  const images = v.image ?? [];
  const names = v.name ?? [];
  if (!images.length && !v.jobs) {
    io.err(`Give --image <file> or --jobs <file>.\n\n${USAGE}`);
    return 1;
  }
  if (images.length && v.jobs) {
    io.err("Give --image or --jobs, not both.");
    return 1;
  }
  if (!v.out) {
    io.err("Say where the models go: --out <folder>.");
    return 1;
  }
  if (names.length && names.length !== images.length) {
    io.err("Give one --name per --image, in the same order (or none: each model is named after its image).");
    return 1;
  }
  const concurrency = v.concurrency === undefined ? DEFAULT_CONCURRENCY : Number(v.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    io.err("--concurrency is a whole number from 1 to 100.");
    return 1;
  }
  const rate = usdPerCreditOf(v["usd-per-credit"]);
  if (v["usd-per-credit"] !== undefined && rate === undefined) {
    io.err(`--usd-per-credit is a number of dollars (0.02) or a plan: ${PLANS.map((p) => p.id).join(", ")}.`);
    return 1;
  }
  const outDir = resolve(cwd, v.out);
  const pendingDir = join(outDir, ".meshy");
  const credential = v.credential ?? DEFAULT_CREDENTIAL;
  const app = v.app ?? DEFAULT_APP;

  let jobs: MeshyJob[];
  try {
    const defaults = defaultsFrom(v);
    if (v.jobs) {
      const file = resolve(cwd, v.jobs);
      jobs = parseJobs(await readFile(file, "utf8"), dirname(file), defaults);
    } else {
      jobs = parseJobs(JSON.stringify(images.map((image, i) => ({ name: names[i] ?? nameFrom(image), image }))), cwd, defaults);
    }
  } catch (e) {
    io.err(e instanceof JobError ? e.message : `Couldn't read the jobs: ${(e as Error).message}`);
    return 1;
  }
  for (const img of new Set(jobs.map((j) => j.image))) {
    if (!imageTypeOf(img)) {
      io.err(`${img}: Meshy takes png, jpg or webp images.`);
      return 1;
    }
    const st = await stat(img).catch(() => undefined);
    if (!st?.isFile()) {
      io.err(`${img}: no such file.`);
      return 1;
    }
    if (st.size > MAX_IMAGE_BYTES) {
      io.err(`${img}: over Meshy's 20 MB.`);
      return 1;
    }
  }

  // What's already there is skipped unless --force; a task an earlier run left is picked up.
  const work: Work[] = [];
  for (const job of jobs) {
    const base = outBase(job);
    const pendingFile = join(pendingDir, `${base}.json`);
    const pending = await readFile(pendingFile, "utf8").then((t) => (JSON.parse(t) as { task?: unknown }).task, () => undefined);
    if (!pending && !v.force && (await exists(join(outDir, `${base}.glb`)))) {
      io.out(`[${base}] already there, skipped (--force makes it again)`);
      continue;
    }
    work.push({ job, base, cost: creditsOf(job), pending: typeof pending === "string" && pending ? pending : undefined });
  }

  const fresh = work.filter((w) => !w.pending);
  const need = fresh.reduce((s, w) => s + w.cost.credits, 0);
  const unknown = fresh.some((w) => w.cost.unknown);
  const usd = usdOf(need, rate);
  io.out(
    `${plural(work.length, "model")}, ${credits(need)}${usd !== undefined ? `, about ${formatUsd(usd)} at ${formatUsd(rate!)} a credit` : ""}${unknown ? " (a model here has no price in the table: counted as 0)" : ""} (prices read ${PRICES_READ_ON}, ${PRICES_SOURCE}).`,
  );
  if (rate === undefined && need) io.out(`Meshy states no dollar price per credit, so this is credits only (--usd-per-credit pro records the Pro plan's ${formatUsd(PLANS[0]!.usdPerCredit)}: $20 for 1,000).`);
  for (const w of work) {
    const src = slash(w.job.image);
    io.out(w.pending ? `  ${w.base}: picking up task ${w.pending} (already paid for)` : `  ${w.base}: ${describe(w.job)}, ${w.cost.unknown ? `? credits (${w.cost.note})` : credits(w.cost.credits)}  <- ${src}`);
  }

  // The key and the balance (free to read), when there is a key.
  let apiKey: string | undefined;
  try {
    apiKey = await (io.loadKey ?? defaultLoadKey)(credential, app);
  } catch (e) {
    io.err(`Couldn't read the key: ${(e as Error).message}`);
  }
  const client: MeshyClient | undefined = apiKey ? createMeshyClient({ apiKey, fetch: io.fetch, attempts: io.attempts ?? 6, baseDelayMs: io.baseDelayMs ?? 5_000 }) : undefined;
  let balance: Balance | undefined;
  let balanceErr: MeshyError | undefined;
  if (client) {
    try {
      balance = await client.balance();
      io.out(balanceLine(balance));
    } catch (e) {
      if (!isMeshyError(e)) throw e;
      balanceErr = e;
      io.out(`Balance: couldn't read it (${e.message}).`);
    }
  } else {
    io.out(`Balance: no Meshy key yet (Benhäus credential ${credential}, or ${KEY_ENV}).`);
  }
  if (!work.length) {
    io.out("Nothing to do.");
    return 0;
  }

  if (v["dry-run"]) {
    for (const w of work) {
      if (w.pending) continue;
      const body = imageTo3dBody(jobRequestOf(w.job, dataUri(new Uint8Array(await readFile(w.job.image)), imageTypeOf(w.job.image)!)));
      io.out(`\n[${w.base}] POST https://api.meshy.ai/openapi/v1/image-to-3d`);
      io.out(JSON.stringify({ ...body, image_url: shortDataUri(body.image_url) }, null, 2));
    }
    io.out("\nNothing sent (--dry-run).");
    return 0;
  }
  if (!v.yes) {
    io.out(`\nNothing sent. Run again with --yes to make ${work.length === 1 ? "it" : "them"} (${credits(need)}), or --dry-run to see the requests.`);
    return 2;
  }
  if (!client) {
    io.err(`No Meshy key. Add it in Benhäus › Settings › Credentials (${credential}, "Meshy (image to 3D)"), or set ${KEY_ENV}. Keys come from https://www.meshy.ai/developers/keys and need a paid plan.`);
    return 1;
  }
  if (balanceErr && ["auth", "credits", "forbidden"].includes(balanceErr.category)) {
    const h = hint(balanceErr, credential);
    io.err(`Meshy refused the balance check, so nothing was sent.${h ? ` ${h}` : ""}`);
    return 1;
  }
  if (balance && balance.balance < need) {
    io.err(`Not enough credits: this needs ${credits(need)} and the balance is ${credits(balance.balance)}. Nothing sent.`);
    return 1;
  }

  const meshy: MeshyClient = client;
  await mkdir(pendingDir, { recursive: true });
  const record = newRecord(now(), rate, balance?.balance);
  let recordFile = join(outDir, runRecordName(Date.parse(record.start)));
  for (let i = 2; await exists(recordFile); i++) recordFile = join(outDir, runRecordName(Date.parse(record.start)).replace(/\.json$/, `-${i}.json`));
  let saving: Promise<void> = Promise.resolve();
  const save = (): Promise<void> => {
    if (!record.jobs.length) return saving;
    const write = () => writeRunRecord(recordFile, settle(record, now()));
    saving = saving.then(write, write);
    return saving;
  };

  let made = 0;
  let failed = 0;
  let notStarted = 0;
  let stop = false;
  const poll = { intervalMs: io.pollIntervalMs ?? 5_000, maxIntervalMs: io.pollMaxIntervalMs ?? 20_000, timeoutMs: io.pollTimeoutMs ?? 60 * 60_000 };

  const runOne = async (w: Work): Promise<void> => {
    const say = (s: string) => io.out(`[${w.base}] ${s}`);
    const pendingFile = join(pendingDir, `${w.base}.json`);
    const t0 = now();
    let rj: RunJob | undefined;
    try {
      let taskId = w.pending;
      const body = imageTo3dBody(jobRequestOf(w.job, "https://stand-in.invalid/image.png"));
      const { image_url: _drop, ...options } = body;
      if (!taskId) {
        const image = { data: new Uint8Array(await readFile(w.job.image)), mimeType: imageTypeOf(w.job.image)! };
        say(`creating (${w.cost.unknown ? "? credits" : credits(w.cost.credits)})…`);
        taskId = await meshy.imageTo3d.create(jobRequestOf(w.job, image));
        await writeFile(pendingFile, JSON.stringify({ task: taskId, name: w.job.name, base: w.base, image: slash(w.job.image), created: new Date(now()).toISOString(), options }, null, 1) + "\n");
      }
      rj = {
        name: w.job.name,
        base: w.base,
        task: taskId,
        image: slash(w.job.image),
        aiModel: w.job.aiModel,
        modelType: body.model_type ?? "standard",
        textured: w.job.texture,
        status: "PENDING",
        credits: w.cost.credits,
        estimated: true,
        ...(w.pending ? { resumed: true } : {}),
        files: [],
      };
      record.jobs.push(rj);
      await save();
      say(w.pending ? `picking up task ${taskId} (already paid for)` : `task ${taskId}`);

      let shown = "";
      const task: Task = await meshy.imageTo3d.wait(taskId, {
        ...poll,
        onPoll: (t) => {
          rj!.status = t.status;
          if (typeof t.consumed_credits === "number" && t.status !== "FAILED") {
            rj!.credits = t.consumed_credits;
            rj!.estimated = false;
          }
          const step = `${t.status}:${Math.floor((t.progress ?? 0) / 25)}`;
          if (step !== shown && t.status !== "SUCCEEDED" && t.status !== "FAILED") {
            shown = step;
            say(`${t.status.toLowerCase().replace("_", " ")} ${t.progress ?? 0}%${t.status === "PENDING" && t.preceding_tasks ? `, ${t.preceding_tasks} ahead` : ""}`);
          }
        },
      });
      rj.status = "SUCCEEDED";
      if (typeof task.consumed_credits === "number") {
        rj.credits = task.consumed_credits;
        rj.estimated = false;
      }

      // The files: every format asked for, the OBJ's .mtl, and the texture maps when textured.
      await mkdir(outDir, { recursive: true });
      const files: string[] = [];
      const fetchTo = async (url: string, name: string) => {
        const bytes = await meshy.download(url);
        const path = join(outDir, name);
        await writeFile(`${path}.part`, bytes);
        await rename(`${path}.part`, path);
        files.push(name);
      };
      for (const fmt of w.job.formats as ModelFormat[]) {
        const url = task.model_urls?.[fmt];
        if (url) await fetchTo(url, `${w.base}.${fmt}`);
        else if (fmt === "glb") throw new Error(`Meshy's task ${taskId} succeeded without a GLB.`);
        else say(`no ${fmt} came back`);
      }
      if (w.job.formats.includes("obj") && task.model_urls?.mtl) await fetchTo(task.model_urls.mtl, `${w.base}.mtl`);
      if (w.job.texture) {
        for (const [map, url] of Object.entries(task.texture_urls?.[0] ?? {})) if (typeof url === "string" && url) await fetchTo(url, `${w.base}-${map}${extOf(url, ".png")}`);
      }
      rj.files = files;
      const secs = Math.round((now() - t0) / 100) / 10;
      rj.secs = secs;
      const usd = usdOf(rj.credits, rate);
      const sidecar = {
        name: w.job.name,
        file: `${w.base}.glb`,
        task: taskId,
        image: slash(w.job.image),
        model: w.job.aiModel,
        modelType: rj.modelType,
        textured: w.job.texture,
        options,
        credits: rj.credits,
        estimatedCredits: w.cost.credits,
        ...(usd === undefined ? {} : { usd, usdPerCredit: rate }),
        secs,
        ...(task.started_at && task.finished_at ? { meshySecs: Math.round((task.finished_at - task.started_at) / 100) / 10 } : {}),
        ...(w.pending ? { resumed: true } : {}),
        files,
        made: new Date(now()).toISOString(),
        tool: "@btkulka/meshy-client",
      };
      await writeFile(join(outDir, `${w.base}.meta.json`), JSON.stringify(sidecar, null, 1) + "\n");
      await rm(pendingFile, { force: true });
      made++;
      say(`${files.join(", ")} in ${secs}s, ${credits(rj.credits)}${usd !== undefined ? ` (${formatUsd(usd)})` : ""}`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      record.failures.push({ name: w.base, error: msg });
      if (rj) rj.error = msg;
      if (isMeshyError(err, "task_failed")) {
        // Refunded: the next run makes it afresh.
        if (rj) {
          rj.status = err.code === "task_canceled" ? "CANCELED" : "FAILED";
          rj.credits = 0;
          rj.estimated = false;
        }
        await rm(pendingFile, { force: true });
      } else if (w.pending && isMeshyError(err, "not_found")) {
        // Meshy no longer has it (deleted, or expired): forget it, so the next run makes it afresh.
        await rm(pendingFile, { force: true });
        if (rj) rj.credits = 0;
      }
      say(`failed: ${msg}`);
      if (rj && !isMeshyError(err, "task_failed") && !isMeshyError(err, "not_found")) say(`task ${rj.task} is kept in ${slash(join(".meshy", `${w.base}.json`))}: the next run picks it up without paying again.`);
      if (isMeshyError(err)) {
        const h = hint(err, credential);
        if (h) say(h);
        if (err.category === "auth" || err.category === "credits" || err.category === "forbidden") stop = true;
      }
    } finally {
      if (rj) {
        rj.secs ??= Math.round((now() - t0) / 100) / 10;
        await save();
      }
    }
  };

  const queue = [...work];
  const worker = async () => {
    for (;;) {
      const w = queue.shift();
      if (!w) return;
      if (stop || io.signal?.aborted) {
        notStarted++;
        continue;
      }
      await runOne(w);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, worker));

  let after: Balance | undefined;
  if (record.jobs.length) {
    after = await meshy.balance().catch(() => undefined);
    if (after) record.balanceAfter = after.balance;
    record.running = false;
    if (notStarted) record.error = `${plural(notStarted, "job")} not started (${stop ? "Meshy refused the key or the credits" : "stopped"})`;
    await save();
  }
  await rmdir(pendingDir).catch(() => undefined);
  const spent = record.credits;
  const spentUsd = usdOf(spent, rate);
  io.out(
    `\n${made} made${failed ? `, ${failed} failed` : ""}${notStarted ? `, ${notStarted} not started` : ""}${spent ? `, ${credits(spent)}${spentUsd !== undefined ? ` (${formatUsd(spentUsd)})` : ""}` : ""}${after ? `; balance now ${credits(after.balance)}` : ""}, in ${slash(outDir)}`,
  );
  if (record.jobs.length) io.out(`Run record: ${basename(recordFile)}`);
  return failed || notStarted ? 1 : 0;
}

type Values = ReturnType<typeof parse>["values"];

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      out: { type: "string", short: "o" },
      jobs: { type: "string" },
      image: { type: "string", multiple: true },
      name: { type: "string", short: "n", multiple: true },
      model: { type: "string" },
      "smart-topology": { type: "boolean" },
      texture: { type: "boolean" },
      pbr: { type: "boolean" },
      "texture-resolution": { type: "string" },
      "texture-prompt": { type: "string" },
      topology: { type: "string" },
      polycount: { type: "string" },
      remesh: { type: "boolean" },
      "no-remesh": { type: "boolean" },
      pose: { type: "string" },
      ultra: { type: "string" },
      "no-enhance": { type: "boolean" },
      formats: { type: "string" },
      concurrency: { type: "string" },
      "usd-per-credit": { type: "string" },
      "dry-run": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      force: { type: "boolean" },
      credential: { type: "string" },
      app: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function defaultLoadKey(credential: string, app: string): Promise<string | undefined> {
  return loadMeshyKey({ credential, app });
}
