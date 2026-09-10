# TODO — PRAHARI build tracker

> **The living status file.** Update it in the same commit as the work it describes.
> Ticket IDs are from `IMPLEMENTATION-PLAN.md §8`. Phases are from `PHASEWISE.md`.
>
> Last updated: **2026-09-09** · **247 unit + 9 browser + 255 server tests green**
> (server count includes 140 MANTRI tests; see TODO-MANTRI.md)
> New here? Read **[START-HERE.md](START-HERE.md)** first.
>
> `pnpm verify` now runs green from a clean checkout with nothing else open — it starts
> its own server. It did not before; see bug #14.

---

## 1. Where the project is, in one paragraph

The agent loop runs end to end on Chrome and Firefox: the side panel takes a goal, the
content script extracts the live DOM and redacts it in place, the egress guard checks
the payload and writes a ledger entry, the server returns a plan, and HASTA executes
it. The **vault with sink binding** works, so the server can plan with `⟦AADHAAR_1⟧`
and only the user's tab can resolve it — and only into the field it came from. The
canary suite reports **0 / 12 PII canaries leaked** and **45 / 45 surfaces read**, live,
from a button — measured by running the real extractor over the planted page, not by
string-searching a synthetic payload (ADR-0004). A real FastAPI server runs
with generated Pydantic models, an ingress guard that mirrors the client's PII pack
(zero disagreements across 900 shared cases), and prompt + post-validation layers.
**Spike S-05 has run** against Qwen2.5-VL-72B: 6/7 behaviours correct, and the core
assumption — that a model can plan over references it cannot read — holds. What still
does not exist: any vision model, any screenshot path, contextual PII detection in free
prose, and a single live task completed against a real model.

**Phase status**: P0 partially (S-05 run, S-01…S-04 not) · **P1 done** · P2 not started ·
**P3 ~75%** · **P4 started** · P5–P8 not started.

---

## 2. Resume work in 60 seconds

```bash
pnpm install
pnpm verify          # contract -> typecheck -> lint -> rule proof -> unit -> build -> bundle -> browser
pnpm server          # terminal 1, real FastAPI server (needs server/.venv)
# pnpm server:mock   # or the zero-dependency Node stand-in
pnpm build           # dist-chrome/ and dist-firefox/
```

Load `packages/extension/dist-chrome` unpacked, open
`packages/eval/fixtures/demo-portal.html`, open the side panel, type a goal, hit Run.
Full walkthrough: `QUICKSTART.md`.

**`pnpm verify` is the merge gate.** If it is red, fixing it outranks everything else.

---

## 3. What must NOT be claimed yet

Keep this section honest; it is what stops a demo becoming a lie (`RULES.md §12`).

- ❌ **Contextual PII is not detected.** Names, addresses, health conditions and
  employers pass through untouched. Needs L2 NER (**C10**).
- ❌ **No vision model runs.** Nothing "reads the screen" yet — extraction is DOM-only.
  R2 of the problem statement is *not* satisfied.
- ❌ **No pixels are ever sent or redacted.** Tier 2 does not exist; faces are not
  blurred.
- ❌ **The loop has never completed a live task against a real model.** S-05 proved a
  model reasons correctly over references *in isolation*, one SSG at a time. The
  extension has still only ever talked to the Node mock, which returns a hard-coded
  plan and which `RULES.md D5` forbids from a demo. Do not claim the hybrid works end
  to end until it has.
- ⚠️ **Prompt-level injection defence FAILED in S-05.** The model followed an injected
  instruction. The client's sink binding refused it, so the correct claim is *"the
  attack succeeds against the model and is stopped by the client"* — never "we are
  resistant to prompt injection".
- ❌ **Schema validity is not 100%.** That figure assumes vLLM + XGrammar. On a cloud
  endpoint we measure it (`/v1/metrics`) and quote the measurement.
