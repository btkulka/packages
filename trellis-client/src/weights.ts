// The TRELLIS.2 weights a ComfyUI 0.45+ needs for its built-in TRELLIS.2 nodes, where they go under models/, and
// how to fetch them (Hugging Face, resumed: the CDN's signed links expire mid-file, so every attempt resumes).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { findExecutable } from "@btkulka/proc-kit";

export interface WeightFile {
  /** Folder under ComfyUI's models/. */
  folder: string;
  file: string;
  /** Hugging Face repo and the path inside it. */
  repo: string;
  inRepo: string;
  /** Approximate size, to tell a finished download from a partial one. */
  bytes: number;
}

export const TRELLIS2_WEIGHTS: WeightFile[] = [
  { folder: "diffusion_models", file: "trellis_2_int8_convrot.safetensors", repo: "Comfy-Org/TRELLIS.2", inRepo: "diffusion_models/trellis_2_int8_convrot.safetensors", bytes: 5.25e9 },
  { folder: "vae", file: "trellis_2_shape_vae_bf16.safetensors", repo: "Comfy-Org/TRELLIS.2", inRepo: "vae/trellis_2_shape_vae_bf16.safetensors", bytes: 1.1e9 },
  { folder: "vae", file: "trellis_2_texture_vae_bf16.safetensors", repo: "Comfy-Org/TRELLIS.2", inRepo: "vae/trellis_2_texture_vae_bf16.safetensors", bytes: 0.95e9 },
  { folder: "clip_vision", file: "dino_v3_L_naf_fp32.safetensors", repo: "Comfy-Org/Pixal3D", inRepo: "clip_vision/dino_v3_L_naf_fp32.safetensors", bytes: 1.22e9 },
  { folder: "background_removal", file: "birefnet.safetensors", repo: "Comfy-Org/BiRefNet", inRepo: "background_removal/birefnet.safetensors", bytes: 0.44e9 },
];

/** What Pixal3D adds to TRELLIS.2's set: its own model and MoGe (monocular geometry) for the pixel-aligned conditioning. */
export const PIXAL3D_WEIGHTS: WeightFile[] = [
  { folder: "diffusion_models", file: "pixal3d_int8_convrot.safetensors", repo: "Comfy-Org/Pixal3D", inRepo: "diffusion_models/pixal3d_int8_convrot.safetensors", bytes: 5.58e9 },
  { folder: "geometry_estimation", file: "moge_2_vitl_normal_fp16.safetensors", repo: "Comfy-Org/MoGe", inRepo: "geometry_estimation/moge_2_vitl_normal_fp16.safetensors", bytes: 0.66e9 },
];

export interface WeightStatus {
  file: WeightFile;
  path: string;
  /** Bytes on disk (0 when missing or still downloading). */
  have: number;
  ok: boolean;
  /** A download in progress or abandoned (an .aria2 or .part file beside it). */
  partial: boolean;
}

/** What is on disk under `<comfyDir>/models`. Nothing is downloaded. */
export function checkWeights(comfyDir: string, files: WeightFile[] = TRELLIS2_WEIGHTS): WeightStatus[] {
  return files.map((file) => {
    const dest = path.join(comfyDir, "models", file.folder, file.file);
    const partial = fs.existsSync(`${dest}.aria2`) || fs.existsSync(`${dest}.part`);
    const have = fs.existsSync(dest) && !partial ? fs.statSync(dest).size : 0;
    return { file, path: dest, have, ok: have > file.bytes * 0.98, partial };
  });
}

export interface DownloadOptions {
  files?: WeightFile[];
  /** Attempts per file, each resuming (default 12). */
  attempts?: number;
  /** Seconds between attempts (default 20). */
  retryWaitS?: number;
  onLog?: (line: string) => void;
  /** Use curl even when aria2c is on the PATH. */
  noAria?: boolean;
}

function run(cmd: string, args: string[], onLog?: (line: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const relay = (chunk: Buffer) => {
      if (!onLog) return;
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) onLog(line);
    };
    child.stdout?.on("data", relay);
    child.stderr?.on("data", relay);
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * Download what `checkWeights` says is missing, resuming partial files, with aria2c when it is on the PATH (two
 * connections, no preallocation) and curl otherwise. Returns the status afterwards; a file that still failed is
 * reported `ok: false` rather than thrown, so the caller can say which.
 */
export async function downloadWeights(comfyDir: string, opts: DownloadOptions = {}): Promise<WeightStatus[]> {
  const files = opts.files ?? TRELLIS2_WEIGHTS;
  const aria = opts.noAria ? null : findExecutable("aria2c");
  const curl = findExecutable("curl");
  const attempts = opts.attempts ?? 12;
  for (const st of checkWeights(comfyDir, files)) {
    if (st.ok) continue;
    const dir = path.dirname(st.path);
    fs.mkdirSync(dir, { recursive: true });
    const url = `https://huggingface.co/${st.file.repo}/resolve/main/${st.file.inRepo}`;
    opts.onLog?.(`${st.partial ? "resuming" : "fetching"} ${st.file.folder}/${st.file.file} (${(st.file.bytes / 1e9).toFixed(2)} GB)`);
    let status = 1;
    for (let attempt = 1; attempt <= attempts && status !== 0; attempt++) {
      if (attempt > 1) {
        opts.onLog?.(`  retrying (${attempt}/${attempts}) in ${opts.retryWaitS ?? 20} s`);
        await new Promise((r) => setTimeout(r, (opts.retryWaitS ?? 20) * 1000));
      }
      if (aria) {
        status = await run(aria, ["-c", "-x", "2", "-s", "2", "--max-tries=5", "--retry-wait=10", "--file-allocation=none", "--summary-interval=120", "--console-log-level=warn", "-d", dir, "-o", st.file.file, url], opts.onLog);
      } else if (curl) {
        status = await run(curl, ["-L", "-C", "-", "--retry", "20", "--retry-delay", "5", "-o", st.path, url], opts.onLog);
      } else {
        opts.onLog?.("neither aria2c nor curl is on the PATH");
        break;
      }
    }
  }
  return checkWeights(comfyDir, files);
}

/**
 * Point the dedicated ComfyUI at another install's models (the SDXL checkpoint that draws concept images) by
 * writing its `extra_model_paths.yaml`, unless one already exists. Returns the file written, or null.
 */
export function writeExtraModelPaths(comfyDir: string, sharedModelsDir: string): string | null {
  const file = path.join(comfyDir, "extra_model_paths.yaml");
  if (fs.existsSync(file) || !fs.existsSync(sharedModelsDir)) return null;
  const base = sharedModelsDir.replace(/\\/g, "/");
  fs.writeFileSync(file, `# Written by @btkulka/trellis-client\nshared:\n  base_path: ${base}\n  checkpoints: checkpoints\n  vae: vae\n  loras: loras\n`);
  return file;
}
