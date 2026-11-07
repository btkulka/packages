// gemini-video's work, with its input and output passed in so tests can run it on a fake fetch.
// Node-only (files, the key from Benhäus); the browser-safe index never imports this.
//
// Spending is opt-in: the estimate prints first, --dry-run prints the requests and sends nothing, and
// without --yes nothing is sent at all. Each started clip leaves its interaction id in
// <out>/.gemini-video/<name>.json until its MP4 is written, so a run that stops (Ctrl+C, a closed
// terminal) picks the clip up again on the next run instead of paying for it twice.

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadCredential } from "@btkulka/benhaus-client";
import { createGeminiClient, GEMINI_API_URL, GEMINI_API_VERSION, type GeminiFetch } from "../client.js";
import { isGeminiError, type GeminiError } from "../errors.js";
import { costOfUsage, estimateClipCost, formatUsd, PRICES_READ_ON, PRICES_SOURCE } from "../pricing.js";
import { interactionBody, type ImageMimeType, type InteractionBody, type VideoRequest } from "../video.js";
import { CLI_DEFAULTS, JobError, parseJobs, promptJob, type Job, type JobDefaults } from "./jobs.js";

export const DEFAULT_CREDENTIAL = "gemini/toejam";
export const DEFAULT_APP = "toejam";
export const KEY_ENV = "GEMINI_API_KEY";

export const USAGE = `gemini-video: render clips with Gemini Omni Flash (the Gemini API's video model) to <name>.mp4 files.

  gemini-video "<prompt>" --out <folder> [--name <name>] [options]
  gemini-video --jobs <jobs.json> --out <folder> [options]

A jobs file is a JSON array (or { "jobs": [...] }) of
  { "name", "prompt", "negativePrompt"?, "aspect"?, "resolution"?, "seconds"?, "model"?, "seed"?, "image"? }
("image" is a start frame, relative to the jobs file). The flags below are the defaults for every job.

  --out, -o <folder>      where <name>.mp4 go (made if missing)
  --aspect 9:16|16:9      default 9:16 (portrait, phone-style)
  --resolution <r>        360p, 720p (default), 1080p or 4k (1080p and 4k are upscaled)
  --seconds <3-10>        the length to ask for; left out, Google picks (the estimate assumes 10)
  --negative <text>       what to avoid (added to the prompt: Omni has no negative-prompt field)
  --seed <n>              a seed (a single prompt only; jobs set their own)
  --model <id>            default gemini-omni-1.1-flash
  --image <file>          a start frame for a single prompt (png, jpg, webp)
  --name, -n <name>       the file name for a single prompt (default: its first words)
  --dry-run               print the requests it would make; send nothing
  --yes, -y               spend: without it nothing is sent (the estimate prints either way)
  --force                 make clips again even when <name>.mp4 is there
  --concurrency <1-8>     clips at once (default 2)
  --credential <id>       the Benhäus credential (default ${DEFAULT_CREDENTIAL}; env ${KEY_ENV} as the fallback)
  --app <id>              the tool id Benhäus shows as the reader (default ${DEFAULT_APP})

Exit codes: 0 done, 1 a failure, 2 needs --yes.`;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** The fetch the client uses. Default the global one. */
  fetch?: GeminiFetch;
  /** The API key. Default: loadCredential(credential, { app, env: { apiKey: GEMINI_API_KEY } }). */
  loadKey?(credential: string, app: string): Promise<string | undefined>;
  /** Stops the run (Ctrl+C): clips in flight keep their interaction ids for the next run. */
  signal?: AbortSignal;
  /** Default process.cwd(). */
  cwd?: string;
  /** The first wait between polls, ms. Default 5 000. */
  pollMs?: number;
}

interface Pending {
  id: string;
  name: string;
  model: string;
  startedAt: string;
}

type Plan = { job: Job; state: "new" } | { job: Job; state: "resume"; pending: Pending } | { job: Job; state: "done" };

const MIME: Record<string, ImageMimeType> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif" };

const exists = (p: string) => stat(p).then(() => true, () => false);

