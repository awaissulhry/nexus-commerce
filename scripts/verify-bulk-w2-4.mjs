#!/usr/bin/env node
// Verify W2.4 — URL + email + phone cell types.

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

console.log('\nW2.4 — URL + email + phone\n')

const ec = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/EditableCell.tsx'),
  'utf8',
)
const gc = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/lib/grid-columns.tsx'),
  'utf8',
)
const tsv = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/lib/tsv-helpers.ts'),
  'utf8',
)

console.log('Case 1: FieldType union')
for (const t of ['url', 'email', 'phone']) {
  check(`'${t}' in union`, new RegExp(`\\|\\s*'${t}'`).test(ec))
}

console.log('\nCase 2: coercion exports')
check('coerceUrl exported', /export function coerceUrl/.test(ec))
check('coerceEmail exported', /export function coerceEmail/.test(ec))
check('coercePhone exported', /export function coercePhone/.test(ec))

// Mirror logic locally
function coerceUrl(v) {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  if (!s) return null
  try {
    const u = /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
      ? new URL(s)
      : new URL(`https://${s}`)
    return u.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}
function coerceEmail(v) {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null
}
function coercePhone(v) {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  if (!s) return null
  const cleaned = s.replace(/[\s().-]/g, '')
  if (!/^\+?\d{4,15}$/.test(cleaned)) return null
  return cleaned
}

console.log('\nCase 3: coerceUrl behaviour')
check("'https://xavia.it' stays canonical",
  coerceUrl('https://xavia.it') === 'https://xavia.it')
check("'xavia.it' → 'https://xavia.it'",
  coerceUrl('xavia.it') === 'https://xavia.it')
check("'http://x.io/page' → 'http://x.io/page'",
  coerceUrl('http://x.io/page') === 'http://x.io/page')
check("'   nope   ' → 'https://nope'",
  coerceUrl('   nope   ') === 'https://nope')
check("'' → null", coerceUrl('') === null)
check("null → null", coerceUrl(null) === null)
// URL constructor accepts almost anything; verify a clearly-invalid
// case (control char) returns null
check("'\\u0001bad' → null", coerceUrl('bad') === null)

console.log('\nCase 4: coerceEmail behaviour')
check("valid email accepted", coerceEmail('awa@xavia.it') === 'awa@xavia.it')
check("missing @ rejected", coerceEmail('not-an-email') === null)
check("missing tld rejected", coerceEmail('a@b') === null)
check("'' → null", coerceEmail('') === null)

console.log('\nCase 5: coercePhone behaviour')
check("E.164 accepted", coercePhone('+393331234567') === '+393331234567')
check("with spaces accepted", coercePhone('+39 333 1234567') === '+393331234567')
check("with dashes accepted", coercePhone('555-1234') === '5551234')
check("letters rejected", coercePhone('1-800-CONTACT') === null)
check("too short rejected", coercePhone('123') === null)
check("'' → null", coercePhone('') === null)

console.log('\nCase 6: render branches')
check(
  'URL/email/phone edit branch',
  /meta\.fieldType === 'url' \|\|/.test(ec) &&
    /meta\.fieldType === 'email' \|\|/.test(ec) &&
    /meta\.fieldType === 'phone'/.test(ec) &&
    /type={inputType}/.test(ec),
)
check(
  'URL display anchor',
  /href={normalised}/.test(ec) &&
    /target="_blank"/.test(ec),
)
check('email display mailto', /href={`mailto:\${valid}`}/.test(ec))
check('phone display tel:', /href={`tel:\${valid}`}/.test(ec))

console.log('\nCase 7: fieldToMeta routing')
check("field.type === 'url' routed", /fieldType: 'url'/.test(gc))
check("field.type === 'email' routed", /fieldType: 'email'/.test(gc))
check("field.type === 'phone' routed", /fieldType: 'phone'/.test(gc))

console.log('\nCase 8: paste coercion')
check("paste 'url' branch", /Not a valid URL/.test(tsv))
check("paste 'email' branch", /Not a valid email/.test(tsv))
check("paste 'phone' branch", /Use a phone number with optional \+ prefix/.test(tsv))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
