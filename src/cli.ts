#!/usr/bin/env node
/**
 * llm-fingerprint — CLI for fingerprinting and verifying LLM endpoints.
 *
 * The API key is read from an environment variable (never from a file, never
 * logged). Verify exit codes are CI-friendly:
 *   0 match · 2 mismatch · 3 uncertain · 4 insufficient · 1 error
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import { compare, fingerprint, verify } from './api.js'
import { CELL_PRIORITY_ORDER, isCellId } from './battery.js'
import {
  DEFAULT_CELL_COUNT,
  DEFAULT_CONCURRENCY,
  DEFAULT_SAMPLES_PER_CELL,
} from './constants.js'
import {
  ORCAROUTER_CYBER_CATALOG_URL,
  ORCAROUTER_KEYS_URL,
  ORCAROUTER_PROVIDER_URL,
  ORCAROUTER_PRESET,
  PROVIDER_PRESETS,
  discoverOrcaRouterModels,
  isOrcaRouterBaseUrl,
  orderCatalogForSelector,
  resolveProviderChoice,
} from './providers/orcarouter.js'
import { ProbeRequestError } from './http.js'
import {
  getBundledAttribution,
  listBundledReferences,
  loadBundledReference,
  parseFingerprintJson,
} from './reference.js'
import { ProbeRunError } from './sampler.js'
import type {
  CellId,
  ComparisonResult,
  Endpoint,
  Fingerprint,
  FingerprintOptions,
  ProgressEvent,
  VerdictLevel,
} from './types.js'

const DEFAULT_KEY_ENV_VARS = ['LLM_FINGERPRINT_API_KEY', 'OPENAI_API_KEY']

const VALUE_OPTIONS = new Set([
  '--base-url',
  '--model',
  '--api-key',
  '--api-key-env',
  '--cells',
  '--samples',
  '--concurrency',
  '--timeout',
  '--preset',
  '--reference',
  '--out',
  '--provider',
])
const BOOLEAN_OPTIONS = new Set(['--json', '--quiet', '--help', '-h', '--version', '-V'])

interface ParsedArgs {
  positionals: string[]
  options: Map<string, string | boolean>
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const options = new Map<string, string | boolean>()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('-')) {
      positionals.push(token)
      continue
    }
    const eq = token.indexOf('=')
    if (eq > 0) {
      options.set(token.slice(0, eq), token.slice(eq + 1))
      continue
    }
    if (BOOLEAN_OPTIONS.has(token)) {
      options.set(token, true)
      continue
    }
    if (VALUE_OPTIONS.has(token)) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        fail(`Option ${token} expects a value`)
      }
      options.set(token, value)
      i += 1
      continue
    }
    fail(`Unknown option: ${token} (see --help)`)
  }
  return { positionals, options }
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`)
  process.exit(1)
}

function packageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version
  } catch {
    return 'unknown'
  }
}

const HELP = `llm-fingerprint — fingerprint & verify LLMs behind OpenAI-compatible APIs
Method: "One Token Is Enough" (Bruckner, arXiv:2607.10252)

USAGE
  llm-fingerprint <command> [options]

COMMANDS
  fingerprint   Probe an endpoint and print/save its behavioral fingerprint
  verify        Fingerprint an endpoint and compare it to a reference
  compare       Compare two saved fingerprints (files or bundled ids)
  references    List bundled sample reference fingerprints
  providers     List named providers${PROVIDER_PRESETS.map((p) => ` (${p.id})`).join('')}

ENDPOINT OPTIONS
  --provider <id>       Named provider preset (see 'providers'). Currently:
                        ${PROVIDER_PRESETS.map((p) => `${p.id} — ${p.name}`).join(', ')}
                        sets the base URL, key env var (${ORCAROUTER_PRESET.apiKeyEnv})
                        and default model (${ORCAROUTER_PRESET.defaultModel})
  --base-url <url>      OpenAI-compatible base URL, e.g. https://api.openai.com/v1
                        (optional with --provider; overrides its base URL)
  --model <id>          Model id to request, e.g. gpt-4o-mini, or the model
                        picker's index / list number with --provider
  --api-key-env <name>  Env var holding the API key
                        (default: tries ${DEFAULT_KEY_ENV_VARS.join(', ')}, then ${ORCAROUTER_PRESET.apiKeyEnv})
  --api-key <key>       API key literal — avoid; prefer --api-key-env

SAMPLING OPTIONS
  --cells <n|list>      Cell count 1-16 (top-N most discriminative) or a
                        comma-separated list of cell ids (default: ${DEFAULT_CELL_COUNT})
  --samples <n>         Samples per cell (default: ${DEFAULT_SAMPLES_PER_CELL})
  --preset <id>         quick (4×15) | standard (8×25) | strict (16×25)
  --concurrency <n>     Concurrent requests (default: ${DEFAULT_CONCURRENCY})
  --timeout <ms>        Per-request timeout (default: 30000)

VERIFY / COMPARE
  --reference <src>     Reference fingerprint: a JSON file produced by
                        'fingerprint --out', or a bundled id (see 'references')

OUTPUT
  --json                Machine-readable JSON on stdout
  --out <file>          Write the fingerprint JSON to a file
  --quiet               No progress output
  --help, -h            Show this help
  --version, -V         Show version

EXIT CODES (verify)
  0 match · 2 mismatch · 3 uncertain · 4 insufficient · 1 error

EXAMPLES
  # Fingerprint an endpoint (key read from OPENAI_API_KEY)
  llm-fingerprint fingerprint --base-url https://api.openai.com/v1 \\
    --model gpt-4o-mini --out gpt-4o-mini.fingerprint.json

  # Is this cheap reseller really serving gpt-4o-mini?
  LLM_FINGERPRINT_API_KEY=sk-... llm-fingerprint verify \\
    --base-url https://cheap-api.example.com/v1 --model gpt-4o-mini \\
    --reference gpt-4o-mini.fingerprint.json

  # Quick demo against a bundled sample reference
  llm-fingerprint verify --base-url https://openrouter.ai/api/v1 \\
    --model openai/gpt-4o-mini --reference openai/gpt-4o-mini --preset quick

  # Fingerprint a model served by OrcaRouter Cyber Inference (named provider)
  ${ORCAROUTER_PRESET.apiKeyEnv}=sk-orca-... llm-fingerprint fingerprint \\
    --provider ${ORCAROUTER_PRESET.id} --model ${ORCAROUTER_PRESET.defaultModel} \\
    --out orcarouter-auto.fingerprint.json

  # Compare two saved fingerprints offline
  llm-fingerprint compare a.fingerprint.json b.fingerprint.json

Web version (no install): https://tosea.ai/free-tools/llm-api-fingerprint-checker
`

interface EndpointChoice {
  endpoint: Endpoint
  providerId: string | null
}

/**
 * Resolve `--provider` / `--base-url` / `--model`. With a named provider the
 * base URL and model default come from the preset; otherwise `--base-url` and
 * `--model` are required exactly as before.
 */
