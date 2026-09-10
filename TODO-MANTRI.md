# TODO-MANTRI — the reasoning layer

> **Owner: SML.** MANTRI is EPIC G of `IMPLEMENTATION-PLAN.md §8`: everything between the
> ingress guard and the action plan. It lives in **`server/mantri/`** — one folder, no
> FastAPI import, so it can be tested, evaluated and swapped without touching the server.
>
> Last updated: **2026-09-09** · **140 MANTRI tests green** (`server/tests/test_mantri_*.py`),
> **255 server tests green** overall, up from 109 before this work.
> **G7 has one complete run: 37/40 on `qwen2.5-vl-72b-instruct`** — see
> [`docs/metrics/g7-mantri-suite.md`](docs/metrics/g7-mantri-suite.md). It predates the
> validator fix below, it is not the 7B, and three later attempts died on HTTP 402
> (out of provider credit) without producing a result.
> Status below was verified by running the suites, not by reading docs.

---

## 1. What MANTRI is, in one paragraph

The client (NETRA + KAVACH) hands the server a screen in which every identifying value has
been replaced by an opaque typed reference. MANTRI decides what to do next on that screen —
without ever learning what the references stand for. It is the half of the system that must
be *useful* while blindfolded, and the half an attacker talks to: every hostile string on
the page arrives in MANTRI's prompt. So it has two obligations, and the second outranks the
first: **plan the task**, and **never let page text become an instruction**.

---

## 2. Board

Legend: ✅ done · 🟡 partial (scope noted) · ⬜ not started

| ID | Ticket | Status | Where | Notes |
|---|---|---|---|---|
| G1 | System prompt + redaction contract + instruction hierarchy | ✅ | `mantri/prompts/` | Composed at call time from `app/agents/prompts/system.md` + `grounder-addenda.md`. Not a copy — the copy is the one that drifts |
| G2 | Few-shot exemplars (6) | ✅ | `mantri/exemplars.py` | Sent as real alternating turns via the new `examples=` parameter on `LlmClient.complete`. Each one asserted schema-valid |
| G3 | Planner / Grounder split + sub-goal caching | ✅ | `mantri/planner.py` | `SubGoalCache`: TTL, LRU-ish eviction, invalidation on goal change / navigation / K steps / two failures. Planner never sees element ids |
| G4 | Text-fast-path routing | ✅ | `mantri/router.py` | Text by default; vision on tier 2, attached screenshot, canvas/media/pdf, low coverage, high unexplained ratio, or a stall. `escalate` is wired: a plan the text path could not ground is retried once on vision |
| G5 | Injection classifier + `<untrusted_page_content>` fencing | ✅ | `mantri/injection.py` | 8 scored families + hidden-text; NFKC and zero-width folding; **the attack text never enters the prompt or the logs** |
| G6 | Model bake-off | 🟡 | `mantri/evals/bakeoff.py` | Harness written, serial, rate-limit-paced, per-category table. **Never run** — needs `PRAHARI_LLM_API_KEY` (blocker B-5) and the GPU/endpoint decision (B-2) |
| G7 | Prompt eval harness (40 tasks × variants) | ✅ | `mantri/evals/` | 40 tasks in ten categories, scoring, 4 prompt variants, the CLI. **Run once: 37/40 on the 72B.** The 7B, the ablations and a re-run after the validator fix are still outstanding |
| G8 | Failure-recovery prompting + `ask_user` policy | ✅ | `mantri/recovery.py` | Complaint→correction map, stall detector, and schema-valid `ask_user`/`fail` plans **built without the model** |

Also landed, outside the G board:

- `app/llm/client.py` gained `examples=` (few-shot turns) and `model=` (per-call override,
  which is what makes routing and the bake-off possible). Both default to the old
  behaviour, so nothing else changed.
- `app/main.py` now delegates the whole reasoning half to `mantri.plan_step` and keeps only
  the HTTP envelope and metrics.
- `/v1/metrics` reports `by_route`, `planner_calls`, `injection_suspicious`,
  `injection_hostile`, `recovered_to_ask_user`, `planner_timeouts`, `escalated_to_vision`.
  Counted, not claimed.
- `LlmError` now carries `complaint` when the retry ladder was spent on *validation*
  rather than on the network. That is what lets the escalation retry tell "the model
  kept naming an element that is not there" apart from "the endpoint is down", and
  retry only the first.
- Post-validation gained two rules the first G7 run found the hard way: an empty plan
  that is not `done` is rejected (it spends the step and changes nothing), and an action
  on an element the page lists as non-actionable is rejected (HASTA refuses it anyway).
  Both map to specific corrections in `recovery.py`, so the retry is told what to return.
