/**
 * Reasoning-disable adapter layer. Hidden "thinking" must be turned off:
 * it burns the max_tokens budget before any visible answer appears, and it
 * shifts the sampled distribution. Three request-body variants are known to
 * work across OpenAI-compatible providers:
 *
 *   1. `reasoning: { enabled: false }`   — OpenRouter style
 *   2. `thinking: { type: "disabled" }`  — Zhipu BigModel style
 *   3. `reasoning_effort: "none"`        — OpenAI style
 *
 * Before a run, each variant is probed in a provider-specific order; the
 * first one that returns a non-empty visible answer without a 4xx wins. If
 * every variant fails, a bare request is tried; if even that yields no
 * visible text, the run falls back to a "post-reasoning" channel
 * (max_tokens=1024) and the resulting fingerprint is flagged as lower
 * confidence.
 */

import { getSystemPrompt, pickParaphrase } from './battery.js'
import {
  POST_REASONING_MAX_TOKENS,
  PROBE_MAX_TOKENS,
  PROBE_TEMPERATURE,
} from './constants.js'
import { guessAdapterHint } from './providers/orcarouter.js'
import { fetchChatCompletion, ProbeRequestError } from './http.js'
import type {
  CellId,
  ReasoningAdapter,
  ReasoningStrategyId,
  ResolvedEndpoint,
} from './types.js'

export const STRATEGY_BODIES: Record<
  Exclude<ReasoningStrategyId, 'none'>,
  Record<string, unknown>
> = {
  'openrouter-reasoning': { reasoning: { enabled: false } },
  'zhipu-thinking': { thinking: { type: 'disabled' } },
  'openai-effort': { reasoning_effort: 'none' },
}

const ADAPTER_PROBE_CELL: CellId = 'random-number-1-100:en'

export interface AdapterDetectionOptions {
  signal?: AbortSignal
  timeoutMs?: number
  onProbe?: (strategy: ReasoningStrategyId) => void
}

/**
 * Detect which reasoning-disable field the endpoint accepts.
 * Auth (401/403) and transport errors abort detection immediately — they are
 * unrelated to the strategy and would fail the whole run anyway.
 */
export async function detectReasoningAdapter(
  endpoint: ResolvedEndpoint,
  options: AdapterDetectionOptions = {},
): Promise<ReasoningAdapter> {
  const hint: ReasoningStrategyId[] = guessAdapterHint(endpoint.baseUrl)
  const systemPrompt = getSystemPrompt(ADAPTER_PROBE_CELL)

  for (const strategy of hint) {
    if (strategy === 'none') continue
    options.onProbe?.(strategy)
    try {
      const result = await fetchChatCompletion({
        endpoint,
        systemPrompt,
        userPrompt: pickParaphrase(ADAPTER_PROBE_CELL),
        temperature: PROBE_TEMPERATURE,
        maxTokens: PROBE_MAX_TOKENS,
        extraBody: STRATEGY_BODIES[strategy],
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        retries: 0,
      })
      if (result.content.trim().length > 0) {
        return {
          strategy,
          extraBody: STRATEGY_BODIES[strategy],
          maxTokens: PROBE_MAX_TOKENS,
          postReasoning: false,
        }
      }
    } catch (error) {
      if (error instanceof ProbeRequestError) {
        if (error.kind === 'auth' || error.kind === 'network' || error.kind === 'aborted') {
          throw error
        }
        // 4xx parameter rejection or timeout: try the next strategy.
        continue
      }
      throw error
    }
  }

  // No disable field accepted → probe with a bare request.
  options.onProbe?.('none')
  try {
    const bare = await fetchChatCompletion({
      endpoint,
      systemPrompt,
      userPrompt: pickParaphrase(ADAPTER_PROBE_CELL),
      temperature: PROBE_TEMPERATURE,
      maxTokens: PROBE_MAX_TOKENS,
      extraBody: {},
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      retries: 0,
    })
    if (bare.content.trim().length > 0) {
      // Non-reasoning model (or reasoning is free): bare requests are fine.
      return { strategy: 'none', extraBody: {}, maxTokens: PROBE_MAX_TOKENS, postReasoning: false }
    }
  } catch (error) {
    if (
      error instanceof ProbeRequestError &&
      (error.kind === 'auth' || error.kind === 'network' || error.kind === 'aborted')
    ) {
      throw error
    }
    // Anything else falls through to the post-reasoning channel.
  }

  // Fallback: reasoning cannot be disabled. Raise max_tokens so a visible
  // answer survives after the hidden reasoning; flag reduced confidence.
  return {
    strategy: 'none',
    extraBody: {},
    maxTokens: POST_REASONING_MAX_TOKENS,
    postReasoning: true,
  }
}
