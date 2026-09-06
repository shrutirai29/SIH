# Client Inference Metrics — NETRA

Auto-updated manually for now; regenerate on every model change (RULES.md F2).

## Face Detection — BlazeFace short-range (float16)

| Delegate | Device | Latency (single frame) | Faces detected | Confidence |
|---|---|---|---|---|
| WebGPU | Intel Arc iGPU (Samsung Galaxy Book4 Pro) | 8.2 ms | 1 | 95% |
| WASM (CPU) | Intel Arc iGPU (Samsung Galaxy Book4 Pro) | TBD | TBD | TBD |

**Test setup**: `@mediapipe/tasks-vision@0.10.14`, `blaze_face_short_range` (float16), single face, webcam input, measured via `performance.now()` around `detectForVideo()`, browser: Chrome.

**Notes**:
- WebGPU delegate succeeded on first attempt — no fallback needed on this device.
- This satisfies the Week-1 MLC deliverable (TEAM-ROLES.md §R3): "BlazeFace running in the offscreen document on WebGPU with a measured latency number."
- Device class: **B** (modern iGPU, no discrete GPU) per the classification in ARCHITECTURE.md §5.1.
- Budget check: well under the 450ms Tier-2 local budget for device class B (ARCHITECTURE.md §5.1) — face detection alone uses under 2% of that budget.