async function readEndpoint(args: ParsedArgs): Promise<EndpointChoice> {
  const provider = args.options.get('--provider')
  const baseUrl = args.options.get('--base-url')
  const model = args.options.get('--model')
  if (typeof baseUrl !== 'string' && typeof provider !== 'string') fail('--base-url is required')
  if (typeof model !== 'string' && typeof provider !== 'string') fail('--model is required')
  if (typeof provider === 'string') {
    return resolveNamedProvider(args, provider, typeof baseUrl === 'string' ? baseUrl : undefined)
  }
  if (typeof baseUrl !== 'string' || typeof model !== 'string') fail('--base-url is required')
  return {
    endpoint: { baseUrl, model, apiKey: resolveApiKey(args) },
    providerId: isOrcaRouterBaseUrl(baseUrl) ? ORCAROUTER_PRESET.id : null,
  }
}

async function resolveNamedProvider(
  args: ParsedArgs,
  providerId: string,
  baseUrl: string | undefined,
): Promise<EndpointChoice> {
  const apiKey = resolveApiKey(args, providerId)
  const modelFlag = args.options.get('--model')
  let choice
  try {
    choice = resolveProviderChoice({
      provider: providerId,
      baseUrl,
      model: typeof modelFlag === 'string' ? modelFlag : undefined,
      apiKey,
    })
  } catch (error) {
    fail((error as Error).message)
  }
  for (const warning of choice.warnings) process.stderr.write(`warning: ${warning}\n`)
  if (!apiKey) {
    process.stderr.write(
      `warning: provider "${providerId}" has no API key; requests will be rejected with 401/403. ` +
        `Create a key at ${ORCAROUTER_KEYS_URL} or export ${choice.apiKeyEnvVars[0] ?? ORCAROUTER_PRESET.apiKeyEnv}\n`,
    )
  }
  let model = choice.endpoint.model
  if (typeof modelFlag === 'string' && modelFlag.trim() === '?') {
    model = await chooseModelInteractively(choice.endpoint.baseUrl, apiKey)
  }
  return { endpoint: { ...choice.endpoint, model }, providerId: choice.preset?.id ?? providerId }
}

