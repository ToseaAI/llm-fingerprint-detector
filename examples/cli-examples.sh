#!/usr/bin/env bash
# CLI usage examples. Keys always come from environment variables — never
# paste keys into files or shell history.
set -euo pipefail

# After `npm install -g llm-fingerprint-detector` use `llm-fingerprint ...`;
# inside this repo use `node dist/cli.js ...` (shown here via npx).
LLM_FP="npx llm-fingerprint"

# --- 0. Explore ---------------------------------------------------------------
$LLM_FP --help
$LLM_FP references                      # bundled sample reference fingerprints

# --- 1. Fingerprint the official API and save a trusted reference --------------
# export OPENAI_API_KEY=sk-...          # ← set in your shell / CI secret store
$LLM_FP fingerprint \
  --base-url https://api.openai.com/v1 \
  --model gpt-4o-mini \
  --preset standard \
  --out reference.gpt-4o-mini.json

# --- 2. Verify a cheap reseller claims honestly --------------------------------
# export LLM_FINGERPRINT_API_KEY=sk-...  # key for the endpoint under test
$LLM_FP verify \
  --base-url https://cheap-llm-reseller.example.com/v1 \
  --model gpt-4o-mini \
  --reference reference.gpt-4o-mini.json
# exit codes: 0 match · 2 mismatch · 3 uncertain · 4 insufficient · 1 error

# --- 3. Quick demo against a bundled sample reference --------------------------
$LLM_FP verify \
  --base-url https://openrouter.ai/api/v1 \
  --model openai/gpt-4o-mini \
  --reference openai/gpt-4o-mini \
  --preset quick --json

# --- 3b. OrcaRouter Cyber Inference (named provider) ---------------------------
# export ORCAROUTER_API_KEY=...  # sk-orca-* key; see https://www.orcarouter.ai/console/keys
$LLM_FP providers                       # preset, default model and key links
# Live model picker: lists chat-capable models from the provider /models endpoint
$LLM_FP fingerprint --provider orcarouter --model '?' --preset quick
# Or name a model explicitly (default: orcarouter/auto; cyber: orca/orcacyber-zero-1.5)
$LLM_FP verify --provider orcarouter --model orcarouter/auto \
  --reference openai/gpt-4o-mini --preset quick --json

# --- 4. Offline: compare two saved fingerprints --------------------------------
$LLM_FP compare reference.gpt-4o-mini.json some-other.fingerprint.json

# --- 5. Custom cell selection ---------------------------------------------------
$LLM_FP fingerprint \
  --base-url https://api.deepseek.com/v1 \
  --model deepseek-chat \
  --api-key-env DEEPSEEK_API_KEY \
  --cells random-number-1-100:en,random-number-1-100:zh,random-color:en,coin-flip:en \
  --samples 30 --json
