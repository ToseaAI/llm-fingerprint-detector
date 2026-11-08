/**
 * Core type definitions.
 *
 * Method: Tomáš Bruckner, "One Token Is Enough: Fingerprinting and Verifying
 * Large Language Models from Single-Token Output Distributions"
 * (arXiv:2607.10252). A probe battery of task × language "cells" is sampled
 * repeatedly at temperature 1.0 with a one-word answer constraint; the
 * empirical distribution of normalized answers is the model's behavioral
 * fingerprint. Two fingerprints are compared with the mean per-cell
 * Jensen-Shannon divergence (base 2, so each cell's JSD lies in [0, 1] bit).
 */

export type ProbeTaskId =
  | 'random-number-1-100'
  | 'random-number-1-10'
  | 'random-letter'
  | 'random-color'
  | 'coin-flip'
  | 'random-animal'
  | 'random-city'
  | 'favorite-number'

export type ProbeLang = 'en' | 'zh'

/**
 * A cell is one task in one language. Distributions are only ever compared
 * within the same cell; there is no cross-language pooling.
 */
export type CellId = `${ProbeTaskId}:${ProbeLang}`

export type AnswerDomain =
  | { kind: 'int'; min: number; max: number }
  | { kind: 'letter' }
  | { kind: 'color' }
  | { kind: 'coin' }
  | { kind: 'word' }

export interface ProbeTaskSpec {
  id: ProbeTaskId
  domain: AnswerDomain
  /**
   * At least 3 paraphrases per language. One is drawn at random per request,
   * so the probes are plain semantic questions with no fixed magic string a
   * gateway could keyword-filter.
   */
  paraphrases: Record<ProbeLang, string[]>
}

export type ProbePresetId = 'quick' | 'standard' | 'strict'

export interface ProbePreset {
  id: ProbePresetId
  cellCount: number
  samplesPerCell: number
}

/** An OpenAI-compatible chat-completions endpoint to probe. */
export interface Endpoint {
  /** Base URL, e.g. `https://api.openai.com/v1`. A bare domain gets `/v1` appended. */
  baseUrl: string
  /** Model id to request, e.g. `gpt-4o-mini`. */
  model: string
  /** API key sent as `Authorization: Bearer <key>`. Omit for keyless local servers. */
  apiKey?: string
  /** Extra HTTP headers merged into every request. */
  headers?: Record<string, string>
}

/** Internal, normalized endpoint (base URL cleaned up, key resolved). */
export interface ResolvedEndpoint {
  baseUrl: string
  model: string
  apiKey: string | null
  headers: Record<string, string>
}

/** Strategy used to disable hidden reasoning ("thinking") on the endpoint. */
export type ReasoningStrategyId =
  | 'openrouter-reasoning'
  | 'zhipu-thinking'
  | 'openai-effort'
  | 'none'

export interface ReasoningAdapter {
  strategy: ReasoningStrategyId
  /** Extra fields merged into the request body. */
  extraBody: Record<string, unknown>
  /** max_tokens used for probe requests. */
  maxTokens: number
  /**
   * True when no disabling strategy produced visible output and the run fell
   * back to a large max_tokens "post-reasoning" channel. Fingerprints
   * collected this way are lower confidence (reasoning shifts sampling).
   */
  postReasoning: boolean
}

/**
 * One entry of an OpenAI-style `GET /models` catalog as parsed from the
 * configured inference origin. Fields are `null` when the provider did not
 * declare them; capability filtering treats missing metadata as incompatible.
 */
export interface ModelCatalogEntry {
  /** Model id exactly as served, namespace included (e.g. `orca/orcacyber-zero-1.5`). */
  id: string
  name?: string
  contextLength: number | null
  inputModalities: string[] | null
  outputModalities: string[] | null
  /** Accepted wire endpoint types (openai / anthropic / gemini / openai-response). */
  endpointTypes: string[] | null
}

/**
 * The model list offered to the user for one inference origin.
 * `source` is `live` when it came from `GET /models` in this process, and
 * `seed` when the provider's verified cold-start list is used because live
 * discovery failed (`fallback: true`, `error` explains why).
 */
export interface ModelCatalog {
  source: 'live' | 'seed'
  fallback: boolean
  entries: ModelCatalogEntry[]
  error?: string
}

export type SampleCategory = 'valid' | 'invalid' | 'refusal' | 'empty' | 'error'

export interface SampleUsage {
  promptTokens: number | null
  completionTokens: number | null
  reasoningTokens: number | null
}

export interface SampleResult {
  cellId: CellId
  /** Verbatim completion text. */
  raw: string
  /** Normalized answer; non-null only when `category === 'valid'`. */
  normalized: string | null
  category: SampleCategory
  latencyMs: number
  usage: SampleUsage | null
  /** Arrival order across the whole run (used for the split-half self check). */
  arrivalIndex: number
  errorMessage?: string
}

