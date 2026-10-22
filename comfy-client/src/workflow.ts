export interface LoraSpec {
  filename: string;
  /** UNet (diffusion) strength — drives the rendered style AND the LoRA's baked-in
   *  composition/pose prior. */
  strength: number;
  /** Text-encoder strength. Optional; defaults to `strength` (the historical
   *  behaviour where model and clip were pinned together). Lowering it below
   *  `strength` loosens how strongly the LoRA's learned concept/pose associations
   *  re-weight the prompt, so the caller's own pose/framing tags drive composition
   *  while the visual style (carried by `strength`) is retained. */
  strengthClip?: number;
}

/**
 * Optional OpenPose (or other image-hint) ControlNet conditioning. When present,
 * a pre-rendered control image (e.g. an OpenPose skeleton already staged in
 * ComfyUI's `input/`) constrains the composition/pose while the LoRA stack still
 * governs style and the prompt still governs identity. The hint is fed straight
 * into `ControlNetApplyAdvanced` with NO preprocessing — pass an already-rendered
 * skeleton, not a raw photo.
 */
export interface ControlNetSpec {
  /** ControlNet model filename as ComfyUI lists it (controlnet_name). */
  model: string;
  /** Staged input image name (a `LoadImage`-resolvable name already in input/). */
  image: string;
  /** Conditioning strength (0–1+). ~0.55 suits stylized output; 1.0 is rigid. */
  strength: number;
  /** Fraction of sampling at which the hint engages (0 = from the first step). */
  startPercent: number;
  /** Fraction of sampling at which the hint disengages (e.g. 0.7 frees late steps). */
  endPercent: number;
}

export interface WorkflowParams {
  checkpoint: string;
  positivePrompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number;
  loras: LoraSpec[];
  filenamePrefix: string;
  /** Optional pose/image-hint conditioning spliced onto the conditioning path. */
  controlNet?: ControlNetSpec;
}

type Node = { class_type: string; inputs: Record<string, unknown> };

/**
 * Build a ComfyUI prompt graph for SDXL/Illustrious text-to-image with optional LoRA stacking.
 * Nodes are referenced by string IDs (Comfy's convention) and chained:
 *   CheckpointLoader -> [LoraLoader...] -> CLIPTextEncode (pos/neg) -> KSampler -> VAEDecode -> SaveImage
 */
