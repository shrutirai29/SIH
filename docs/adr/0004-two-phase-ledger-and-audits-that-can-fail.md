# ADR-0004 — A two-phase ledger, and audits that are able to fail

- **Date**: 2026-09-06
- **Status**: Accepted
- **Trigger**: a code review of the whole tree, and one browser test that had been
  encoding the bug it was supposed to catch
- **Amends**: `ARCHITECTURE.md §7` (ledger), `RULES.md` P8 (unchanged in substance),
  `PRD.md` E-02 / `PIPELINE.md §12D` (canary suite semantics)

---

## The pattern behind all four decisions

Every one of these started as a component that reported success and could not have
reported anything else.

That is a specific and recurring failure in privacy engineering, and this project has
already recorded one instance of it as bug #9 — *"a privacy metric that can be satisfied
by doing nothing needs a second metric that cannot."* The lesson generalises further
than the canary audit it was written about, and the four items below are the rest of the
places it had happened.

---

## Decision 1 — an egress is recorded in two halves

**Was**: the egress guard's check 8 appended a ledger row with `outcome: 'sent'`, then
returned the bytes. `net.ts` called `fetch` afterwards.

**Problem**: the row was written before anything left. With the server down, every step
produced a hash-chained, tamper-evident record asserting an egress that never happened,
carrying a SHA-256 of bytes that never left the machine. LEKHA's claim — *everything
that leaves is logged* — was true. Its converse — *everything logged, left* — was false,
and an audit record is only worth trusting when both hold.

This was not theoretical. It is what produced the D16 browser-test failure on a clean
checkout: the test polled the ledger, found a row, opened the diff viewer, and was told
"the exact bytes for this step are no longer in memory" — because the transmission
buffer, which is only written on an actual send, was empty.

**Now**: `GuardOutcome` is `attempted | sent | failed | blocked`.

- `blocked` is terminal and stands alone; nothing was offered to the network.
- The guard writes `attempted` when it clears a payload. It must write *something*
  first: a record written only after the request resolves could be lost to a crash, and
  an unlogged egress is the failure this system exists to prevent.
- `net.ts` calls `guard.confirm()` in a `finally`, closing the pair with `sent` or
  `failed`. In `finally` so a throw between the two still resolves the record.

A non-2xx response is recorded as `sent`: the bytes reached a server that read them and
objected. That *is* a disclosure, and calling it anything else would understate what was
transmitted.

**A row left reading `attempted` is not a bug.** It means the request never resolved,
and "we do not know whether this landed" is the honest state for it to be in. The side
panel renders it as OFFERED rather than folding it into either certainty.

Rejected: mutating the original row. The chain exists so that an edited record is
detectable; mutating rows to keep the log tidy would destroy the property the log is for.

## Decision 2 — the canary audit measures the redactor

**Was**: the audit planted 60 conspicuous strings, then scored `leaked` by building a
synthetic SSG around each canary and asking the egress guard to refuse it.

**Problem**: those payloads had never been through the extractor. The number measured
the guard's `serialised.includes(canary)` string search, and would have reported a clean
`0 / 60` with the redactor deleted from the build entirely.

**Now** the audit runs `extractScreen()` over the actually-planted page and searches the
actual bytes. Three numbers, because no one of them is a privacy property alone:

| | Question | Component |
|---|---|---|
| `leaked` | did anything personal survive into the payload? | the **redactor** |
| `requiredObserved` | did the harvester read every surface it should? | the **reader** |
| `guardBlocked` | would the guard have refused it anyway? | the **guard**, independently |

Running the real extractor mid-session is only safe because of a second change:
`extractScreen({ ephemeral: true })` uses a throwaway vault and touches neither the
element registry nor the overlay. Otherwise an audit during a live task would renumber
the tokens a plan refers to, or wipe the vault outright, and the next `value_ref` the
server sent back would be refused as an unknown token.

### Decision 2b — two kinds of plant, because one cannot answer both questions

Turning on the real measurement immediately reported **25 of 60 leaked**, and that
number was correct in a way that made the metric wrong.

