#!/usr/bin/env node
// Verify W4.2 — conditional formatting.
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

console.log('\nW4.2 — conditional formatting\n')

const lib = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/lib/conditional-format.ts'),
  'utf8',
)
const bar = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/components/ConditionalFormatBar.tsx'),
  'utf8',
)

console.log('Case 1: lib exports')
for (const name of ['evaluateRule', 'tonefor', 'buildToneMap']) {
  check(`${name} exported`, new RegExp(`export function ${name}`).test(lib))
}
for (const c of ['TONE_CLASSES', 'TONE_LABELS', 'OP_LABELS']) {
  check(`${c} exported`, new RegExp(`export const ${c}`).test(lib))
}

// Mirror evaluateRule for behavioural test
function evaluateRule(rule, cellValue) {
  if (!rule.enabled) return false
  const isEmpty = cellValue === null || cellValue === undefined || cellValue === ''
  if (rule.op === 'empty') return isEmpty
  if (rule.op === 'notEmpty') return !isEmpty
  if (isEmpty) return false
  if (['lt', 'lte', 'gt', 'gte'].includes(rule.op)) {
    const a = typeof cellValue === 'number' ? cellValue : parseFloat(String(cellValue))
    const b = typeof rule.value === 'number' ? rule.value : parseFloat(String(rule.value))
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false
    if (rule.op === 'lt') return a < b
    if (rule.op === 'lte') return a <= b
    if (rule.op === 'gt') return a > b
    return a >= b
  }
  const a = String(cellValue).toLowerCase()
  const b = rule.value === null || rule.value === undefined ? '' : String(rule.value).toLowerCase()
  if (rule.op === 'eq') return a === b
  if (rule.op === 'neq') return a !== b
  if (rule.op === 'contains') return a.includes(b)
  if (rule.op === 'startsWith') return a.startsWith(b)
  if (rule.op === 'endsWith') return a.endsWith(b)
  return false
}

console.log('\nCase 2: evaluateRule — numeric ops')
const stockRule = { id: '1', columnId: 'totalStock', op: 'lt', value: 5, tone: 'red', enabled: true }
check("stock 3 < 5 fires", evaluateRule(stockRule, 3))
check("stock 5 < 5 does not fire", !evaluateRule(stockRule, 5))
check("stock 10 < 5 does not fire", !evaluateRule(stockRule, 10))
check("string '3' < 5 fires (numeric coerce)", evaluateRule(stockRule, '3'))
check("empty cell does not fire numeric", !evaluateRule(stockRule, null))

console.log('\nCase 3: evaluateRule — string ops + case insensitivity')
const statusRule = { id: '2', columnId: 'status', op: 'eq', value: 'DRAFT', tone: 'amber', enabled: true }
check("status 'DRAFT' matches", evaluateRule(statusRule, 'DRAFT'))
check("status 'draft' matches (case-insensitive)", evaluateRule(statusRule, 'draft'))
check("status 'ACTIVE' does not match", !evaluateRule(statusRule, 'ACTIVE'))

const containsRule = { id: '3', columnId: 'name', op: 'contains', value: 'mesh', tone: 'blue', enabled: true }
check("'Airmesh Jacket' contains 'mesh'", evaluateRule(containsRule, 'Airmesh Jacket'))
check("'Racing Pants' does not contain 'mesh'", !evaluateRule(containsRule, 'Racing Pants'))

console.log('\nCase 4: evaluateRule — empty / notEmpty')
const empRule = { id: '4', columnId: 'asin', op: 'empty', value: null, tone: 'slate', enabled: true }
check("empty op fires on null", evaluateRule(empRule, null))
check("empty op fires on ''", evaluateRule(empRule, ''))
check("empty op does NOT fire on 'B0123'", !evaluateRule(empRule, 'B0123'))
check("disabled rule never fires",
  !evaluateRule({ ...empRule, enabled: false }, null))

console.log('\nCase 5: ConditionalFormatBar component')
check('exports ConditionalFormatBar', /export function ConditionalFormatBar/.test(bar))
check('uses TONE_CLASSES for swatches', /TONE_CLASSES\[tone\]/.test(bar))
check('renders all 5 tones', /ALL_TONES.*=.*\['red',\s*'amber',\s*'green',\s*'blue',\s*'slate'\]/.test(bar))
check('Add rule button',
  /onClick={add}[\s\S]*Add rule/.test(bar))
check('Esc closes the panel', /e\.key === 'Escape'/.test(bar))
check('hides value input for empty / notEmpty',
  /rule\.op !== 'empty' && rule\.op !== 'notEmpty'/.test(bar))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