export function buildTextToImageWorkflow(p: WorkflowParams): Record<string, Node> {
  const nodes: Record<string, Node> = {};
  let nextId = 1;
  const id = () => String(nextId++);

  const ckptId = id();
  nodes[ckptId] = {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: p.checkpoint },
  };

  // Chain LoRAs: each consumes the previous (model, clip) pair and outputs a new one.
  let modelSrc: [string, number] = [ckptId, 0];
  let clipSrc: [string, number] = [ckptId, 1];
  const vaeSrc: [string, number] = [ckptId, 2];

  for (const lora of p.loras) {
    const lid = id();
    nodes[lid] = {
      class_type: "LoraLoader",
      inputs: {
        lora_name: lora.filename,
        strength_model: lora.strength,
        // Defaults to strength_model (legacy coupling) unless the caller decoupled it.
        strength_clip: lora.strengthClip ?? lora.strength,
        model: modelSrc,
        clip: clipSrc,
      },
    };
    modelSrc = [lid, 0];
    clipSrc = [lid, 1];
  }

  const posId = id();
  nodes[posId] = {
    class_type: "CLIPTextEncode",
    inputs: { text: p.positivePrompt, clip: clipSrc },
  };

  const negId = id();
  nodes[negId] = {
    class_type: "CLIPTextEncode",
    inputs: { text: p.negativePrompt, clip: clipSrc },
  };

  const latentId = id();
  nodes[latentId] = {
    class_type: "EmptyLatentImage",
    inputs: { width: p.width, height: p.height, batch_size: 1 },
  };

  const samplerId = id();
  nodes[samplerId] = {
    class_type: "KSampler",
    inputs: {
      seed: p.seed,
      steps: p.steps,
      cfg: p.cfg,
      sampler_name: p.sampler,
      scheduler: p.scheduler,
      denoise: 1.0,
      model: modelSrc,
      positive: [posId, 0],
      negative: [negId, 0],
      latent_image: [latentId, 0],
    },
  };

  const decodeId = id();
  nodes[decodeId] = {
    class_type: "VAEDecode",
    inputs: { samples: [samplerId, 0], vae: vaeSrc },
  };

  const saveId = id();
  nodes[saveId] = {
    class_type: "SaveImage",
    inputs: { images: [decodeId, 0], filename_prefix: p.filenamePrefix },
  };

  // ControlNet is OPTIONAL: when absent the graph above is byte-identical to the
  // historical text-to-image graph (preserving reproducibility of every existing
  // render). When present, splice the pose/image hint onto the CONDITIONING path
  // only — the model/clip (LoRA) path and latent/vae are untouched, so the full
  // LoRA stack and identity prompt still apply; only the composition is steered.
  if (p.controlNet) {
    const cn = p.controlNet;

    // Find the encoders by FOLLOWING the sampler's positive/negative refs rather
    // than by class_type/position — robust to any reordering of the base graph.
    const ksampler = nodes[samplerId];
    const posRef = ksampler.inputs.positive as [string, number];
    const negRef = ksampler.inputs.negative as [string, number];

    const loaderId = id();
    nodes[loaderId] = {
      class_type: "ControlNetLoader",
      inputs: { control_net_name: cn.model },
    };

    const imageId = id();
    nodes[imageId] = {
      class_type: "LoadImage",
      inputs: { image: cn.image },
    };

    const applyId = id();
    nodes[applyId] = {
      class_type: "ControlNetApplyAdvanced",
      inputs: {
        positive: posRef,
        negative: negRef,
        control_net: [loaderId, 0],
        image: [imageId, 0],
        strength: cn.strength,
        start_percent: cn.startPercent,
        end_percent: cn.endPercent,
        // `vae` intentionally omitted — only SD3/Flux-style ControlNets need it;
        // SDXL/Illustrious openpose does not.
      },
    };

    // ControlNetApplyAdvanced returns (positive, negative) at indices 0 and 1.
    ksampler.inputs.positive = [applyId, 0];
    ksampler.inputs.negative = [applyId, 1];
  }

  return nodes;
}

/**
 * Same chain as `buildTextToImageWorkflow` up to VAEDecode, but appends a
 * background-removal node (`LayerMask: RemBgUltra` from ComfyUI_LayerStyle)
 * and joins the matte back as the alpha channel before saving. The output is
 * a transparent PNG suitable for compositing into the chat UI.
 *
 * Requires `ComfyUI_LayerStyle` installed in ComfyUI; the workflow will fail
 * at runtime with a clear node-not-found error otherwise.
 */
export function buildDialogueArtWorkflow(p: WorkflowParams): Record<string, Node> {
  const nodes = buildTextToImageWorkflow(p);

  // Find the existing VAEDecode + SaveImage; we need to splice between them.
  const decodeEntry = Object.entries(nodes).find(([, n]) => n.class_type === "VAEDecode");
  const saveEntry = Object.entries(nodes).find(([, n]) => n.class_type === "SaveImage");
  if (!decodeEntry || !saveEntry) {
    throw new Error("buildDialogueArtWorkflow: base workflow missing VAEDecode or SaveImage");
  }
  const [decodeId] = decodeEntry;
  const [, saveNode] = saveEntry;

  const nextId = (): string => {
    let n = 1;
    while (nodes[String(n)]) n++;
    return String(n);
  };

  // BG removal — VITMatte gives the cleanest hair edges of the available methods.
  const rmbgId = nextId();
  nodes[rmbgId] = {
    class_type: "LayerMask: RemBgUltra",
    inputs: {
      image: [decodeId, 0],
      detail_method: "VITMatte(local)",
      detail_erode: 6,
      detail_dilate: 6,
      black_point: 0.01,
      white_point: 0.99,
      process_detail: true,
      device: "cuda",
      max_megapixels: 2.0,
    },
  };
  // RemBgUltra outputs [image_with_bg_removed (RGB), mask].
  // Re-attach the mask as alpha so SaveImage emits PNG-with-alpha.
  const joinId = nextId();
  nodes[joinId] = {
    class_type: "JoinImageWithAlpha",
    inputs: {
      image: [rmbgId, 0],
      alpha: [rmbgId, 1],
    },
  };
  saveNode.inputs.images = [joinId, 0];

  return nodes;
}
