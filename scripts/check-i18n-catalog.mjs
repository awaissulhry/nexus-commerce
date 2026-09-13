#!/usr/bin/env node
// W5.40 — i18n catalog parity + t() reference check.
//
// Run after every commit that touches lib/i18n/messages/* OR a file
// that calls t(). Catches the exact race-loss class of bug that hit
// W5.34 + W5.38: catalog edits that silently dropped during a
// commit while concurrent sessions were also editing the catalogs.
//
// Three checks:
//
// 1. Catalog parity, except the finite D22 English fallback list.
//    Every other key must exist in both catalogs; deliberate fallbacks
//    are reported separately and require an English source.
//
// 2. t() literal refs — every t('foo.bar.baz') call across
//    apps/web/src/ must resolve to a key that exists in en.json.
//    Catches typos + the W5.34/38 race-loss where the threading
//    landed but the catalog edits didn't.
//
// 3. Dynamic-template t() refs — t(`foo.${x}.bar`) calls where
//    `x` is one of a small known enumeration. Hand-listed; covers
//    the namespaces that use this pattern (relations, repricing
//    strategy, locale, urgency, column labelKey).
//
// Usage:
//   node scripts/check-i18n-catalog.mjs        # exit 0 if clean
//
// CI hint: wire into the pre-push hook alongside `tsc --noEmit`.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const webSrc = path.join(root, 'apps/web/src')
const enPath = path.join(webSrc, 'lib/i18n/messages/en.json')
const itPath = path.join(webSrc, 'lib/i18n/messages/it.json')

const en = JSON.parse(fs.readFileSync(enPath, 'utf8'))
const it = JSON.parse(fs.readFileSync(itPath, 'utf8'))
const enKeys = new Set(Object.keys(en).filter((k) => k !== '$meta'))
const itKeys = new Set(Object.keys(it).filter((k) => k !== '$meta'))

let errors = 0
const fail = (msg) => {
  console.log(`✗ ${msg}`)
  errors++
}
const pass = (msg) => console.log(`✓ ${msg}`)

// D22: these changed lifecycle sentences deliberately use visible English until translated.
// This finite set is not a general exemption for missing translations.
const intentionalEnglishFallbacks = new Set([
  'products.hardDelete.body',
  'products.hardDelete.preflightError',
  'products.hardDelete.channelAction.note',
  'products.hardDelete.channelAction.unpublish.label',
  'products.hardDelete.channelAction.unpublish.body',
  'products.hardDelete.channelAction.delete.label',
  'products.hardDelete.channelAction.delete.body',
  'products.hardDelete.channelAction.none.body',
  'products.hardDelete.submit.unpublish',
  'products.hardDelete.submit.delete',
])
const missingTranslations = (source, translated, deliberate) => [...source].filter(key => !translated.has(key) && !deliberate.has(key))
const control = missingTranslations(new Set(['translated', 'deliberate', 'unexpected']), new Set(['translated']), new Set(['deliberate']))
if (control.length !== 1 || control[0] !== 'unexpected') throw new Error('Translation fallback control failed')
pass('fallback control: deliberate English accepted; unrelated missing translation rejected')
for (const key of intentionalEnglishFallbacks) if (!enKeys.has(key)) fail(`Stale English fallback declaration: ${key}`)

// ── Check 1: parity ─────────────────────────────────────────────
const deliberateMissing = [...intentionalEnglishFallbacks].filter(key => !itKeys.has(key))
const missingInIt = missingTranslations(enKeys, itKeys, intentionalEnglishFallbacks)
const missingInEn = [...itKeys].filter((k) => !enKeys.has(k))
if (missingInIt.length === 0 && missingInEn.length === 0) {
  pass(`catalog parity (${enKeys.size - deliberateMissing.length} keys both sides; ${deliberateMissing.length} intentional English fallbacks)`)
} else {
  if (missingInIt.length > 0) {
    fail(`${missingInIt.length} keys in en.json missing from it.json:`)
    missingInIt.slice(0, 20).forEach((k) => console.log(`    ${k}`))
    if (missingInIt.length > 20) console.log(`    … +${missingInIt.length - 20} more`)
  }
  if (missingInEn.length > 0) {
    fail(`${missingInEn.length} keys in it.json missing from en.json:`)
    missingInEn.slice(0, 20).forEach((k) => console.log(`    ${k}`))
  }
}

