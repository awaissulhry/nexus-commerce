#!/usr/bin/env node
/**
 * check-i18n — RULE: every UI string of apps/factory-web exists in every interface language (PLAN §4.6, PLT-127).
 *
 * The catalogues are `apps/factory-web/messages/<locale>/<area>.json` (src/lib/i18n/messages.ts). For each area:
 *   1. a file in every locale of LOCALES (it, en) and no other locale folder;
 *   2. the same keys in every locale (a key is the path to a leaf: `nav.admin.users`); every leaf a string, not empty;
 *   3. the same `{placeholders}` in every locale's text of a key;
 *   4. plural forms in pairs: a key `x_one` has an `x_other` and the other way round;
 *   5. every navigation label key a nav manifest names (`label: 'shell:nav.admin.users'` in src/areas/<area>/nav.ts)
 *      exists in that namespace.
 * LOCALES must match `LOCALES` in src/lib/i18n/locales.ts.
 *
 * owb-fl7 (pick J) — Urdu, the floor's own language (`FLOOR_LOCALES` = it, en, ur in locales.ts; the office never gets it):
 *   6. `messages/ur/` may hold ONLY the floor's catalogues (`FLOOR_NAMESPACES` in src/floor/tasks/routes.ts): any other file fails;
 *   7. an Urdu key exists in English (a key Urdu lacks shows in English, so every Urdu key falls back to one), with English's
 *      placeholders, plural forms in pairs, never empty;
 *   8. a key Urdu lacks only WARNS (printed, counted per file): Italian and English stay strict (1–5).
 * The Urdu files are DRAFT words (from the design's prototype, 2026-11-25): a native reader checks them before a site turns Urdu on
 * (a site adds `ur` only with an Urdu worker notice in force: factory-domain privacy/floor-languages.ts). The drafts:
 *   messages/ur/floor-basket.json · floor-help2.json · floor-board.json · floor.json (the keys the new floor screens show).
 *
 * Run: node scripts/factory/check-i18n.mjs — exit 1 on any violation. `CHECK_I18N_ROOT` points it at another tree (its tests).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.CHECK_I18N_ROOT || fileURLToPath(new URL('../..', import.meta.url))
const WEB = join(ROOT, 'apps/factory-web')
const MESSAGES = join(WEB, 'messages')
const LOCALES = ['it', 'en']
/** owb-fl7: languages of the floor only, beside LOCALES (their files: the floor's catalogues alone; a missing key warns). */
const FLOOR_ONLY = ['ur']
const violations = []
const warnings = []

const localesTs = existsSync(join(WEB, 'src/lib/i18n/locales.ts')) ? readFileSync(join(WEB, 'src/lib/i18n/locales.ts'), 'utf8') : ''
const declared = /export const LOCALES\s*=\s*\[([^\]]*)\]/.exec(localesTs)?.[1]?.match(/'([^']+)'|"([^"]+)"/g)?.map((q) => q.slice(1, -1)) ?? []
if (declared.join(',') !== LOCALES.join(',')) violations.push(`src/lib/i18n/locales.ts declares LOCALES [${declared.join(', ')}]; this check knows [${LOCALES.join(', ')}]: update both together`)
const declaredFloor = /export const FLOOR_LOCALES\s*=\s*\[([^\]]*)\]/.exec(localesTs)?.[1]?.match(/'([^']+)'|"([^"]+)"/g)?.map((q) => q.slice(1, -1)) ?? []
if (declaredFloor.join(',') !== [...LOCALES, ...FLOOR_ONLY].join(',')) violations.push(`src/lib/i18n/locales.ts declares FLOOR_LOCALES [${declaredFloor.join(', ')}]; this check knows [${[...LOCALES, ...FLOOR_ONLY].join(', ')}]: update both together`)

// owb-fl7: the floor's catalogues, as the floor app loads them (src/floor/tasks/routes.ts FLOOR_NAMESPACES).
const routesTs = existsSync(join(WEB, 'src/floor/tasks/routes.ts')) ? readFileSync(join(WEB, 'src/floor/tasks/routes.ts'), 'utf8') : ''
const FLOOR_NAMESPACES = /export const FLOOR_NAMESPACES\s*=\s*\[([^\]]*)\]/.exec(routesTs)?.[1]?.match(/'([^']+)'|"([^"]+)"/g)?.map((q) => q.slice(1, -1)) ?? []
if (FLOOR_NAMESPACES.length === 0) violations.push('src/floor/tasks/routes.ts: FLOOR_NAMESPACES not found (the floor languages need it)')

