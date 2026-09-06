# ADR-0002 — The vault lives in the content script, not the background

- **Date**: 2026-09-05
- **Status**: Accepted
- **Supersedes**: the placement stated in `ARCHITECTURE.md §4.2` and `§10`

---

## Context

`ARCHITECTURE.md §10` places the vault in "Background memory `Map`". `RULES.md P3`
requires that vault values "never touch `chrome.storage`, IndexedDB, `localStorage`,
`postMessage`, or any log."

**These two requirements are incompatible.** Redaction runs in the content script — by
deliberate design, so that "the raw text of a password field should never be serialised
into a `postMessage` at all" (`ARCHITECTURE.md §3.1`). If the vault then lives in the
background, every minted entry has to be messaged across the very boundary P3 forbids.
The contradiction is not hypothetical; it appears the moment you write the code.

## Decision

**The vault lives in the content script, one per tab** (`content/session.ts`).

Both parties to a value are already in that context:

- **Minting** happens during extraction, in the content script.
- **Resolving** happens during execution, in the content script — HASTA is what types
  the value into the field.

So the value is created, held, and consumed without ever crossing a boundary. P3 stops
being a rule people must remember and becomes a property of the architecture.

The background continues to own the network, the guard, the ledger and the state
machine. It sees tokens; it never sees values.

## Consequences

**Good**

- P3 is true by construction. `Vault` holds entries in a `#private` field, and its
  `toJSON`/`toString` return `[Vault: N entries, values withheld]`, so a value cannot
  reach a log or a payload even by accident. There is a test for exactly this.
- The blast radius of a background bug no longer includes user secrets.
- Wipe-on-`pagehide` is natural: the vault dies with the page that owned it.

**Costs, accepted**

- The vault does not survive navigation. This is correct rather than merely tolerable:
  SSG element ids are page-instance scoped, so a navigated page's `e17` is not the
  `e17` a token was bound to. Resolving across a navigation would be the bug, not the
  feature. The vault's `ORIGIN_CHANGED` check enforces this independently.
- A multi-tab task would need one vault per tab. Out of scope for v1; the tier ladder
  and the agent loop are single-tab by design.

**Follow-up**

- `ARCHITECTURE.md §4.2` and the data-lifecycle table in `§10` should be amended to say
  "content script, per tab". Doing that is a docs change, not a code change.

## Sink binding, implemented

The reverse channel is what makes redaction an encoding rather than a deletion, and it
creates an attack the naive version does not defend against: an injected instruction
asks the agent to type the user's Aadhaar into an attacker-controlled search box, which
exfiltrates it through a URL (EIA, arXiv 2409.11295). A Casper-style reversible mapping
happily complies.

`Vault.detokenize` refuses unless **all** of the following hold, and each refusal path
has its own test:

| Check | Refusal | Defends against |
|---|---|---|
| token was minted this session | `UNKNOWN_TOKEN` | forged or replayed references |
| class was reversible | `NOT_REVERSIBLE` | a request to resolve a credential |
| origin unchanged since minting | `ORIGIN_CHANGED` | cross-origin navigation mid-task |
| within TTL | `EXPIRED` | stale bindings after the page moved on |
| **target ∈ allowedSinks** | `SINK_NOT_ALLOWED` | **environmental injection / exfiltration** |

Credentials never reach the vault at all. `tokenFor` returns the shared `⟦REDACTED_0⟧`
sentinel and stores nothing, so several distinct passwords collapse onto one symbol
that no request can ever resolve.

## What this unlocks in the demo

Beat 5 of the demo script now works for real: the server emits
`{"op":"type","target":"e3","value_ref":"⟦AADHAAR_1⟧"}` having never seen a digit, and
the client fills in the true twelve digits locally. The mock server does this at step 1
so the path is exercised every run.

Beat 5b — the one worth rehearsing — is the refusal: point the same plan at a different
element and the client answers

> REFUSED: ⟦AADHAAR_1⟧ is bound to the field it came from, and e99 is not that field.

## Findings while building this

1. **A real L0 bug.** `autocomplete="section-a billing tel"` was not classified as a
   phone field, because the code tested the whole attribute for a `tel` prefix instead
   of the individual token. Every prefixed field on a real checkout page would have
   been missed. Caught by a test, fixed in `l0-dom-rules.ts`.
2. **Unknown classes must fail closed too.** `groupOf()` returns `credential` for a
   class it does not recognise, so a taxonomy gap over-redacts rather than under-
   redacts. This is the same instinct as P6 applied to the type system.
3. **Fusion must take the union of spans, never the intersection.** A detector that saw
   slightly less of a value would otherwise shrink the redaction, and a box two
   characters too small leaves a legible fragment of an identifier.
