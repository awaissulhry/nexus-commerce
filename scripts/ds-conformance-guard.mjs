#!/usr/bin/env node
/**
 * Wave 1 — Design-system conformance ratchet (Owner directive 2026-07-04:
 * "I do not want any such thing on any page or even a single tab").
 *
 * Counts the banned idioms per top-level app section:
 *   - native <select>            (system components exist: DS Select / H10Select)
 *   - native <input type="date"> (DS DateRangePicker / EbDateField)
 *   - inline style fontSize      (type scales are classes/tokens)
 *   - inline style hex colours   (palette lives in CSS)
 *
 * Modes:
 *   --census              print the per-section table
 *   --baseline            write scripts/ds-conformance-baseline.json
 *   --check               fail (exit 1) if ANY section exceeds its baseline
 *                         — the ratchet: waves lower baselines, never raise
 *   --manifest <section>  file:line offender checklist for a wave
 *
 * Scope: apps/web/src/app. Allowlisted (counted as their own sections but
 * never enforced): the two legacy ad consoles (Wave 0 retires them later)
 * and the Amazon H10 pixel-match world. marketing/ads/ebay IS enforced —
 * it reached zero in EV4 and stays there.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(process.cwd(), 'apps/web/src/app')
const BASELINE = join(process.cwd(), 'scripts/ds-conformance-baseline.json')

// Never-enforced prefixes (relative to app/). Legacy consoles await Wave 0;
// the Amazon ads tree is the deliberate H10 pixel-match world. NOTE:
// marketing/ads/ebay is carved back IN below — it must stay at zero.
const ALLOW = ['marketing/ads-console/', 'marketing/advertising/', 'marketing/ads/']
const ENFORCE_ANYWAY = ['marketing/ads/ebay/']

const METRICS = {
  select: /<select\b/g,
  date: /type="date"/g,
  fontSize: /style=\{\{[^}]*fontSize/g,
  hex: /style=\{\{[^}]*#[0-9a-fA-F]{3,6}/g,
}

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const s = statSync(p)
    if (s.isDirectory()) yield* walk(p)
    else if (p.endsWith('.tsx')) yield p
  }
}

const allowed = (rel) => ALLOW.some((a) => rel.startsWith(a)) && !ENFORCE_ANYWAY.some((e) => rel.startsWith(e))

function scan() {
  const bySection = {}
  const offenders = {}
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file)
    if (allowed(rel)) continue
    const section = rel.split('/')[0]
    const src = readFileSync(file, 'utf8')
    const lines = src.split('\n')
    for (const [name, re] of Object.entries(METRICS)) {
      lines.forEach((line, i) => {
        if (new RegExp(re.source).test(line)) {
          bySection[section] ??= { select: 0, date: 0, fontSize: 0, hex: 0 }
          bySection[section][name]++
          ;(offenders[section] ??= []).push(`${name.padEnd(8)} apps/web/src/app/${rel}:${i + 1}`)
        }
      })
    }
    bySection[section] ??= { select: 0, date: 0, fontSize: 0, hex: 0 }
  }
  return { bySection, offenders }
}

const mode = process.argv[2] ?? '--census'
const { bySection, offenders } = scan()
const total = (s) => s.select + s.date + s.fontSize + s.hex

if (mode === '--census') {
  const rows = Object.entries(bySection).sort((a, b) => total(b[1]) - total(a[1]))
  console.log('section'.padEnd(20), 'select', 'date', 'fontSize', 'hex')
  for (const [k, v] of rows) if (total(v)) console.log(k.padEnd(20), String(v.select).padEnd(6), String(v.date).padEnd(4), String(v.fontSize).padEnd(8), v.hex)
  console.log('\n(zero-count sections omitted; legacy consoles + Amazon H10 world allowlisted)')
}

if (mode === '--baseline') {
  writeFileSync(BASELINE, JSON.stringify({ note: 'DS-conformance ratchet — waves lower these, pushes may never raise them', updatedAt: new Date().toISOString().slice(0, 10), sections: bySection }, null, 2) + '\n')
  console.log(`baseline written: ${Object.keys(bySection).length} sections`)
}

if (mode === '--check') {
  if (!existsSync(BASELINE)) { console.log('no baseline — run --baseline once'); process.exit(0) }
  const base = JSON.parse(readFileSync(BASELINE, 'utf8')).sections
  let failed = false

  // Owner 2026-07-04: the eBay ads console must look EXACTLY like the Amazon
  // one — every colour in ebay.css must exist in ads.css (the Amazon palette).
  const adsCss = readFileSync(join(ROOT, 'marketing/ads/ads.css'), 'utf8')
  const ebayCss = readFileSync(join(ROOT, 'marketing/ads/ebay/ebay.css'), 'utf8')
  const amazonPalette = new Set((adsCss.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((h) => h.toLowerCase()))
  const offPalette = [...new Set((ebayCss.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((h) => h.toLowerCase()))].filter((h) => !amazonPalette.has(h))
  if (offPalette.length) {
    failed = true
    console.error(`❌ ebay.css uses colour(s) not in the Amazon ads palette: ${offPalette.join(', ')}`)
    console.error('   Copy the exact value ads.css uses for the same semantic — the consoles must match.')
  }
  for (const [section, counts] of Object.entries(bySection)) {
    const b = base[section] ?? { select: 0, date: 0, fontSize: 0, hex: 0 }
    for (const m of Object.keys(METRICS)) {
      if (counts[m] > b[m]) {
        failed = true
        console.error(`❌ ${section}: ${m} ${b[m]} → ${counts[m]} — new ${m === 'select' ? 'native <select>' : m === 'date' ? 'native date input' : `inline ${m}`}(s) added.`)
        console.error(`   Use the design-system component instead (Select/DateRangePicker/type classes).`)
        console.error(`   Offenders: node scripts/ds-conformance-guard.mjs --manifest ${section}`)
      }
    }
  }
  if (failed) process.exit(1)
  console.log('✓ DS-conformance ratchet clean (no section above baseline)')
}

if (mode === '--manifest') {
  const section = process.argv[3]
  if (!section || !offenders[section]) { console.log(`sections with offenders: ${Object.keys(offenders).join(', ')}`); process.exit(0) }
  console.log(offenders[section].join('\n'))
  console.log(`\n${offenders[section].length} offender(s) in ${section}`)
}
