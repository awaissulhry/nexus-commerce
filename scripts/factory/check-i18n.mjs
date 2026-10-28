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
 * Run: node scripts/factory/check-i18n.mjs — exit 1 on any violation.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WEB = join(ROOT, 'apps/factory-web')
const MESSAGES = join(WEB, 'messages')
const LOCALES = ['it', 'en']
const violations = []

const localesTs = existsSync(join(WEB, 'src/lib/i18n/locales.ts')) ? readFileSync(join(WEB, 'src/lib/i18n/locales.ts'), 'utf8') : ''
const declared = /export const LOCALES\s*=\s*\[([^\]]*)\]/.exec(localesTs)?.[1]?.match(/'([^']+)'|"([^"]+)"/g)?.map((q) => q.slice(1, -1)) ?? []
if (declared.join(',') !== LOCALES.join(',')) violations.push(`src/lib/i18n/locales.ts declares LOCALES [${declared.join(', ')}]; this check knows [${LOCALES.join(', ')}]: update both together`)

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
for (const folder of folders) if (!LOCALES.includes(folder)) violations.push(`messages/${folder}: not an interface language (${LOCALES.join(', ')})`)

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

if (violations.length > 0) {
  console.error(`check-i18n: ${violations.length} violation(s)\n  ${violations.join('\n  ')}`)
  process.exit(1)
}
console.log(`check-i18n: ok (${namespaces.size} catalogue(s) × ${LOCALES.length} languages, ${keys} keys, ${navKeys} navigation labels; every key in ${LOCALES.join(' and ')})`)
