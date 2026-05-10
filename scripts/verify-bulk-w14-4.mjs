#!/usr/bin/env node
// Verify W14.4 — Cmd+K palette entries for the W9-W13 surfaces.
// Closes Wave 14.
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

console.log('\nW14.4 — Cmd+K palette entries\n')

const palette = fs.readFileSync(
  path.join(repo, 'apps/web/src/components/CommandPalette.tsx'),
  'utf8',
)

const REQUIRED_IDS = [
  'bulk-imports',
  'bulk-exports',
  'bulk-automation',
  'bulk-schedules',
  'bulk-ai-translate',
  'bulk-ai-seo',
  'bulk-ai-alt-text',
]

console.log('Case 1: every new entry registered')
for (const id of REQUIRED_IDS) {
  check(`palette has id ${id}`,
    new RegExp(`id: ['\"]${id}['\"]`).test(palette))
}

console.log('\nCase 2: nav entries point at the right routes')
check("bulk-imports → /bulk-operations/imports",
  /id: 'bulk-imports'[\s\S]{0,300}href: '\/bulk-operations\/imports'/.test(palette))
check("bulk-exports → /bulk-operations/exports",
  /id: 'bulk-exports'[\s\S]{0,300}href: '\/bulk-operations\/exports'/.test(palette))
check("bulk-automation → /bulk-operations/automation",
  /id: 'bulk-automation'[\s\S]{0,300}href: '\/bulk-operations\/automation'/.test(palette))
check("bulk-schedules → /bulk-operations/schedules",
  /id: 'bulk-schedules'[\s\S]{0,300}href: '\/bulk-operations\/schedules'/.test(palette))

console.log('\nCase 3: AI verbs dispatch CustomEvents')
check("ai-translate dispatches nexus:bulk-operations:ai-translate",
  /CustomEvent\('nexus:bulk-operations:ai-translate'\)/.test(palette))
check("ai-seo dispatches nexus:bulk-operations:ai-seo",
  /CustomEvent\('nexus:bulk-operations:ai-seo'\)/.test(palette))
check("ai-alt-text dispatches nexus:bulk-operations:ai-alt-text",
  /CustomEvent\('nexus:bulk-operations:ai-alt-text'\)/.test(palette))
check("AI actions scoped to /bulk-operations contextPath",
  /id: 'bulk-ai-translate'[\s\S]{0,500}contextPath: \/\^\\\/bulk-operations/.test(palette))

console.log('\nCase 4: keyword fields are bilingual where useful')
check("bulk-exports keywords include 'esportazioni'",
  /id: 'bulk-exports'[\s\S]{0,400}esportazioni/.test(palette))
check("bulk-imports keywords include 'importazioni'",
  /id: 'bulk-imports'[\s\S]{0,400}importazioni/.test(palette))
check("ai-translate keywords include Italian 'traduci'",
  /id: 'bulk-ai-translate'[\s\S]{0,400}traduci/.test(palette))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed (Wave 14 complete)')