function flatten(tree, file, prefix = '') {
  const out = {}
  if (typeof tree !== 'object' || tree === null || Array.isArray(tree)) {
    violations.push(`${file}: ${prefix || 'the file'} is not an object`)
    return out
  }
  for (const [name, value] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${name}` : name
    if (typeof value === 'string') {
      if (value.trim() === '') violations.push(`${file}: "${key}" is empty`)
      out[key] = value
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(out, flatten(value, file, key))
    } else {
      violations.push(`${file}: "${key}" is ${Array.isArray(value) ? 'a list' : typeof value}, not text`)
    }
  }
  return out
}

const placeholders = (text) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(',')

const folders = existsSync(MESSAGES) ? readdirSync(MESSAGES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []
for (const folder of folders) if (!LOCALES.includes(folder) && !FLOOR_ONLY.includes(folder)) violations.push(`messages/${folder}: not an interface language (${LOCALES.join(', ')}) nor a floor language (${FLOOR_ONLY.join(', ')})`)

const catalogues = {}
const namespaces = new Set()
for (const locale of LOCALES) {
  catalogues[locale] = {}
  const dir = join(MESSAGES, locale)
  if (!existsSync(dir)) {
    violations.push(`messages/${locale}: missing`)
    continue
  }
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const namespace = name.slice(0, -5)
    namespaces.add(namespace)
    const file = `messages/${locale}/${name}`
    try {
      catalogues[locale][namespace] = flatten(JSON.parse(readFileSync(join(dir, name), 'utf8')), file)
    } catch (error) {
      violations.push(`${file}: not valid JSON (${error.message})`)
    }
  }
}

let keys = 0
for (const namespace of [...namespaces].sort()) {
  const all = new Set()
  for (const locale of LOCALES) {
    if (!catalogues[locale][namespace]) violations.push(`messages/${locale}/${namespace}.json: missing (the other languages have it)`)
    for (const key of Object.keys(catalogues[locale][namespace] ?? {})) all.add(key)
  }
  keys += all.size
  for (const key of [...all].sort()) {
    const texts = LOCALES.map((locale) => [locale, catalogues[locale][namespace]?.[key]])
    for (const [locale, text] of texts) if (catalogues[locale][namespace] && text === undefined) violations.push(`messages/${locale}/${namespace}.json: "${key}" is missing`)
    const shapes = new Set(texts.filter(([, text]) => text !== undefined).map(([, text]) => placeholders(text)))
    if (shapes.size > 1) violations.push(`${namespace}: "${key}" has different placeholders per language (${texts.map(([l, t]) => `${l}: {${placeholders(t ?? '')}}`).join(' · ')})`)
    const plural = /^(.*)_(one|other)$/.exec(key)
    if (plural) {
      const pair = `${plural[1]}_${plural[2] === 'one' ? 'other' : 'one'}`
      if (!all.has(pair)) violations.push(`${namespace}: "${key}" has no "${pair}"`)
    }
  }
}

// 5. navigation label keys
let navKeys = 0
const areas = join(WEB, 'src/areas')
for (const area of existsSync(areas) ? readdirSync(areas, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []) {
  const file = join(areas, area, 'nav.ts')
  if (!existsSync(file)) continue
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/\b(label|ariaLabel|childrenLabel):\s*'([a-z][\w-]*):([\w.]+)'/g)) {
    navKeys++
    const [, , namespace, key] = match
    for (const locale of LOCALES) {
      if (catalogues[locale][namespace]?.[key] === undefined) violations.push(`src/areas/${area}/nav.ts:${text.slice(0, match.index).split('\n').length}: "${namespace}:${key}" is not in messages/${locale}/${namespace}.json`)
    }
  }
}

// 6–8. owb-fl7: the floor-only languages (Urdu): the floor's catalogues alone; each key in English with its placeholders; a missing key warns.
let floorFiles = 0
let floorKeys = 0
for (const locale of FLOOR_ONLY) {
  const dir = join(MESSAGES, locale)
  if (!existsSync(dir)) continue
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const namespace = name.slice(0, -5)
    const file = `messages/${locale}/${name}`
    if (!FLOOR_NAMESPACES.includes(namespace)) {
      violations.push(`${file}: ${locale} is a floor language only — "${namespace}" is not a floor catalogue (FLOOR_NAMESPACES in src/floor/tasks/routes.ts)`)
      continue
    }
    let own
    try {
      own = flatten(JSON.parse(readFileSync(join(dir, name), 'utf8')), file)
    } catch (error) {
      violations.push(`${file}: not valid JSON (${error.message})`)
      continue
    }
    const english = catalogues.en?.[namespace]
    if (!english) {
      violations.push(`${file}: messages/en/${namespace}.json is missing (every ${locale} key falls back to English)`)
      continue
    }
    floorFiles++
    for (const [key, text] of Object.entries(own)) {
      floorKeys++
      if (english[key] === undefined) {
        violations.push(`${file}: "${key}" is not in messages/en/${namespace}.json (no English to fall back on: a stray key)`)
        continue
      }
      if (placeholders(text) !== placeholders(english[key])) violations.push(`${file}: "${key}" has other placeholders than English ({${placeholders(text)}} · en {${placeholders(english[key])}})`)
      const plural = /^(.*)_(one|other)$/.exec(key)
      if (plural && own[`${plural[1]}_${plural[2] === 'one' ? 'other' : 'one'}`] === undefined) violations.push(`${file}: "${key}" has no "${plural[1]}_${plural[2] === 'one' ? 'other' : 'one'}"`)
    }
    const missing = Object.keys(english).filter((key) => own[key] === undefined)
    if (missing.length > 0) warnings.push(`${file}: ${missing.length} of ${Object.keys(english).length} keys have no ${locale} words yet (English shows)`)
  }
}

if (warnings.length > 0) console.log(`check-i18n: warning — ${warnings.length} floor catalogue(s) not whole in ${FLOOR_ONLY.join(', ')} (a warning, never a failure)\n  ${warnings.join('\n  ')}`)
if (violations.length > 0) {
  console.error(`check-i18n: ${violations.length} violation(s)\n  ${violations.join('\n  ')}`)
  process.exit(1)
}
console.log(`check-i18n: ok (${namespaces.size} catalogue(s) × ${LOCALES.length} languages, ${keys} keys, ${navKeys} navigation labels; every key in ${LOCALES.join(' and ')}; ${floorFiles} floor catalogue(s), ${floorKeys} keys in ${FLOOR_ONLY.join(', ')})`)
