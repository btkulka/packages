# lora-train

Image/style **LoRA training engine** for SDXL via kohya_ss `sd-scripts`. Framework-free
(plain Node + `child_process`); no Next.js, no React. Consumed locally via `file:` deps by:

- `nhi-album-art-gen` — its `/train` web UI
- `orson` — its `/lora-train` skill

This is **not** an LLM/text-LoRA trainer. Orson has a separate stack (`/train dm`,
`/train character`, `/train narrator`) for fine-tuning chat models via unsloth → GGUF →
Ollama. This package only produces `.safetensors` image LoRAs for ComfyUI.

## What it does

Given a folder of accepted training images (+ optional `.txt` captions), it:

1. `prepareDataset` — copies images into kohya's `<repeats>_<name>/` layout, materializes captions.
2. `startTraining` — spawns `accelerate launch sdxl_train_network.py …` with a VRAM-tuned
   flag set (gradient checkpointing, cached/frozen text encoders, SDPA, bucket caps) sized for
   an 8GB card. Parses step/epoch/loss progress from stdout.
3. `cancelTraining` / `readTrainingLog` — lifecycle + log tailing. One run at a time per process.

## Usage

All paths and the kohya working dir are injected per-consumer via `LoraTrainEnv`:

```ts
import { prepareDataset, startTraining, DEFAULT_TRAINING_CONFIG, type LoraTrainEnv } from "lora-train";

const env: LoraTrainEnv = {
  trainingDir: "/path/to/training",   // holds <collection>/accepted/*.jpg
  runsDir: "/path/to/data/training-runs",
  outputDir: "/path/to/comfyui/models/loras",
  cwd: "/path/to/sd-scripts",          // kohya checkout (sdxl_train_network.py resolves here)
};

const config = {
  ...DEFAULT_TRAINING_CONFIG,
  name: "my style",
  collection: "my-collection",
  outputName: "my-style-lora",
  baseModel: "/path/to/checkpoints/sdxlBase.safetensors",
};

const { datasetPath } = prepareDataset(env, config);
const run = startTraining(env, config, datasetPath);
```

## Prerequisites (runtime, not code)

- `kohya_ss` / `sd-scripts` checked out, with `sdxl_train_network.py` resolvable from `env.cwd`.
- `accelerate` on PATH (or set `env.accelerateBin`).
- A CUDA GPU. Defaults are tuned for ~8GB (RTX 3070); raise `resolution`/`networkRank` on bigger cards.

## Build

```
npm install
npm run build   # tsc -> dist/  (consumers load dist via the file: dep)
```
