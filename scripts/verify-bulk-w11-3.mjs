#!/usr/bin/env node
// Verify W11.3 — AI bulk alt-text generation.
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

console.log('\nW11.3 — AI bulk alt-text\n')

const altSvc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/ai/alt-text.service.ts'),
  'utf8',
)
const baSvc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/bulk-action.service.ts'),
  'utf8',
)

console.log('Case 1: alt-text service')
check('generateAltText exported',
  /export async function generateAltText/.test(altSvc))
check('rejects empty product name',
  /source\.name is required/.test(altSvc))
check('honors NEXUS_AI_KILL_SWITCH',
  /isAiKillSwitchOn\(\)/.test(altSvc))
check('uses jsonMode',
  /jsonMode: true/.test(altSvc))
check('clipAlt enforces 125-char cap',
  /ALT_MAX_CHARS = 125/.test(altSvc) &&
  /clipAlt/.test(altSvc))
check('prompt branches on imageType',
  /role === 'LIFESTYLE'[\s\S]{0,200}role === 'SWATCH'[\s\S]{0,200}role === 'DIAGRAM'/.test(altSvc))
check('prompt forbids "image of" preamble',
  /No "image of"/.test(altSvc))
check('logs usage on success and error',
  /ok: true/.test(altSvc) && /ok: false/.test(altSvc))
check('feature tag bulk-alt-text',
  /feature: input\.feature \?\? 'bulk-alt-text'/.test(altSvc))
check('telemetry binds to ProductImage entityType when imageId set',
  /input\.imageId \? 'ProductImage' : input\.productId \? 'Product'/.test(altSvc))

console.log('\nCase 2: bulk-action wiring')
check('AI_ALT_TEXT in BulkActionType union',
  /\| 'AI_ALT_TEXT'/.test(baSvc))
check('AI_ALT_TEXT in KNOWN_BULK_ACTION_TYPES',
  /'AI_ALT_TEXT',\s*\n\]\);/.test(baSvc))
check('ACTION_ENTITY maps AI_ALT_TEXT to product',
  /AI_ALT_TEXT: 'product'/.test(baSvc))

console.log('\nCase 3: dispatcher + handler')
check('case AI_ALT_TEXT in processItem',
  /case 'AI_ALT_TEXT':\s*\n\s*return await this\.processAiAltText/.test(baSvc))
check('handler lazy-imports alt-text service',
  /await import\('\.\/ai\/alt-text\.service\.js'\)/.test(baSvc))
check('handler validates BCP 47 locale',
  /payload\.locale must be BCP 47 lowercase/.test(baSvc))
check('handler skips when product has no name',
  /if \(!product \|\| !product\.name\?\.trim\(\)\) return \{ status: 'skipped' \}/.test(baSvc))
check('handler skips when no images',
  /if \(images\.length === 0\) return \{ status: 'skipped' \}/.test(baSvc))
check('onlyEmpty=true (default) skips images that already have alt',
  /if \(onlyEmpty && img\.alt && img\.alt\.trim\(\)\.length > 0\) continue/.test(baSvc))
check('passes image type to the generator',
  /imageType: img\.type/.test(baSvc))
check('persists alt back to ProductImage',
  /productImage\.update\(/.test(baSvc) &&
  /data: \{ alt: out\.alt \}/.test(baSvc))

console.log('\nCase 4: state extractors')
check('extractItemState handles AI_ALT_TEXT',
  /case 'AI_ALT_TEXT':[\s\S]{0,500}onlyEmpty: payload\?\.onlyEmpty !== false/.test(baSvc))
check('refetchAfterState returns per-image alt previews',
  /case 'AI_ALT_TEXT': \{[\s\S]{0,300}productImage\.findMany/.test(baSvc))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