/**
 * Model selector for the named provider. The list comes from `GET {baseUrl}/models`
 * on the configured inference origin; when discovery fails the provider's small
 * verified seed is offered and clearly labelled as degraded. There is no free-text
 * fallback: pass `--model <id>` explicitly to override.
 */
async function chooseModelInteractively(baseUrl: string, apiKey: string | undefined): Promise<string> {
  const catalog = await discoverOrcaRouterModels({ baseUrl, apiKey: apiKey ?? null })
  const options = orderCatalogForSelector(catalog)
  const out = process.stderr
  if (catalog.source === 'live') {
    out.write(`models: ${options.length} chat-capable model(s) from ${baseUrl}/models\n`)
  } else {
    out.write(
      `warning: live model discovery unavailable${catalog.error ? ` (${catalog.error})` : ''}; ` +
        'offering the OrcaRouter verified seed only\n',
    )
  }
  options.forEach((entry, index) => {
    const ctx = entry.contextLength ? `  ctx ${Math.round(entry.contextLength / 1000)}k` : ''
    out.write(`  ${String(index + 1).padStart(2)}. ${entry.id}${ctx}\n`)
  })
  const prompt = `Enter a number 1-${options.length} (or a full model id): `
  out.write(prompt)
  const answer = await readLine(prompt)
  const trimmed = answer.trim()
  if (/^\d+$/.test(trimmed)) {
    const picked = options[Number(trimmed) - 1]
    if (!picked) fail(`model index ${trimmed} is out of range 1-${options.length}`)
    return picked.id
  }
  if (!trimmed) fail('no model selected')
  if (!options.some((entry) => entry.id === trimmed)) {
    process.stderr.write(`warning: "${trimmed}" was not in the ${catalog.source} catalog list\n`)
  }
  return trimmed
}

async function readLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? ''
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await rl.question(prompt)
  } finally {
    rl.close()
  }
}

function resolveApiKey(args: ParsedArgs, providerId?: string): string | undefined {
  const literal = args.options.get('--api-key')
  if (typeof literal === 'string' && literal.trim()) return literal.trim()

  const envName = args.options.get('--api-key-env')
  if (typeof envName === 'string') {
    const value = process.env[envName]
    if (!value) fail(`Environment variable ${envName} is empty or not set`)
    return value
  }

  const names = providerId
    ? [...DEFAULT_KEY_ENV_VARS, ORCAROUTER_PRESET.apiKeyEnv]
    : DEFAULT_KEY_ENV_VARS
  for (const name of names) {
    const value = process.env[name]
    if (value) return value
  }
  process.stderr.write(
    `note: no API key found (checked ${names.join(', ')}); ` +
      'sending requests without Authorization header\n',
  )
  return undefined
}

function readSamplingOptions(args: ParsedArgs): FingerprintOptions {
  const options: FingerprintOptions = {}

  const preset = args.options.get('--preset')
  if (typeof preset === 'string') {
    const presets: Record<string, { cells: number; samples: number }> = {
      quick: { cells: 4, samples: 15 },
      standard: { cells: 8, samples: 25 },
      strict: { cells: 16, samples: 25 },
    }
    const found = presets[preset]
    if (!found) fail(`Unknown preset "${preset}" (quick | standard | strict)`)
    options.cells = found.cells
    options.samplesPerCell = found.samples
  }

  const cells = args.options.get('--cells')
  if (typeof cells === 'string') {
    if (/^\d+$/.test(cells)) {
      const n = Number(cells)
      if (n < 1 || n > CELL_PRIORITY_ORDER.length) {
        fail(`--cells must be 1-${CELL_PRIORITY_ORDER.length} or a comma-separated cell list`)
      }
      options.cells = n
    } else {
      const list = cells.split(',').map((cell) => cell.trim())
      for (const cell of list) {
        if (!isCellId(cell)) {
          fail(`Unknown cell id "${cell}". Valid cells:\n  ${CELL_PRIORITY_ORDER.join('\n  ')}`)
        }
      }
      options.cells = list as CellId[]
    }
  }

  const samples = args.options.get('--samples')
  if (typeof samples === 'string') {
    const n = Number(samples)
    if (!Number.isInteger(n) || n < 1) fail('--samples must be a positive integer')
    options.samplesPerCell = n
  }

  const concurrency = args.options.get('--concurrency')
  if (typeof concurrency === 'string') {
    const n = Number(concurrency)
    if (!Number.isInteger(n) || n < 1) fail('--concurrency must be a positive integer')
    options.concurrency = n
  }

  const timeout = args.options.get('--timeout')
  if (typeof timeout === 'string') {
    const n = Number(timeout)
    if (!Number.isFinite(n) || n < 100) fail('--timeout must be ≥ 100 (milliseconds)')
    options.timeoutMs = n
  }

  return options
}

