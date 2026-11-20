#!/usr/bin/env node
// btkulka-trellis: the package from a terminal.
//
//   btkulka-trellis check    [--comfy D:/tools/comfyui-3d]                 the weights on disk
//   btkulka-trellis fetch    [--comfy …]                                   download what is missing (resumes)
//   btkulka-trellis serve    [--comfy …] [--url http://127.0.0.1:8190] [--force] [--shared-models D:/source/comfyui/models]
//   btkulka-trellis stop     [--comfy …] [--url …]
//   btkulka-trellis generate (--image ref.png | --prompt "a thing") --name my-thing [--out dir] [--quality high] [--seed n] [--style "…"]
//   btkulka-trellis obj      in.glb out/prefix [--colors 6] [--scale 1]
//   btkulka-trellis rent     --image a.png [--name a] [--image b.png --name b …] [--out dir] [--min-memory 40] [--minutes N] [--budget 2] [--yes]
//                            (a rented GPU on RunPod for what an 8 GB card can't hold; the plan and price print first, --yes spends;
//                            what the run cost goes into --out as rent-<stamp>.json once the pod has ended)
//
// TRELLIS_COMFY_DIR and TRELLIS_URL set the defaults.
import path from "node:path";
import { parseArgs } from "node:util";

import { DEFAULT_CREDENTIAL as RUNPOD_CREDENTIAL, KEY_ENV as RUNPOD_KEY_ENV, loadRunPodKey } from "@btkulka/runpod-client";

import { generate } from "./generate.js";
import { rentAndGenerate, rentPlan, type RentJob } from "./rent.js";
import { glbToObj } from "./glb.js";
import { TrellisError, isUp, serve, stopServer, watchMemoryFloor } from "./server.js";
import type { TrellisEnv } from "./server.js";
import { checkWeights, downloadWeights } from "./weights.js";

const USAGE = `btkulka-trellis check|fetch|serve|stop|generate|obj
  check|fetch [--comfy DIR]
  serve [--comfy DIR] [--url URL] [--shared-models DIR] [--force]      (foreground; Ctrl+C stops it)
  stop [--comfy DIR] [--url URL]
  generate (--image FILE | --prompt TEXT) --name NAME [--out DIR] [--quality high] [--seed N] [--resolution N] [--style TEXT]
  obj IN.glb OUT_PREFIX [--colors N] [--scale S]
  rent --image FILE [--name NAME] [--image FILE --name NAME …] [--out DIR] [--min-memory GB] [--gpu ID ...] [--minutes N] [--budget USD] [--yes]
       [--model trellis2|pixal3d|both] [--quality high] [--textured] [--max-faces N]
       a GPU rented on RunPod by the minute: the plan and its worst-case cost print first; only --yes rents.
       The key: Benhäus credential ${RUNPOD_CREDENTIAL} (or env ${RUNPOD_KEY_ENV}).`;

