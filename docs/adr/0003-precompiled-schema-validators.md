# ADR-0003 — Precompile the schema validators; the guard must never throw

- **Date**: 2026-09-05
- **Status**: Accepted
- **Trigger**: `EvalError` in the loaded extension, reported from `background.js`

---

## What happened

Loading the built extension and running a task produced:

```
Uncaught EvalError: Evaluating a string as JavaScript violates the following
Content Security Policy directive because 'unsafe-eval' is not an allowed
source of script: script-src 'self' 'wasm-unsafe-eval' ...
```

preceded by a wall of `Error compiling schema, function code: const schema1 = ...`.

**Cause.** Ajv does not interpret JSON Schema; it *generates JavaScript source* for a
validator and instantiates it with `new Function`. MV3 extension pages forbid that. The
schema wall is Ajv's logger printing the source it was about to evaluate, immediately
before throwing — one bug, two symptoms. It was compiling the draft-2020-12
meta-schema, because `strict: true` validates our schemas against it on `addSchema`.

**Effect.** Guard check 1 crashed, so `guard()` threw, so nothing was ever sent. The
privacy invariant held — no payload escaped — but the loop was dead and the side panel
sat on "Checking the payload before it leaves…" forever.

## Why our tests missed it

Node has no CSP. All 122 tests exercised the guard happily, because `new Function` is
legal there. This is exactly the gap `TODO.md` records as **H5 — "the biggest testing
gap: no browser test exists"**, and it cost a broken build to demonstrate. The Playwright
harness is not a nice-to-have.

## Decision 1 — precompile the validators, do not relax the CSP

The tempting fix is adding `'unsafe-eval'` to `manifest.base.mjs`. **Rejected.** It
violates `RULES.md` S7, and it would permit arbitrary strings to execute in the single
most privileged context we have: the one holding the network permission. Our CSP is
correct; Ajv is the wrong tool for this environment as configured.

Instead, `packages/ssg/scripts/compile-schemas.mjs` runs Ajv's standalone mode at build
time (`pnpm gen:contract`) and writes plain ES modules with the validator already
emitted. No codegen at runtime, no eval.

Properties preserved:

- The JSON Schema stays the single source of truth (`RULES.md` C1). Output is
  generated, never edited, and `pnpm verify` fails if it drifts from a fresh run.
- `strict: true` and `allErrors` are unchanged, so `additionalProperties: false`
  remains the privacy control it was (`RULES.md` P7).

Side effects, both welcome: **`background.js` fell from 1027 KB to 532 KB** (the whole
Ajv compiler left the bundle) and first validation no longer pays a compile cost.

Rejected alternatives: hand-writing a validator (loses the schema as source of truth,
breaks C1); swapping validator library (a new dependency, and the schema *is* the
contract — Ajv's semantics are what the server will mirror).

## Decision 2 — the guard returns a verdict on every path, including its own crashes

`guard()` is now wrapped so an unexpected exception becomes
`{ ok: false, reason: 'GUARD_ERROR' }`, written to the ledger like any other refusal.

A guard that throws is *worse* than one that refuses: the caller sees an unhandled
rejection, the loop stalls, and the user cannot tell a crash from a hang. Fail-closed
(`RULES.md` P6) has to cover the guard's own bugs, not only detector timeouts. Nothing
is sent either way; the difference is entirely whether the user is told.

More specific verdicts still win — `LEDGER_WRITE_FAILED` is not swallowed by the
catch-all — and there is a test for that so the generic handler cannot mask a
diagnosable failure.

## Decision 3 — `modulePreload: false`

Chrome logged, for every chunk:

```
A preload for '.../chunks/browser-polyfill-*.js' is found, but is not used
because it is a cross-world extension resource mismatch.
```

Cosmetic, but two reasons to switch it off entirely rather than silence it: the
polyfill calls `fetch()` to warm chunks, which puts a network API inside the side panel
(a context the manifest denies the network, `RULES.md` P1 — this was caught by the
bundle grep in ADR-0001), and Chrome will not honour the tags across extension worlds
anyway. Our bundles are small and local; preloading buys nothing.

## Guardrail added

`scripts/check-bundle.mjs` now also greps every bundle — `background.js` included — for
`new Function` and `eval(`, and fails the build on either. The CSP applies everywhere,
an `EvalError` in the background kills the whole agent, and the symptom is invisible to
node tests. The regression cannot be reintroduced quietly.

## Follow-up

- **H5 (Playwright harness) moves up in priority.** Every claim about behaviour in a
  browser is currently unverified by anything but a human loading the extension.
- The same precompilation applies to the server's Pydantic models when EPIC F starts:
  generated from the same schema, never hand-written.