function makeProgressRenderer(args: ParsedArgs): ((event: ProgressEvent) => void) | undefined {
  if (args.options.get('--quiet')) return undefined
  const isTty = process.stderr.isTTY === true
  let lastPercent = -1
  return (event) => {
    if (event.stage === 'adapter') {
      // A TTY shows a transient status line, cleared once the adapter is chosen.
      process.stderr.write(
        isTty
          ? `\rprobing reasoning adapter (${event.strategy})...          `
          : `probing reasoning adapter (${event.strategy})...\n`,
      )
      return
    }
    if (isTty) {
      const errs = event.errors > 0 ? `, errors: ${event.errors}` : ''
      process.stderr.write(`\r\u001b[Ksampling ${event.done}/${event.total}${errs}`)
      if (event.done === event.total) process.stderr.write('\n')
    } else {
      const percent = Math.floor((event.done / event.total) * 10) * 10
      if (percent > lastPercent) {
        lastPercent = percent
        process.stderr.write(`sampling ${event.done}/${event.total} (${percent}%)\n`)
      }
    }
  }
}

/** Record the named provider (never the key) in fingerprint metadata. */
function metaOptions(options: FingerprintOptions, providerId: string | null): FingerprintOptions {
  if (providerId !== ORCAROUTER_PRESET.id) return options
  return { ...options, meta: { ...options.meta, provider: ORCAROUTER_PRESET.id, providerName: ORCAROUTER_PRESET.name } }
}

/** Load a reference: a JSON file path first, then a bundled sample id. */
function loadReference(source: string): Fingerprint {
  let fileText: string | null = null
  try {
    fileText = readFileSync(source, 'utf8')
  } catch {
    fileText = null
  }
  if (fileText !== null) return parseFingerprintJson(fileText, source)
  try {
    return loadBundledReference(source)
  } catch (error) {
    fail(
      `"${source}" is neither a readable file nor a bundled reference id.\n${(error as Error).message}`,
    )
  }
}

function verdictLabel(verdict: VerdictLevel): string {
  switch (verdict) {
    case 'match':
      return 'MATCH — behavior is consistent with the reference'
    case 'uncertain':
      return 'UNCERTAIN — in the gray zone; collect more samples or a fresh reference'
    case 'mismatch':
      return 'MISMATCH — behavior differs from the reference'
    case 'insufficient':
      return 'INSUFFICIENT — not enough comparable cells for a verdict'
  }
}

function verdictExitCode(verdict: VerdictLevel): number {
  switch (verdict) {
    case 'match':
      return 0
    case 'mismatch':
      return 2
    case 'uncertain':
      return 3
    case 'insufficient':
      return 4
  }
}

function renderComparison(result: ComparisonResult): string {
  const lines: string[] = []
  const mean = result.meanJsd === null ? 'n/a' : result.meanJsd.toFixed(3)
  lines.push(`Verdict: ${verdictLabel(result.verdict)}`)
  lines.push(`Mean JSD: ${mean} over ${result.comparableCellCount} comparable cell(s)`)
  lines.push('')
  lines.push('Interpretation scale (paper baselines, arXiv:2607.10252):')
  lines.push(
    `  same model ≈ ${result.baselines.sameModelSelf} · same model, other provider ≈ ${result.baselines.sameModelCrossProvider} · different model ≈ ${result.baselines.differentModel}`,
  )
  lines.push(
    `  thresholds: match ≤ ${result.thresholds.match} < uncertain ≤ ${result.thresholds.mismatch} < mismatch`,
  )
  if (result.cells.length > 0) {
    lines.push('')
    lines.push('Per-cell JSD (most divergent first):')
    for (const cell of result.cells) {
      lines.push(
        `  ${cell.cellId.padEnd(26)} ${cell.jsd.toFixed(3)}  (${cell.validA} vs ${cell.validB} valid)`,
      )
    }
  }
  if (result.protocolMismatch) {
    lines.push('')
    lines.push(
      'note: the fingerprints were collected under different probe protocols; treat the verdict as indicative only.',
    )
  }
  return lines.join('\n')
}

