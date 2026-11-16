#!/usr/bin/env node
// btkulka-trellis: the package from a terminal.
//
//   btkulka-trellis check    [--comfy D:/tools/comfyui-3d]                 the weights on disk
//   btkulka-trellis fetch    [--comfy …]                                   download what is missing (resumes)
//   btkulka-trellis serve    [--comfy …] [--url http://127.0.0.1:8190] [--force] [--shared-models D:/source/comfyui/models]
//   btkulka-trellis stop     [--comfy …] [--url …]
//   btkulka-trellis generate (--image ref.png | --prompt "a thing") --name my-thing [--out dir] [--quality high] [--seed n] [--style "…"]
//   btkulka-trellis obj      in.glb out/prefix [--colors 6] [--scale 1]
//
// TRELLIS_COMFY_DIR and TRELLIS_URL set the defaults.
import path from "node:path";
import { parseArgs } from "node:util";

import { generate } from "./generate.js";
import { glbToObj } from "./glb.js";
import { TrellisError, isUp, serve, stopServer, watchMemoryFloor } from "./server.js";
import type { TrellisEnv } from "./server.js";
import { checkWeights, downloadWeights } from "./weights.js";

const USAGE = `btkulka-trellis check|fetch|serve|stop|generate|obj
  check|fetch [--comfy DIR]
  serve [--comfy DIR] [--url URL] [--shared-models DIR] [--force]      (foreground; Ctrl+C stops it)
  stop [--comfy DIR] [--url URL]
  generate (--image FILE | --prompt TEXT) --name NAME [--out DIR] [--quality high] [--seed N] [--resolution N] [--style TEXT]
  obj IN.glb OUT_PREFIX [--colors N] [--scale S]`;

function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      comfy: { type: "string" },
      url: { type: "string" },
      "shared-models": { type: "string" },
      force: { type: "boolean" },
      image: { type: "string" },
      prompt: { type: "string" },
      name: { type: "string" },
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
        if (!values.name || (!values.image && !values.prompt)) {
          console.error(USAGE);
          return 2;
        }
        if (!(await isUp(env))) {
          console.error(`No 3D ComfyUI at ${env.url ?? "http://127.0.0.1:8190"}. Start it: btkulka-trellis serve`);
          return 1;
        }
        const r = await generate(env, {
          image: values.image,
          prompt: values.prompt,
          name: values.name,
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