async function readPending(file: string): Promise<Pending | undefined> {
  try {
    const p = JSON.parse(await readFile(file, "utf8")) as Partial<Pending>;
    return typeof p.id === "string" && p.id ? (p as Pending) : undefined;
  } catch {
    return undefined;
  }
}

function hint(err: GeminiError, credential: string): string {
  switch (err.category) {
    case "auth":
      return `The key was refused: check ${credential} in Benhäus › Settings › Credentials (or ${KEY_ENV}).`;
    case "setup":
      return "The key's Google project can't make video yet: video is paid-tier only, so set up billing for it in AI Studio (aistudio.google.com › API keys › Set up billing), or read Google's message above.";
    case "rate_limit":
      return "Rate limited: try again later, or with --concurrency 1.";
    case "blocked":
      return "Google's filters refused it: reword it (no real people's names, no minors, nothing sexual, violent or dangerous).";
    default:
      return "";
  }
}

export async function run(argv: string[], io: CliIo): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  let a: ReturnType<typeof parse>;
  try {
    a = parse(argv);
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${USAGE}`);
    return 1;
  }
  const { values: v, positionals } = a;
  if (v.help) {
    io.out(USAGE);
    return 0;
  }
  const prompt = positionals.join(" ").trim();
  if (!prompt && !v.jobs) {
    io.err(`Give a prompt or --jobs <file>.\n\n${USAGE}`);
    return 1;
  }
  if (prompt && v.jobs) {
    io.err("Give a prompt or --jobs, not both.");
    return 1;
  }
  if (!v.out) {
    io.err("Say where the clips go: --out <folder>.");
    return 1;
  }
  const outDir = resolve(cwd, v.out);
  const pendingDir = join(outDir, ".gemini-video");
  const credential = v.credential ?? DEFAULT_CREDENTIAL;
  const app = v.app ?? DEFAULT_APP;
  const concurrency = v.concurrency === undefined ? 2 : Number(v.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    io.err("--concurrency must be a whole number from 1 to 8.");
    return 1;
  }

  // The jobs, with the flags as defaults.
  let jobs: Job[];
  let imageBase = cwd;
  try {
    const defaults: JobDefaults = {
      aspect: (v.aspect ?? CLI_DEFAULTS.aspect) as JobDefaults["aspect"],
      resolution: (v.resolution ?? CLI_DEFAULTS.resolution) as JobDefaults["resolution"],
      seconds: v.seconds === undefined ? undefined : Number(v.seconds),
      model: v.model ?? CLI_DEFAULTS.model,
      negativePrompt: v.negative,
    };
    if (v.jobs) {
      const file = resolve(cwd, v.jobs);
      imageBase = dirname(file);
      let json: unknown;
      try {
        json = JSON.parse(await readFile(file, "utf8"));
      } catch (e) {
        throw new JobError(`Can't read ${file}: ${(e as Error).message}`);
      }
      if (v.name || v.seed !== undefined || v.image) throw new JobError("--name, --seed and --image are for a single prompt; a jobs file sets them per job.");
      jobs = parseJobs(json, defaults);
    } else {
      jobs = [promptJob(prompt, v.name, v.seed === undefined ? undefined : Number(v.seed), v.image, defaults)];
    }
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }

  // Each job's request, checked now (a retired model or a bad field stops the run before anything is sent).
  const requests = new Map<string, { req: VideoRequest; body: InteractionBody }>();
  try {
    for (const job of jobs) {
      const req: VideoRequest = {
        prompt: job.prompt,
        model: job.model,
        aspectRatio: job.aspect,
        resolution: job.resolution,
        seconds: job.seconds,
        negativePrompt: job.negativePrompt,
        seed: job.seed,
      };
      if (job.image) {
        const file = resolve(imageBase, job.image);
        const mimeType = MIME[extname(file).toLowerCase()];
        if (!mimeType) throw new JobError(`${job.name}: ${job.image} isn't a png, jpg, webp or heic.`);
        let data: Uint8Array;
        try {
          data = new Uint8Array(await readFile(file));
        } catch (e) {
          throw new JobError(`${job.name}: can't read ${file}: ${(e as Error).message}`);
        }
        req.images = [{ data, mimeType }];
      }
      requests.set(job.name, { req, body: interactionBody(req) });
    }
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }

  // What's already made, what's half made, what's new.
  const plans: Plan[] = [];
  for (const job of jobs) {
    if (!v.force && (await exists(join(outDir, `${job.name}.mp4`)))) {
      plans.push({ job, state: "done" });
      continue;
    }
    const pending = v.force ? undefined : await readPending(join(pendingDir, `${job.name}.json`));
    plans.push(pending ? { job, state: "resume", pending } : { job, state: "new" });
  }

  // The estimate, first, every time.
  const fresh = plans.filter((p) => p.state === "new");
  const costs = new Map(fresh.map((p) => [p.job.name, estimateClipCost({ model: p.job.model, resolution: p.job.resolution, seconds: p.job.seconds })]));
  const total = [...costs.values()].reduce((s, c) => s + c.usd, 0);
  io.out(`${jobs.length} clip${jobs.length === 1 ? "" : "s"} → ${outDir}`);
  for (const p of plans) {
    const j = p.job;
    const what = `${j.model} ${j.aspect} ${j.resolution} ${j.seconds ? `${j.seconds}s` : "≤10s"}`;
    if (p.state === "done") io.out(`  ${j.name}: already there, skipped (--force to make it again)`);
    else if (p.state === "resume") io.out(`  ${j.name}: picking up ${p.pending.id} from ${p.pending.startedAt} (no new charge)`);
    else {
      const c = costs.get(j.name)!;
      io.out(`  ${j.name}: ${what}  ~${formatUsd(c.usd)}${c.unknown ? " (no price for this model)" : !c.verified ? " (assumes the 720p rate)" : ""}`);
    }
  }
  const approx = [...costs.values()].some((c) => c.assumedSeconds || !c.verified);
  io.out(
    `Estimated cost: ${formatUsd(total)} for ${fresh.length} new clip${fresh.length === 1 ? "" : "s"}${approx ? " (an upper bound where the length is left to Google)" : ""}. Prices read ${PRICES_READ_ON} from ${PRICES_SOURCE}; paid tier only.`,
  );

  const work = plans.filter((p) => p.state !== "done");
  if (v["dry-run"]) {
    const root = `${GEMINI_API_URL}/${GEMINI_API_VERSION}`;
    io.out("\nDry run: these are the requests; nothing was sent.");
    for (const p of work) {
      io.out(`\n# ${p.job.name}`);
      if (p.state === "new") {
        io.out(`POST ${root}/interactions`);
        io.out(`x-goog-api-key: <the ${credential} key>`);
        io.out(JSON.stringify(printable(requests.get(p.job.name)!.body), null, 2));
        io.out(`then GET ${root}/interactions/<id> every 5-30 s until it's completed, and write ${join(outDir, `${p.job.name}.mp4`)}`);
      } else {
        io.out(`GET ${root}/interactions/${p.pending.id} until it's completed, and write ${join(outDir, `${p.job.name}.mp4`)}`);
      }
    }
    return 0;
  }
  if (!work.length) {
    io.out("Nothing to do.");
    return 0;
  }
  if (!v.yes) {
    io.out(`\nNothing sent. Run again with --yes to make ${work.length === 1 ? "it" : "them"}${fresh.length ? ` (about ${formatUsd(total)})` : ""}, or --dry-run to see the requests.`);
    return 2;
  }

  const apiKey = await (io.loadKey ?? defaultLoadKey)(credential, app);
  if (!apiKey) {
    io.err(
      `No Gemini key. Add it in Benhäus › Settings › Credentials › Add › "Gemini (Google AI Studio)" with the id ${credential}, or set ${KEY_ENV}. Keys come from https://aistudio.google.com/apikey, and video needs billing on the key's project.`,
    );
    return 1;
  }
  const client = createGeminiClient({ apiKey, fetch: io.fetch });
  await mkdir(pendingDir, { recursive: true });

  let made = 0;
  let failed = 0;
  let spent = 0;
  let spentKnown = true;
  const one = async (p: Exclude<Plan, { state: "done" }>): Promise<void> => {
    const { job } = p;
    const say = (s: string) => io.out(`[${job.name}] ${s}`);
    const pendingFile = join(pendingDir, `${job.name}.json`);
    let id = p.state === "resume" ? p.pending.id : "";
    try {
      if (p.state === "new") {
        const started = await client.video.start(requests.get(job.name)!.req, { signal: io.signal });
        id = started.id;
        const record: Pending = { id, name: job.name, model: job.model, startedAt: new Date().toISOString() };
        await writeFile(pendingFile, JSON.stringify(record, null, 2) + "\n");
        say(`started ${id}`);
      } else {
        say(`picking up ${id}`);
      }
      const done = await client.video.wait(id, {
        signal: io.signal,
        intervalMs: io.pollMs,
        onPoll: (i, ms) => {
          if (i.status === "in_progress") say(`${i.status} ${Math.round(ms / 1000)}s`);
        },
      });
      const bytes = await client.video.download(done, { signal: io.signal });
      const file = join(outDir, `${job.name}.mp4`);
      await writeFile(`${file}.part`, bytes);
      await rename(`${file}.part`, file);
      await rm(pendingFile, { force: true });
      const cost = costOfUsage(job.model, done.usage);
      if (cost) spent += cost.usd;
      else spentKnown = false;
      made++;
      say(`wrote ${file} (${(bytes.length / 1_048_576).toFixed(1)} MB${cost ? `, ${formatUsd(cost.usd)}: ${cost.videoTokens} video tokens` : ""})`);
    } catch (e) {
      failed++;
      const err = e as GeminiError;
      if (isGeminiError(err) && err.kind === "aborted") {
        say(id ? `stopped waiting; ${id} carries on at Google. Run the same command again to pick it up (no new charge).` : "stopped before it started.");
        return;
      }
      if (isGeminiError(err) && err.code === "wait_timeout") {
        say(`${err.message} Run the same command again to pick it up.`);
        return;
      }
      // A finished interaction that failed, or one Google no longer has: it can't be picked up again.
      if (id && isGeminiError(err) && ["generation_failed", "cancelled", "incomplete", "no_video", "requires_action", "requires_continuation"].includes(err.code ?? "")) {
        await rm(pendingFile, { force: true });
      }
      if (id && isGeminiError(err) && err.category === "not_found") await rm(pendingFile, { force: true });
      say(`failed: ${(e as Error).message}`);
      if (isGeminiError(err)) {
        const h = hint(err, credential);
        if (h) say(h);
      }
    }
  };

  // A small pool: `concurrency` clips at once, in order.
  const queue = work.slice() as Exclude<Plan, { state: "done" }>[];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        if (io.signal?.aborted) {
          failed++;
          continue;
        }
        await one(p);
      }
    }),
  );
  io.out(`\n${made} made, ${failed} not${made ? `; ${spentKnown ? "" : "at least "}${formatUsd(spent)} by Google's usage counts` : ""}.`);
  return failed ? 1 : 0;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      out: { type: "string", short: "o" },
      jobs: { type: "string", short: "j" },
      name: { type: "string", short: "n" },
      aspect: { type: "string" },
      resolution: { type: "string" },
      seconds: { type: "string" },
      negative: { type: "string" },
      seed: { type: "string" },
      model: { type: "string" },
      image: { type: "string" },
      "dry-run": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      force: { type: "boolean" },
      concurrency: { type: "string" },
      credential: { type: "string" },
      app: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

/** The body with image data shortened, for printing. */
function printable(body: InteractionBody): unknown {
  if (typeof body.input === "string") return body;
  return { ...body, input: body.input.map((c) => (c.type === "image" && typeof c.data === "string" ? { ...c, data: `<${Math.round((c.data.length * 3) / 4)} bytes, base64>` } : c)) };
}

async function defaultLoadKey(credential: string, app: string): Promise<string | undefined> {
  const c = await loadCredential(credential, { app, env: { apiKey: KEY_ENV }, required: ["apiKey"] });
  return c?.fields.apiKey;
}
