# llm-fingerprint-detector

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >= 18.17](https://img.shields.io/badge/node-%E2%89%A5%2018.17-brightgreen.svg)](package.json)
[![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20deps-0-success.svg)](package.json)
[![Paper: arXiv:2607.10252](https://img.shields.io/badge/paper-arXiv%3A2607.10252-b31b1b.svg)](https://arxiv.org/abs/2607.10252)

**Is that API really serving the model it claims?** Fingerprint and verify any OpenAI-compatible LLM endpoint from single-token output distributions — no logits, no weights, no privileged access. Just ~100–400 cheap one-word completions. Catches **model substitution**, silent quantization and server-side prompt injection by API resellers, gateways and aggregators.

An independent, open-source TypeScript implementation of:

> Tomáš Bruckner, **"One Token Is Enough: Fingerprinting and Verifying Large Language Models from Single-Token Output Distributions"**, [arXiv:2607.10252](https://arxiv.org/abs/2607.10252).
> Dataset: [DOI 10.5281/zenodo.21278557](https://doi.org/10.5281/zenodo.21278557) (CC-BY-4.0) · Paper code: [DOI 10.5281/zenodo.21278793](https://doi.org/10.5281/zenodo.21278793) (MIT)

This package is **not affiliated with the paper's author** — it is a from-scratch implementation of the published method, engineered as a reusable library + CLI. If you use the method in research, cite the paper.

- **Zero runtime dependencies** — Node ≥ 18 built-in `fetch`, nothing else
- **Named providers** — e.g. `--provider orcarouter` for OrcaRouter Cyber Inference (see [Named providers](#named-providers))
- **Library + CLI** — embed it, or run `llm-fingerprint verify` in CI
- **Reasoning-model aware** — auto-detects how to disable hidden "thinking" (OpenRouter / Zhipu / OpenAI-style), with a graceful fallback
- **Filter-resistant probes** — every probe is a plain semantic question drawn from a paraphrase pool; there is no magic string a gateway can special-case
- **Bundled sample references** for 11 popular models, derived from the paper's public dataset

> Prefer a no-install web version? Try the free online checker: **[tosea.ai/free-tools/llm-api-fingerprint-checker](https://tosea.ai/free-tools/llm-api-fingerprint-checker)** — same method, runs entirely in your browser.

---

## How it works

LLMs answer "*Name a random number between 1 and 100*" with model-specific, surprisingly stable biases (GPT-family models love 42 and 73; other families prefer 57, 37, 7…). The paper's key result: the **empirical distribution of one-word answers** across a small battery of such tasks is a reliable *behavioral fingerprint* — stable across time, load and providers for the same model, and clearly different between models.

```
 probe battery (task × language cells)      collect at temperature 1.0
 ┌──────────────────────────────┐           ┌─────────────────────────┐
 │ random number 1-100 (en/zh)  │           │ "42" ×19  "73" ×4  ...  │
 │ random color / letter / city │  ──25×──▶ │ per-cell answer         │
 │ coin flip / animal / fav-num │           │ distributions           │
 └──────────────────────────────┘           └───────────┬─────────────┘
                                                        ▼
                reference fingerprint  ──── mean per-cell Jensen-Shannon
                (trusted endpoint)          divergence (base 2) ──▶ verdict
```

1. **Probe** — ask one-word questions (random numbers, colors, letters, coin flips…) in English and Chinese, `temperature=1.0`, `max_tokens=16`, a fixed minimal system prompt, hidden reasoning disabled. Requests are shuffled and paraphrased per call.
2. **Normalize** — NFC, punctuation/emoji stripping, case folding, first word, digit unification (`seven`/`七`/`٧`/`７` → `7`), color and coin-word canonicalization; answers are classified valid / invalid / refusal / empty.
3. **Compare** — per-cell Jensen-Shannon divergence (base 2, range 0–1 bit), averaged over cells where both sides have ≥10 valid samples.
4. **Verdict** — three bands calibrated against the paper's baselines (see [Interpreting results](#interpreting-results)).

## Install

```bash
npm install llm-fingerprint-detector    # library + `llm-fingerprint` CLI
# or run the CLI ad hoc:
npx llm-fingerprint-detector --help
```

Requires Node ≥ 18.17 (built-in `fetch`). The core library is runtime-agnostic and also works in browsers/edge runtimes; only the CLI and the bundled-reference loader touch the filesystem.

## Quick start — CLI

```bash
# 1. Fingerprint the endpoint you trust (key read from OPENAI_API_KEY)
export OPENAI_API_KEY=sk-...
llm-fingerprint fingerprint \
  --base-url https://api.openai.com/v1 \
  --model gpt-4o-mini \
  --out reference.gpt-4o-mini.json

# 2. Verify the endpoint you don't
export LLM_FINGERPRINT_API_KEY=sk-...   # key for the endpoint under test
llm-fingerprint verify \
  --base-url https://cheap-llm-reseller.example.com/v1 \
  --model gpt-4o-mini \
  --reference reference.gpt-4o-mini.json
```

```
Verdict: MISMATCH — behavior differs from the reference
Mean JSD: 0.481 over 8 comparable cell(s)

Interpretation scale (paper baselines, arXiv:2607.10252):
  same model ≈ 0.14 · same model, other provider ≈ 0.227 · different model ≈ 0.463
  thresholds: match ≤ 0.25 < uncertain ≤ 0.35 < mismatch

Per-cell JSD (most divergent first):
  random-number-1-100:en     0.712  (24 vs 25 valid)
  ...
```

Exit codes are CI-friendly: `0` match · `2` mismatch · `3` uncertain · `4` insufficient · `1` error. API keys are only ever read from environment variables (`--api-key-env NAME`, defaulting to `LLM_FINGERPRINT_API_KEY` then `OPENAI_API_KEY`) and are never logged.

More: `llm-fingerprint --help`, [`examples/cli-examples.sh`](examples/cli-examples.sh).

## Named providers

`--provider <id>` skips the manual base-URL / key-variable / model wiring. `llm-fingerprint providers` lists every named provider (also `--json`).

### OrcaRouter Cyber Inference (`--provider orcarouter`)

[OrcaRouter](https://www.orcarouter.ai) is an OpenAI-compatible AI gateway that routes many providers behind one endpoint. The **OrcaRouter Cyber Inference** provider targets security teams doing authorized red/blue-team work — pentests, audits and model-verification pipelines — whose inference requests generic gateways often refuse or silently degrade.

| | |
|---|---|
| Provider page | <https://www.orcarouter.ai/cyber> |
| Cyber-tier model catalog | <https://www.orcarouter.ai/models?tier=cyber> |
| Base URL | `https://api.orcarouter.ai/v1` |
| API key | `ORCAROUTER_API_KEY` (an `sk-orca-` key), or `--api-key-env NAME` — create/revoke at <https://www.orcarouter.ai/console/keys> |
| Default model | `orcarouter/auto` — automatic routing, works with any key |
| Dedicated cyber models (verified security teams) | `orca/orcacyber-ultra-1.0` (security code scanning, large-codebase multi-step reasoning), `orca/orcacyber-zero-1.5` (OrcaCyber harness; `orca/orcacyber-zero-1.0` also available) |
| General fallback | `orcarouter/fusion` |

```bash
export ORCAROUTER_API_KEY=...                   # sk-orca-* key; never logged; read from the environment
llm-fingerprint providers                       # show the preset and key links

# Model picker bound to the live catalog: GET the provider's /models endpoint
llm-fingerprint fingerprint --provider orcarouter --model '?' --preset standard \
  --out orcarouter.reference.json

# Or name a model directly (ids are namespaced inside OrcaRouter):
llm-fingerprint verify --provider orcarouter --model orca/orcacyber-zero-1.5 \
  --reference openai/gpt-4o-mini --preset quick
```

With `--model '?'` the CLI asks `GET /v1/models` on the configured inference origin and lists only models that can answer a text chat completion (an `openai` / `anthropic` / `gemini` / `openai-response` endpoint type or none declared, text output, and the text input modality explicitly declared when the catalog has modality metadata). The provider's default and cyber models are listed first. The request is bounded (10 s timeout, 512 KiB, 500 entries); if discovery fails — bad key, network, timeout, malformed body — the CLI says so and offers only OrcaRouter's four verified seed models, each of which was confirmed against the live catalog. Live success is authoritative: seed entries are never mixed in. A bare model id is qualified into OrcaRouter's namespace (`gpt-4o-mini` → `orca/gpt-4o-mini`, `auto` → `orcarouter/auto`), and fingerprints collected this way record `meta.provider: "orcarouter"`.

## Quick start — library

```ts
import { fingerprint, compare, verify } from 'llm-fingerprint-detector'

// Collect a fingerprint
const run = await fingerprint(
  { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY },
  { cells: 8, samplesPerCell: 25, onProgress: (e) => console.log(e.done, '/', e.total) },
)
console.log(run.fingerprint)          // JSON-serializable artifact
console.log(run.splitHalfJsd)         // self-consistency (≈0.14 is normal)

// Verify another endpoint against it
const result = await verify(
  { baseUrl: 'https://suspect.example.com/v1', model: 'gpt-4o-mini', apiKey: process.env.SUSPECT_KEY },
  run.fingerprint,
)
console.log(result.verdict, result.meanJsd)   // 'match' | 'uncertain' | 'mismatch' | 'insufficient'

// Or compare two saved fingerprints offline
const distance = compare(fingerprintA, fingerprintB)
```

Bundled sample references (Node only):

```ts
import { listBundledReferences, loadBundledReference } from 'llm-fingerprint-detector/references'

const reference = loadBundledReference('openai/gpt-4o-mini')
const result = await verify(suspectEndpoint, reference)
```

Runnable examples: [`examples/01-fingerprint-endpoint.mjs`](examples/01-fingerprint-endpoint.mjs), [`examples/02-verify-endpoint.mjs`](examples/02-verify-endpoint.mjs).

## Tutorial: "Is my cheap API really GPT-4o / Claude / DeepSeek?"

You bought API access from a reseller/aggregator at half price. Are you getting the real model, a cheaper substitute, or a quantized clone? Ten minutes:

1. **Collect a trusted reference.** Fingerprint the *official* API (or any endpoint you fully trust) for the model in question:

   ```bash
   llm-fingerprint fingerprint --base-url https://api.openai.com/v1 \
     --model gpt-4o-mini --api-key-env OFFICIAL_KEY --out ref.json
   ```

   No official access? Start with a bundled sample (`llm-fingerprint references`) — good enough for a first signal, with the caveats below.

2. **Verify the suspect endpoint** with the *same* model id:

   ```bash
   llm-fingerprint verify --base-url https://reseller.example.com/v1 \
     --model gpt-4o-mini --api-key-env RESELLER_KEY --reference ref.json
   ```

3. **Read the verdict.**
   - `match` — the endpoint's one-token behavior is statistically consistent with your reference. That is strong (not absolute) evidence it's the same model.
   - `mismatch` — the behavior is as far from the reference as *different* models typically are. Common causes, in practice: a substituted cheaper model, a heavily quantized deployment, or an injected system prompt.
   - `uncertain` — the gray zone. Raise `--samples` (e.g. 40), use `--preset strict` (all 16 cells), or refresh your reference — models drift when providers ship updates.
   - Also watch the warnings: a high **split-half JSD** means the endpoint disagrees *with itself* between the first and second half of your own run — a classic sign of an aggregator rotating several backends.

4. **Re-run before you conclude anything.** Two independent mismatch runs on different days are a much stronger signal than one.

## Interpreting results

Distances are mean Jensen-Shannon divergence (base 2), so 0 = identical behavior, 1 = disjoint answer sets. Paper baselines:

| meanJsd | reading |
|---|---|
| ≈ 0.14 | same model, same endpoint (sampling noise floor) |
| ≈ 0.227 | same model, different provider (median) |
| **≤ 0.25** | → verdict **match** |
| 0.25 – 0.35 | → verdict **uncertain** |
| **> 0.35** | → verdict **mismatch** |
| ≈ 0.463 | different models (median) |

**Error rates (paper):** distinguishing same-model vs different-model pairs achieves an equal error rate of ≈ **10.6% with 8 cells** and ≈ **7.3% with 40 cells**. A single run is *evidence*, not proof — treat verdicts accordingly.

### Limitations you must know

- **Fingerprints drift.** Providers silently update models; a 3-month-old reference can legitimately mismatch today's deployment. Always check `collectedAt`, refresh references regularly.
- **You need a trusted reference.** The method compares two endpoints; it cannot conjure ground truth. If your reference is wrong, your verdict is wrong.
- **The system prompt must be identical on both sides.** Swapping only the system prompt shifts fingerprints by JSD ≈ 0.44–0.46 — the magnitude of a model swap. This tool pins the same minimal system prompt on both sides automatically; if an endpoint *injects* its own server-side prompt, that will (correctly) surface as divergence.
- **Reasoning fallback lowers confidence.** When hidden reasoning can't be disabled, the run is flagged `postReasoning` — distributions shift measurably in that channel.
- **Quantization/serving stack changes** the same weights can move distances into the uncertain band.
- **A mismatch is a statistical observation, not an accusation.** Do not treat any single verdict as proof of fraud by a provider; investigate, re-run, and compare notes before drawing conclusions.

## Bundled sample references

`data/reference-fingerprints.sample.json` ships fingerprints of 11 popular models (GPT-4o, GPT-4o-mini, GPT-4.1-mini, Claude Sonnet 4.5, Gemini 2.5 Flash, DeepSeek-chat, Llama-3.1-8B, Qwen3-30B-A3B, Mistral Small 3.2, GLM-4.5, Kimi K2), derived from the paper's public dataset:

> Bruckner, T. (2026). *Single-token output distributions as behavioral fingerprints of large language models* [Data set]. Zenodo. [https://doi.org/10.5281/zenodo.21278557](https://doi.org/10.5281/zenodo.21278557) — CC-BY-4.0. Counts reconstructed from the published per-cell distributions and re-normalized with this package's normalizer (see [`scripts/build-sample-references.mjs`](scripts/build-sample-references.mjs)).

Those samples were collected by the paper's harness (via OpenRouter) under the paper's prompt protocol — close to, but not identical to, this package's battery. `compare()` flags such pairs with `protocolMismatch: true` and the verdict should be read as *indicative*. For anything that matters, collect your own reference:

```bash
llm-fingerprint fingerprint --base-url <trusted-url> --model <id> --out my-reference.json
```

To rebuild or extend the bundled samples from the Zenodo dataset, download the dataset, then:

```bash
npm run build
node scripts/build-sample-references.mjs path/to/distributions.json --models openai/gpt-4o,another/model
```

## API surface (TypeScript, fully typed)

| export | what it does |
|---|---|
| `fingerprint(endpoint, options?)` | probe an endpoint → `FingerprintRun` (fingerprint, adapter, split-half, warnings) |
| `compare(a, b)` | two fingerprints → `ComparisonResult` (meanJsd, per-cell JSD, verdict, baselines) |
| `verify(endpoint, reference, options?)` | fingerprint + compare in one call → `VerifyResult` |
| `normalizeAnswer(raw, domain)` | the full normalization pipeline (pure, unit-tested) |
| `jensenShannonDivergence(p, q)` | base-2 JSD over count maps |
| `splitHalfJsd(samplesByCell)` | endpoint self-consistency check |
| `detectReasoningAdapter(endpoint)` | which reasoning-disable field the endpoint accepts |
| `PROBE_TASKS`, `CELL_PRIORITY_ORDER`, `SYSTEM_PROMPTS` | the battery itself |
| `llm-fingerprint-detector/references` | bundled sample loader (Node only) |

All options (`cells`, `samplesPerCell`, `concurrency`, `timeoutMs`, `maxRetries`, `signal`, `onProgress`, …) are documented in [`src/types.ts`](src/types.ts).

## Development

```bash
git clone https://github.com/ToseaAI/llm-fingerprint-detector.git
cd llm-fingerprint-detector
npm install
npm run build     # tsc → dist/
npm test          # builds, then runs node --test against the built output
```

No test framework, no bundler — TypeScript and the Node built-in test runner only.

## Contributing

Issues and PRs are welcome. Especially valuable:

- **More named providers** in `src/providers/` (mirror the OrcaRouter preset: base URL, key env var, default model, reasoning hint) with tests
- **More languages** in the probe battery (the paper also used Arabic and Russian) — requires matching normalizer support, see `src/normalizer.ts`
- **Reference fingerprints** for more models/providers, collected with this tool's protocol (`one-token/v1`) and a documented date/channel
- **Threshold calibration data**: pairs of same-model / different-model runs to sharpen the match/mismatch cut points

Please keep changes dependency-free and covered by `node --test` tests.

## Citation & license

Method: cite the paper —

```bibtex
@article{bruckner2026onetoken,
  title   = {One Token Is Enough: Fingerprinting and Verifying Large Language Models
             from Single-Token Output Distributions},
  author  = {Bruckner, Tom{\'a}{\v s}},
  journal = {arXiv preprint arXiv:2607.10252},
  year    = {2026}
}
```

This package: [MIT](LICENSE). Bundled sample data: CC-BY-4.0, © Tomáš Bruckner (see above).

---

*Built and maintained by [Tosea.ai](https://tosea.ai). Want the zero-setup version? → [LLM API Fingerprint Checker](https://tosea.ai/free-tools/llm-api-fingerprint-checker) (runs in your browser, your key never leaves it).*
