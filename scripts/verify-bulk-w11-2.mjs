#!/usr/bin/env node
// Verify W11.2 — AI bulk SEO regeneration.
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

console.log('\nW11.2 — AI bulk SEO regen\n')

const seoSvc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/ai/seo-regen.service.ts'),
  'utf8',
)
const baSvc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/bulk-action.service.ts'),
  'utf8',
)

console.log('Case 1: regen service')
check('regenerateProductSeo exported',
  /export async function regenerateProductSeo/.test(seoSvc))
check('rejects invalid BCP 47 locale',
  /BCP 47 lowercase/.test(seoSvc))
check('rejects empty product name',
  /source\.name is required/.test(seoSvc))
check('honors NEXUS_AI_KILL_SWITCH',
  /isAiKillSwitchOn\(\)/.test(seoSvc))
check('uses jsonMode',
  /jsonMode: true/.test(seoSvc))
check('clip helper trims to length cap',
  /function clip\(/.test(seoSvc) &&
  /slice\(0, max\)\.trimEnd\(\)/.test(seoSvc))
check('metaTitle clipped to 60 chars',
  /clip\(parsed\.metaTitle, 60\)/.test(seoSvc))
check('metaDescription clipped to 160 chars',
  /clip\(parsed\.metaDescription, 160\)/.test(seoSvc))
check('logs usage on success and error',
  /ok: true/.test(seoSvc) && /ok: false/.test(seoSvc))
check('feature tag bulk-seo-regen',
  /feature: input\.feature \?\? 'bulk-seo-regen'/.test(seoSvc))

console.log('\nCase 2: bulk-action wiring')
check('AI_SEO_REGEN in BulkActionType union',
  /\| 'AI_SEO_REGEN'/.test(baSvc))
check('AI_SEO_REGEN in KNOWN_BULK_ACTION_TYPES',
  /KNOWN_BULK_ACTION_TYPES[\s\S]{0,800}'AI_SEO_REGEN'/.test(baSvc))
check('ACTION_ENTITY maps AI_SEO_REGEN to product',
  /AI_SEO_REGEN: 'product'/.test(baSvc))

console.log('\nCase 3: dispatcher + handler')
check('case AI_SEO_REGEN in processItem',
  /case 'AI_SEO_REGEN':\s*\n\s*return await this\.processAiSeoRegen/.test(baSvc))
check('handler lazy-imports regen service',
  /await import\('\.\/ai\/seo-regen\.service\.js'\)/.test(baSvc))
check('handler validates BCP 47 locales',
  /\/\^\[a-z\]\{2\}\(-\[a-z0-9\]\{2,8\}\)\?\$\//.test(baSvc))
check('handler rejects empty locales array',
  /payload\.locales required/.test(baSvc))
check('handler skips when product has no name',
  /if \(!product \|\| !product\.name\?\.trim\(\)\) return \{ status: 'skipped' \}/.test(baSvc))
check('handler upserts ProductSeo per locale',
  /productSeo\.upsert\(/.test(baSvc) &&
  /productId_locale: \{ productId: product\.id, locale \}/.test(baSvc))
check('handler does not touch urlHandle / canonicalUrl / schemaOrgJson',
  /SEO regen is title\/desc only/.test(baSvc))

console.log('\nCase 4: state extractors')
check('extractItemState handles AI_SEO_REGEN',
  /case 'AI_SEO_REGEN':[\s\S]{0,300}masterKeywords:/.test(baSvc))
check('refetchAfterState reads back ProductSeo rows',
  /case 'AI_SEO_REGEN': \{[\s\S]{0,400}productSeo\.findMany/.test(baSvc))
check('refetchAfterState returns metaTitle/metaDescription per locale',
  /seo: rows\.map[\s\S]{0,200}metaTitle: r\.metaTitle/.test(baSvc))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
