# Test report — §15 product-image upload & compression (imgpipe_v1)

- QA task: t_0595a9ba (acceptance suite for t_fd20d685's implementation)
- Contract source: `use_cases.md` §15 (contract_version `imgpipe_v1`)
- Tree under test: branch `feature/img-compress-t-fd20d685` @ e8508c0 (base 2295fdf)
- Harness: repo pytest suite, real FastAPI app via TestClient (in-process ASGI)
- Env: python 3.9.6 venv, Pillow 11.3.0, `features.check("webp")` True
- Suite file: `tests/test_img_upload_acceptance.py` (16 checks, seed-fixed fixtures built in-file per the §15.4 re-anchor caveat — no stale 10 MiB-gate inputs)

## Result: PASS — 16/16 acceptance checks green; full battery 270 passed + 1 skipped (baseline parity 254+1, zero regressions)

## Fixture classes (task-mandated, all built seed-fixed in the suite)
- small: real JPEG (~25-60 KB, under P2) + real WebP — passthrough/already-compressed class
- oversized: 26 MiB JPEG-magic blob (over the P1 gate) + seed-fixed 4032×3024 camera-like JPEG (decodable, strictly inside the (P2, P1) window)
- unsupported: plain-text bytes, real GIF (both classes, incl. under-P2 GIF to pin step-2-before-step-3 ordering)
- corrupt: real JPEG cut mid-scan — over P2 (must 415) and under P2 (must passthrough, pinned)
- already-compressed: the small JPEG/WebP are themselves this class (byte-identity asserted)

## Checks and verdicts
| # | §15.8 | Check | Verdict |
|---|---|---|---|
| 1 | F-413 | 26 MiB → 413 PAYLOAD_TOO_LARGE, canonical 25.0 MB message verbatim, NO file written, doc intact | PASS |
| 2 | F-sniff | text-as-jpeg → 415 (sniff beats header; closes the old validation.py hole); GIF → 415 both declared and undeclared types | PASS |
| 3 | F-passthrough | small JPEG → 200, stored byte-identical (disk + GET parity), mime stays image/jpeg, pipeline/original_size keys present | PASS |
| 4 | F-passthrough (webp) | small WebP → 200, original container kept, GET byte-identical (§15.4 stored-artifact rule) | PASS |
| 5 | F-big/F-phone | camera-like (in-window, >P2) → 200; stored ≤307 200 B (was ~288 KB for the sibling fixture, ~34:1); decodable; image/webp; long-edge clamped ≤2048; ratio ≥20:1 asserted with margin; GET serves stored bytes | PASS |
| 6 | F-fail (endpoint) | SOLIN_IMG_MAX_STORED_BYTES=1024 → 422 IMAGE_COMPRESS_FAILED, canonical message, nothing stored, product still usable | PASS |
| 7 | F-fail (unit) | compress_image never stores larger: corrupt input raises ImageDecodeError; camera-like input shrinks; stored container RIFF | PASS |
| 8 | F-kill | SOLIN_IMG_COMPRESS=false → byte-exact storage of camera-like upload, declared mime trusted (pre-§15 control); 413 gate still reads SOLIN_IMG_MAX_UPLOAD_BYTES | PASS |
| 9 | F-log | exactly ONE solin.media `upload ` line per attempt (4/4 through HTTP); keys original_bytes/stored_bytes/mode/q/outcome/dur_ms/sha1_8 all present; outcomes stored/stored/too_large/bad_type exact; empty-body and bad-slot requests stay SILENT (attempt-definition pinned); no paths/secrets in lines | PASS |
| 10 | F-slot | re-upload replaces (old leaf gone from disk AND slot JSON); DELETE cascades BOTH slot dirs; slot-dir single-file invariant across doc edits | PASS |
| 11 | task clause "product creation usable after compression" | POST create → compress upload → GET doc (slot populated, keys intact) → PUT echoing the §15.4 ImageSlot object back (validate_image_body accepts original_size+pipeline) → macronutrient block survives → GET url still streams stored artifact | PASS |
| 12 | undeclared-type parity | octet-stream + empty declared types TRUST the sniff (SPA FormData default unaffected; dev decision pinned as a test) | PASS |

## Methodology
- Endpoint-level through the real app (status codes + C8 body shape + canonical strings verbatim + StaticFiles mount parity), service seam only where §15.8 pins unit proof.
- Fresh service per test (temp store + media root repointed to the captured mount → upload/fetch parity).
- Effective caps flipped through the `_settings()` seam (monkeypatched Settings), no process env needed.
- Iteration log (honesty trail): first run 14/16 — two reds traced to MY fixture builder (the "corrupt" fixture slice landed at whole-file length, so the payload was valid, not corrupt). Fixture fixed to cut mid-scan; re-ran → 16/16. No product-code defect found; nothing was downgraded or skipped to reach green.

## Observations (non-blocking)
- O1: corrupt payloads UNDER P2 store byte-identical by pinned design (passthrough skips decode, §15.2 step 3 before step 4). Pinned by `test_fcorrupt_under_target_stores_byte_identical` so a future refactor cannot flip it silently.
- O2: §15.8 #5's "label text legible at 2× zoom" is a product/visual judgment, not machine-decidable here; stored artifact verified decodable + clamped. Legibility floor is the pinned ladder (82,72,62,52) — escalate to the designer only if a ticket disputes legibility.
- O3: branch still NOT pushed (delivery rule: staging promotion via PR only). This suite is committed on top of e8508c0.
