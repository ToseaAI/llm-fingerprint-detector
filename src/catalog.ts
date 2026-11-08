/**
 * Provider-agnostic model catalog: parsing, bounded shape acceptance and
 * capability filtering for the CLI model selector.
 *
 * The catalog is whatever the configured inference origin returns from
 * `GET {baseUrl}/models` (the OrcaRouter origin by default). Filtering is
 * fail-closed: a model is offered for text chat only when its metadata proves
 * it, never because its name looks plausible.
 */

import type { ModelCatalog, ModelCatalogEntry } from './types.js'

/** Guard rails so a hostile or broken catalog cannot exhaust the process. */
export const CATALOG_MAX_MODELS = 500
export const CATALOG_MAX_BYTES = 512 * 1024
export const CATALOG_TIMEOUT_MS = 10_000

/** Endpoint types a chat-completions request can use. */
const CHAT_ENDPOINT_TYPES = new Set(['openai', 'anthropic', 'gemini', 'openai-response'])
/** Chat-capable entries that cannot answer a text chat completion. */
const NON_CHAT_ID = /(^|[-/])(image|imagen|dall-e|flux|stable-diffusion|video|veo|sora|tts|whisper|embed|rerank|moderation)/i

export interface CatalogFilter {
  capability: 'chat'
  /**
   * Input modalities the entry must explicitly declare (default `text`).
   * A multimodal entry adds `image`/`audio`/`video` only when the caller
   * actually sends that modality.
   */
  requiredInputModalities?: Array<'text' | 'image' | 'audio' | 'video'>
}

function normalizeModalities(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((m): m is string => typeof m === 'string')
}

/**
 * Parse an unknown `/v1/models` payload into entries. Items that do not match
 * the accepted shape are dropped rather than guessed at.
 */
export function parseModelCatalog(
  payload: unknown,
  options: { source: 'live' | 'seed'; fallback?: boolean } = { source: 'live' },
): ModelCatalog {
  const data =
    payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data as unknown[])
      : []
  const entries: ModelCatalogEntry[] = []
  const seen = new Set<string>()
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const arch = (record.architecture ?? null) as Record<string, unknown> | null
    const endpointTypes = Array.isArray(record.supported_endpoint_types)
      ? record.supported_endpoint_types.filter((t): t is string => typeof t === 'string')
      : null
    entries.push({
      id,
      name: typeof record.name === 'string' ? record.name : undefined,
      contextLength: typeof record.context_length === 'number' ? record.context_length : null,
      inputModalities: normalizeModalities(arch?.input_modalities),
      outputModalities: normalizeModalities(arch?.output_modalities),
      endpointTypes,
    })
    if (entries.length >= CATALOG_MAX_MODELS) break
  }
  return { source: options.source, fallback: options.fallback ?? false, entries }
}

export function filterChatCatalog(
  catalog: ModelCatalog,
  filter: CatalogFilter = { capability: 'chat' },
): ModelCatalogEntry[] {
  const required = filter.requiredInputModalities ?? ['text']
  return catalog.entries.filter((entry) => {
    if (NON_CHAT_ID.test(entry.id)) return false
    if (entry.endpointTypes && entry.endpointTypes.length > 0) {
      if (!entry.endpointTypes.some((t) => CHAT_ENDPOINT_TYPES.has(t))) return false
    }
    if (entry.outputModalities && !entry.outputModalities.includes('text')) return false
    // Fail closed: an entry must explicitly declare every required modality.
    if (!entry.inputModalities) return false
    const declared = entry.inputModalities
    return required.every((m) => declared.includes(m))
  })
}
