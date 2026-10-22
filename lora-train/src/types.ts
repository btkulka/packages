export interface TrainingConfig {
  /** Display name for this training run */
  name: string;
  /** Collection to source accepted images from (subdir under env.trainingDir) */
  collection: string;
  /** Base model checkpoint to train against (absolute path) */
  baseModel: string;
  /** Output LoRA filename (without extension) */
  outputName: string;
  /** LoRA network rank (dimension) — higher = more expressive, more VRAM */
  networkRank: number;
  /** LoRA network alpha — typically same as rank */
  networkAlpha: number;
  /** Learning rate */
  learningRate: number;
  /** Text encoder learning rate (usually lower) */
  textEncoderLr: number;
  /** Number of training epochs */
  epochs: number;
  /** Batch size */
  batchSize: number;
  /** Training image resolution */
  resolution: number;
  /** Number of repeats per image per epoch */
  repeats: number;
  /** LR scheduler type */
  lrScheduler: "cosine" | "constant" | "cosine_with_restarts" | "polynomial";
  /** Save every N epochs */
  saveEveryNEpochs: number;
  /** Enable bucket resolution (multi-aspect training) */
  bucketResolution: boolean;
  /** Mixed precision mode */
  mixedPrecision: "fp16" | "bf16" | "no";
  /** Optimizer */
  optimizer: "AdamW8bit" | "AdamW" | "Lion" | "Prodigy";
  /** Gradient accumulation steps */
  gradientAccumulationSteps: number;
}

/**
 * Filesystem + process environment for a training engine instance. Injected by
 * each consumer (nhi, orson) so the engine itself stays path-agnostic.
 */
export interface LoraTrainEnv {
  /** Root holding per-collection accepted/rejected image folders */
  trainingDir: string;
  /** Where per-run dataset/log scratch dirs are written */
  runsDir: string;
  /** Where trained .safetensors LoRAs land */
  outputDir: string;
  /**
   * Working dir for the spawned `accelerate` process. kohya's sdxl_train_network.py
   * must resolve from here (i.e. the sd-scripts checkout, or a dir with it on PATH).
   */
  cwd: string;
  /** sd-scripts entry script name (default "sdxl_train_network.py") */
  trainScript?: string;
  /** accelerate binary (default "accelerate") */
  accelerateBin?: string;
}

/**
 * Hardware-tuned defaults for an 8GB card (RTX 3070) + ~65-image style LoRA on
 * SDXL. `baseModel`, `name`, `collection`, and `outputName` are consumer-supplied.
 */
export const DEFAULT_TRAINING_CONFIG: Omit<
  TrainingConfig,
  "name" | "collection" | "outputName" | "baseModel"
> = {
  networkRank: 16, // 16 is plenty for a style LoRA; lower than 32 also saves a little VRAM
  networkAlpha: 16,
  learningRate: 1e-4,
  textEncoderLr: 5e-5, // unused at train time (TE outputs are cached/frozen for VRAM) — kept for reference
  epochs: 8,
  batchSize: 1,
  resolution: 768, // 1024 OOMs on 8GB; 768 is the realistic ceiling for a 3070
  repeats: 5, // 65 imgs * 5 * 8 epochs = 2600 steps — sane for a style LoRA
  lrScheduler: "cosine",
  saveEveryNEpochs: 2,
  bucketResolution: true,
  mixedPrecision: "bf16",
  optimizer: "AdamW8bit",
  gradientAccumulationSteps: 1,
};

export interface TrainingRun {
  id: string;
  config: TrainingConfig;
  status: "preparing" | "training" | "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  currentEpoch?: number;
  currentStep?: number;
  totalSteps?: number;
  lastLoss?: number;
  logPath?: string;
  outputPath?: string;
  error?: string;
}
