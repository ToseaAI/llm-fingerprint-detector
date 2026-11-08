/**
 * CLI: named provider selection, model picker bound to the real catalog, and
 * an end-to-end verify() over the OrcaRouter provider path.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLI = join(fileURLToPath(new URL('..', import.meta.url)), 'dist', 'cli.js')

function runCli(args, { input = '', env = {} } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })
    })
    child.stdin?.end(input)
  })
}

test('providers command advertises the named OrcaRouter Cyber Inference provider', async () => {
  const text = await runCli(['providers'])
  assert.equal(text.code, 0)
  assert.match(text.stdout, /orcarouter — OrcaRouter Cyber Inference/)
  assert.match(text.stdout, /base URL: https:\/\/api\.orcarouter\.ai\/v1/)
  assert.match(text.stdout, /default model: orcarouter\/auto/)
  assert.match(text.stdout, /orca\/orcacyber-ultra-1\.0/)
  assert.match(text.stdout, /orca\/orcacyber-zero-1\.5/)
  assert.match(text.stdout, /orcarouter\/fusion/)
  assert.match(text.stdout, /https:\/\/www\.orcarouter\.ai\/cyber/)
  assert.match(text.stdout, /https:\/\/www\.orcarouter\.ai\/models\?tier=cyber/)
  assert.match(text.stdout, /ORCAROUTER_API_KEY=sk-orca-/)

  const json = await runCli(['providers', '--json'])
  const parsed = JSON.parse(json.stdout)
  assert.equal(parsed.providers[0].id, 'orcarouter')
  assert.equal(parsed.providers[0].name, 'OrcaRouter Cyber Inference')
})

test('help lists --provider and the orcarouter key variable without leaking keys', async () => {
  const help = await runCli(['--help'], { env: { ORCAROUTER_API_KEY: 'sk-orca-sentinel-should-not-appear' } })
  assert.match(help.stdout, /--provider <id>/)
  assert.match(help.stdout, /ORCAROUTER_API_KEY/)
  assert.doesNotMatch(help.stdout, /sk-orca-sentinel-should-not-appear/)
})

test('unknown provider and missing model fail with actionable errors', async () => {
  const unknown = await runCli(['fingerprint', '--provider', 'bogus'])
  assert.equal(unknown.code, 1)
  assert.match(unknown.stderr, /Unknown provider "bogus"/)

  const missing = await runCli(['fingerprint', '--base-url', 'https://example.com/v1'])
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /--model is required/)
})

/** Mock inference + catalog origin (uses --provider with a local --base-url). */
const MODEL_ANSWERS = {
  'orca/mock-alpha': { number: '42', color: 'blue', coin: 'heads' },
  'orca/mock-beta': { number: '57', color: 'crimson', coin: 'tails' },
}

function startMock() {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const auth = req.headers.authorization
      seen.push({ url: req.url, auth })
      if (req.url === '/v1/models') {
        if (auth !== 'Bearer sk-orca-test') {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'bad key' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [
              { id: 'orca/mock-alpha', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_endpoint_types: ['openai'] },
              { id: 'orca/mock-beta', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_endpoint_types: ['openai'] },
              { id: 'openai/gpt-image-1', architecture: { input_modalities: ['text'], output_modalities: ['image'] }, supported_endpoint_types: ['image-generation'] },
            ],
          }),
        )
        return
      }
      if (auth !== 'Bearer sk-orca-test') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'bad key' } }))
        return
      }
      const payload = JSON.parse(body)
      const answers = MODEL_ANSWERS[payload.model]
      if (!answers || payload.reasoning !== undefined) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'unsupported' } }))
        return
      }
      const prompt = payload.messages.at(-1).content.toLowerCase()
      const answer = prompt.includes('color') || prompt.includes('颜色') ? answers.color : prompt.includes('coin') || prompt.includes('硬币') ? answers.coin : answers.number
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }))
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ base: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => new Promise((r) => server.close(r)) }),
    ),
  )
}

