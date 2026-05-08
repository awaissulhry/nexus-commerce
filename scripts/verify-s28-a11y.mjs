#!/usr/bin/env node
/**
 * S.28 — WCAG AA static a11y audit on the stock surface.
 *
 * Asserts every icon-only <button>, <input>, and <select> in the
 * stock client tree exposes a name to assistive tech (aria-label,
 * aria-labelledby, htmlFor pairing, or placeholder for inputs).
 *
 * The verification is static — it does not boot a browser. Runtime
 * checks (axe-core in Playwright, contrast on real renders) come in
 * a future commit; this gate prevents the patterns we just fixed
 * from regressing.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')

const FILES = [
  'apps/web/src/app/fulfillment/stock/StockWorkspace.tsx',
  'apps/web/src/app/fulfillment/stock/analytics/AnalyticsClient.tsx',
  'apps/web/src/app/fulfillment/stock/transfers/TransfersClient.tsx',
  'apps/web/src/app/fulfillment/stock/reservations/ReservationsClient.tsx',
  'apps/web/src/app/fulfillment/stock/shopify-locations/ShopifyLocationsClient.tsx',
  'apps/web/src/app/fulfillment/stock/cycle-count/CycleCountListClient.tsx',
  'apps/web/src/app/fulfillment/stock/cycle-count/[id]/CycleCountSessionClient.tsx',
  'apps/web/src/app/fulfillment/stock/fba-pan-eu/FbaPanEuClient.tsx',
  'apps/web/src/app/fulfillment/stock/import/ImportClient.tsx',
  'apps/web/src/app/fulfillment/stock/mcf/MCFClient.tsx',
]

// JSX opening-tag scanner that respects { } expression depth and
// quote pairs — naïve `[^>]` regex breaks on arrow functions like
// `onClick={(e) => ...}` because `>` in the arrow truncates the
// captured attribute span.
function findOpenTagEnd(src, startIdx) {
  let i = startIdx
  let depth = 0
  let quote = null
  while (i < src.length) {
    const c = src[i]
    if (quote) {
      if (c === '\\') { i += 2; continue }
      if (c === quote) quote = null
      i++; continue
    }
    if (c === '"' || c === "'") { quote = c; i++; continue }
    if (c === '{') { depth++; i++; continue }
    if (c === '}') { depth--; i++; continue }
    if (c === '>' && depth === 0) return i
    i++
  }
  return -1
}

const findings = []
for (const rel of FILES) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) {
    findings.push(`MISSING file: ${rel}`)
    continue
  }
  const src = fs.readFileSync(abs, 'utf8')

  const tagOpenRe = /<(button|input|Input|select)\b/g
  let m
  while ((m = tagOpenRe.exec(src)) !== null) {
    const tag = m[1]
    const attrStart = m.index + m[0].length
    const closeIdx = findOpenTagEnd(src, attrStart)
    if (closeIdx < 0) continue
    const attrs = src.slice(attrStart, closeIdx)
    const lineNum = src.slice(0, m.index).split('\n').length
    if (attrs.includes('aria-label') || attrs.includes('aria-labelledby')) continue

    if (tag === 'button') {
      const closeTag = src.indexOf('</button>', closeIdx)
      if (closeTag < 0) continue
      const children = src.slice(closeIdx + 1, closeTag).trim()
      // Icon-only: a single self-closing JSX tag whose name starts uppercase.
      if (/^<[A-Z][A-Za-z0-9]*\b[^>]*\/>$/.test(children)) {
        const icon = children.match(/^<([A-Z][A-Za-z0-9]*)/)?.[1] ?? '?'
        findings.push(`${rel}:${lineNum} icon-only <button> [${icon}] has no aria-label`)
      }
    } else if (tag === 'input' || tag === 'Input') {
      if (attrs.includes('placeholder=')) continue
      if (attrs.includes('type="hidden"')) continue
      if (attrs.includes('type="checkbox"') || attrs.includes('type="radio"')) continue
      const idM = attrs.match(/\bid="([^"]+)"/)
      if (idM && src.includes(`htmlFor="${idM[1]}"`)) continue
      findings.push(`${rel}:${lineNum} <${tag}> has no label/placeholder/aria-label`)
    } else if (tag === 'select') {
      const idM = attrs.match(/\bid="([^"]+)"/)
      if (idM && src.includes(`htmlFor="${idM[1]}"`)) continue
      findings.push(`${rel}:${lineNum} <select> has no label/aria-label`)
    }
  }
}

if (findings.length === 0) {
  console.log(`✅ S.28 a11y audit clean across ${FILES.length} stock files`)
  process.exit(0)
}

console.error(`❌ S.28 a11y audit found ${findings.length} violation(s):`)
for (const f of findings) console.error(`   - ${f}`)
process.exit(1)
