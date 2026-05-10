#!/usr/bin/env node
// Verify W14.7 — Cmd+K AI verb event wiring.
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

console.log('\nW14.7 — Cmd+K AI verb wiring\n')

const palette = fs.readFileSync(
  path.join(repo, 'apps/web/src/components/CommandPalette.tsx'),
  'utf8',
)
const modal = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/BulkOperationModal.tsx'),
  'utf8',
)
const client = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/BulkOperationsClient.tsx'),
  'utf8',
)

console.log('Case 1: palette dispatches the events')
for (const evt of [
  'nexus:bulk-operations:ai-translate',
  'nexus:bulk-operations:ai-seo',
  'nexus:bulk-operations:ai-alt-text',
]) {
  check(`palette dispatches ${evt}`,
    new RegExp(`new CustomEvent\\('${evt}'\\)`).test(palette))
}

console.log('\nCase 2: modal accepts initialActionType')
check('Props.initialActionType declared',
  /initialActionType\?:\s*OperationType/.test(modal))
check('useState seeded from initialActionType ?? PRICING_UPDATE',
  /useState<OperationType>\(\s*\n?\s*initialActionType \?\? 'PRICING_UPDATE'/.test(modal))
check('open transition re-applies initialActionType',
  /useEffect\(\(\) => \{[\s\S]{0,300}if \(open && initialActionType\)[\s\S]{0,200}setOpType\(initialActionType\)/.test(modal))

console.log('\nCase 3: client subscribes to the events')
for (const evt of [
  'nexus:bulk-operations:ai-translate',
  'nexus:bulk-operations:ai-seo',
  'nexus:bulk-operations:ai-alt-text',
]) {
  check(`window.addEventListener('${evt}', …)`,
    new RegExp(`addEventListener\\('${evt}'`).test(client))
  check(`window.removeEventListener('${evt}', …)`,
    new RegExp(`removeEventListener\\('${evt}'`).test(client))
}

console.log('\nCase 4: events open the modal with the right preselect')
check('bulkOpInitialType state declared',
  /useState<\s*\n?\s*\| 'AI_TRANSLATE_PRODUCT'\s*\n?\s*\| 'AI_SEO_REGEN'\s*\n?\s*\| 'AI_ALT_TEXT'\s*\n?\s*\| null\s*\n?\s*>\(null\)/.test(client))
check('handler opens the modal',
  /setBulkOpInitialType\(type\)\s*\n\s*setBulkOpModalOpen\(true\)/.test(client))
check('initialActionType passed into the modal',
  /initialActionType=\{bulkOpInitialType \?\? undefined\}/.test(client))
check('onClose clears the preselect',
  /setBulkOpInitialType\(null\)/.test(client))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
