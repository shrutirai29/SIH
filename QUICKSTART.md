# QUICKSTART — run the loop

Clone to a running agent in about ten minutes; five if you skip the Python server and
use the mock. If any step takes materially longer, that is a bug — file it.

> Verified on 2026-09-09 against this tree: `pnpm test` → **168 unit tests, 11 files,
> green**; `pnpm typecheck`, `pnpm lint`, `pnpm lint:prove` and `pnpm check:bundle`
> → green; `pnpm build` → both targets built; `pnpm test:server` → **49 tests, green**
> (on Python 3.13.14, from a clean `server/.venv`). The e2e suite (9 browser tests)
> needs Chromium installed, see step 1b.

## 0. Prerequisites

- **Node 20+** (built and tested on 24.14)
- **pnpm 11.25.0** — the version is pinned in `package.json` as `packageManager`.
  `corepack enable` is the intended way in; `npm i -g pnpm` works; if neither is
  available (no admin rights on Windows), every command below also runs as
  `npx pnpm@11.25.0 <script>`.
- Chrome 120+ and/or Firefox 128+
- **Python 3.12+** — required now, not optional. (3.13 works; the suite was last run
  green on 3.13.14.) The real planning server (MANTRI) is
  a FastAPI app in `server/`. You can run the whole client loop without it against the
  Node mock, but the mock returns a hard-coded plan and `RULES.md D5` forbids it from
  any demo.

## 1. Install and verify

```bash
pnpm install
pnpm verify
```

`verify` is the merge gate and is self-contained. In order:

| Step | What it proves |
|---|---|
| `gen:contract` + `git diff --exit-code` | The precompiled schema validators match the schemas (ADR-0003) |
| `typecheck` | `tsc -b` across ssg → kavach → netra → extension |
| `lint` | ESLint, including the choke-point rule |
| `lint:prove` | The choke-point rule actually *fires* — a configured rule that never fires protects nothing |
| `test` | 168 unit + integration tests (vitest) |
| `build` | Both browser targets |
| `check:bundle` | No network API outside `background.js`, in the **shipped artefact**, not just the source |
| `test:e2e` | 9 browser tests in real Chromium under the real MV3 CSP |

### 1b. First time only, for the browser suite

```bash
pnpm exec playwright install --with-deps chromium
```

`pnpm test:e2e` starts the mock server itself and reuses one you already have running,
so you do not have to remember to launch anything.

## 2. Start a server

Pick one. The extension talks to `http://localhost:8080` either way.

### Option A — the mock (fastest, not demoable)

```bash
pnpm server:mock
```

Zero-dependency Node. Hard-coded plan, no model. It labels itself as a mock in its own
`/v1/models` response, and it runs a coarse ingress PII sweep so a client-side
redaction bug is loud from day one.

### Option B — the real server, MANTRI (what the submission rests on)

```bash
# once
python -m venv server/.venv          # or: py -3.12 -m venv server/.venv
node scripts/py.mjs -m pip install -r requirements-dev.txt

# every time
pnpm server                          # http://127.0.0.1:8080
pnpm test:server                     # the server suite
```

`scripts/py.mjs` finds the venv interpreter on both Windows and POSIX and prints an
actionable message if it is missing — do not hand-write `.venv/Scripts/python.exe`,
it is not portable across the shells pnpm may pick.

It needs an API key to reach a model. Without one it starts fine and answers every
step with `503 MODEL_UNAVAILABLE`, which is the honest failure rather than a fake plan:

```bash
setx PRAHARI_LLM_API_KEY  sk-or-v1-...
setx PRAHARI_LLM_MODEL    qwen/qwen2.5-vl-72b-instruct
setx PRAHARI_LLM_BASE_URL https://openrouter.ai/api/v1
```

`setx` does not affect the shell you typed it in. Reopen it. Details, model choices and
the schema-validity caveat: `server/README.md`.

## 3. Build the extension

```bash
pnpm build          # both targets
# or: pnpm build:chrome / pnpm build:firefox
```

Output: `packages/extension/dist-chrome/` and `dist-firefox/`.

`pnpm dev` gives a rebuild-on-save loop (you still hit reload in the browser).
The server origin is baked in at build time; point elsewhere with
`VITE_PRAHARI_SERVER_ORIGIN=https://…` and the manifest's single host permission
follows it (`RULES.md P10`).

## 4. Load it

**Chrome** — `chrome://extensions` → enable *Developer mode* → *Load unpacked* →
select `packages/extension/dist-chrome`.