// ── Check 2: literal t() refs ───────────────────────────────────
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      yield* walk(p)
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      yield p
    }
  }
}

const literalRe = /\bt\(\s*['"`]([a-zA-Z0-9_.]+)['"`]/g
const missingLiteralRefs = new Map() // key → [files]
let totalLiteralRefs = 0

// Skip the hook + server helper: they document `t('key')` in JSDoc
// + define the t() function itself, neither of which is a consumer.
const I18N_HELPER_FILES = new Set([
  path.join(webSrc, 'lib/i18n/use-translations.ts'),
  path.join(webSrc, 'lib/i18n/server.ts'),
])

for (const file of walk(webSrc)) {
  if (I18N_HELPER_FILES.has(file)) continue
  const src = fs.readFileSync(file, 'utf8')
  let m
  while ((m = literalRe.exec(src)) !== null) {
    totalLiteralRefs++
    const k = m[1]
    if (!enKeys.has(k)) {
      if (!missingLiteralRefs.has(k)) missingLiteralRefs.set(k, [])
      missingLiteralRefs.get(k).push(path.relative(root, file))
    }
  }
}

if (missingLiteralRefs.size === 0) {
  pass(`${totalLiteralRefs} literal t() refs all resolve`)
} else {
  fail(`${missingLiteralRefs.size} literal t() refs miss en.json:`)
  for (const [k, files] of missingLiteralRefs) {
    console.log(`    ${k}`)
    files.slice(0, 3).forEach((f) => console.log(`      ${f}`))
  }
}

// ── Check 3: known dynamic-template expansions ──────────────────
// Hand-listed because the static enumeration of `${var}` values
// isn't extractable from source without a real TS analyser. Each
// entry must stay in sync with the corresponding source enum.
const dynamic = [
  {
    desc: 'Related-product relation kinds',
    ns: 'products.drawer.related.kind',
    codes: ['CROSS_SELL', 'ACCESSORY', 'UPSELL', 'REPLACEMENT', 'BUNDLE_PART', 'RECOMMENDED'],
    suffixes: ['label', 'hint'],
  },
  {
    desc: 'Repricing strategy codes',
    ns: 'products.drawer.repricing.strategy',
    codes: ['match_buy_box', 'beat_lowest_by_pct', 'beat_lowest_by_amount', 'fixed_to_buy_box_minus', 'manual'],
    suffixes: [''],
  },
  {
    desc: 'Locale display names (TranslationsLens + drawer)',
    ns: 'products.lens.translations.locale',
    codes: ['it', 'en', 'de', 'fr', 'es', 'nl', 'sv', 'pl'],
    suffixes: [''],
  },
  {
    desc: 'Forecast urgency states',
    ns: 'products.drawer.forecast.urgency',
    codes: ['critical', 'warn', 'ok', 'unknown'],
    suffixes: [''],
  },
]

let dynamicMissing = 0
for (const d of dynamic) {
  for (const code of d.codes) {
    for (const suffix of d.suffixes) {
      const k = `${d.ns}.${code}${suffix ? '.' + suffix : ''}`
      if (!enKeys.has(k)) {
        console.log(`    MISSING: ${k} (${d.desc})`)
        dynamicMissing++
      }
    }
  }
}

// Column labelKey: walk _columns.ts + verify each labelKey resolves
const colSrc = fs.readFileSync(path.join(webSrc, 'app/products/_columns.ts'), 'utf8')
const labelKeyRe = /labelKey:\s*'([^']+)'/g
let colCount = 0
let m
while ((m = labelKeyRe.exec(colSrc)) !== null) {
  colCount++
  const k = m[1]
  if (!enKeys.has(k)) {
    console.log(`    MISSING column labelKey: ${k}`)
    dynamicMissing++
  }
}

if (dynamicMissing === 0) {
  const totalDynamic =
    dynamic.reduce((acc, d) => acc + d.codes.length * d.suffixes.length, 0) + colCount
  pass(`${totalDynamic} dynamic t() expansions all resolve`)
} else {
  fail(`${dynamicMissing} dynamic t() expansions miss en.json`)
}

// ── Summary ─────────────────────────────────────────────────────
console.log('')
if (errors === 0) {
  console.log('All i18n catalog checks pass ✓')
  process.exit(0)
} else {
  console.log(`${errors} check${errors === 1 ? '' : 's'} failed`)
  process.exit(1)
}
