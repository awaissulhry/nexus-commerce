#!/usr/bin/env node
// Verify W11.1 — AI bulk translate.
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

console.log('\nW11.1 — AI bulk translate\n')

const trSvc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/ai/translate.service.ts'),
  'utf8',
)
const baSvc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/bulk-action.service.ts'),
  'utf8',
)

console.log('Case 1: translate service')
check('translateProductCopy exported',
  /export async function translateProductCopy/.test(trSvc))
check('rejects invalid ISO 639-1 codes',
  /ISO 639-1 lowercase/.test(trSvc))
check('honors NEXUS_AI_KILL_SWITCH',
  /isAiKillSwitchOn\(\)/.test(trSvc))
check('rejects when no provider configured',
  /No AI provider configured/.test(trSvc))
check('builds JSON-only prompt',
  /Schema:[\s\S]{0,200}name/.test(trSvc))
check('calls provider.generate with jsonMode',
  /jsonMode: true/.test(trSvc))
check('logs usage on success',
  /logUsage\(\{[\s\S]{0,400}ok: true/.test(trSvc))
check('logs usage on error',
  /logUsage\(\{[\s\S]{0,400}ok: false/.test(trSvc))
check('parses JSON tolerant of code fences',
  /```\?:json\)\?\\s\*|^\\\\\\*```\?:json\)|```\(\?:json\)\?/.test(trSvc) ||
  /replace\(\/\^```/.test(trSvc))
check('source tag derived from provider',
  /'ai-gemini' : 'ai-anthropic'/.test(trSvc))

console.log('\nCase 2: bulk-action wiring')
check('AI_TRANSLATE_PRODUCT in BulkActionType union',
  /\| 'AI_TRANSLATE_PRODUCT'/.test(baSvc))
check('AI_TRANSLATE_PRODUCT in KNOWN_BULK_ACTION_TYPES',
  /KNOWN_BULK_ACTION_TYPES[\s\S]{0,800}'AI_TRANSLATE_PRODUCT'/.test(baSvc))
check('ACTION_ENTITY maps to product',
  /AI_TRANSLATE_PRODUCT: 'product'/.test(baSvc))

console.log('\nCase 3: processItem dispatcher')
check('case AI_TRANSLATE_PRODUCT dispatches to handler',
  /case 'AI_TRANSLATE_PRODUCT':\s*\n\s*return await this\.processAiTranslate/.test(baSvc))

console.log('\nCase 4: handler behavior')
check('lazy-imports translate service',
  /await import\('\.\/ai\/translate\.service\.js'\)/.test(baSvc))
check('rejects empty targetLanguages',
  /payload\.targetLanguages required/.test(baSvc))
check('filters target languages by ISO 639-1',
  /\/\^\[a-z\]\{2\}\$\/.test\(l\)/.test(baSvc))
check('skips when product has no copy in any field',
  /if \(!hasAny\) return \{ status: 'skipped' \}/.test(baSvc))
check('skipReviewed=true (default) skips reviewed translations',
  /existing\?\.reviewedAt[\s\S]{0,80}continue/.test(baSvc))
check('upserts ProductTranslation per language',
  /productTranslation\.upsert\(/.test(baSvc) &&
  /productId_language: \{ productId: product\.id, language \}/.test(baSvc))
check('resets reviewedAt on new AI output',
  /reviewedAt: null/.test(baSvc))

console.log('\nCase 5: state extractors')
check('extractItemState handles AI_TRANSLATE_PRODUCT',
  /case 'AI_TRANSLATE_PRODUCT':\s*\n\s*\/\/ W11\.1[\s\S]{0,400}targetLanguages:/.test(baSvc))
check('refetchAfterState reads back ProductTranslation rows',
  /case 'AI_TRANSLATE_PRODUCT': \{[\s\S]{0,300}productTranslation\.findMany/.test(baSvc))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
