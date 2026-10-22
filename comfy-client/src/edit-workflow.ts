// Qwen-Image-Edit-2509 (GGUF Q4_K_M) instruction-following edit graph.
//
// Mirror of assets/comfy-workflows/edit.json so callers can build the workflow
// programmatically without round-tripping through JSON + token substitution.
// The JSON file is kept as a debugging reference and as the path the
// ComfyClient runs by default.
//
// Requires custom node ComfyUI-GGUF (for UnetLoaderGGUF / DualCLIPLoaderGGUF /
// CLIPTextEncodeQwenImageEdit ships with stock ComfyUI as of 2025).
//
// LoRA splicing is intentionally not modeled here — Qwen's stack is
// incompatible with the SDXL LoRAs on disk. ComfyClient skips the splice when
// it routes a request through this builder.

export interface EditWorkflowParams {
  unetName: string;
  clipName: string;
  vaeName: string;
  sourceImage: string;
  instruction: string;
  negativePrompt: string;
  denoise: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number;
  filenamePrefix: string;
}

type Node = { class_type: string; inputs: Record<string, unknown> };

export function buildEditWorkflow(p: EditWorkflowParams): Record<string, Node> {
  const nodes: Record<string, Node> = {};

  nodes["10"] = { class_type: "LoadImage", inputs: { image: p.sourceImage } };
  nodes["11"] = { class_type: "UnetLoaderGGUF", inputs: { unet_name: p.unetName } };
  nodes["12"] = {
    class_type: "DualCLIPLoaderGGUF",
    inputs: { clip_name1: p.clipName, clip_name2: p.clipName, type: "qwen_image" },
  };
  nodes["13"] = { class_type: "VAELoader", inputs: { vae_name: p.vaeName } };
  nodes["14"] = {
    class_type: "ModelSamplingAuraFlow",
    inputs: { model: ["11", 0], shift: 3.1 },
  };
  nodes["20"] = { class_type: "VAEEncode", inputs: { pixels: ["10", 0], vae: ["13", 0] } };
  nodes["21"] = {
    class_type: "CLIPTextEncodeQwenImageEdit",
    inputs: {
      clip: ["12", 0],
      vae: ["13", 0],
      image: ["10", 0],
      prompt: p.instruction,
    },
  };
  nodes["22"] = {
    class_type: "CLIPTextEncodeQwenImageEdit",
    inputs: {
      clip: ["12", 0],
      vae: ["13", 0],
      image: ["10", 0],
      prompt: p.negativePrompt,
    },
  };
  nodes["30"] = {
    class_type: "KSampler",
    inputs: {
      seed: p.seed,
      steps: p.steps,
      cfg: p.cfg,
      sampler_name: p.sampler,
      scheduler: p.scheduler,
      denoise: clamp(p.denoise, 0, 1),
      model: ["14", 0],
      positive: ["21", 0],
      negative: ["22", 0],
      latent_image: ["20", 0],
    },
  };
  nodes["40"] = { class_type: "VAEDecode", inputs: { samples: ["30", 0], vae: ["13", 0] } };
  nodes["50"] = {
    class_type: "SaveImage",
    inputs: { filename_prefix: p.filenamePrefix, images: ["40", 0] },
  };

  return nodes;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