/** Aggregated answer distribution for one cell. */
export interface CellDistribution {
  cellId: CellId
  /** Normalized answer → count (valid samples only). */
  counts: Record<string, number>
  validCount: number
  invalidCount: number
  refusalCount: number
  emptyCount: number
  errorCount: number
  totalCount: number
  /** Shannon entropy of the valid-answer distribution, in bits. */
  entropyBits: number
  /** entropyBits / log2(nominal domain size), clamped to [0, 1]. */
  normalizedEntropy: number
  medianLatencyMs: number | null
  meanCompletionTokens: number | null
  meanReasoningTokens: number | null
}

/**
 * A behavioral fingerprint: per-cell answer distributions plus collection
 * metadata. This is the JSON artifact written/read by the CLI.
 */
export interface Fingerprint {
  formatVersion: 1
  /**
   * Probe protocol identifier. Fingerprints are only strictly comparable when
   * both sides used the same protocol (same battery, same system prompt).
   * This package emits `one-token/v1`; bundled Zenodo-derived samples use
   * `bruckner-zenodo-2026`.
   */
  protocol: string
  model: string
  /** ISO timestamp. Fingerprints drift when models are updated, so age matters. */
  collectedAt: string
  samplesPerCell: number
  postReasoning: boolean
  cells: Partial<Record<CellId, CellDistribution>>
  meta?: {
    tool?: string
    channel?: string
    source?: string
    note?: string
    [key: string]: unknown
  }
}

export type VerdictLevel = 'match' | 'uncertain' | 'mismatch' | 'insufficient'

export interface CellComparison {
  cellId: CellId
  /** Jensen-Shannon divergence, base 2, in [0, 1] bit. */
  jsd: number
  validA: number
  validB: number
}

export interface ComparisonBaselines {
  /** Median split-half distance of a model against itself (paper): ≈ 0.140. */
  sameModelSelf: number
  /** Median distance, same model served by different providers (paper): ≈ 0.227. */
  sameModelCrossProvider: number
  /** Median distance between different models (paper): ≈ 0.463. */
  differentModel: number
}

export interface ComparisonResult {
  /** Mean per-cell JSD across comparable cells; null when none are comparable. */
  meanJsd: number | null
  verdict: VerdictLevel
  /** Per-cell details, sorted by descending JSD. */
  cells: CellComparison[]
  comparableCellCount: number
  /** True when the two fingerprints were collected under different probe protocols. */
  protocolMismatch: boolean
  thresholds: { match: number; mismatch: number }
  baselines: ComparisonBaselines
}

export interface ProgressEvent {
  stage: 'adapter' | 'sampling'
  /** Completed requests (sampling stage) or probes attempted (adapter stage). */
  done: number
  total: number
  errors: number
  cellId?: CellId
  strategy?: ReasoningStrategyId
}

export interface FingerprintOptions {
  /**
   * Cells to probe: an explicit list, or a number N meaning the top-N cells
   * from the discriminativeness-ordered battery. Default: 8 (standard preset).
   */
  cells?: CellId[] | number
  /** Samples per cell. Default: 25. */
  samplesPerCell?: number
  /** Concurrent in-flight requests. Default: 4. */
  concurrency?: number
  /** Per-request timeout in milliseconds. Default: 30000. */
  timeoutMs?: number
  /** Retries per request on 429/5xx/timeout. Default: 2. */
  maxRetries?: number
  /** Abort the whole run (in-flight requests are cancelled). */
  signal?: AbortSignal
  onProgress?: (event: ProgressEvent) => void
  /** Skip reasoning-adapter detection and use this adapter directly. */
  adapter?: ReasoningAdapter
  /** Keep raw per-sample results on the run result (off by default). */
  keepSamples?: boolean
  /** Free-form metadata merged into `fingerprint.meta`. */
  meta?: Fingerprint['meta']
}

export interface FingerprintRun {
  fingerprint: Fingerprint
  adapter: ReasoningAdapter
  /** Requests that errored out after retries (excluded from distributions). */
  errorCount: number
  /**
   * Mean JSD between odd/even arrival halves of the run itself.
   * Values far above the same-model baseline (≈ 0.14) suggest the endpoint
   * routes across multiple backends (aggregator behavior).
   */
  splitHalfJsd: number | null
  durationMs: number
  /** Present only when `keepSamples: true`. */
  samples?: SampleResult[]
  /** Human-readable caveats collected during the run. */
  warnings: string[]
}

export interface VerifyResult {
  verdict: VerdictLevel
  meanJsd: number | null
  comparison: ComparisonResult
  target: FingerprintRun
  reference: Fingerprint
  warnings: string[]
}