test('model picker lists only catalog chat models and the pick drives the real request', async () => {
  const mock = await startMock()
  try {
    const cells = 'random-number-1-100:en,random-color:en,coin-flip:en,random-letter:en'
    const picked = await runCli(
      ['fingerprint', '--provider', 'orcarouter', '--base-url', mock.base, '--model', '?', '--cells', cells, '--samples', '3', '--quiet', '--json'],
      { input: '1\n', env: { ORCAROUTER_API_KEY: 'sk-orca-test' } },
    )
    assert.equal(picked.code, 0, picked.stderr)
    assert.match(picked.stderr, /models: 2 chat-capable model\(s\) from http:\/\/127\.0\.0\.1:\d+\/v1\/models/)
    assert.match(picked.stderr, /1\. orca\/mock-alpha/)
    assert.match(picked.stderr, /2\. orca\/mock-beta/)
    assert.doesNotMatch(picked.stderr, /gpt-image-1/, 'image models must not appear in the text-chat picker')
    assert.doesNotMatch(picked.stderr, /sk-orca-test/, 'the key must never be printed')
    const out = JSON.parse(picked.stdout)
    assert.equal(out.fingerprint.model, 'orca/mock-alpha')
    assert.equal(out.fingerprint.meta.provider, 'orcarouter')
    assert.equal(out.fingerprint.meta.providerName, 'OrcaRouter Cyber Inference')
    const chatCalls = mock.seen.filter((r) => r.url === '/v1/chat/completions')
    assert.ok(chatCalls.length > 0)
    assert.ok(chatCalls.every((r) => r.auth === 'Bearer sk-orca-test'))
    assert.ok(mock.seen.every((r) => r.auth === 'Bearer sk-orca-test'))
  } finally {
    await mock.close()
  }
})

test('verify() through the provider resolves a reference and exits with the verdict code', async () => {
  const mock = await startMock()
  try {
    const cells = 'random-number-1-100:en,random-color:en,coin-flip:en'
    const result = await runCli(
      ['verify', '--provider', 'orcarouter', '--base-url', mock.base, '--model', 'mock-alpha', '--reference', 'openai/gpt-4o-mini', '--cells', cells, '--samples', '2', '--json'],
      { env: { ORCAROUTER_API_KEY: 'sk-orca-test' } },
    )
    // A tiny mock distribution cannot match/open enough cells: verdict code, not a crash.
    assert.ok([0, 2, 3, 4].includes(result.code), `unexpected exit ${result.code}: ${result.stderr}`)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.target.fingerprint.model, 'mock-alpha') // base-url override passes ids through
    assert.equal(parsed.target.fingerprint.meta.provider, 'orcarouter')
  } finally {
    await mock.close()
  }
})

test('a rejected key surfaces an auth error and offers the key dashboard', async () => {
  const mock = await startMock()
  try {
    const bad = await runCli(['fingerprint', '--provider', 'orcarouter', '--base-url', mock.base, '--model', 'mock-alpha', '--cells', 'random-number-1-100:en', '--samples', '1', '--quiet'], {
      env: { ORCAROUTER_API_KEY: 'sk-orca-wrong-key-value' },
    })
    assert.equal(bad.code, 1)
    assert.match(bad.stderr, /API key rejected/)
    assert.match(bad.stderr, /console\/keys/)
    assert.doesNotMatch(bad.stderr, /sk-orca-wrong-key-value/)

    // Discovery failure is degraded, then the probe fails on the 401.
    const pick = await runCli(['fingerprint', '--provider', 'orcarouter', '--base-url', mock.base, '--model', '?', '--cells', 'random-number-1-100:en', '--samples', '1', '--quiet'], {
      input: '1\n',
      env: { ORCAROUTER_API_KEY: 'sk-orca-wrong-key-value' },
    })
    assert.equal(pick.code, 1)
    assert.match(pick.stderr, /live model discovery unavailable \(model discovery rejected the API key/)
    assert.match(pick.stderr, /offering the OrcaRouter verified seed only/)
  } finally {
    await mock.close()
  }
})
