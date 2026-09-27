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

console.log('Case 1: palette dispatches the events')
for (const evt of [
  'nexus:bulk-operations:ai-translate',
  'nexus:bulk-operations:ai-seo',
  'nexus:bulk-operations:ai-alt-text',
]) {
  check(`palette dispatches ${evt}`,
    new RegExp(`new CustomEvent\\('${evt}'\\)`).test(palette))
}

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
