# meshy-client

The Meshy 3D API (image to 3D) for Ben's apps, a Benhäus credential adapter (`package.json` › `benhaus.credential`, credential id `meshy`), and the `meshy-3d` CLI. README.md is the reference.

Started 2026-11-19 from a Claude Code session; this file is the brief and the state.

## Brief
What Ben said:
> let's create a meshy adapter and work through there

He is replacing the unreliable rented-GPU Pixal3D pipeline (`trellis-client rent`) with Meshy for 3D models from concept images, for the TouchDesigner piece toejam/pieces/skyline. The session was told: modelled on gemini-client (credential block, http-kit, errors, pricing, a CLI that prints the price first and spends nothing without `--yes`, a sidecar per output) and trellis-client (a run record for spend tracking); options ai_model, should_texture (default false: his shaders do the colour), topology, target_polycount, should_remesh, symmetry and pose, enable_pbr; `--concurrency` default 4; key from Benhäus `meshy` (field apiKey, env MESHY_API_KEY); toejam's Spend page to count the run records. No credits spent while building (no key yet: Ben is making the account).

## What Meshy's docs said on 2026-11-19 (read, not remembered)
docs.meshy.ai/api/image-to-3d, /api/pricing, /api/balance, /api/authentication, /api/errors, /api/rate-limits, /api/quick-start, /api/changelog, and meshy.ai/pricing:
- `POST /openapi/v1/image-to-3d` takes `image_url` as a public URL or a data URI; answers `{ result: id }`. `latest` = meshy-7.1 (2026-09-18); meshy-7 retires 2026-12-31; Smart Topology (`model_type: smart-topology`, meshy-t2 / meshy-t2.5) replaced lowpoly / meshy-t1. `should_texture` defaults to true at Meshy. `symmetry_mode` is deprecated with no effect.
- Credits: 20 mesh / 30 textured (latest, meshy-6), 5 / 15 (meshy-6-lite, t2, t2.5), 8K +5, Ultra geometry +5 (7.1 only). No charge listed for PBR or remesh. Failed tasks refunded (`consumed_credits` 0).
- No dollar price per credit anywhere; plans Pro $20/1,000, Premium $40/3,000, Studio $70/5,500, Ultra $100/8,000 a month; API needs a paid plan.
- The shared test-mode key (`msy_dummy_api_key_for_test_mode_12345678`) was retired 2026-09-16: it answers 401. So no live generation test exists; `MESHY_LIVE=1` reads the (free) balance only.
- Polls get `Retry-After` while a task runs; 20 requests a second; 10 concurrent tasks on Pro.

## State
Built 2026-11-19, nothing sent to Meshy: `src/client.ts` (http-kit; Bearer key to api.meshy.ai only; downloads without it), `src/image-to-3d.ts` (body builder with the docs' constraints, create / get / wait / list / delete / generate), `src/errors.ts`, `src/pricing.ts` (credit table, plans), `src/bytes.ts`, `src/key.ts` (subpath `./key`, Node only), the CLI in `src/cli` (`jobs.ts`, `record.ts`, `run.ts` with injected IO, `meshy-3d.ts` the bin). 38 tests on a fake Meshy, all passing (one live test skipped). toejam/toejam/spend.py counts `meshy-<stamp>.json` records, each task once.

Decisions: mesh only by default; `create` retries only a 429; topology or polycount turn remeshing on for standard models; glb always among the formats; `<name>-textured.meta.json` for a textured model so it doesn't overwrite the mesh-only one's; dollars only with `--usd-per-credit` (a number or a plan); the run record is written progressively, and a picked-up task is `resumed` there so spend counts it once.

Unverified until the first paid run: the exact shape of a live task (the docs' examples were followed), whether `consumed_credits` is set while PENDING (the CLI keeps the estimate until it is), texture file extensions in `texture_urls`, and the real time a task takes. Next: Ben adds the key (`meshy`) in Benhäus and presses Test, then one `--dry-run` and one mesh-only model with `--yes`; this file and the README get what that run shows.
