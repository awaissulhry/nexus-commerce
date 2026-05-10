#!/usr/bin/env node
// Verify W14.5 — UI entry points for the W11/W12 actions.
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

console.log('\nW14.5 — operation modal entries\n')

const types = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/_operations/types.ts'),
  'utf8',
)
const cfg = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/_operations/configs.tsx'),
  'utf8',
)

console.log('Case 1: OperationType extended')
for (const t of ['AI_TRANSLATE_PRODUCT', 'AI_SEO_REGEN', 'AI_ALT_TEXT', 'CHANNEL_BATCH']) {
  check(`OperationType includes ${t}`,
    new RegExp(`\\| '${t}'`).test(types))
}

console.log('\nCase 2: each new OperationConfig registered')
for (const t of ['AI_TRANSLATE_PRODUCT', 'AI_SEO_REGEN', 'AI_ALT_TEXT', 'CHANNEL_BATCH']) {
  check(`OPERATIONS has type=${t}`,
    new RegExp(`type: '${t}'`).test(cfg))
}

console.log('\nCase 3: AI_TRANSLATE_PRODUCT shape')
check('default targetLanguages includes "it"',
  /targetLanguages: \['it'\]/.test(cfg))
check('default fields covers name + description + bulletPoints',
  /fields: \['name', 'description', 'bulletPoints'\]/.test(cfg))
check('language picker for it/de/fr/es/en/nl/sv/pl',
  /\['it', 'de', 'fr', 'es', 'en', 'nl', 'sv', 'pl'\]/.test(cfg))
check('isPayloadValid checks targetLanguages non-empty',
  /Array\.isArray\(p\.targetLanguages\)[\s\S]{0,200}\.length > 0/.test(cfg))

console.log('\nCase 4: AI_SEO_REGEN shape')
check('default locale en',
  /AI_SEO_REGEN[\s\S]{0,400}locales: \['en'\]/.test(cfg))
check('locale picker present',
  /\['en', 'it', 'de', 'fr', 'es', 'nl'\]/.test(cfg))

console.log('\nCase 5: AI_ALT_TEXT shape')
check('defaults onlyEmpty + locale',
  /AI_ALT_TEXT[\s\S]{0,400}onlyEmpty: true, locale: 'en'/.test(cfg))
check('locale validator matches BCP 47 lowercase',
  /\^\[a-z\]\{2\}\(-\[a-z0-9\]\{2,8\}\)\?\$/.test(cfg))

console.log('\nCase 6: CHANNEL_BATCH shape')
check('channel picker covers AMAZON/EBAY/SHOPIFY',
  /CHANNEL_BATCH[\s\S]{0,1500}\['AMAZON', 'EBAY', 'SHOPIFY'\]/.test(cfg))
check('operation picker price | stock',
  /\['price', 'stock'\]/.test(cfg))
check('marketplace text input optional',
  /Marketplace \(optional/.test(cfg))
check('isPayloadValid enforces enum',
  /\(p\.channel === 'AMAZON' \|\| p\.channel === 'EBAY' \|\| p\.channel === 'SHOPIFY'\)/.test(cfg) &&
  /\(p\.operation === 'price' \|\| p\.operation === 'stock'\)/.test(cfg))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
