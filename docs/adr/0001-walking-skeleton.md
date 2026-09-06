# ADR-0001 — Walking skeleton: choices made, and where we deviated from the plan

- **Date**: 2026-09-05
- **Status**: Accepted
- **Phase**: P1 (built ahead of P0 spikes — see §5)

---

## Context

`IMPLEMENTATION-PLAN.md §7` calls the walking skeleton "the single most important
scheduling decision in the project". This ADR records what was actually built, and
every place the implementation departs from the written plan, so nobody has to
reverse-engineer the difference later.

## Decisions

### D1 — Build the skeleton before running the Phase-0 spikes

`PHASEWISE.md` puts five de-risking spikes in W0 and the skeleton in W1. We inverted
that for the first slice only.

**Why**: four of the five spikes (S-01 WebGPU in an offscreen document, S-02 GLiNER
latency, S-03 capture-to-JPEG budget, S-04 AX-shim parity) need a loaded extension with
a working message bus to measure anything at all. The skeleton *is* the spike harness.
S-05 (vLLM + XGrammar validity) is independent and is unblocked by the schema in
`packages/ssg/schema/action-plan-v1.json`, which now exists.

**Cost accepted**: if a spike invalidates an architecture choice, we throw away
plumbing rather than models. That is the cheap direction.

### D2 — `manifest.base.mjs`, not `manifest.base.ts`

`RULES.md X2` requires both manifests be generated from a single source. It is written
as `.mjs` so `scripts/build.mjs` can import it directly with no transpile step, keeping
the build to two Vite passes and zero extra tooling. The invariant (never hand-edit a
generated `manifest.json`) is unchanged.

### D3 — Two Vite passes rather than `@crxjs/vite-plugin`

The plan names `@crxjs/vite-plugin`. We build with plain Vite instead:

- pass 1: background + side panel + offscreen as **ES modules** (both Chrome MV3
  service workers and Firefox MV3 event pages accept `"type": "module"`);
- pass 2: the content script as a **single IIFE** — content scripts are classic
  scripts and cannot be modules or code-split.

**Why**: the two required output formats are not negotiable, and expressing them
directly is less magic to debug than a plugin that has to infer them. Revisit if HMR
becomes painful.

### D4 — Plain CSS in the side panel, not Tailwind 4

Tailwind is in the documented stack. The skeleton uses ~450 lines of hand-written CSS
with a light/dark token set. **Why**: no build surface to fail on day one. Adding
Tailwind later is a mechanical change confined to one package.

### D5 — Node mock server now, FastAPI later

`tools/mock-server/index.mjs` is a zero-dependency Node server returning a **hard-coded**
plan. **Why**: this machine has Python 3.7.9, and the real server needs 3.12 plus vLLM,
which does not run natively on Windows. The mock unblocks the whole client loop today.

It is labelled a mock in its own `/v1/models` response, and `RULES.md D5` forbids it
from appearing in a demo. It does carry a coarse ingress PII sweep, so a client-side
redaction bug is loud from day one rather than silent until Phase 3.

### D6 — Real DOM extraction instead of the specified 5-element stub

The plan calls for a stub SSG. We built a real (if minimal) extractor: implicit roles,
the practical part of the accname algorithm, geometry, visibility, and client-side risk
derivation.

**Why**: a stub cannot exercise the guard's text sweep, which is the component whose
correctness matters most. Running against real page text immediately surfaced a
precision bug (see §4).

**Consequence**: because there is real text, there must be real redaction, so
`content/redact-v0.ts` (L0 DOM rules + L1 regex, ticket D9 v0) landed in this slice
rather than Phase 3.

### D7 — Guard check 6 verifies the manifest *describes the payload*

The original wording ("counts in the manifest must equal the number of applied
redactions") is ambiguous once one element carries two redacted values, and it produces
constant false blocks. The implemented invariant is stronger and well-defined:

1. every token class present in the payload must be declared in the manifest; and
2. the number of distinct tokens must not exceed the declared total.

Credentials are exempt from (1) via the `⟦REDACTED_0⟧` sentinel, because several
distinct credentials deliberately collapse onto one non-resolvable token.

### D8 — Ajv 2020-12 build

Our schemas declare `$schema: draft/2020-12`. Ajv's default export only speaks
draft-07 and fails to resolve the meta-schema at runtime. `ajv/dist/2020.js` is
required. Recorded because the failure mode ("no schema with key or ref …") is opaque.

## Deliberately NOT built in this slice

Named so nobody mistakes absence for oversight:

| Not built | Ticket | Fails **closed** today? |
|---|---|---|
| Vault + sink binding | D11 | Yes — `value_ref` is refused by the executor |
| Guard check 5 (image verification) | D12 | Yes — any payload with an image is blocked |
| Tier 2 / screenshots | C4–C9 | Yes — tier ceiling is 1 |
| L2 local NER (contextual PII) | C10 | **No** — names and addresses are NOT caught yet |
| Local vision models | C4, C6, C11 | n/a — host pings only |
| Adaptive tier controller | C12 | No — `chooseTier` returns a fixed tier 1 and says so |
| `navigate` action | E-series | Yes — disabled in the executor |
| Glass-box overlay, diff viewer, canary suite | D15–D17 | n/a |

The L2 gap is the one that matters: **v0 redaction covers structured PII only.** Do not
describe the current build as catching names or addresses.

## Findings from building it

1. **A real precision bug, caught by a test.** The UPI VPA pattern matched
   `asha.patil@example.com` as far as `asha.patil@example`, and `example` is not in the
   TLD denylist — so every ordinary email would have been reported as a payment address.
   Fixed with a `(?!\.[a-zA-Z])` lookahead. This is the `SOLUTION-SPACE.md` Branch-3
   claim ("validated regex, not naive regex") earning its keep on day one.
2. **The mock server's ingress pack had already diverged** from the client pack — it was
   missing `PHONE_IN`, `GSTIN` and `IFSC`. On day one. This is precisely why ticket F4's
   TS↔Python parity test is a CI job and not a good intention.
3. **`dist-*/` inside a block comment closes the comment.** Cost 10 minutes. Mentioned
   only because it will happen again.

## Consequences

- The loop is real and green in CI: 61 tests, including a spawned-server integration
  test that drives the actual guard over actual HTTP.
- `pnpm verify` (typecheck + lint + lint-rule proof + tests) is the merge gate.
- The choke-point rule is not just configured — `pnpm lint:prove` fails the build if it
  ever stops firing on the deliberate violation fixture.
