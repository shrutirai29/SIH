# MANTRI — the reasoning layer

> EPIC G of `IMPLEMENTATION-PLAN.md`. Everything between the ingress guard and the
> action plan. Tracker: [`TODO-MANTRI.md`](../../TODO-MANTRI.md).

MANTRI decides what to do next on a screen it is not allowed to understand. The client
(NETRA + KAVACH) has already replaced every identifying value with an opaque typed
reference, so this package plans over `⟦AADHAAR_1⟧` and never learns what it stands for.

It imports no FastAPI, opens no socket and holds no request state. That is what lets the
whole reasoning layer be evaluated offline and tested with a scripted model, rather than
only against a live paid endpoint.

## The path a step takes

```
        app/main.py: schema -> ingress guard -> image sanity
                                     |
                                     v
   injection.py   screen the page's own strings, score, build an advisory
        |
   router.py      text fast path, or vision because the description is incomplete
        |          (and, after a plan that would not ground, a second look on vision)
        |
   planner.py     the sub-goal to work on (cached; the planner runs rarely)
        |
   pipeline.py    assemble: [plan] [security] [recovery] [perception] + fenced screen
        |
   exemplars.py   six worked examples, as real alternating turns
        |
        v                                                app/llm/client.py
   grounder validator (app/agents/grounder.py)  <->  decode ladder + retries
        |
   recovery.py    a hint on failure; a server-built ask_user when the ladder is spent
        |
        v
   ActionPlan  ->  HASTA, which re-checks all of it on the user's machine
```

## Files

| File | Ticket | What it is |
|---|---|---|
| `injection.py` | G5 | 8 scored signal families and the structural fence. **The advisory never quotes the attack** — a quoted attack is a second delivery of it, inside the trusted half of the prompt. |
| `router.py` | G4 | Text fast path vs vision. An attached screenshot is never routed down to a text model; `escalate` is the retry after a plan that did not ground. |
| `planner.py` | G3 | Planner/grounder split, `SubGoalCache` with TTL and invalidation on goal change, navigation, drift and repeated failure. The round trip runs under `PlannerConfig.timeout_s`. |
| `recovery.py` | G8 | Complaint→correction hints, the stall detector, and schema-valid `ask_user` / `fail` plans built without the model. |
| `exemplars.py` | G2 | Six exemplars, each asserted schema-valid by the test suite. |
| `prompts/` | G1 | The MANTRI addenda, composed at call time with the base redaction contract in `app/agents/prompts/system.md`. |
| `pipeline.py` | — | The facade. `app/main.py` calls `plan_step` and does nothing else with reasoning. |
| `evals/` | G6, G7 | 40-task suite, scoring, prompt ablations, model bake-off. |

## Running the evals

```bash
export PRAHARI_LLM_API_KEY=...                # the suite evaluates a model
python -m mantri.evals                        # full variant
python -m mantri.evals --variant no-exemplars # what do the exemplars buy?
python -m mantri.evals --bakeoff qwen/qwen2.5-vl-7b-instruct,qwen/qwen2.5-vl-72b-instruct
python -m mantri.evals --json ../docs/metrics/g7-full.json
```

Exit code is non-zero on any failing task, so it can gate CI once it is green.

## Things that are true and inconvenient

- **This package does not stop prompt injection.** Spike S-05 put an injected
  instruction in front of Qwen2.5-VL-72B and the model followed it. `injection.py` would
  have flagged that page as hostile and the model would still have followed it. What
  stopped the attack was the client's sink binding. Say *"the attack succeeds against the
  model and is stopped by the client"*.
- **A hostile page is still planned for.** Refusing to act on a screen that scores
  hostile would hand every website a switch that turns the agent off. The advisory goes
  in, the event is counted at `/v1/metrics`, and the step proceeds.
- **The suite has been run once: 37/40 on `qwen2.5-vl-72b-instruct`**
  (`docs/metrics/g7-mantri-suite.md`). That is not the 7B the submission rests on, it is
  not a system accuracy figure, and it predates the two post-validation rules the run
  itself exposed. Quote the denominator and the model.
- **Two of that run's three failures were ours, not the model's.** An empty plan and an
  action on a disabled control both passed post-validation on the first attempt, so the
  retry ladder never ran. Closed as rules 1b and 7 in `agents/grounder.py`.
- **No bake-off has been run.** G6 is a harness, not a result.
- **The planner's token saving is unmeasured.** `--variant no-planner` is how it gets a
  number; until then it is a design argument, not a claim.

## Tests

`tests/test_mantri_*.py`, 140 of them, all offline. The ones to read first:

- `test_mantri_injection.py::test_advisory_never_quotes_the_attack`
- `test_mantri_exemplars.py::test_every_exemplar_is_schema_valid`
- `test_mantri_pipeline.py::test_our_blocks_sit_above_the_fence_and_page_text_below_it`
- `test_mantri_evals.py::test_a_model_that_clicks_blindly_fails_most_of_the_suite` —
  the harness is tested by making it fail, because a harness nobody has seen fail is a
  harness nobody should quote (ADR-0004). It scores 11/40; an idle model scores 2/40.
- `test_mantri_evals.py::test_every_task_in_the_suite_can_actually_be_passed` — the
  other half: a hand-written answer for every task (`tests/mantri_oracle.py`) scores
  40/40 through the real pipeline and the real grounder validator, so a task no plan
  could satisfy cannot hide in the denominator.
