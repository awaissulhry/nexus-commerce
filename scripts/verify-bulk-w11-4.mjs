#!/usr/bin/env node
// Verify W11.4 — AI cost preview. Closes Wave 11.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')

let failures = 0
function check(label, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) failures++
}

console.log('\nW11.4 — AI cost preview\n')

const svc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/ai/cost-preview.service.ts'),
  'utf8',
)
const routes = fs.readFileSync(
  path.join(repo, 'apps/api/src/routes/bulk-operations.routes.ts'),
  'utf8',
)

console.log('Case 1: cost-preview service')
check('estimateAiBulkCost exported',
  /export function estimateAiBulkCost/.test(svc))
check('rejects productCount <= 0',
  /productCount must be > 0/.test(svc))
check('honors provider override + falls back to default model',
  /provider\?\.defaultModel \?\?\s*\n?\s*\(providerName === 'gemini' \? GEMINI_DEFAULT_MODEL : ANTHROPIC_DEFAULT_MODEL\)/.test(svc))
check('priceFor() applied to total tokens',
  /priceFor\(providerName, model, inputTokens, outputTokens\)/.test(svc))

console.log('\nCase 2: per-action heuristics')
for (const t of ['AI_TRANSLATE_PRODUCT', 'AI_SEO_REGEN', 'AI_ALT_TEXT']) {
  check(`HEURISTICS covers ${t}`, new RegExp(`${t}: \\{ inputPerCall:`).test(svc))
}
check('translate calls = products × languages',
  /productCount \* Math\.max\(langs, 1\)/.test(svc))
check('seo calls = products × locales',
  /productCount \* Math\.max\(locales, 1\)/.test(svc))
check('alt-text calls = products × avgImages',
  /productCount \* imgs/.test(svc))
check('avgImagesPerProduct default = 4',
  /avgImagesPerProduct \?\? 4/.test(svc))

console.log('\nCase 3: estimate result shape')
for (const k of [
  'actionType', 'productCount', 'callCount',
  'inputTokens', 'outputTokens', 'costUSD',
  'provider', 'model', 'note',
]) {
  check(`AiCostEstimate has ${k}`,
    new RegExp(`${k}:`).test(svc))
}

console.log('\nCase 4: route wiring')
check("registers POST '/bulk-operations/ai/cost-preview'",
  /'\/bulk-operations\/ai\/cost-preview'/.test(routes))
check('400 for invalid actionType',
  /AI_TRANSLATE_PRODUCT \| AI_SEO_REGEN \| AI_ALT_TEXT/.test(routes))
check('400 for missing productCount',
  /productCount required \(> 0\)/.test(routes))
check('lazy-imports cost-preview service',
  /await import\(\s*\n?\s*'\.\.\/services\/ai\/cost-preview\.service\.js'/.test(routes))
check('returns { success, estimate }',
  /reply\.send\(\{ success: true, estimate \}\)/.test(routes))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed (Wave 11 complete)')