- ❌ **The tier controller is fixed at 1.** `chooseTier` returns a constant and says so
  in its own docstring and in the UI.
- ⚠️ Say **"we have not observed a leak on our canary suite"**, never "leaks are
  impossible".
- ⚠️ **The canary numbers changed, and the new ones are smaller.** `0 / 60 leaked` used
  to be scored by asking the guard to refuse hand-built payloads the extractor had never
  touched — it would have read 0/60 with the redactor deleted. The honest pair is
  **0 / 12 PII canaries leaked** (checksum-valid synthetic Aadhaars, through the real
  pipeline) and **45 / 45 required surfaces read**. Three surfaces —
  `css_content`, `same_origin_iframe`, `canvas_pixels` — report **0 observed**, because
  nothing reads computed styles, `all_frames` is `false`, and Tier 2 does not exist.
  Quote 0/12 and 45/45, and name the three gaps. See ADR-0004.
- ❌ **`observed` measures the harvester, not extraction's reach.** The audit walks
  `querySelectorAll('*')`; extraction only harvests interactive elements. So a surface
  on a non-interactive node can read as observed while extraction would never visit it.
  Listed as follow-up in ADR-0004.

---

## 4. Ticket board

Legend: ✅ done · 🟡 partial (scope noted) · ⬜ not started · 🚫 blocked

### EPIC A — Extension shell & cross-browser (EXT)

| ID | Ticket | Status | Notes |
|---|---|---|---|
| A1 | Monorepo + dual-target build | ✅ | pnpm workspaces; turbo not used — two Vite passes instead (ADR-0001 D3) |
| A2 | `manifest.base` → both manifests | ✅ | `.mjs` not `.ts` (ADR-0001 D2); both load unpacked |
| A3 | Typed message bus, 4 contexts | ✅ | `shared/messages.ts`; offscreen answers a ping |
| A4 | `InferenceHost` platform abstraction | ✅ | offscreen doc (Chrome) / event page (Firefox) |
| A5 | Side panel shell | 🟡 | task input, status, ledger, self-test. **Missing**: tier badge detail, per-site grant UI |
| A6 | Throttle-aware capture | ⬜ | needs Tier 2 |
| A7 | AX provider (CDP + shim) | ⬜ | P1 priority |
| A8 | Packaging (zip / signed xpi) | ⬜ | Phase 7 |

### EPIC B — Screen extraction (EXT)

| ID | Ticket | Status | Notes |
|---|---|---|---|
| B1 | DOM walker + roles + accname | 🟡 | practical accname; full implicit-role table pending |
| B2 | Geometry, z-order, occlusion | 🟡 | bbox + visibility only; no occlusion sampling |
| B3 | Stable IDs surviving re-render | 🟡 | `WeakRef` registry; **no fingerprint fallback** — a React re-render loses targets |
| B4 | iframe stitching | ⬜ | `all_frames: false` today |
| B5 | Shadow-root traversal | ⬜ | |
| B6 | Settle detection | ⬜ | fixed 400 ms sleep stands in |
| B7 | Dirty-element tracking | ⬜ | no MutationObserver yet; every step re-walks |

### EPIC C — NETRA on-device perception (MLC)

| ID | Ticket | Status | Notes |
|---|---|---|---|
| C1 | Capability probe + device profile | 🟡 | `probeDevice()` reports WebGPU/WASM; **no micro-benchmark**, cannot tell class A from B |
| C2 | Model registry + SHA-256 verify | ⬜ | |
| C3 | Warm session pool | ⬜ | |
| C4 | Face detection + `<video>` rule | ⬜ | |
| C5 | dHash + tile diff | ⬜ | |
| C6 | UI-element YOLO | 🚫 | **Recommended CUT** — 4d, worst value/day. Use an off-the-shelf ONNX detector |
| C7 | DOM ↔ widget reconciliation | ⬜ | depends on C6 |
| C8 | Coverage mask + unexplained-pixel ratio | ⬜ | field exists in the SSG, hard-coded to 0 |
| C9 | PP-OCR det + rec | ⬜ | P1 |
| C10 | **GLiNER-PII wrapper** | ⬜ | **The most important gap.** Until this lands, no contextual PII |
| C11 | Florence-2 local VLM | ⬜ | P1, first to cut |
| C12 | Adaptive Perception Controller | 🟡 | interface + fixed policy in `netra/src/index.ts`; no signals, no weights |
| C13 | WASM fallback tuning | ⬜ | |

