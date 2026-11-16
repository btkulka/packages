import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { RunPodClient } from "@btkulka/runpod-client";

import { generate } from "./generate.js";
import { bootScript, BOOT_CMD, COMFY_REV, PROXY_PY, RENT_TORCH, rentPlan } from "./rent.js";
import { TRELLIS2_WEIGHTS } from "./weights.js";
import type { ObjectInfo, UiWorkflow } from "./workflow.js";

const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" }).status === 0;

test("the boot script is valid bash and does every step", () => {
  const s = bootScript();
  assert.match(s, /git fetch -q --depth 1 origin "\$COMFY_REV"/);
  assert.match(s, new RegExp(`torch==${RENT_TORCH.torch.replace(/\./g, "\\.")} torchvision==${RENT_TORCH.torchvision.replace(/\./g, "\\.")} --index-url ${RENT_TORCH.index}`));
  for (const w of TRELLIS2_WEIGHTS) assert.ok(s.includes(`dl ${w.folder} ${w.file} ${w.repo} ${w.inRepo}`), w.file);
  assert.match(s, /sleep "\$\{RENT_DEADLINE_S:-2700\}"/, "the pod's own deadline");
  assert.match(s, /--listen 127\.0\.0\.1 --port 8189/, "ComfyUI only on localhost");
  assert.match(s, /step "ready"/);
  assert.equal(COMFY_REV.length, 40);
  assert.match(BOOT_CMD, /base64 -d > \/workspace\/boot\.sh && exec bash \/workspace\/boot\.sh/);
  if (has("bash", ["--version"])) {
    const r = spawnSync("bash", ["-n"], { input: s, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
});

test("the token proxy is valid Python and turns away a request without the token", () => {
  assert.match(PROXY_PY, /hmac\.compare_digest/);
  assert.match(PROXY_PY, /status=401/);
  assert.match(PROXY_PY, /port=8188/);
  const py = ["python", "python3"].find((c) => has(c, ["--version"]));
  if (py) {
    const r = spawnSync(py, ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], { input: PROXY_PY, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
});

test("rentPlan asks for CUDA 13 hosts and 40 GB by default, and sizes the deadline to the jobs", async () => {
  const asked: unknown[] = [];
  const client = {
    gpus: async (q: unknown) => {
      asked.push(q);
      return [
        { id: "NVIDIA RTX 4090", name: "RTX 4090", memory: 24, community: true, price: { community: 0.34 }, availability: "HIGH" },
        { id: "NVIDIA A40", name: "A40", memory: 48, community: true, price: { community: 0.35 }, availability: "HIGH" },
      ];
    },
  } as unknown as RunPodClient;
  const plan = await rentPlan({ apiKey: "k", client, outDir: ".", clouds: ["COMMUNITY"], jobs: [{ image: "a.png", name: "a" }, { image: "b.png", name: "b" }, { image: "c.png", name: "c" }, { image: "d.png", name: "d" }] });
  assert.deepEqual(asked[0], { cloud: "COMMUNITY", minCudaVersion: "13.0" });
  assert.deepEqual(plan.candidates.map((c) => c.name), ["A40"]);
  assert.equal(plan.maxMinutes, 35);
  assert.equal(plan.maxCostUsd, 0.2);
  assert.equal(plan.ok, true);
});

const INFO: ObjectInfo = {
  Trellis2ShapeStage: { input: { required: {} } },
  LoadImage: { input: { required: { image: ["COMBO"] } } },
  PrimitiveBoolean: { input: { required: { value: ["BOOLEAN"] } } },
  ComfySwitchNode: { input: { required: { switch: ["BOOLEAN"], on_true: ["*"], on_false: ["*"] } } },
  Trellis2UpsampleStage: { input: { required: { latent: ["LATENT"], target_resolution: ["INT"] } } },
  PaintMesh: { input: { required: { mesh: ["MESH"] } } },
};
const TEMPLATE: UiWorkflow = {
  nodes: [
    { id: 1, type: "LoadImage", widgets_values: ["x.png"] },
    { id: 2, type: "PrimitiveBoolean", widgets_values: [false] },
    { id: 3, type: "ComfySwitchNode", inputs: [{ name: "switch", link: 1 }, { name: "on_true", link: 2 }, { name: "on_false", link: 3 }] },
    { id: 5, type: "Trellis2UpsampleStage", inputs: [{ name: "latent", link: 4 }], widgets_values: [1536] },
    { id: 6, type: "PaintMesh", inputs: [{ name: "mesh", link: 5 }] },
  ],
  links: [
    [1, 2, 0, 3, 0, "BOOLEAN"],
    [2, 1, 0, 3, 1, "*"],
    [3, 1, 0, 3, 2, "*"],
    [4, 3, 0, 5, 0, "LATENT"],
    [5, 5, 0, 6, 0, "MESH"],
  ],
};

test("generate against a remote server: every request carries the token, the GLB comes back over /view", async () => {
  const seen: string[] = [];
  let queued: Record<string, { class_type: string; inputs: Record<string, unknown> }> | undefined;
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url?.split("?")[0]} ${req.headers.authorization ?? "-"}`);
    if (req.headers.authorization !== "Bearer t0k") {
      res.writeHead(401).end("unauthorized");
      return;
    }
    const json = (o: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
    const url = new URL(req.url ?? "/", "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (url.pathname === "/object_info") return json(INFO);
      if (url.pathname === "/upload/image") return json({ name: "up.png" });
      if (url.pathname === "/prompt") {
        queued = (JSON.parse(body) as { prompt: typeof queued }).prompt;
        return json({ prompt_id: "p1" });
      }
      if (url.pathname === "/history/p1") return json({ p1: { status: { completed: true }, outputs: { trellis_save: { "3d": [{ filename: "drawer_00001_.glb", subfolder: "3d/trellis", type: "output" }] } } } });
      if (url.pathname === "/view") {
        assert.equal(url.searchParams.get("filename"), "drawer_00001_.glb");
        assert.equal(url.searchParams.get("subfolder"), "3d/trellis");
        return res.writeHead(200, { "content-type": "model/gltf-binary" }).end(Buffer.from("glTF-bytes"));
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-remote-"));
  try {
    const img = path.join(dir, "in.png");
    fs.writeFileSync(img, "png");
    const r = await generate(
      { comfyDir: "", url: `http://127.0.0.1:${port}`, headers: { Authorization: "Bearer t0k" }, remote: true },
      { image: img, name: "drawer", outDir: dir, seed: 3, template: TEMPLATE, pollS: 0.01 },
    );
    assert.equal(fs.readFileSync(r.glb, "utf8"), "glTF-bytes");
    assert.ok(seen.every((l) => l.endsWith("Bearer t0k")), seen.join("\n"));
    assert.deepEqual(queued?.trellis_save, { class_type: "SaveGLB", inputs: { mesh: ["6", 0], filename_prefix: "3d/trellis/drawer" } });
    await assert.rejects(generate({ comfyDir: "", url: `http://127.0.0.1:${port}`, remote: true }, { image: img, name: "x", outDir: dir, template: TEMPLATE }), /No 3D ComfyUI|401/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