**Firefox** — `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* →
select `packages/extension/dist-firefox/manifest.json`.
(Temporary add-ons are cleared when Firefox restarts. That is expected.)

## 5. Run the loop

1. Open the demo page: `packages/eval/fixtures/demo-portal.html` (drag it into a tab).
   It is a fictional government-scheme form carrying a checksum-valid synthetic
   Aadhaar, PAN, IFSC, UPI handle, phone, email, a password and an OTP.
2. Open the side panel — click the PRAHARI toolbar icon (Chrome), or open the sidebar
   (Firefox).
3. Type a goal, e.g. *"Apply for the scheme using my saved profile"*, and press **Run**.

### What you should see

- The status card moves through **Reading screen → Redacting → Guard check → Server
  planning → Acting**.
- **Redacted** counts the identifiers KAVACH found and tokenised.
- **Sent this step** is a few KB — the SSG only, no pixels.
- The page scrolls, fields fill, and the loop stops on `done` or at the 12-step cap.
- The **Ledger** tab shows the steps, each with the SHA-256 of the exact bytes offered
  to the network — recorded in two halves, `attempted` then `sent`/`failed`, so it
  never claims an egress that did not happen (ADR-0004).
- The **Diff** tab shows the exact transmitted bytes beside shape-preserving masks of
  what was on screen. Credentials show *(never stored)*, because they were dropped at
  redaction time and there is nothing to preview.

### Prove it refuses to leak

Three buttons, and they measure three different things. Do not conflate them.

| Button | What it measures |
|---|---|
| **Run self-test** | The guard refuses a synthetic payload carrying a valid Aadhaar; the ledger chain verifies; the inference boundary is alive. The refusal lands in the ledger as a `blocked` row. |
| **Run canary audit** | The *redactor*. The tab plants checksum-valid synthetic Aadhaars across twelve surfaces, runs the **real** extractor over the real page, and searches the bytes it produced. Quote **0 / 12 PII canaries leaked** and **45 / 45 required surfaces read**. |
| **Overlay** | The glass-box view: boxes every field that was redacted, on the live page. |

You can also watch the server: it runs its own independent PII sweep and answers
`422 REDACTOR_FAILURE` if anything unredacted ever reaches it. In normal operation you
should never see that line.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Side panel says *"Could not read the page"* | The content script is not on that tab. Reload the tab after loading the extension; it cannot inject into `chrome://` pages or the extension gallery. |
| Status stops at **Blocked** | Working as designed — the guard refused its own payload. The message names the check. Read it; do not work around it (`RULES.md AI-3`). |
| *"server unreachable"* | Neither server is running, or something else holds port 8080. |
| `503 MODEL_UNAVAILABLE` | The real server is up but `PRAHARI_LLM_API_KEY` is unset. Reopen the shell after `setx`. |
| `409 VERSION_MISMATCH` | The extension and server disagree on the SSG major version. Rebuild both. |
| `422 REDACTOR_FAILURE` | The ingress guard found PII the client should have removed. This is a real bug — capture the trace id and fix the detector, never the guard. |
| *"No server virtualenv found"* | `scripts/py.mjs` could not find `server/.venv`. It prints the two commands that create it. |
| `pnpm: command not found` | Use `corepack enable`, or prefix every command with `npx pnpm@11.25.0`. |
| Firefox: no sidebar | Use *View → Sidebar → PRAHARI*, or reload the temporary add-on. |

## What this build does and does not do

**Does**: real DOM + accessibility extraction; L0 DOM-rule and L1 checksum-validated
redaction (Aadhaar/PAN/GSTIN/IFSC/UPI/ABHA/Voter ID/passport/phone/email/card/IMEI/
IP/JWT/API key/private key); the **vault with sink binding**, so `value_ref` resolves
locally into the origin element and nowhere else; a 7-of-8-check egress guard; a
two-phase hash-chained privacy ledger; click/type/scroll/select execution with
client-side risk re-derivation; the diff viewer, the glass-box overlay and the live
canary audit; a real FastAPI server whose ingress guard mirrors the client's PII pack,
with a parity test that fails on any disagreement; Chrome and Firefox from one codebase.

**Does not, yet**:

- **No vision model runs.** Extraction is DOM-only, so problem-statement R2 is not
  satisfied. `packages/netra` carries a MediaPipe BlazeFace face detector, but nothing
  imports it and it is not wired into the extension (see `TODO.md`).
- **No contextual PII.** Names and addresses in free prose pass through; names in
  *form fields* are caught via `autocomplete`. Needs L2 NER, ticket C10.
- **No pixels.** Tier 2 does not exist; check 5 of the egress guard fails closed on any
  payload carrying an image (`IMAGE_UNVERIFIED`).
- **The tier controller is a constant.** `chooseTier` returns tier 1 and says so in the
  UI.
- **The loop has never completed a live task against a real model.** Wiring the
  extension to the running FastAPI server is the next task.

The canonical, longer version of that list is `TODO.md §3` — re-read it before any
demo. Deviations from the plan, with reasons, are in `docs/adr/`.
