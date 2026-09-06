# MANTRI — the PRAHARI planning server

Takes a Sanitized Screen Graph, reasons over it, returns an action plan. It never sees
personal data; it plans with typed references the client alone can resolve.

**Status: running.** FastAPI + generated Pydantic models + ingress guard + the
prompt/validation layer, 46 tests. Not yet wired to a model — that needs an API key.

---

## Setup

Python 3.12 is required. On Windows the `py` launcher usually has it even when
`python` on PATH is older:

```bash
py -3.12 -m venv .venv
./.venv/Scripts/python.exe -m pip install -r requirements.txt   # or see pyproject
```

### The API key

We run against a **cloud-hosted endpoint of open weights** during development. R9
permits this explicitly: *"During SIH they can use cloud hosted version of these
models."* The offline `docker compose` for the air-gapped claim is ticket F2.

```bash
# OpenRouter (or any OpenAI-compatible base URL)
setx PRAHARI_LLM_API_KEY  sk-or-v1-...
setx PRAHARI_LLM_MODEL    qwen/qwen2.5-vl-72b-instruct
setx PRAHARI_LLM_BASE_URL https://openrouter.ai/api/v1
```

Reopen the shell after `setx`. The key is read from the environment only: it is never
written to a file in this repo, never logged, never returned in an error, and never
reaches the extension bundle — the extension talks to *this* server, which talks to
the provider.

Models worth trying, in order:

| Model | Why |
|---|---|
| `qwen/qwen2.5-vl-72b-instruct` | Best Qwen-VL generally available on OpenRouter |
| `qwen/qwen2.5-vl-7b-instruct` | Closest to what the air-gapped box will actually run |
| `qwen/qwen3-vl-8b-instruct` | If the provider has it — the documented primary |

The 7B number is the one that matters for the submission, because that is what fits on
one GPU offline. Run the spike against both and report both.

### Run

```bash
./.venv/Scripts/python.exe -m app.main          # http://127.0.0.1:8080
./.venv/Scripts/python.exe -m pytest tests/ -q  # 46 tests
```

Point the extension at it by rebuilding with `PRAHARI_SERVER_ORIGIN=http://localhost:8080`
(the default already matches).

---

## Spike S-05 — the one that can still invalidate the architecture

```bash
./.venv/Scripts/python.exe -m spikes.s05_ssg_reasoning
```

`PHASEWISE.md` frames S-05 as "does guided decoding produce valid JSON". That is the
easy half. The half that matters is whether the model plans **correctly** over
`⟦CLASS_N⟧` references it cannot read. Seven cases, each a behaviour the architecture
depends on:

| Case | If it fails |
|---|---|
| `filled-field-is-filled` | The server treats redaction as deletion. The central claim is false. |
| `reverse-channel` | `value_ref` is not understood; the demo's best moment does not work. |
| `credential-cannot-be-resolved` | The model asks for values nothing can produce. |
| `no-invented-targets` | It clicks things that do not exist. Unsafe on a real portal. |
| `prompt-injection-in-page-text` | The fence is insufficient — the client's sink binding is load-bearing, and we must say so. |
| `coreference-across-the-page` | Multi-step reasoning over redacted screens breaks down. |
| `low-coverage-humility` | It acts confidently on screens it was told it cannot see. |

Writes `docs/metrics/s05-ssg-reasoning.md`, including the actual plans, so the results
are inspectable rather than asserted.

---

## Layout

```
app/
  main.py              request path: schema -> ingress guard -> prompt -> model -> post-validate
  schemas/             GENERATED from packages/ssg/schema. Never hand-edit (RULES.md C1)
  guards/ingress_pii   Python mirror of the client L1 pack (F4)
  agents/
    grounder.py        prompt assembly + post-validation
    prompts/system.md  the redaction contract taught to the model
  llm/client.py        OpenAI-compatible client with the decode-tier ladder
spikes/                S-05
tests/                 46 tests, no API key needed
```

### Regenerating the models after a schema change

```bash
./.venv/Scripts/python.exe -m datamodel_code_generator \
  --input ../packages/ssg/schema/ssg-v1.json --input-file-type jsonschema \
  --output app/schemas/ssg.py --output-model-type pydantic_v2.BaseModel \
  --target-python-version 3.12 --use-standard-collections --use-union-operator \
  --class-name SanitizedScreenGraph
```

---

## Two things to know about this server

**The ingress guard is not defence against a hostile client.** A hostile client would
simply not send us the data. It is defence against *our own bugs*, which is the
failure mode that actually happens, and it is the honest answer to "how do you know
your redactor works" — the receiver checks, independently, every time. It had already
caught a real drift: the mock server's pack was missing `PHONE_IN`, `GSTIN` and `IFSC`
that the client caught, on day one. That is what `tests/test_parity.py` now prevents.

**Schema validity is measured, not assumed.** `IMPLEMENTATION-PLAN.md` F3 assumes
vLLM + XGrammar, which makes invalid output structurally impossible. Cloud endpoints
expose at most OpenAI-style `response_format`, so `llm/client.py` tries three tiers —
strict JSON schema, JSON mode, then validate-and-retry with the validator's complaint
fed back — and records which one ran. `/v1/metrics` reports the real first-try rate.
Do not quote 100% until we are on self-hosted vLLM.
