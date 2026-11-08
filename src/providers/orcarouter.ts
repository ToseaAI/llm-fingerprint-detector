/**
 * OrcaRouter Cyber Inference provider wiring.
 *
 * [OrcaRouter](https://www.orcarouter.ai) is an OpenAI-compatible AI gateway
 * that routes many providers behind one endpoint. This module is the single
 * place where the tool knows about OrcaRouter: endpoint presets, the provider
 * defaults (inference origin, key environment variable, default/recommended/
 * fallback models), reasoning-strategy hint, and bounded model discovery for
 * the CLI model selector.
 *
 * Nothing here is OrcaRouter-specific inference logic: a resolved provider is
 * turned into the same `Endpoint` the rest of the package already probes.
 */

import { normalizeBaseUrl } from '../endpoint.js'
import { STRATEGY_BODIES } from '../adapter.js'
import {
  CATALOG_MAX_BYTES,
  CATALOG_TIMEOUT_MS,
  filterChatCatalog,
  parseModelCatalog,
} from '../catalog.js'
import type { Endpoint, ModelCatalog, ModelCatalogEntry, ReasoningStrategyId } from '../types.js'

/** Inference (and model-list) origin. Authentication lives on a different origin. */
export const ORCAROUTER_API_BASE = 'https://api.orcarouter.ai/v1'

/** Where users create or revoke their key. */
export const ORCAROUTER_KEYS_URL = 'https://www.orcarouter.ai/console/keys'
export const ORCAROUTER_PROVIDER_URL = 'https://www.orcarouter.ai/cyber'
export const ORCAROUTER_CYBER_CATALOG_URL = 'https://www.orcarouter.ai/models?tier=cyber'

/**
 * Provider id used for `--provider` and as the label in help/docs. The
 * display name is `OrcaRouter Cyber Inference`: a named inference provider for
 * security teams, not a generic "any endpoint" option.
 */
export const ORCAROUTER_PROVIDER_ID = 'orcarouter'

export interface ProviderPreset {
  id: string
  name: string
  baseUrl: string
  /** Environment variable the CLI reads the key from for this provider. */
  apiKeyEnv: string
  /** Model id used when `--model` is omitted. */
  defaultModel: string
  /**
   * Models shown first in the CLI selector when live discovery is unavailable
   * or when the user has not selected anything yet.
   */
  suggestedModels: readonly string[]
  /** Reasoning-disable strategy probe order for this provider's host. */
  reasoningHint: readonly ReasoningStrategyId[]
  /** Short positioning line printed by `--help` and `providers`. */
  description: string
}

/**
 * Models are OrcaRouter-namespaced ids from `GET /v1/models`; a bare vendor id
 * (e.g. `gpt-4o-mini`) is resolved inside OrcaRouter's own namespace instead of
 * silently falling through to the inference origin.
 */