### EPIC D — KAVACH privacy engine (PRV)

| ID | Ticket | Status | Notes |
|---|---|---|---|
| D1 | Normalisation + offset map | ✅ | NFKC, zero-width, confusables, digit compaction |
| D2 | L0 DOM rules + site list | ✅ | `l0-dom-rules.ts`, pure and tested |
| D3 | L1 regex — global | ✅ | email, IP, card, IMEI, JWT, API keys |
| D4 | **L1 regex — India + validators** | ✅ | Verhoeff, Luhn, GSTIN mod-36, PAN entity code, IFSC, UPI, voter, passport |
| D5 | Secrets / entropy detector | ✅ | entropy gate on API keys |
| D6 | Cascade + verdict cache | 🟡 | L0-before-L1 short-circuit works; **no cache** — every step rescans |
| D7 | Fusion | ✅ | noisy-OR, sensitivity lattice, span union, corroboration |
| D8 | Policy engine + packs | ✅ | default/gov/bank/health; overrides tighten-only; fail-closed |
| D9 | Text redaction + tokens | ✅ | right-to-left substitution via offset map |
| D10 | Pixel redaction | ⬜ | needs Tier 2 |
| D11 | **Vault + sink binding + TTL** | ✅ | 25 tests; ADR-0002 |
| D12 | **Egress guard, 8 checks** | 🟡 | **7 of 8.** Check 5 (image verify) fails closed on any image. Check 6 can now actually fail on a forged token: the manifest is derived from what the vault minted, not from what the payload contains (bug #13) |
| D13 | `no-fetch` lint rule + bundle grep | ✅ | plus `pnpm lint:prove`, which fails if the rule stops firing |
| D14 | LEKHA ledger | ✅ | hash-chained, tamper-detecting, hashes only. **Two-phase**: `attempted` before the wire, `sent`/`failed` after (ADR-0004, bug #10) |
| D15 | **Glass-box overlay** | ✅ | shadow-root host, pointer-events:none, colour by sensitivity group, credentials in red; skipped by extraction so markers never become targets |
| D16 | **"What the server saw" diff viewer** | ✅ | byte-accurate payload pane, masked previews, per-redaction detector trace; browser-tested to display no recoverable value **in any field of the row, label included** (bug #12) |
| D17 | **Canary audit button** | ✅ | plants 60 markers + 12 checksum-valid synthetic Aadhaars across 12 live surfaces, runs the **real extractor** over them, restores the page. Reports leaked (redactor), observed (reader) and guardBlocked (guard) — three components, three numbers (ADR-0004, bug #11) |
| D18 | Policy editor UI | ⬜ | P2 |
| D19 | Indic-script normalisation | ⬜ | P2 |

### EPIC E — HASTA executor (EXT)

| ID | Ticket | Status | Notes |
|---|---|---|---|
| E1 | Target resolution + staleness | ✅ | refuses a stale id rather than guessing |
| E2 | Client-side risk derivation | ✅ | server may only escalate |
| E3 | Risk gating UI | 🟡 | `window.confirm` stands in for the real modal (no crop, no undo) |
| E4 | **Detokenisation + sink binding** | ✅ | plain-language refusal messages |
| E5 | Synthetic events + React setter | ✅ | native-setter path |
| E6 | CDP trusted events | ⬜ | P1 |
| E7 | Character-wise typing | ⬜ | P1 |
| E8 | Post-condition read-back | ⬜ | outcome is assumed, not verified |

### EPIC F — Server (BE)

| ID | Ticket | Status | Notes |
|---|---|---|---|
| F1 | FastAPI + Pydantic + SSE | 🟡 | **runs.** Generated Pydantic, ingress guard, prompt+validation, 46 tests. **SSE not implemented** — plans return as one JSON response |
| F2 | vLLM deployment + compose | ⬜ | offline `docker compose` still required for the submission's air-gapped claim; cloud endpoint for development |
| F3 | Guided decoding | 🟡 | three-tier ladder: strict json_schema → json_object → validate-and-retry, with the tier recorded. XGrammar returns with self-hosted vLLM (F2) |
| F4 | **Ingress PII guard + parity test** | ✅ | full Python mirror incl. Verhoeff/Luhn/GSTIN; 900-case shared corpus, **zero disagreements**; CI fails on drift |
| F5 | Image sanity check | ⬜ | |
| F6 | Redis session store | ⬜ | |
| F7 | Post-validation | ✅ | targets must exist, no literal PII, risk escalation-only, credential refs refused |
| F8 | Metrics + OTel | ⬜ | |
| F9 | Air-gapped compose + nightly CI | ⬜ | this is how R9 stops being a claim |
| F10 | Local fallback server | 🟡 | the Node mock covers the demo-network contingency |

### EPIC G — MANTRI reasoning (SML) — **now a package: `server/mantri/`**

Full board and honesty list: **[TODO-MANTRI.md](TODO-MANTRI.md)**. Summary:

| ID | Ticket | Status | Notes |
|---|---|---|---|
| G1 | System prompt + redaction contract + hierarchy | ✅ | composed from the base contract + `mantri/prompts/grounder-addenda.md`, never copied |
| G2 | Few-shot exemplars (6) | ✅ | real alternating turns; each asserted schema-valid |
| G3 | Planner/Grounder split + sub-goal cache | ✅ | TTL, invalidation on goal change / navigation / K steps / two failures |
| G4 | Text-fast-path routing | ✅ | vision only when the structural description is known to be incomplete; a plan that would not ground escalates to vision once |
| G5 | Injection classifier + fencing | ✅ | 8 families; **the attack text never enters the prompt or the log** |
| G6 | Model bake-off | 🟡 | harness runnable, **never run** — needs the API key (B-5) and the GPU decision (B-2) |
| G7 | Prompt eval harness | ✅ | 40 tasks in ten categories, scoring, 4 ablation variants, CLI. **37/40 on `qwen2.5-vl-72b-instruct`** (`docs/metrics/g7-mantri-suite.md`) — not the 7B, and it predates a validator fix |
| G8 | Failure recovery + `ask_user` policy | ✅ | complaint→correction hints; `ask_user` plans built server-side so recovery never depends on the model |

140 offline tests (`server/tests/test_mantri_*.py`). The eval harness is tested from both
ends (ADR-0004's lesson): a blindly-clicking model scores 11/40, an idle one 2/40, and a
hand-written correct answer for every task scores 40/40 — the suite can both fail and be
passed. The first real run found two post-validation gaps before it found any model
weakness; both are closed, so 37/40 is a baseline pending a re-run.

Historic notes:
G1 ✅ system prompt + redaction contract · G5 ✅ untrusted-content fencing ·
G7 🟡 **S-05 RE-RAN: 6/7** on Qwen2.5-VL-72B — see `docs/metrics/s05-ssg-reasoning.md`. `coreference` now passes (the 429 backoff worked) and `credential-cannot-be-resolved` passes *properly*: the model still invented `⟦PASSWORD_1⟧`, post-validation rejected it, and it corrected on attempt 3 — the retry ladder doing exactly its job. **Injection still fails, unchanged.** Still to do: run it against `qwen/qwen2.5-vl-7b-instruct`, which is the number the submission rests on ·
G2/G3/G4/G6/G8 ⬜.

### EPIC H — Evaluation (PRV + SML)

| ID | Ticket | Status | Notes |
|---|---|---|---|
| H1 | Faker-IN corpus generator | ⬜ | validators exist and can generate valid values |
| H2 | 500-page corpus | 🟡 | 1 hand-built demo portal, used as a recall fixture |
| H3 | **Canary suite** | 🟡 | 12 surfaces, 0/12 PII canaries leaked, 45/45 required surfaces read, in-browser. **Not yet a blocking job** — and when it becomes one it must assert `requiredObserved === requiredTotal` too, or it inherits the vacuity ADR-0004 removed |
| H4 | 40-task suite | ⬜ | |
| H5 | Playwright runner | 🟡 | 9 browser tests, and the suite now **starts its own server** so it passes from a clean checkout (bug #14). Chromium only; **Firefox not covered** (X4 unmet) |
| H6 | Latency harness | ⬜ | no timing measured anywhere yet |
| H7 | Accuracy harness | 🟡 | per-class recall on one fixture |
| H8 | Adversarial suite | 🟡 | homoglyph, zero-width, split-digit cases tested; no injection pages |
| H9 | Ablation runs | ⬜ | needs H5 + H6 |

### EPIC I — Demo & submission (LEAD)

| ID | Ticket | Status | Notes |
|---|---|---|---|
| I1 | Mock government portal | ✅ | `packages/eval/fixtures/demo-portal.html` |
| I2 | Demo script, 8 beats | ⬜ | beat 5 (reverse channel) works; script unwritten |
| I3 | Pitch deck | ⬜ | |
| I4 | 3-minute video | ⬜ | |
| I5 | README 5-minute setup | ✅ | `QUICKSTART.md` |
| I6 | Judge Q&A sheet | ⬜ | |

---

## 5. Tier-S scorecard (`SOLUTION-SPACE.md` — "the four features that *are* the submission")

| Feature | Status |
|---|---|
| Egress guard with 8 checks | 🟡 7 of 8; the missing one fails closed |
| Vault + sink binding | ✅ |
| "What the server saw" diff viewer | ✅ |
| Live canary suite | ✅ runs on stage, against the real guard |

---

## 6. Blocked, and on whom

| # | Blocker | Blocks | Owner |
|---|---|---|---|
| ~~B-1~~ | ~~Python 3.12~~ **RESOLVED**: 3.12.8 was already installed under the `py` launcher | — | — |
| **B-5** | **An OpenRouter API key** in `PRAHARI_LLM_API_KEY` | spike S-05, G2/G6/G7, any real plan | **you** |
| **B-2** | GPU allocation — nothing in the docs says where it comes from | F2, G6, S-05 | **you** |
| B-3 | Phase-0 spikes S-01…S-05 never run | C-epic confidence | MLC / BE |
| B-4 | No Playwright harness (H5) | every browser-level claim | PRV |

> On B-2: consider **Qwen2.5-VL-7B on a rented A10/L4** rather than blocking on 8B-class
> VRAM. It is already the documented fallback in `CONTEXT.md §3.3`.

---

## 7. Next three steps

**Step 3 — diff viewer (D16) + glass-box overlay (D15) + canary button (D17)** · ~2 days
Completes Tier-S. Needs no GPU, no Python, no models. `SOLUTION-SPACE.md` calls the
diff viewer "the strongest single feature". Highest value per day remaining.

**Step 4 — the real server (F1–F4) + spike S-05** · ~3 days · 🚫 blocked on B-1, B-2
S-05 asks whether Qwen can actually reason over the SSG format with `⟦CLASS_N⟧` tokens.
**It is the spike that can still invalidate the architecture**, and the action-plan
schema is already written, so it can run the moment any endpoint exists.

**Step 5 — L2 NER (C10) + face detection (C4)** · ~5 days
Closes the contextual-PII gap and makes "a local ViT reads the screen" literally true,
satisfying R2. Until then, §3 above stands.

---

## 8. Decisions log

| ADR | Decision |
|---|---|
| [0001](docs/adr/0001-walking-skeleton.md) | Skeleton before spikes; `.mjs` manifest source; two Vite passes; plain CSS; Node mock server; guard check 6 semantics; Ajv 2020-12 |
| [0002](docs/adr/0002-vault-in-content-script.md) | Vault lives in the content script, not the background — resolves a real contradiction between  and  P3 |
| [0003](docs/adr/0003-precompiled-schema-validators.md) | Schemas precompiled at build time (Ajv's `new Function` violates the extension CSP); the guard returns a verdict even when it crashes; `modulePreload` off |
| [0004](docs/adr/0004-two-phase-ledger-and-audits-that-can-fail.md) | Two-phase ledger (`attempted` → `sent`/`failed`); the canary audit runs the real extractor and plants PII canaries; the manifest comes from the vault, not the payload; the browser suite starts its own server |

**Docs that need amending** (not yet done): `ARCHITECTURE.md §4.2` and `§10` still place
the vault in the background. `PRD.md` E-02 says 8 canary surfaces; `PIPELINE.md §12D`
and `IMPLEMENTATION-PLAN.md` H3 say 12. The code uses 12.

---

## 9. Bugs the tests caught (keep adding — this list is an argument for the test suite)

1. **UPI pattern matched ordinary emails.** `asha@example.com` matched as far as
   `asha@example`; `example` is not an emailish TLD, so every email on a page would
   have been reported as a payment address. Fixed with a lookahead.
2. **The server's ingress pack had already diverged from the client's** — missing
   `PHONE_IN`, `GSTIN`, `IFSC` — on day one. This is exactly what F4's parity test is
   for.
3. **`autocomplete="billing tel"` was not classified as a phone field**, because the
   code tested the whole attribute instead of each token. Every prefixed field on a
   real checkout would have been missed.
4. **Vite's modulepreload polyfill injected a `fetch` into the side panel**, a context
   the manifest denies the network. Found by the bundle grep, not by lint. Polyfill
   disabled.
5. **Ajv built its validator with `new Function`, which the extension CSP forbids.** The
   egress guard threw `EvalError` on every step and the loop hung. **Every node test
   passed** — node has no CSP — so this was found only by loading the extension in a
   browser. Fixed by precompiling the schemas (ADR-0003); the bundle grep now rejects
   `eval` and `new Function` too. **This is the argument for H5.**
6. **The guard could throw instead of returning a verdict.** The resulting unhandled
   rejection left the loop stalled with no message, and a crash looks exactly like a
   hang to the user. Fail-closed now covers the guard's own bugs.
7. **The page URL leaked the user's real name.** On a `file:` page, `path_shape` was
   sent verbatim — `/C:/Users/<the user's actual name>/Downloads/...` — and
   `origin_class` was empty, so the path was the *only* identifying field in the
   payload. A person's name, transmitted to the server, by the component whose whole
   job is to prevent that. **Found by the first browser test, minutes after writing
   it.** Non-http(s) paths are now withheld entirely.
8. **The manifest over-counted redactions 3×.** Every value is scanned on several
   surfaces (`value`, `defaultValue`, `aria-label`, `data-*`) and the per-call counts
   were summed, so a screen with one Aadhaar declared three. The manifest is what the
   planner reasons about, so an inflated count is a lie it acts on. Counts are now
   derived from the distinct tokens actually present.
9. **The canary audit's own probe was rejected at the schema check.** Its
   `session_id` was not valid hex, so all 60 probes failed check 1 and the canary
   check never ran. The audit would have displayed a truthful `0 / 60 leaked` that
   proved nothing whatsoever — **the exact vacuous pass this feature exists to
   prevent, occurring inside the feature itself.** Caught only because the test
   asserts `guardBlocked`, not merely `leaked === 0`. The lesson generalises: a
   privacy metric that can be satisfied by doing nothing needs a second metric that
   cannot.

---

### Bugs #10–#14 — found by a full code review, 2026-09-06

Bug #9's lesson turned out to have four more instances in the tree. All five are
written up in **[ADR-0004](docs/adr/0004-two-phase-ledger-and-audits-that-can-fail.md)**.

10. **The ledger recorded `sent` for payloads that were never sent.** Check 8 appended
    the row *before* `fetch`, so every step against an unreachable server produced a
    hash-chained, tamper-evident record asserting an egress that never happened, with a
    SHA-256 of bytes that never left the machine. "Everything that leaves is logged" was
    true; "everything logged, left" was false. **This is what the D16 browser test was
    failing on**, and the ledger test asserted the wrong outcome, so the suite was
    encoding the bug rather than catching it. Now two rows: `attempted` before the wire,
    `sent`/`failed` after.

11. **The canary audit scored `leaked` against payloads the extractor never touched.**
    It built a synthetic SSG per canary and asked the guard to refuse it — a measurement
    of the guard's string search that would have reported a clean `0 / 60` with the
    redactor deleted from the build. It now runs the real extractor over the planted
    page. Turning that on immediately reported 25/60, which was *correct* — canaries are
    deliberately not PII-shaped, so a Tier-1 payload legitimately carries them — so a
    second plant set was added: one checksum-valid synthetic Aadhaar per surface, which
    must be redacted. Also fixed: `take()` did not consume, so `data_attribute` was
    planted twice with the same five values; and `css_content` / `same_origin_iframe`
    were planted as a data attribute and a `<span>`, reporting 5/5 observed while
    neither CSS nor an iframe was involved. They are real now, and honestly report 0.

12. **The diff viewer sent the raw accessible name across the message boundary.**
    `DiffRow.preview` was carefully masked; `DiffRow.label` beside it was the unredacted
    name, and the type documented itself as carrying "no recoverable value, so it is
    safe to send to the side panel". On any page whose label is itself identifying —
    `aria-label="Delete payment method ending 4242"`, a row button naming an account —
    the real string crossed into the panel and rendered next to the mask of the same
    data. RULES.md P3. **The demo portal's labels are generic, which is exactly why the
    existing "no recoverable value" test passed.** The new test plants an identifying
    label on purpose.

13. **Guard check 6 could not fail in the direction it advertised.** It claimed to catch
    "a token forged into page text", but `countDistinctTokens` built the manifest by
    scanning the payload for tokens — so a `⟦AADHAAR_1⟧` written by a hostile page was
    harvested, declared, and then compared against itself. The manifest now comes from
    the tokens the vault actually minted, and `neutralizeTokens()` folds the brackets on
    every page-derived string as defence in depth.

14. **`pnpm verify` did not pass on a clean checkout.** `playwright.config.ts` declared
    no `webServer`, so the browser suite — and the CI job running the same command —
    needed someone to have `pnpm server:mock` open in another terminal. A gate that only
    passes on a developer's warm machine is not a gate. It starts its own server now.

Two more, smaller, with regression tests: the vault generated **two session keys under
concurrent mints**, silently breaking coreference (proved by reverting the fix — the same
value minted `⟦AADHAAR_1⟧` and `⟦AADHAAR_2⟧`); and `fuse()` attached a bridging detection
to only the first group it touched, leaving overlapping spans for the redactor to write
over each other.

---

## 10. How to update this file

- Flip a status the moment the ticket's tests pass, in the **same commit**.
- When a status becomes 🟡, say in the Notes column exactly what is missing. A 🟡 with
  no scope note is worse than a ⬜.
- Add every bug a test catches to §9.
- Re-check §3 before any demo or any claim made to a judge.
- Update the header line (date, commit, test count) whenever you touch this file.
