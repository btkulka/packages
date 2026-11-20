// The run record: meshy-<stamp>.json in the out folder, what toejam's Spend page reads (toejam/spend.py). Written
// as soon as the first task is created and again as each one moves, so a run that is killed still says what it
// spent. Each job names its task; a task picked up again by a later run is marked `resumed` there, so its credits
// count once (with the run that created it).

import { rename, writeFile } from "node:fs/promises";
import { usdOf } from "../pricing.js";

export const RECORD_KIND = "meshy-run";
export const RECORD_TOOL = "@btkulka/meshy-client meshy-3d";

export interface RunJob {
  name: string;
  /** The files' stem: name, or name-textured. */
  base: string;
  task: string;
  image: string;
  aiModel: string;
  modelType: "standard" | "smart-topology";
  textured: boolean;
  /** Meshy's status as last seen (SUCCEEDED, FAILED, IN_PROGRESS…). */
  status: string;
  /** What the task used: Meshy's consumed_credits once it said, the table's estimate before; 0 once it FAILED (refunded). */
  credits: number;
  /** credits is still the table's estimate. */
  estimated: boolean;
  /** Created by an earlier run and picked up by this one: its credits belong to that run's record. */
  resumed?: boolean;
  usd?: number;
  secs?: number;
  files: string[];
  error?: string;
}

export interface MeshyRunRecord {
  kind: typeof RECORD_KIND;
  tool: typeof RECORD_TOOL;
  /** ISO times: the run's start, and its end (or the last update while it runs). */
  start: string;
  end: string;
  secs: number;
  /** The run is still going (or was killed before it could say otherwise). */
  running: boolean;
  /** Credits this run spent: its own tasks' (resumed ones not counted; failed ones 0, refunded). */
  credits: number;
  /** Some of credits is still the table's estimate. */
  estimated: boolean;
  /** Dollars a credit, when the run was given a rate (Meshy states none); null: credits only. */
  usdPerCredit: number | null;
  /** credits at usdPerCredit; null without a rate. */
  usd: number | null;
  balanceBefore?: number;
  balanceAfter?: number;
  /** Every job made its model and nothing stopped the run. */
  ok: boolean;
  /** Why the run stopped early, when it did. */
  error?: string;
  /** The models made, by name. */
  models: string[];
  jobs: RunJob[];
  failures: { name: string; error: string }[];
}

/** The record's file name for a run that started at `start`: meshy-20261119T031500Z.json (an ISO time a file name can hold). */
export function runRecordName(start: number | Date): string {
  return `meshy-${new Date(start).toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "")}.json`;
}

export function newRecord(start: number, usdPerCredit: number | undefined, balanceBefore: number | undefined): MeshyRunRecord {
  const iso = new Date(start).toISOString();
  return {
    kind: RECORD_KIND,
    tool: RECORD_TOOL,
    start: iso,
    end: iso,
    secs: 0,
    running: true,
    credits: 0,
    estimated: false,
    usdPerCredit: usdPerCredit ?? null,
    usd: null,
    ...(balanceBefore === undefined ? {} : { balanceBefore }),
    ok: true,
    models: [],
    jobs: [],
    failures: [],
  };
}

/** The totals worked out again from the jobs, as of `now`. */
export function settle(r: MeshyRunRecord, now: number): MeshyRunRecord {
  const own = r.jobs.filter((j) => !j.resumed);
  for (const j of r.jobs) {
    const usd = usdOf(j.credits, r.usdPerCredit);
    if (usd === undefined) delete j.usd;
    else j.usd = usd;
  }
  r.credits = own.reduce((s, j) => s + j.credits, 0);
  r.estimated = own.some((j) => j.estimated);
  r.usd = usdOf(r.credits, r.usdPerCredit) ?? null;
  r.end = new Date(now).toISOString();
  r.secs = Math.max(0, Math.round((now - Date.parse(r.start)) / 1000));
  r.models = r.jobs.filter((j) => j.status === "SUCCEEDED" && j.files.length).map((j) => j.base);
  r.ok = !r.error && !r.failures.length;
  return r;
}

/** Writes the record (through a .part file, so a reader never sees half of it). */
export async function writeRunRecord(file: string, record: MeshyRunRecord): Promise<void> {
  await writeFile(`${file}.part`, JSON.stringify(record, null, 1) + "\n");
  await rename(`${file}.part`, file);
}
