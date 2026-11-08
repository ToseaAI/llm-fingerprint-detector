#!/usr/bin/env node
/**
 * Live provider check for OrcaRouter Cyber Inference.
 *
 * Uses the CLI's own provider path (`--provider orcarouter`) against the
 * official inference origin: live model discovery via GET /v1/models, then one
 * small real fingerprint through the normal probe pipeline. The key is read
 * only from ORCAROUTER_API_KEY and is never printed.
 *
 * Live model order varies per key tier, so the model is chosen deterministically:
 *   1. orca/orcacyber-ultra-1.0, orca/orcacyber-zero-1.5, orca/orcacyber-zero-1.0
 *      (dedicated cyber models, verified security teams) when the catalog lists them;
 *   2. otherwise the OrcaRouter general fallback orcarouter/fusion / orcarouter/auto;
 *   3. otherwise a namespaced text-chat deployment (e.g. deepseek/deepseek-v4.1-flash),
 *      proving the provider wiring when the key has not unlocked the routing/cyber tiers.
 *
 * Skip (exit 0 with a notice) when ORCAROUTER_API_KEY is not set.
 */
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const cli = join(root, 'dist', 'cli.js')
const key = process.env.ORCAROUTER_API_KEY

if (!key) {
  console.log('SKIP: ORCAROUTER_API_KEY is not set; live provider check not executed.')
  process.exit(0)
}

const { discoverOrcaRouterModels, orderCatalogForSelector } = await import(
  new URL('../dist/index.js', import.meta.url).href
)

const catalog = await discoverOrcaRouterModels({ apiKey: key })
if (catalog.source !== 'live') {
  console.error(`FAIL: live discovery fell back to seed: ${catalog.error}`)
  process.exit(1)
}
const ids = orderCatalogForSelector(catalog).map((entry) => entry.id)
console.log(`live catalog: ${ids.length} chat-capable model(s) from https://api.orcarouter.ai/v1/models`)
for (const id of ids.slice(0, 10)) console.log(`  ${id}`)

const dedicated = ['orca/orcacyber-ultra-1.0', 'orca/orcacyber-zero-1.5', 'orca/orcacyber-zero-1.0']
const routing = ['orcarouter/auto', 'orcarouter/fusion']
let model = dedicated.find((id) => ids.includes(id))
let tier = 'dedicated cyber model'
if (!model) {
  model = routing.find((id) => ids.includes(id))
  tier = 'general routing model'
}
if (!model) {
  model = ids.find((id) => id.includes('/') && !/image|video|embed|rerank/i.test(id))
  tier = 'namespaced text-chat deployment'
}
if (!model) {
  console.error('FAIL: no chat-capable model in the live catalog')
  process.exit(1)
}
console.log(`selected: ${model} (${tier})`)

const args = [
  cli,
  'fingerprint',
  '--provider',
  'orcarouter',
  '--model',
  model,
  '--cells',
  'random-number-1-100:en',
  '--samples',
  '2',
  '--quiet',
  '--json',
]
const result = await new Promise((resolve) => {
  execFile(process.execPath, args, { env: process.env, timeout: 120_000 }, (error, stdout, stderr) => {
    resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr })
  })
})
if (result.stderr.trim()) console.log(result.stderr.trim())
if (result.code !== 0) {
  console.error(`FAIL: provider fingerprint exited ${result.code}`)
  process.exit(1)
}
const parsed = JSON.parse(result.stdout)
const fingerprint = parsed.fingerprint
if (fingerprint.model !== model) {
  console.error(`FAIL: fingerprint model ${fingerprint.model} != ${model}`)
  process.exit(1)
}
if (fingerprint.meta?.provider !== 'orcarouter') {
  console.error('FAIL: fingerprint metadata does not record the orcarouter provider')
  process.exit(1)
}
const valid = Object.values(fingerprint.cells).reduce((n, cell) => n + (cell?.validCount ?? 0), 0)
console.log(`live inference: model=${fingerprint.model} validAnswers=${valid} postReasoning=${fingerprint.postReasoning}`)
if (valid < 1) {
  console.error('FAIL: no valid answer from the live provider')
  process.exit(1)
}
console.log('PASS: OrcaRouter Cyber Inference provider path verified live.')
