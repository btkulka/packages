import fs from "fs";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import { nanoid } from "nanoid";
import { TrainingConfig, TrainingRun, LoraTrainEnv } from "./types.js";

// In-memory tracking of the active run. One trainer at a time per process.
let activeRun: TrainingRun | null = null;
let activeProcess: ChildProcess | null = null;

export function getActiveRun(): TrainingRun | null {
  return activeRun;
}

/**
 * Prepare dataset for training:
 * - Copy accepted images from collection into a kohya-compatible folder structure
 * - Generate/verify caption files
 * - Return the dataset path
 */
export function prepareDataset(
  env: LoraTrainEnv,
  config: TrainingConfig
): {
  datasetPath: string;
  imageCount: number;
  captions: { filename: string; caption: string; hasCaption: boolean }[];
} {
  const collPath = path.join(env.trainingDir, config.collection, "accepted");
  if (!fs.existsSync(collPath)) {
    throw new Error(`No accepted images in collection "${config.collection}"`);
  }

  const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);
  const images = fs.readdirSync(collPath).filter((f) =>
    IMAGE_EXTS.has(path.extname(f).toLowerCase())
  );

  if (images.length === 0) {
    throw new Error("No accepted images found in collection");
  }

  // Create dataset directory: <runsDir>/<id>/img/<repeats>_<name>/
  const runId = nanoid(8);
  const runDir = path.join(env.runsDir, runId);
  const imgDirName = `${config.repeats}_${config.outputName}`;
  const imgDir = path.join(runDir, "img", imgDirName);

  fs.mkdirSync(imgDir, { recursive: true });

  // Copy images and check for captions
  const captions: { filename: string; caption: string; hasCaption: boolean }[] = [];

  for (const img of images) {
    const src = path.join(collPath, img);
    const dest = path.join(imgDir, img);
    fs.copyFileSync(src, dest);

    // Check for existing caption file
    const captionName = img.replace(/\.[^.]+$/, ".txt");
    const captionPath = path.join(collPath, captionName);
    const destCaptionPath = path.join(imgDir, captionName);

    if (fs.existsSync(captionPath)) {
      fs.copyFileSync(captionPath, destCaptionPath);
      captions.push({
        filename: img,
        caption: fs.readFileSync(captionPath, "utf-8").trim(),
        hasCaption: true,
      });
    } else {
      // Create a default caption
      const defaultCaption = config.outputName.replace(/[-_]/g, " ");
      fs.writeFileSync(destCaptionPath, defaultCaption, "utf-8");
      captions.push({
        filename: img,
        caption: defaultCaption,
        hasCaption: false,
      });
    }
  }

  return { datasetPath: runDir, imageCount: images.length, captions };
}

/**
 * Update a caption file in both the dataset and the source collection
 */
export function updateCaption(
  env: LoraTrainEnv,
  collection: string,
  datasetPath: string,
  imageFilename: string,
  caption: string
) {
  const captionName = imageFilename.replace(/\.[^.]+$/, ".txt");

  // Update in dataset
  const datasetImgDirs = fs.readdirSync(path.join(datasetPath, "img"));
  for (const dir of datasetImgDirs) {
    const p = path.join(datasetPath, "img", dir, captionName);
    if (fs.existsSync(p) || fs.existsSync(path.join(datasetPath, "img", dir, imageFilename))) {
      fs.writeFileSync(p, caption, "utf-8");
    }
  }

  // Also save back to collection's accepted folder
  const collCaptionPath = path.join(env.trainingDir, collection, "accepted", captionName);
  fs.writeFileSync(collCaptionPath, caption, "utf-8");
}

/**
 * Start a training run using kohya_ss sd-scripts
 */
