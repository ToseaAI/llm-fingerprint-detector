/**
 * OrcaRouter Cyber Inference provider wiring: named preset, model namespace,
 * reasoning hint, and the CLI model selector.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import {
  ORCAROUTER_API_BASE,
  ORCAROUTER_PRESET,
  PROVIDER_PRESETS,
  discoverOrcaRouterModels,
  getProviderPreset,
  guessAdapterHint,
  isOrcaRouterBaseUrl,
  orderCatalogForSelector,
  orcaRouterSeedCatalog,
  qualifyOrcaRouterModel,
  resolveProviderChoice,
} from '../dist/index.js'

test('orcarouter preset: named provider, default model, key env, cyber positioning', () => {
  const preset = getProviderPreset('OrcaRouter')
  assert.equal(preset, ORCAROUTER_PRESET)
  assert.equal(preset.id, 'orcarouter')
  assert.equal(preset.name, 'OrcaRouter Cyber Inference')
  assert.equal(preset.baseUrl, 'https://api.orcarouter.ai/v1')
  assert.equal(preset.apiKeyEnv, 'ORCAROUTER_API_KEY')
  assert.equal(preset.defaultModel, 'orcarouter/auto')
  // Default, dedicated cyber models, general fallback — in that order.
  assert.deepEqual(preset.suggestedModels, [
    'orcarouter/auto',
    'orca/orcacyber-ultra-1.0',
    'orca/orcacyber-zero-1.5',
    'orcarouter/fusion',
  ])
  assert.equal(PROVIDER_PRESETS.length, 1)
  assert.equal(getProviderPreset('nope'), undefined)
})

test('--provider orcarouter fills base URL, default model and key env', () => {
  const choice = resolveProviderChoice({ provider: 'orcarouter' })
  assert.equal(choice.endpoint.baseUrl, 'https://api.orcarouter.ai/v1')
  assert.equal(choice.endpoint.model, 'orcarouter/auto')
  assert.deepEqual(choice.apiKeyEnvVars, ['ORCAROUTER_API_KEY'])
  assert.deepEqual(choice.warnings, [])
})

test('model ids are namespaced inside OrcaRouter, not passed through bare', () => {
  assert.equal(qualifyOrcaRouterModel('gpt-4o-mini'), 'orca/gpt-4o-mini')
  assert.equal(qualifyOrcaRouterModel('auto'), 'orcarouter/auto')
  assert.equal(qualifyOrcaRouterModel('fusion'), 'orcarouter/fusion')
  assert.equal(qualifyOrcaRouterModel('orca/orcacyber-zero-1.5'), 'orca/orcacyber-zero-1.5')
  assert.equal(qualifyOrcaRouterModel('openai/gpt-5.5'), 'openai/gpt-5.5')
  const choice = resolveProviderChoice({ provider: 'orcarouter', model: 'deepseek-v4-pro' })
  assert.equal(choice.endpoint.model, 'orca/deepseek-v4-pro')
})

test('--base-url override with --provider is honoured and warns', () => {
  const choice = resolveProviderChoice({
    provider: 'orcarouter',
    baseUrl: 'http://127.0.0.1:9999/v1',
    model: 'mock-alpha',
  })
  assert.equal(choice.endpoint.baseUrl, 'http://127.0.0.1:9999/v1')
  assert.equal(choice.endpoint.model, 'mock-alpha')
  assert.equal(choice.warnings.length, 1)
  assert.match(choice.warnings[0], /non-default --base-url/)
})

test('plain --base-url mode keeps the legacy behaviour', () => {
  const choice = resolveProviderChoice({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' })
  assert.equal(choice.preset, null)
  assert.equal(choice.endpoint.model, 'gpt-4o-mini')
  assert.deepEqual(choice.apiKeyEnvVars, [])
  assert.throws(() => resolveProviderChoice({ provider: 'bogus' }), /Unknown provider/)
})

test('host detection and reasoning hint are OrcaRouter-specific', () => {
  assert.equal(isOrcaRouterBaseUrl('https://api.orcarouter.ai/v1'), true)
  assert.equal(isOrcaRouterBaseUrl('api.orcarouter.ai/v1'), true)
  assert.equal(isOrcaRouterBaseUrl('https://api.orcarouter.ai'), true)
  assert.equal(isOrcaRouterBaseUrl('https://evil.example/?u=api.orcarouter.ai'), false)
  assert.equal(isOrcaRouterBaseUrl('https://api.openai.com/v1'), false)
  assert.deepEqual(guessAdapterHint('https://api.orcarouter.ai/v1'), [
    'openrouter-reasoning',
    'openai-effort',
    'zhipu-thinking',
  ])
  assert.deepEqual(guessAdapterHint('https://openrouter.ai/api/v1'), [
    'openrouter-reasoning',
    'openai-effort',
    'zhipu-thinking',
  ])
  assert.deepEqual(guessAdapterHint('https://api.deepseek.com/v1'), [
    'openai-effort',
    'zhipu-thinking',
    'openrouter-reasoning',
  ])
})

test('seed catalog: exactly the verified fallback list, marked as fallback', () => {
  const seed = orcaRouterSeedCatalog()
  assert.equal(seed.source, 'seed')
  assert.equal(seed.fallback, true)
  assert.deepEqual(
    seed.entries.map((e) => e.id),
    ['orcarouter/auto', 'orca/orcacyber-ultra-1.0', 'orca/orcacyber-zero-1.5', 'orcarouter/fusion'],
  )
  for (const entry of seed.entries) {
    assert.deepEqual(entry.inputModalities, ['text'])
    assert.deepEqual(entry.outputModalities, ['text'])
  }
})

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

async function startCatalogServer(handler) {
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization ?? null })
    const { status, body } = handler(req)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/v1`
  return { base, requests, close: () => new Promise((resolve) => server.close(resolve)) }
}

const FIXTURE = {
  data: [
    {
      id: 'orcarouter/auto',
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_endpoint_types: ['openai', 'anthropic'],
    },
    {
      id: 'orca/orcacyber-ultra-1.0',
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_endpoint_types: ['openai'],
      context_length: 1048576,
    },
    {
      id: 'anthropic/claude-opus-4.8',
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      supported_endpoint_types: ['openai', 'anthropic'],
      context_length: 200000,
    },
    {
      id: 'openai/gpt-image-1',
      architecture: { input_modalities: ['text'], output_modalities: ['image'] },
      supported_endpoint_types: ['image-generation'],
    },
    {
      id: 'google/gemini-3.5-flash',
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      supported_endpoint_types: ['gemini'],
    },
    { id: 'openai/text-embedding-3-large', supported_endpoint_types: ['embeddings'] },
    { id: 'jina/jina-rerank-v2', supported_endpoint_types: ['jina-rerank'] },
    { id: 'openai/sora-2', supported_endpoint_types: ['openai-video'] },
    { id: 'no/modalities-declared', supported_endpoint_types: ['openai'] },
    'garbage-entry',
    { noId: true },
  ],
}

test('live discovery is authoritative, filtered, and ordered with defaults first', async () => {
  const srv = await startCatalogServer(() => ({ status: 200, body: FIXTURE }))
  try {
    const catalog = await discoverOrcaRouterModels({ baseUrl: srv.base, apiKey: 'fake-key' })
    assert.equal(catalog.source, 'live')
    assert.equal(catalog.fallback, false)
    assert.equal(catalog.entries.length, 9) // garbage + noId dropped
    assert.equal(srv.requests.length, 1)
    assert.equal(srv.requests[0].url, '/v1/models')
    assert.equal(srv.requests[0].auth, 'Bearer fake-key')

    const ids = orderCatalogForSelector(catalog).map((e) => e.id)
    assert.deepEqual(ids, [
      'orcarouter/auto',
      'orca/orcacyber-ultra-1.0',
      'anthropic/claude-opus-4.8',
      'google/gemini-3.5-flash',
    ])
    // No seed entry is merged into a successful live catalog.
    assert.ok(!ids.includes('orcarouter/fusion'))
  } finally {
    await srv.close()
  }
})

test('discovery falls back to the labelled seed on auth, 5xx, malformed and oversized bodies', async () => {
  const cases = [
    { status: 401, body: { error: 'invalid key' } },
    { status: 403, body: { error: 'forbidden' } },
    { status: 500, body: { error: 'boom' } },
    { status: 200, body: '{not json' },
    { status: 200, body: { data: [] } },
    { status: 200, body: { data: [{ id: 'x'.repeat(600 * 1024) }] } },
  ]
  for (const c of cases) {
    const srv = await startCatalogServer(() => c)
    try {
      const catalog = await discoverOrcaRouterModels({ baseUrl: srv.base, retries: 0 })
      assert.equal(catalog.source, 'seed')
      assert.equal(catalog.fallback, true)
      assert.equal(typeof catalog.error, 'string')
      assert.deepEqual(
        catalog.entries.map((e) => e.id),
        ORCAROUTER_PRESET.suggestedModels,
      )
    } finally {
      await srv.close()
    }
  }
})

test('discovery falls back on network errors and honours the abort signal', async () => {
  const network = await discoverOrcaRouterModels({
    baseUrl: 'http://127.0.0.1:1/v1',
    retries: 0,
    timeoutMs: 500,
  })
  assert.equal(network.source, 'seed')
  assert.match(network.error, /model discovery failed/)

  const controller = new AbortController()
  let hits = 0
  const slowFetch = (url, init) => {
    hits += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(jsonResponse(200, { data: [] })), 5000)
      init.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      })
    })
  }
  const pending = discoverOrcaRouterModels({
    apiKey: 'fake',
    retries: 2,
    signal: controller.signal,
    fetchImpl: slowFetch,
  })
  setTimeout(() => controller.abort(), 50)
  const catalog = await pending
  assert.equal(catalog.source, 'seed')
  assert.equal(hits, 1, 'an aborted discovery must not retry')
})

test('default discovery origin is the OrcaRouter inference API', async () => {
  const seen = []
  const fakeFetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers })
    return jsonResponse(200, {
      data: [{ id: 'orca/orcacyber-zero-1.5', architecture: { input_modalities: ['text'] } }],
    })
  }
  const catalog = await discoverOrcaRouterModels({ apiKey: 'sk-orca-test', fetchImpl: fakeFetch })
  assert.equal(seen[0].url, 'https://api.orcarouter.ai/v1/models')
  assert.equal(seen[0].headers.Authorization, 'Bearer sk-orca-test')
  assert.equal(catalog.source, 'live')
  assert.equal(ORCAROUTER_API_BASE, 'https://api.orcarouter.ai/v1')
})

test('adapter detection on orcarouter uses the reasoning-disable body, then bare requests', async () => {
  let sawReasoning = 0
  let sawThinking = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const payload = JSON.parse(body)
      if (payload.thinking !== undefined) sawThinking += 1
      if (payload.reasoning !== undefined || payload.reasoning_effort !== undefined) {
        sawReasoning += 1
        res.writeHead(400).end(JSON.stringify({ error: 'unknown parameter' }))
        return
      }
      if (payload.thinking !== undefined) {
        // Unknown `thinking` field: acknowledged with no visible answer.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: '' } }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '42' } }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  try {
    const { detectReasoningAdapter } = await import('../dist/adapter.js')
    const adapter = await detectReasoningAdapter({ baseUrl, model: 'm', apiKey: null, headers: {} })
    // The reasoning-disable body is rejected (400) → falls back to a bare request.
    assert.equal(adapter.strategy, 'none')
    assert.equal(adapter.postReasoning, false)
    // All three disable strategies probed and rejected; only then the bare request.
    assert.equal(sawReasoning, 2)
    assert.equal(sawThinking, 1)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