`canary.ts` deliberately makes canaries conspicuous rather than PII-shaped, and its
reasoning is sound: *"a canary that resembles real PII would be caught by the detectors,
which would prove nothing about the surfaces — the point is to test whether the pipeline
SEES a surface."* But the consequence is that `PRAHARICANARY3F0A…` is not personal data,
no detector claims it, and a Tier-1 payload legitimately carries page text. Those 25
were correct behaviour.

So the audit now plants **two** sets:

- the conspicuous canaries, scoring `observed` — can the harvester see this surface?
- one **checksum-valid synthetic Aadhaar per surface** (`generatePiiCanaries`), scoring
  `leaked` — does the redactor remove personal data found on this surface?

Neither set can do the other's job. Together they can both fail.

### Decision 2c — plant the awkward surfaces honestly

`css_content` was planted as a `data-css-canary` attribute and `same_origin_iframe` as a
`<span>`. Both are surfaces the harvester reads trivially, so both reported 5/5 observed
while neither CSS nor an iframe was ever involved.

They are now real `::after` content and a real `srcdoc` iframe, and they come back
**unobserved** — which is the truth, because nothing reads computed styles and
`all_frames` is `false`. The report distinguishes surfaces that are expected to be read
today (`HARVEST_REQUIRED_SURFACES`) from those that are known gaps, so a 60/60 that was
partly theatre is replaced by a smaller number that is entirely real.

Also fixed: `take()` did not consume, so the `data_attribute` canaries were planted
twice — on the synthetic host *and* on real page fields — with the same five values. The
second plant could never fail independently because the first satisfied it.

## Decision 3 — a token is something the vault minted

`⟦` and `⟧` are ordinary characters. A hostile page could write `⟦AADHAAR_1⟧` into its
own text; there is no PII inside that string, so it survived redaction untouched and
reached the planner indistinguishable from a real reference.

Nothing leaked — the vault refuses to resolve a token it never issued, and
`injection-defence.test.ts` covers that — but the planner could be handed fabricated
references, which is a planning-integrity attack in the same family as the S-05
injection. Worse, the egress guard's check 6 documented itself as catching *"a token
forged into page text"* and structurally could not: `countDistinctTokens` built the
manifest by scanning the payload for tokens, so a forged one was dutifully declared and
then compared against itself.

Two changes, and the second is the one that matters:

1. `neutralizeTokens()` folds the brackets to their fullwidth lookalikes on every
   page-derived string entering the SSG. One character for one character, so the
   redactor's offset map is undisturbed.
2. The manifest is derived from **the tokens the vault actually minted**, not from the
   tokens the payload happens to contain. The vault is ground truth no page can reach,
   so check 6 can now fail in the direction it advertises.

## Decision 4 — the browser suite starts its own server

`playwright.config.ts` declared no `webServer`, so `pnpm test:e2e` — and therefore
`pnpm verify`, described in `TODO.md` as *the merge gate* — failed on a clean checkout,
and the CI job ran the same command with nothing listening. The suite passed only for
someone who happened to have `pnpm server:mock` open in another terminal.

It now starts the mock server itself, with `reuseExistingServer` so a real FastAPI
server can stand in when that is what is being exercised.

---

## What this costs

The headline canary number gets smaller and more specific: `0 / 12 leaked` against
checksum-valid identifiers, beside `45 / 45 read` on surfaces we can actually read,
rather than `0 / 60 leaked` measured against a string search. That is a worse slide and
a much better claim, and the difference is exactly the kind a judge is entitled to probe.

The ledger grows two rows per step instead of one. `MAX_ENTRIES` is 2000 and the
retention window is 30 days, so this halves the history at the bound — acceptable, and
cheaper than a record that cannot be trusted.

## Follow-up

- **H3** should assert `requiredObserved === requiredTotal` as well as `leaked === 0`,
  or the blocking canary job inherits the vacuity this ADR removes.
- `observed` currently measures `harvestSurfaces` over `document.querySelectorAll('*')`,
  while extraction only applies it to interactive elements. The two should be the same
  walk, or `observed` overstates extraction's reach on non-interactive nodes.
- The `attempted`/`sent` pairing gives F8 (metrics) a real delivery-success rate for
  free. It should be reported rather than assumed, in the same spirit as
  `schema_validity_first_try`.
