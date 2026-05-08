#!/usr/bin/env node
/**
 * S.11 verification — cycle-count list + session wired through
 * useTranslations, cycleCount.* keys present in both en/it catalogs,
 * key parity holds.
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const en = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/en.json'), 'utf8'))
const it = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/it.json'), 'utf8'))
const list = fs.readFileSync(
  path.join(here, '..', 'apps/web/src/app/fulfillment/stock/cycle-count/CycleCountListClient.tsx'),
  'utf8',
)
const session = fs.readFileSync(
  path.join(here, '..', 'apps/web/src/app/fulfillment/stock/cycle-count/[id]/CycleCountSessionClient.tsx'),
  'utf8',
)

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

// 1. Catalog keys present
const enKeys = Object.keys(en).filter((k) => k.startsWith('cycleCount.'))
const itKeys = Object.keys(it).filter((k) => k.startsWith('cycleCount.'))
if (enKeys.length >= 50) ok(`en.json has ${enKeys.length} cycleCount.* keys`)
else bad('en.json has 50+ cycleCount.* keys', `${enKeys.length}`)
if (itKeys.length >= 50) ok(`it.json has ${itKeys.length} cycleCount.* keys`)
else bad('it.json has 50+ cycleCount.* keys', `${itKeys.length}`)

// 2. Parity
const enSet = new Set(enKeys)
const itSet = new Set(itKeys)
const missingInIt = [...enSet].filter((k) => !itSet.has(k))
const extraInIt = [...itSet].filter((k) => !enSet.has(k))
if (missingInIt.length === 0) ok('every en cycleCount key has an it translation')
else bad('every en cycleCount key has an it translation', `missing: ${missingInIt.slice(0, 5).join(', ')}`)
if (extraInIt.length === 0) ok('no orphan it cycleCount keys')
else bad('no orphan it cycleCount keys', `extra: ${extraInIt.slice(0, 5).join(', ')}`)

// 3. Italian non-empty + differs from English
let untranslated = 0
let identical = 0
for (const k of enKeys) {
  if (!it[k] || !String(it[k]).trim()) untranslated++
  else if (it[k] === en[k]) identical++
}
if (untranslated === 0) ok('every it cycleCount key non-empty')
else bad('every it cycleCount key non-empty', `${untranslated} empty`)
if (identical < 10) ok(`cycleCount translations differ from English (${identical} identical)`)
else bad('cycleCount translations differ', `${identical} identical (likely untranslated)`)

// 4. Both clients import + use useTranslations
for (const [src, name] of [[list, 'list'], [session, 'session']]) {
  if (/import\s*\{[^}]*\buseTranslations\b[^}]*\}\s*from\s*['"]@\/lib\/i18n\/use-translations['"]/.test(src)) {
    ok(`${name}: useTranslations imported`)
  } else {
    bad(`${name}: useTranslations imported`)
  }
  if (/const \{ t \} = useTranslations\(\)/.test(src)) {
    ok(`${name}: const { t } destructured`)
  } else {
    bad(`${name}: const { t } destructured`)
  }
}

// 5. List client routes high-impact strings through t()
const listRequired = [
  "t('cycleCount.list.actionRefresh')",
  "t('cycleCount.list.actionNew')",
  "t('cycleCount.list.empty.title')",
  "t('cycleCount.list.empty.description')",
  "t('cycleCount.list.modal.title')",
  "t('cycleCount.list.modal.create')",
  "t('cycleCount.list.modal.cancel')",
]
for (const r of listRequired) {
  if (list.includes(r)) ok(`list: ${r}`)
  else bad(`list: ${r}`)
}

// 6. Session client routes high-impact strings through t()
const sessionRequired = [
  "t('cycleCount.session.startedToast')",
  "t('cycleCount.session.completedToast')",
  "t('cycleCount.session.cancelledToast')",
  "t('cycleCount.session.completeConfirmTitle')",
  "t('cycleCount.session.qtyInvalid')",
  "t('cycleCount.session.scanNotInCount'",
]
for (const r of sessionRequired) {
  if (session.includes(r)) ok(`session: ${r}`)
  else bad(`session: ${r}`)
}

console.log()
console.log(`[S.11 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