export const ORCAROUTER_PRESET: ProviderPreset = {
  id: ORCAROUTER_PROVIDER_ID,
  name: 'OrcaRouter Cyber Inference',
  baseUrl: ORCAROUTER_API_BASE,
  apiKeyEnv: 'ORCAROUTER_API_KEY',
  defaultModel: 'orcarouter/auto',
  suggestedModels: [
    'orcarouter/auto',
    'orca/orcacyber-ultra-1.0',
    'orca/orcacyber-zero-1.5',
    'orcarouter/fusion',
  ],
  reasoningHint: ['openrouter-reasoning', 'openai-effort', 'zhipu-thinking'],
  description:
    'Cyber Inference provider for authorized security work (red/blue team, pentest, ' +
    'audit). Default orcarouter/auto; dedicated cyber models orca/orcacyber-ultra-1.0 ' +
    'and orca/orcacyber-zero-1.5 for verified security teams; orcarouter/fusion fallback.',
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [ORCAROUTER_PRESET]

export function getProviderPreset(id: string): ProviderPreset | undefined {
  const wanted = id.trim().toLowerCase()
  return PROVIDER_PRESETS.find((preset) => preset.id === wanted)
}

/** True when `baseUrl` points at the OrcaRouter inference origin (any path). */
export function isOrcaRouterBaseUrl(baseUrl: string): boolean {
  const { ok, normalized } = normalizeBaseUrl(baseUrl)
  if (!ok) return false
  try {
    const url = new URL(normalized)
    return url.hostname === 'api.orcarouter.ai'
  } catch {
    return false
  }
}

export function qualifyOrcaRouterModel(model: string): string {
  const trimmed = model.trim()
  if (!trimmed) return trimmed
  if (trimmed.includes('/')) return trimmed
  if (/^(auto|fusion|fusion-[\w.-]+)$/.test(trimmed)) return `orcarouter/${trimmed}`
  return `orca/${trimmed}`
}

export interface ResolveProviderOptions {
  /** `--provider <id>` (case-insensitive). */
  provider?: string
  /** `--base-url <url>`; overrides the preset's base URL when both are given. */
  baseUrl?: string
  /** `--model <id>`; defaults to the preset's default model. */
  model?: string
  apiKey?: string
}

export interface ResolvedProviderChoice {
  endpoint: Endpoint
  preset: ProviderPreset | null
  warnings: string[]
  /** Environment variables (in order) that may carry this provider's key. */
  apiKeyEnvVars: string[]
}

/**
 * Turn provider / base-url / model flags into an `Endpoint`. For OrcaRouter the
 * inference origin, model namespace and key environment variable are filled in
 * so users do not have to paste a base URL or remember a vendor mapping.
 */
export function resolveProviderChoice(options: ResolveProviderOptions): ResolvedProviderChoice {
  const preset = options.provider ? getProviderPreset(options.provider) : undefined
  if (options.provider && !preset) {
    const known = PROVIDER_PRESETS.map((p) => p.id).join(', ')
    throw new Error(`Unknown provider "${options.provider}" (known providers: ${known})`)
  }

  const explicitBaseUrl = options.baseUrl?.trim()
  const warnings: string[] = []

  if (preset) {
    const baseUrl = explicitBaseUrl || preset.baseUrl
    const orcaRouter = isOrcaRouterBaseUrl(baseUrl)
    let model = options.model?.trim() || preset.defaultModel
    if (orcaRouter) {
      model = qualifyOrcaRouterModel(model)
    } else {
      warnings.push(
        `provider "${preset.id}" with a non-default --base-url (${baseUrl}); model ids are passed through unchanged`,
      )
    }
    return {
      endpoint: { baseUrl, model, apiKey: options.apiKey },
      preset,
      warnings,
      apiKeyEnvVars: [preset.apiKeyEnv],
    }
  }

  return {
    endpoint: { baseUrl: explicitBaseUrl ?? '', model: options.model?.trim() ?? '', apiKey: options.apiKey },
    preset: null,
    warnings,
    apiKeyEnvVars: [],
  }
}

/**
 * Reasoning-disable strategy probe order per host. OrcaRouter is matched by
 * exact hostname (the inference origin only); the legacy substring hints keep
 * their historical behaviour for every other endpoint.
 */
const HOST_ADAPTER_HINTS: Array<{ hostIncludes: string; hint: ReasoningStrategyId[] }> = [
  { hostIncludes: 'openrouter.ai', hint: ['openrouter-reasoning', 'openai-effort', 'zhipu-thinking'] },
  { hostIncludes: 'api.openai.com', hint: ['openai-effort', 'openrouter-reasoning', 'zhipu-thinking'] },
  { hostIncludes: 'api.deepseek.com', hint: ['openai-effort', 'zhipu-thinking', 'openrouter-reasoning'] },
  { hostIncludes: 'bigmodel.cn', hint: ['zhipu-thinking', 'openai-effort', 'openrouter-reasoning'] },
]

export const DEFAULT_ADAPTER_HINT: ReasoningStrategyId[] = [
  'openrouter-reasoning',
  'zhipu-thinking',
  'openai-effort',
]

/** Order in which reasoning-disable strategies are probed for a given base URL. */
export function guessAdapterHint(baseUrl: string): ReasoningStrategyId[] {
  const lower = baseUrl.toLowerCase()
  if (isOrcaRouterBaseUrl(baseUrl)) return [...ORCAROUTER_PRESET.reasoningHint]
  for (const { hostIncludes, hint } of HOST_ADAPTER_HINTS) {
    if (lower.includes(hostIncludes)) return hint
  }
  return DEFAULT_ADAPTER_HINT
}

/** Request-body variant for "disable hidden reasoning" on OrcaRouter. */
export function orcaRouterReasoningBody(): Record<string, unknown> {
  return STRATEGY_BODIES['openrouter-reasoning']
}

/** Verified fallback models (orcarouter/auto first) used when discovery fails. */
export function orcaRouterFallbackModels(): readonly string[] {
  return ORCAROUTER_PRESET.suggestedModels
}

/**
 * OrcaRouter's verified cold-start seed: only the models the provider itself
 * documents and whose chat capability was confirmed against the live catalog.
 * Vendor models appear once their fingerprint reference exists; until then the
 * selector shows these plus whatever live discovery returns.
 */
export function orcaRouterSeedCatalog(): ModelCatalog {
  const entries: ModelCatalogEntry[] = orcaRouterFallbackModels().map((id) => ({
    id,
    inputModalities: ['text'],
    outputModalities: ['text'],
    endpointTypes: ['openai'],
    contextLength: null,
  }))
  return { source: 'seed', fallback: true, entries }
}

/**
 * Display order for the selector: the provider's default/recommended models
 * first (when present in the discovered catalog), then the rest as returned.
 */
export function orderCatalogForSelector(catalog: ModelCatalog): ModelCatalogEntry[] {
  const chat = filterChatCatalog(catalog)
  const priority = new Map(ORCAROUTER_PRESET.suggestedModels.map((id, index) => [id, index]))
  return [...chat].sort((a, b) => {
    const pa = priority.get(a.id) ?? Number.MAX_SAFE_INTEGER
    const pb = priority.get(b.id) ?? Number.MAX_SAFE_INTEGER
    if (pa !== pb) return pa - pb
    return 0
  })
}

export interface DiscoverModelsOptions {
  apiKey?: string | null
  baseUrl?: string
  /** Number of times to retry after a network/5xx/timeout failure. */
  retries?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** Page size hint; OrcaRouter ignores unknown query parameters. */
  limit?: number
  fetchImpl?: typeof fetch
}

/**
 * Bounded live discovery of `GET {baseUrl}/models`. On any failure (auth,
 * network, timeout, oversized or malformed body) it returns the seed in
 * degraded mode rather than an empty selector. Live success is authoritative:
 * nothing from the seed is merged into it.
 */
export async function discoverOrcaRouterModels(
  options: DiscoverModelsOptions = {},
): Promise<ModelCatalog & { error?: string }> {
  const baseUrl = normalizeBaseUrl(options.baseUrl || ORCAROUTER_API_BASE)
  if (!baseUrl.ok) return { ...orcaRouterSeedCatalog(), error: `invalid base URL "${baseUrl}"` }
  const url = `${baseUrl.normalized}/models`
  const doFetch = options.fetchImpl ?? fetch
  const retries = options.retries ?? 1
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS
  let lastError = ''

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onOuterAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onOuterAbort, { once: true })
    try {
      const response = await doFetch(url, { headers, signal: controller.signal })
      if (response.status === 401 || response.status === 403) {
        lastError = `model discovery rejected the API key (HTTP ${response.status})`
        break
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = `model discovery failed (HTTP ${response.status})`
        if (attempt < retries) continue
        break
      }
      if (!response.ok) {
        lastError = `model discovery failed (HTTP ${response.status})`
        break
      }
      const text = await response.text()
      if (text.length > CATALOG_MAX_BYTES) {
        lastError = 'model catalog response exceeded the size bound'
        break
      }
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        lastError = 'model catalog response was not valid JSON'
        break
      }
      const catalog = parseModelCatalog(payload, { source: 'live' })
      if (catalog.entries.length === 0) {
        lastError = 'model catalog response contained no models'
        break
      }
      return catalog
    } catch (error) {
      lastError =
        controller.signal.aborted && !options.signal?.aborted
          ? `model discovery timed out after ${timeoutMs}ms`
          : `model discovery failed: ${error instanceof Error ? error.message : String(error)}`
      if (options.signal?.aborted) break
      if (attempt < retries) continue
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  return { ...orcaRouterSeedCatalog(), error: lastError }
}

/** Lookup used to re-validate a stored model id before it is restored. */
export function isModelInCatalog(catalog: ModelCatalog, modelId: string): boolean {
  return filterChatCatalog(catalog).some((entry) => entry.id === modelId)
}