function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      comfy: { type: "string" },
      url: { type: "string" },
      "shared-models": { type: "string" },
      force: { type: "boolean" },
      image: { type: "string", multiple: true },
      prompt: { type: "string" },
      name: { type: "string", multiple: true },
      "min-memory": { type: "string" }, gpu: { type: "string", multiple: true },
      model: { type: "string" },
      textured: { type: "boolean" },
      "max-faces": { type: "string" },
      minutes: { type: "string" },
      budget: { type: "string" },
      yes: { type: "boolean", short: "y" },
      out: { type: "string" },
      quality: { type: "string" },
      seed: { type: "string" },
      resolution: { type: "string" },
      style: { type: "string" },
      colors: { type: "string" },
      scale: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const cmd = positionals[0];
  if (!cmd || values.help) {
    console.log(USAGE);
    return Promise.resolve(cmd ? 0 : 2);
  }
  const env: TrellisEnv = {
    comfyDir: values.comfy ?? process.env.TRELLIS_COMFY_DIR ?? "D:/tools/comfyui-3d",
    url: values.url ?? process.env.TRELLIS_URL,
    sharedModelsDir: values["shared-models"],
  };
  const log = (line: string) => console.log(line);
  return (async () => {
    switch (cmd) {
      case "check":
      case "fetch": {
        const status = cmd === "fetch" ? await downloadWeights(env.comfyDir, { onLog: log }) : checkWeights(env.comfyDir);
        for (const s of status) console.log(`${s.ok ? "ok      " : s.partial ? "partial " : "missing "} ${s.file.folder}/${s.file.file} (${(s.file.bytes / 1e9).toFixed(2)} GB)`);
        const missing = status.filter((s) => !s.ok).length;
        console.log(missing ? `${missing} file(s) missing.` : "All TRELLIS.2 weights are in place.");
        return missing ? 1 : 0;
      }
      case "serve": {
        const handle = await serve(env, { force: values.force, onLog: log });
        if (handle.reused) return 0;
        const stopWatch = watchMemoryFloor(handle, { onStop: () => console.error("Free RAM stayed under the floor for 30 s; stopped ComfyUI so the machine stays usable.") });
        console.log("Serving; Ctrl+C stops it.");
        await new Promise<void>((resolve) => {
          const end = () => { stopWatch(); void handle.stop().then(() => resolve()); };
          process.on("SIGINT", end);
          process.on("SIGTERM", end);
          process.on("SIGBREAK", end);
        });
        return 0;
      }
      case "stop":
        console.log((await stopServer(env)) ? "Stopped." : "Nothing of ours was running.");
        return 0;
      case "generate": {
        const image = values.image?.[0];
        const name = values.name?.[0];
        if (!name || (!image && !values.prompt)) {
          console.error(USAGE);
          return 2;
        }
        if (!(await isUp(env))) {
          console.error(`No 3D ComfyUI at ${env.url ?? "http://127.0.0.1:8190"}. Start it: btkulka-trellis serve`);
          return 1;
        }
        const r = await generate(env, {
          image,
          prompt: values.prompt,
          name,
          outDir: values.out ?? path.resolve("trellis-out"),
          quality: values.quality === "high" ? "high" : "standard",
          seed: values.seed ? Number(values.seed) : undefined,
          resolution: values.resolution ? Number(values.resolution) : undefined,
          conceptStyle: values.style,
          onProgress: (stage, secs) => console.log(`  ${stage}… ${secs}s`),
        });
        if (r.concept) console.log(`concept  ${r.concept}`);
        console.log(`glb      ${r.glb} (${r.secs}s, seed ${r.seed})`);
        console.log(`meta     ${r.meta}`);
        return 0;
      }
      case "obj": {
        const [, input, prefix] = positionals;
        if (!input || !prefix) {
          console.error(USAGE);
          return 2;
        }
        const out = glbToObj(input, prefix, { colors: values.colors ? Number(values.colors) : undefined, scale: values.scale ? Number(values.scale) : undefined });
        for (const [k, f] of out.files.entries()) console.log(`${out.groups[k].hex}  ${out.groups[k].faces} faces  ${f}`);
        console.log(`manifest ${out.manifest}`);
        return 0;
      }
      case "rent": {
        const images = values.image ?? [];
        if (!images.length) {
          console.error(USAGE);
          return 2;
        }
        const names = values.name ?? [];
        const models: ("trellis2" | "pixal3d")[] = values.model === "both" ? ["trellis2", "pixal3d"] : [values.model === "pixal3d" ? "pixal3d" : "trellis2"];
        const tag = { trellis2: "t2", pixal3d: "px" } as const;
        const jobs: RentJob[] = images.flatMap((img, i) => {
          const base = names[i] ?? path.basename(img, path.extname(img)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
          return models.map((m) => ({
            image: path.resolve(img),
            name: models.length > 1 ? `${base}-${tag[m]}` : base,
            seed: values.seed ? Number(values.seed) : undefined,
            quality: values.quality === "high" ? ("high" as const) : ("standard" as const),
            model: m,
            textured: !!values.textured,
            maxFaces: values["max-faces"] ? Number(values["max-faces"]) : undefined,
          }));
        });
        const apiKey = await loadRunPodKey({ app: "trellis-client" });
        if (!apiKey) {
          console.error(`No RunPod key. Add it in Benhäus › Settings › Credentials as ${RUNPOD_CREDENTIAL} (or set ${RUNPOD_KEY_ENV}).`);
          return 1;
        }
        const opts = {
          apiKey,
          jobs,
          outDir: values.out ?? path.resolve("trellis-out"),
          minMemoryGb: values["min-memory"] ? Number(values["min-memory"]) : undefined,
          gpus: values.gpu && (values.gpu as string[]).length ? (values.gpu as string[]) : undefined,
          maxMinutes: values.minutes ? Number(values.minutes) : undefined,
          budgetUsd: values.budget ? Number(values.budget) : undefined,
          onLog: log,
        };
        const plan = await rentPlan(opts);
        console.log(`${jobs.length} model(s): ${jobs.map((j) => j.name).join(", ")}`);
        for (const c of plan.candidates.slice(0, 5)) console.log(`  $${c.pricePerHour.toFixed(2)}/h  ${c.memory} GB  ${c.cloud.toLowerCase()}  ${c.name}`);
        if (!plan.ok) {
          console.error(`Not renting: ${plan.reason}`);
          return 1;
        }
        console.log(`Ends after ${plan.maxMinutes} min at the latest: at most $${plan.maxCostUsd.toFixed(2)} (from $${plan.minCostUsd.toFixed(2)} on the cheapest), budget $${plan.budgetUsd.toFixed(2)}. Setup takes about 10 min of that.`);
        if (!values.yes) {
          console.log("Nothing rented. Run again with --yes to rent and model.");
          return 3;
        }
        const ac = new AbortController();
        const stop = () => {
          console.error("Stopping: terminating the rented GPU…");
          ac.abort();
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        const r = await rentAndGenerate({ ...opts }, ac.signal);
        for (const g of r.results) console.log(`glb      ${g.glb} (${g.secs}s, seed ${g.seed})`);
        for (const f of r.failures) console.log(`failed   ${f.name}: ${f.error}`);
        console.log(`${r.gpu ?? "No GPU"}: ${r.minutes} min, about $${r.spentUsd.toFixed(2)}.`);
        if (r.record) console.log(`record   ${r.record}`);
        return r.failures.length || !r.results.length ? 1 : 0;
      }
      default:
        console.error(USAGE);
        return 2;
    }
  })();
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const e = err as Error & { code?: string };
    console.error(e instanceof TrellisError ? `${e.code}: ${e.message}` : (e.stack ?? String(err)));
    process.exit(1);
  });