function summarizeFingerprint(fp: Fingerprint): string {
  const lines: string[] = []
  lines.push(`Model: ${fp.model}`)
  lines.push(`Protocol: ${fp.protocol} · collected ${fp.collectedAt}`)
  lines.push(`Cells: ${Object.keys(fp.cells).length} × ${fp.samplesPerCell} samples`)
  if (fp.postReasoning) lines.push('warning: collected via post-reasoning fallback (reduced confidence)')
  lines.push('')
  lines.push('Top answers per cell:')
  for (const [cellId, cell] of Object.entries(fp.cells)) {
    if (!cell) continue
    const top = Object.entries(cell.counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([answer, count]) => `${answer}×${count}`)
      .join(', ')
    lines.push(
      `  ${cellId.padEnd(26)} valid ${String(cell.validCount).padStart(3)}  H=${cell.entropyBits.toFixed(2)}b  ${top || '(no valid answers)'}`,
    )
  }
  return lines.join('\n')
}

function writeWarnings(warnings: string[]): void {
  for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`)
}

let providerHint: string | null = null

async function cmdFingerprint(args: ParsedArgs): Promise<number> {
  const { endpoint, providerId } = await readEndpoint(args)
  providerHint = providerId
  const options = readSamplingOptions(args)
  options.onProgress = makeProgressRenderer(args)

  const run = await fingerprint(endpoint, metaOptions(options, providerId))
  writeWarnings(run.warnings)

  const out = args.options.get('--out')
  if (typeof out === 'string') {
    writeFileSync(out, `${JSON.stringify(run.fingerprint, null, 2)}\n`, 'utf8')
    process.stderr.write(`fingerprint written to ${out}\n`)
  }

  if (args.options.get('--json')) {
    const { fingerprint: fp, adapter, errorCount, splitHalfJsd, durationMs, warnings } = run
    process.stdout.write(
      `${JSON.stringify({ fingerprint: fp, run: { adapter, errorCount, splitHalfJsd, durationMs, warnings } }, null, 2)}\n`,
    )
  } else if (typeof out !== 'string') {
    process.stdout.write(`${summarizeFingerprint(run.fingerprint)}\n`)
  } else {
    process.stderr.write(`${summarizeFingerprint(run.fingerprint)}\n`)
  }
  return 0
}

async function cmdVerify(args: ParsedArgs): Promise<number> {
  const referenceSource = args.options.get('--reference')
  if (typeof referenceSource !== 'string') {
    fail('--reference <file-or-bundled-id> is required (see `llm-fingerprint references`)')
  }
  const reference = loadReference(referenceSource)
  const { endpoint, providerId } = await readEndpoint(args)
  providerHint = providerId
  const options = readSamplingOptions(args)
  options.onProgress = makeProgressRenderer(args)

  const result = await verify(endpoint, reference, metaOptions(options, providerId))
  writeWarnings(result.warnings)

  const out = args.options.get('--out')
  if (typeof out === 'string') {
    writeFileSync(out, `${JSON.stringify(result.target.fingerprint, null, 2)}\n`, 'utf8')
    process.stderr.write(`target fingerprint written to ${out}\n`)
  }

  if (args.options.get('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`${renderComparison(result.comparison)}\n`)
    process.stdout.write(
      `\nReference: ${reference.model} (collected ${reference.collectedAt}, protocol ${reference.protocol})\n`,
    )
  }
  return verdictExitCode(result.verdict)
}

async function cmdCompare(args: ParsedArgs): Promise<number> {
  if (args.positionals.length !== 2) {
    fail('compare expects exactly two arguments: <fingerprint-a> <fingerprint-b>')
  }
  const a = loadReference(args.positionals[0])
  const b = loadReference(args.positionals[1])
  const result = compare(a, b)

  if (args.options.get('--json')) {
    process.stdout.write(`${JSON.stringify({ a: a.model, b: b.model, ...result }, null, 2)}\n`)
  } else {
    process.stdout.write(`A: ${a.model} (${a.collectedAt})\nB: ${b.model} (${b.collectedAt})\n\n`)
    process.stdout.write(`${renderComparison(result)}\n`)
  }
  return verdictExitCode(result.verdict)
}

function cmdReferences(args: ParsedArgs): number {
  const references = listBundledReferences()
  const attribution = getBundledAttribution()
  if (args.options.get('--json')) {
    process.stdout.write(`${JSON.stringify({ source: attribution, references }, null, 2)}\n`)
    return 0
  }
  process.stdout.write('Bundled sample reference fingerprints:\n\n')
  for (const ref of references) {
    process.stdout.write(
      `  ${ref.id.padEnd(36)} ${String(ref.cellCount).padStart(2)} cells  collected ${ref.collectedAt}\n`,
    )
  }
  process.stdout.write(
    `\nSource: ${attribution.dataset}\n` +
      `by ${attribution.author} — DOI ${attribution.datasetDoi} (${attribution.license})\n` +
      'Collected under the paper\'s protocol: fine for demos; for high-stakes checks,\n' +
      'collect your own reference with `llm-fingerprint fingerprint --out ...`.\n',
  )
  return 0
}

function cmdProviders(args: ParsedArgs): number {
  const providers = PROVIDER_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    baseUrl: preset.baseUrl,
    apiKeyEnv: preset.apiKeyEnv,
    defaultModel: preset.defaultModel,
    suggestedModels: preset.suggestedModels,
    description: preset.description,
  }))
  const attribution = {
    providerPage: ORCAROUTER_PROVIDER_URL,
    cyberModelCatalog: ORCAROUTER_CYBER_CATALOG_URL,
    keys: ORCAROUTER_KEYS_URL,
  }
  if (args.options.get('--json')) {
    process.stdout.write(`${JSON.stringify({ providers, attribution }, null, 2)}\n`)
    return 0
  }
  process.stdout.write('Named providers:\n\n')
  for (const preset of PROVIDER_PRESETS) {
    process.stdout.write(`  ${preset.id} — ${preset.name}\n`)
    process.stdout.write(`    ${preset.description}\n`)
    process.stdout.write(`    base URL: ${preset.baseUrl}\n`)
    process.stdout.write(`    key: export ${preset.apiKeyEnv}=sk-orca-... (or --api-key-env NAME)\n`)
    process.stdout.write(`    default model: ${preset.defaultModel}\n`)
    process.stdout.write(`    suggested: ${preset.suggestedModels.join(', ')}\n`)
  }
  process.stdout.write(
    `\nProvider page: ${ORCAROUTER_PROVIDER_URL}\n` +
      `Cyber-tier models: ${ORCAROUTER_CYBER_CATALOG_URL}\n` +
      `Create or revoke a key: ${ORCAROUTER_KEYS_URL}\n` +
      `Select a model from the live catalog: --provider ${ORCAROUTER_PRESET.id} --model '?'\n`,
  )
  return 0
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)

  if (args.options.get('--version') || args.options.get('-V')) {
    process.stdout.write(`${packageVersion()}\n`)
    process.exit(0)
  }
  const command = args.positionals.shift()
  if (!command || args.options.get('--help') || args.options.get('-h') || command === 'help') {
    process.stdout.write(HELP)
    process.exit(0)
  }

  try {
    let exitCode: number
    switch (command) {
      case 'fingerprint':
        exitCode = await cmdFingerprint(args)
        break
      case 'verify':
        exitCode = await cmdVerify(args)
        break
      case 'compare':
        exitCode = await cmdCompare(args)
        break
      case 'references':
        exitCode = cmdReferences(args)
        break
      case 'providers':
        exitCode = cmdProviders(args)
        break
      default:
        fail(`Unknown command: ${command} (see --help)`)
    }
    process.exit(exitCode)
  } catch (error) {
    if (error instanceof ProbeRunError) {
      const hints: Record<string, string> = {
        auth: providerHint === ORCAROUTER_PRESET.id
          ? `The ${ORCAROUTER_PRESET.name} endpoint rejected the API key (401/403). Check it is active and has model access, or create a new key at ${ORCAROUTER_KEYS_URL}.`
          : 'The endpoint rejected the API key (401/403).',
        network: 'The endpoint is unreachable — check the base URL and your network.',
        aborted: 'Run cancelled.',
      }
      fail(`${hints[error.reason] ?? ''} ${error.message}`.trim())
    }
    if (error instanceof ProbeRequestError && error.kind === 'auth' && providerHint === ORCAROUTER_PRESET.id) {
      fail(
        `The ${ORCAROUTER_PRESET.name} endpoint rejected the API key (401/403). Check it is active and has model access, or create a new key at ${ORCAROUTER_KEYS_URL}. ${error.message}`,
      )
    }
    fail(error instanceof Error ? error.message : String(error))
  }
}

void main()