export function startTraining(
  env: LoraTrainEnv,
  config: TrainingConfig,
  datasetPath: string
): TrainingRun {
  if (activeRun && activeRun.status === "training") {
    throw new Error("A training run is already in progress");
  }

  const runId = path.basename(datasetPath);
  const outputDir = path.join(env.outputDir, config.outputName);
  const logFile = path.join(datasetPath, "training.log");

  fs.mkdirSync(outputDir, { recursive: true });

  const run: TrainingRun = {
    id: runId,
    config,
    status: "training",
    startedAt: new Date().toISOString(),
    logPath: logFile,
    outputPath: outputDir,
  };

  // Build kohya_ss command
  // This assumes kohya_ss / sd-scripts is installed and `accelerate` is available
  const args = [
    env.trainScript ?? "sdxl_train_network.py",
    `--pretrained_model_name_or_path=${config.baseModel}`,
    `--train_data_dir=${path.join(datasetPath, "img")}`,
    `--output_dir=${outputDir}`,
    `--output_name=${config.outputName}`,
    "--network_module=networks.lora",
    `--network_dim=${config.networkRank}`,
    `--network_alpha=${config.networkAlpha}`,
    `--learning_rate=${config.learningRate}`,
    // NOTE: --text_encoder_lr is intentionally omitted below. We cache text-encoder
    // outputs (--cache_text_encoder_outputs) to save VRAM on 8GB cards, which freezes
    // the text encoders — passing a TE learning rate alongside caching makes kohya error.
    `--max_train_epochs=${config.epochs}`,
    `--train_batch_size=${config.batchSize}`,
    `--resolution=${config.resolution}`,
    `--lr_scheduler=${config.lrScheduler}`,
    `--save_every_n_epochs=${config.saveEveryNEpochs}`,
    `--mixed_precision=${config.mixedPrecision}`,
    `--gradient_accumulation_steps=${config.gradientAccumulationSteps}`,
    "--save_model_as=safetensors",
    "--cache_latents",
    "--cache_latents_to_disk",
    "--no_half_vae",
    "--logging_dir=logs",
    "--log_prefix=lora-train",
    // Low-VRAM flags — required to fit SDXL LoRA training on an 8GB card (e.g. RTX 3070).
    // gradient_checkpointing trades compute for memory (biggest saver);
    // cache_text_encoder_outputs frees the text encoders during the training loop;
    // xformers gives memory-efficient attention. Without these, SDXL training OOMs on 8GB.
    "--gradient_checkpointing",
    "--cache_text_encoder_outputs",
    "--cache_text_encoder_outputs_to_disk",
    // Caching TE outputs freezes the text encoders, so the LoRA must train the UNet only
    // (kohya asserts this). UNet-only is a fine, common choice for a style LoRA anyway.
    "--network_train_unet_only",
    // Our captions are .txt files; kohya defaults to .caption and would silently ignore
    // them, falling back to the folder's class token. This makes it use the real captions.
    "--caption_extension=.txt",
    // Use PyTorch's built-in memory-efficient attention (SDPA) rather than xformers.
    // xformers has no prebuilt wheel for this Python/torch combo and fails to build from
    // source on Windows; --sdpa ships with torch 2.x and is comparably VRAM-efficient.
    "--sdpa",
  ];

  if (config.bucketResolution) {
    args.push("--enable_bucket");
    args.push("--min_bucket_reso=256");
    // Cap buckets near the training resolution. Leaving this at 2048 while training at
    // 768 would let kohya build 2048px buckets that OOM an 8GB card.
    args.push(`--max_bucket_reso=${Math.max(config.resolution, 1024)}`);
  }

  if (config.optimizer === "AdamW8bit") {
    args.push("--optimizer_type=AdamW8bit");
  } else if (config.optimizer === "Prodigy") {
    args.push("--optimizer_type=prodigy");
    args.push("--optimizer_args", "decouple=True", "weight_decay=0.01");
  } else if (config.optimizer === "Lion") {
    args.push("--optimizer_type=Lion");
  } else {
    args.push("--optimizer_type=AdamW");
  }

  const logStream = fs.createWriteStream(logFile, { flags: "a" });

  // Explicit accelerate launch flags that pin training to the GPU. Without these,
  // accelerate reads ~/.cache/huggingface/accelerate/default_config.yaml — which may
  // contain `use_cpu: true` and silently force CPU training (catastrophically slow).
  const accelerateFlags = [
    "launch",
    "--num_processes=1",
    "--num_machines=1",
    "--gpu_ids=0",
    `--mixed_precision=${config.mixedPrecision}`,
    "--dynamo_backend=no",
  ];

  const proc = spawn(env.accelerateBin ?? "accelerate", [...accelerateFlags, ...args], {
    cwd: env.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    // Force UTF-8 I/O. kohya logs Japanese strings; on Windows the default cp1252
    // console encoding throws UnicodeEncodeError and kills the run at startup.
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });

  proc.stdout?.on("data", (data: Buffer) => {
    const text = data.toString();
    logStream.write(text);

    // Parse progress from kohya output
    const stepMatch = text.match(/step\s+(\d+)\/(\d+)/i);
    if (stepMatch && activeRun) {
      activeRun.currentStep = parseInt(stepMatch[1]);
      activeRun.totalSteps = parseInt(stepMatch[2]);
    }

    const epochMatch = text.match(/epoch\s+(\d+)\/(\d+)/i);
    if (epochMatch && activeRun) {
      activeRun.currentEpoch = parseInt(epochMatch[1]);
    }

    const lossMatch = text.match(/loss[=:]\s*([\d.]+)/i);
    if (lossMatch && activeRun) {
      activeRun.lastLoss = parseFloat(lossMatch[1]);
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    logStream.write(data.toString());
  });

  proc.on("close", (code) => {
    logStream.end();
    if (activeRun) {
      activeRun.completedAt = new Date().toISOString();
      if (code === 0) {
        activeRun.status = "completed";
      } else {
        activeRun.status = "failed";
        activeRun.error = `Process exited with code ${code}`;
      }
    }
    activeProcess = null;
  });

  proc.on("error", (err) => {
    logStream.end();
    if (activeRun) {
      activeRun.status = "failed";
      activeRun.error = err.message;
      activeRun.completedAt = new Date().toISOString();
    }
    activeProcess = null;
  });

  activeRun = run;
  activeProcess = proc;

  return run;
}

/**
 * Cancel the active training run
 */
export function cancelTraining(): boolean {
  if (!activeProcess || !activeRun) return false;
  activeProcess.kill("SIGTERM");
  activeRun.status = "cancelled";
  activeRun.completedAt = new Date().toISOString();
  return true;
}

/**
 * Read the last N lines of the training log
 */
export function readTrainingLog(logPath: string, lines: number = 50): string {
  if (!fs.existsSync(logPath)) return "";
  const content = fs.readFileSync(logPath, "utf-8");
  const allLines = content.split("\n");
  return allLines.slice(-lines).join("\n");
}
