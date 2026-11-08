/**
 * llm-fingerprint-detector — fingerprint and verify LLMs behind
 * OpenAI-compatible APIs from single-token output distributions.
 *
 * Independent open-source implementation of Tomáš Bruckner,
 * "One Token Is Enough: Fingerprinting and Verifying Large Language Models
 * from Single-Token Output Distributions" (arXiv:2607.10252).
 *
 * Everything exported here is runtime-agnostic (Node ≥ 18 or browsers with
 * fetch). Bundled sample references are Node-only and live in the
 * `llm-fingerprint-detector/references` subpath export.
 */

export { fingerprint, compare, verify } from './api.js'

export {
  CELL_PRIORITY_ORDER,
  PROBE_PRESETS,
  PROBE_TASKS,
  SYSTEM_PROMPTS,
  getCellsForPreset,
  getSystemPrompt,
  getTaskSpec,
  isCellId,
  makeCellId,
  parseCellId,
  pickParaphrase,
} from './battery.js'

export {
  normalizeAnswer,
  parseAnyNumber,
  parseChineseNumeral,
  parseEnglishNumberWord,
} from './normalizer.js'
export type { NormalizedAnswer } from './normalizer.js'

export {
  buildCellDistribution,
  compareCellSets,
  domainSize,
  jensenShannonDivergence,
  median,
  shannonEntropyBits,
  splitHalfJsd,
} from './stats.js'
export type { CellJsdEntry, CountMap } from './stats.js'

export { decideVerdict, buildComparisonResult } from './verdict.js'

export { detectReasoningAdapter, STRATEGY_BODIES } from './adapter.js'
export type { AdapterDetectionOptions } from './adapter.js'

export { runProbeBattery, ProbeRunError } from './sampler.js'
export type { SamplerOptions, SamplerResult } from './sampler.js'

export { fetchChatCompletion, ProbeRequestError } from './http.js'
export type { ChatCompletionRequest, ChatCompletionResult, ProbeErrorKind } from './http.js'

export { normalizeBaseUrl, resolveEndpoint, guessAdapterHint } from './endpoint.js'
export type { BaseUrlNormalization } from './endpoint.js'

export {
  ORCAROUTER_API_BASE,
  ORCAROUTER_KEYS_URL,
  ORCAROUTER_PROVIDER_ID,
  ORCAROUTER_PROVIDER_URL,
  ORCAROUTER_CYBER_CATALOG_URL,
  ORCAROUTER_PRESET,
  orcaRouterReasoningBody,
  PROVIDER_PRESETS,
  discoverOrcaRouterModels,
  getProviderPreset,
  isModelInCatalog,
  isOrcaRouterBaseUrl,
  orcaRouterFallbackModels,
  orcaRouterSeedCatalog,
  orderCatalogForSelector,
  qualifyOrcaRouterModel,
  resolveProviderChoice,
} from './providers/orcarouter.js'
export type { ProviderPreset, ResolveProviderOptions, ResolvedProviderChoice } from './providers/orcarouter.js'

export { CATALOG_MAX_BYTES, CATALOG_MAX_MODELS, CATALOG_TIMEOUT_MS, filterChatCatalog, parseModelCatalog } from './catalog.js'
export type { CatalogFilter } from './catalog.js'

export * from './constants.js'

export type {
  AnswerDomain,
  CellComparison,
  CellDistribution,
  CellId,
  ComparisonBaselines,
  ComparisonResult,
  Endpoint,
  Fingerprint,
  FingerprintOptions,
  FingerprintRun,
  ModelCatalog,
  ModelCatalogEntry,
  ProbeLang,
  ProbePreset,
  ProbePresetId,
  ProbeTaskId,
  ProbeTaskSpec,
  ProgressEvent,
  ReasoningAdapter,
  ReasoningStrategyId,
  ResolvedEndpoint,
  SampleCategory,
  SampleResult,
  SampleUsage,
  VerdictLevel,
  VerifyResult,
} from './types.js'
