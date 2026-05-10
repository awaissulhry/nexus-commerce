#!/usr/bin/env node
// Verify W14.8 — AI cost preview banner inside the bulk modal.
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

console.log('\nW14.8 — AI cost preview in modal\n')

const modal = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/BulkOperationModal.tsx'),
  'utf8',
)

console.log('Case 1: state + ref declared')
check('aiCost state has costUSD/callCount/tokens fields',
  /useState<\{[\s\S]{0,400}callCount: number[\s\S]{0,200}costUSD: number/.test(modal))
check('aiCostLoading flag declared',
  /aiCostLoading, setAiCostLoading/.test(modal))
check('aiCostSeq ref for race-cancellation',
  /aiCostSeq = useRef\(0\)/.test(modal))

console.log('\nCase 2: isAiOp flag')
check('isAiOp evaluates AI_TRANSLATE_PRODUCT / AI_SEO_REGEN / AI_ALT_TEXT',
  /const isAiOp =[\s\S]{0,300}'AI_TRANSLATE_PRODUCT'[\s\S]{0,200}'AI_SEO_REGEN'[\s\S]{0,200}'AI_ALT_TEXT'/.test(modal))

console.log('\nCase 3: cost preview fetch')
check('only fires when AI op selected + preview affectedCount > 0',
  /!open \|\| !isAiOp \|\| !preview \|\| preview\.affectedCount === 0/.test(modal))
check('POSTs to /api/bulk-operations/ai/cost-preview',
  /\/api\/bulk-operations\/ai\/cost-preview/.test(modal))
check('debounced 350ms (matches preview cadence)',
  /aiCostSeq[\s\S]{0,400}setTimeout\([\s\S]{0,1500}\}, 350\)/.test(modal))
check('passes actionType + productCount + payload',
  /actionType: opType,\s*\n\s*productCount: preview\.affectedCount,\s*\n\s*payload,/.test(modal))
check('discards stale responses via seq check',
  /seq !== aiCostSeq\.current/.test(modal))

console.log('\nCase 4: banner rendering')
check('renders cost banner when isAiOp + (loading or cost)',
  /isAiOp && \(aiCostLoading \|\| aiCost\)/.test(modal))
check('shows ≈ $X.XX with 2 decimals',
  /aiCost\.costUSD\.toFixed\(2\)/.test(modal))
check('shows callCount + tokens + model in subtitle',
  /aiCost\.callCount\.toLocaleString\(\)[\s\S]{0,400}aiCost\.inputTokens \+ aiCost\.outputTokens[\s\S]{0,200}aiCost\.model/.test(modal))
check('Estimating cost… while loading',
  /Estimating cost…/.test(modal))
check('role=status + aria-live=polite',
  /role="status"[\s\S]{0,80}aria-live="polite"/.test(modal))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