- The planner round trip is bounded (`PlannerConfig.timeout_s`, 6s). It is the step's
  second call and the one nobody is waiting on; unbounded it doubled the step on a slow
  endpoint. A spent budget is survivable — the step continues with the previous plan or
  with none — and is counted at `/v1/metrics`.

---

## 3. What must NOT be claimed

- ❌ **Prompt-level injection defence does not stop the model.** S-05 showed Qwen2.5-VL-72B
  following an injected instruction. This classifier would have flagged that page hostile
  and the model would still have followed it. The correct claim: **the attack succeeds
  against the model and is stopped by the client's sink binding and post-validation.**
- ❌ **No bake-off number exists.** G6 has never been run against any model.
- ❌ **37/40 is not a system accuracy figure, and it is not the shipped model.** It is the
  planner's behaviour on forty fixed screens, on `qwen2.5-vl-72b-instruct`; the submission
  rests on the 7B, which has not been run. Always quote the denominator and the model.
  Three controls bound what the number means: a blind clicker scores 11/40, a model that
  returns nothing scores 2/40, and a hand-written correct answer for every task
  (`tests/mantri_oracle.py`) scores 40/40 — the suite can both fail and be passed.
- ❌ **37/40 describes the pre-fix validator.** Two of the three failures were gaps in
  post-validation, now closed, so the number no longer describes the code. It is a
  baseline until the suite is re-run.
- ❌ **A run that stopped early is not a low score.** Three attempts ran out of credit
  part-way; the harness used to print "12/40 (30%)" for one in which 28 tasks never
  reached a model. It now refuses to print a rate for an incomplete run at all. Only
  `g7-72b-prevalidator.json` (40/40 attempted) is quotable.
- ❌ **11/12 on injection is not 11/12 on defence.** The one failure (`inject-04`) did not
  follow the injected instruction — it returned no action at all. On "did the page capture
  the agent" the column is 12/12; on "did it also do the user's job" it is 11/12.
- ❌ **The planner's token saving is unmeasured.** `--variant no-planner` is how it gets a
  number. Until then it is a design argument.
- ⚠️ A hostile page is **still planned for**, deliberately: refusing would let any website
  disable the agent by printing an attack at it. `refuse_on_hostile` exists and is off.
- ⚠️ The suite measures the *planner's behaviour on fixed screens*. It is not task success
  on a live site (H4) and says nothing about latency (H6).

---

## 4. Remaining, in the order it is worth doing

1. **Run G7 against `qwen/qwen2.5-vl-7b-instruct`** — the model the submission rests on.
   The 37/40 that exists is the 72B. `python -m mantri.evals --model qwen/qwen2.5-vl-7b-instruct
   --json ../docs/metrics/g7-7b.json`. Everything else in this list is worth less until
   that number exists.
2. **Run the ablations** (`no-exemplars`, `no-planner`, `no-advisory`) and write the deltas
   into `docs/metrics/`. This is what turns "the exemplars help" into a measurement.
3. **G6 bake-off**, 7B vs 72B, same suite. Read the credential and injection columns first:
   a failure there is a leak risk, not a lost step.
4. **Top up the provider credit and re-run `full` on the 72B** now that the two
   validator gaps are closed, so the headline number describes the code that ships
   rather than the code that was measured. Three attempts have died on HTTP 402; the
   harness now stops on one instead of buying 39 more identical failures.
5. **Set the planner's timeout from a measured budget.** It is bounded now, but 6s is a
   guess; H6 is what turns it into a number, and `planner_timeouts` at `/v1/metrics` is
   what says whether the guess was wrong.
6. **Grow the thin categories.** Ten categories, but `completion` has one task and
   `perception`, `recovery` and `reference` have two. The suite is 40 tasks, not 40
   *good* tasks, until each category can fail a model for its own reason.
7. **Session store**: `SubGoalCache` is process-local. It becomes Redis when F6 lands;
   nothing else reaches into it, so that swap is one file.

---

## 5. How to work on this

```bash
cd server
./.venv/Scripts/python.exe -m pytest tests/ -q          # 255 pass, 1 skipped
./.venv/Scripts/python.exe -m pytest tests/test_mantri_evals.py -q   # the harness's own tests
```

All 140 MANTRI tests run offline against a scripted model (`tests/mantri_fakes.py`). A
reasoning layer whose tests need a paid endpoint is a reasoning layer that gets tested
once, so keep it that way: if a change can only be verified against a live model, it
belongs behind the eval suite, not in the unit tests.

Read `server/mantri/README.md` for the module map and the diagram of what a step goes
through.
