# PRAHARI

**P**rivacy-**R**especting **A**gentic **H**ybrid **A**ssistant for **R**edacted **I**nteraction

> *The server sees the shape of your screen, never its secrets.*

A browser extension plus a redaction-aware server that lets a powerful cloud VLM drive a browser agent **without the cloud ever seeing your private data**.

**Smart India Hackathon 2026 · Software Edition** · [Problem statement](./problem%20statment.txt)

---

## The idea in one picture

```
   YOUR LAPTOP                    │              THE SERVER
   ────────────────────────────── │ ──────────────────────────────
   NETRA  reads the screen        │
     DOM + accessibility tree     │
     + local ViT / YOLO / OCR     │
              ↓                   │
   KAVACH detects & redacts       │
     Aadhaar → ⟦AADHAAR_1⟧        │
     face    → blurred            │
     password→ blacked out        │
              ↓                   │
   EGRESS GUARD (8 checks) ═══════╪═══► MANTRI reasons over the
     6 KB of sanitized JSON       │       sanitized screen
              ↑                   │       (Qwen3-VL, open weights)
   HASTA executes ◄═══════════════╪═════ "type ⟦AADHAAR_1⟧ into e17"
     resolves the token LOCALLY   │
     types the real 12 digits     │       ← never knew the digits
```

The server plans with a **reference**. Only your laptop can resolve it — and only into the exact field it came from.

---

## Documents

Read in this order.

| # | Document | What's in it |
|---|---|---|
| 1 | **[CONTEXT.md](./CONTEXT.md)** | Problem decoded, prior art, 2026 tech landscape, vocabulary, PII taxonomy, DPDP mapping. **Start here.** |
| 2 | **[SOLUTION-SPACE.md](./SOLUTION-SPACE.md)** | Tree-of-thought over every architecture branch; the full feature catalogue ranked by value/day; what we rejected and why |
| 3 | **[PRD.md](./PRD.md)** | Users, scope, functional spec, NFR targets, success metrics, key decisions, risks, release criteria |
| 4 | **[ARCHITECTURE.md](./ARCHITECTURE.md)** | Trust boundaries, browser execution contexts, KAVACH's five stages, the SETU wire contract, server design, failure modes |
| 5 | **[PIPELINE.md](./PIPELINE.md)** | The ten per-step stages in microscopic detail, with the latency budget and the trade-off tables |
| 6 | **[IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md)** | Stack, repo layout, JSON schemas, module interfaces, API, and the full ticket backlog (~92 P0 person-days) |
| 7 | **[TEAM-ROLES.md](./TEAM-ROLES.md)** | Six role charters, RACI, interface ownership, working agreements, judge-facing speaking split |
| 8 | **[RULES.md](./RULES.md)** | The non-negotiable invariants — privacy, security, cross-browser, performance, testing, and rules for AI assistants |
| 9 | **[PHASEWISE.md](./PHASEWISE.md)** | Eight phases with hard exit criteria, the 36-hour finale plan, the 8-beat demo script, and a 72-hour fast path |

---

## The four things that make this different

1. **Redaction is an encoding, not a deletion.** `⟦AADHAAR_1⟧` is a typed, coreferent reference. The server reasons perfectly over it; the client holds the only decoder. Privacy stops trading off against capability.
2. **Sink binding.** A token can only be resolved back into the element it came from. This defeats the attack where an injected instruction makes the agent type your Aadhaar into an attacker's search box.
3. **The claim is falsifiable, live.** A byte-accurate "what the server saw" diff, a hash-chained privacy ledger that records what was *offered* and what actually *left*, and a canary audit that plants identifiers in your page and runs the real pipeline over them, on stage. Each number names the component it measures — and each one is able to come back red.
4. **The trade-off is measured, not asserted.** An adaptive tier ladder (nothing / 6 KB JSON / 55 KB redacted image) with published ablations: **2.4× faster than always-send-pixels, at 2 points of task success, at zero leakage.**

---

## Headline **targets**

Design targets from `PRD.md §8`, not measurements. Latency has never been measured
(ticket H6), and the task-success suite does not exist yet (H4). The numbers we have
actually measured are in `docs/metrics/` and in the status section below.

| | Naive cloud agent | PRAHARI (target) |
|---|---|---|
| Sensitive items transmitted per task | ~18 | **0** |
| Bytes per step | ~180 KB | **6 KB** (Tier 1) / **55 KB** (Tier 2) |
| p50 step latency | 2.2 s | **1.0 s** |
| Task success rate (40-task suite) | 78 % | **≥ 75 %** |
| Canary leak rate | 100 % | **0** |

---

## Stack at a glance

**Client** — TypeScript · Vite · React 19 · MV3 (Chrome) + event page (Firefox) · ONNX Runtime Web (WebGPU → WASM) · Transformers.js · BlazeFace · YOLO on WebUI+Rico · PP-OCRv5 · GLiNER-PII · Florence-2 (optional)

**Server** — Python 3.12 · FastAPI · vLLM · **Qwen3-VL-8B-Instruct** (open weights, offline-deployable) · XGrammar guided decoding · Redis · OpenTelemetry

**Everything the server runs is open-weights and ships as a `docker compose` that works air-gapped** — verified nightly on a network-isolated CI runner.

---

## Component names

| Name | Meaning | Role |
|---|---|---|
| **NETRA** | *eye* | On-device perception: capture, detect, classify, ground |
| **KAVACH** | *armour* | On-device privacy: detect → policy → redact → vault → egress guard |
| **SETU** | *bridge* | The wire contract: Sanitized Screen Graph + Action Plan |
| **MANTRI** | *counsellor* | Server-side planner (the remote VLM) |
| **HASTA** | *hand* | Client-side action executor |
| **LEKHA** | *record* | The privacy ledger |

---

## Status

🔨 **Building.** The loop runs end to end on Chrome and Firefox; the vault with sink
binding works; the live canary audit reports **0 / 12 PII canaries leaked** and
**45 / 45 required surfaces read**, measured by running the real extraction pipeline
over a page it has just planted. No vision model and no real server yet.

168 unit + 9 browser + 49 server tests. `pnpm verify` is the gate and is self-contained.

Three of the twelve canary surfaces — CSS generated content, cross-frame text, canvas
pixels — honestly report **0 observed**: nothing reads them yet. That gap is in the
report on purpose. `TODO.md §3` is the canonical list of what must not be claimed.

- **[START-HERE.md](./START-HERE.md)** — entry point for a new session or teammate. **Start here.**
- **[TODO.md](./TODO.md)** — live ticket board, blockers, and what must not be claimed
- **[QUICKSTART.md](./QUICKSTART.md)** — running in five minutes.
- **[docs/adr/](./docs/adr/)** — decisions and deviations from the plan.
