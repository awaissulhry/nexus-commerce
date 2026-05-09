#!/usr/bin/env node
// W5.47 — link-target regression check.
//
// Runs three audits across apps/web/src/:
//
// 1. Every static href= literal that starts with `/` resolves to a
//    real route (against apps/web/src/app/ page.tsx structure). 263+
//    refs today, all green.
//
// 2. Every breadcrumb array's href fields resolve. 86+ items today,
//    all green.
//
// 3. Every template-literal href={`/path/${var}/...`} has a route
//    shape matching the path-segment templates (treating ${var} as
//    [id] for shape comparison). Skips the channel-enum-expansion
//    false positive (`/listings/${ch.toLowerCase()}` resolves to one
//    of /listings/{amazon,ebay,shopify,woocommerce,etsy}, all real).
//
// Hint: wire into pre-push hook (warn-only initially) like the
// i18n catalog check.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const appDir = path.join(root, 'apps/web/src/app')
const srcDir = path.join(root, 'apps/web/src')

// Build route index from page.tsx files
function* findPages(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* findPages(p)
    else if (e.name === 'page.tsx') yield p
  }
}
const routes = []
for (const p of findPages(appDir)) {
  let r = p.replace(appDir, '').replace(/\/page\.tsx$/, '')
  if (r === '') r = '/'
  routes.push(r)
}
const routeSet = new Set(routes)
const routePatterns = routes.map(
  (r) => new RegExp('^' + r.replace(/\[([^\]]+)\]/g, '[^/]+').replace(/\//g, '\\/') + '$'),
)

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      yield* walk(p)
    } else if (/\.(tsx?|jsx?)$/.test(e.name)) yield p
  }
}

let errors = 0
const fail = (m) => {
  console.log(`✗ ${m}`)
  errors++
}
const pass = (m) => console.log(`✓ ${m}`)

// ── Check 1: static href= refs ───────────────────────────────────
const hrefRe = /href=(?:"([^"]+)"|\{['"`]([^'"`]+)['"`]\})/g
const links = new Map()
let totalStatic = 0
for (const file of walk(srcDir)) {
  const src = fs.readFileSync(file, 'utf8')
  let m
  while ((m = hrefRe.exec(src)) !== null) {
    const href = m[1] || m[2]
    if (!href || !href.startsWith('/') || href.startsWith('//')) continue
    // Skip template-literal bodies; check 3 handles those.
    if (href.includes('${')) continue
    totalStatic++
    const p = href.split('?')[0].split('#')[0]
    if (!links.has(p)) links.set(p, [])
    const lineNum = src.slice(0, m.index).split('\n').length
    links.get(p).push(`${file}:${lineNum}`)
  }
}
const broken1 = []
for (const [p, callers] of links) {
  if (p.startsWith('/api/')) continue
  if (!routePatterns.some((rp) => rp.test(p))) broken1.push({ p, callers })
}
if (broken1.length === 0) {
  pass(`${totalStatic} static href= refs all resolve`)
} else {
  fail(`${broken1.length} static href= refs miss a route:`)
  broken1.forEach((b) => {
    console.log(`    ${b.p}`)
    b.callers.slice(0, 3).forEach((c) => console.log(`      ${c}`))
  })
}

// ── Check 2: breadcrumb hrefs ────────────────────────────────────
const bcRe = /breadcrumbs=\{\s*\[([\s\S]*?)\]\s*\}/g
const itemRe = /\{\s*label:\s*['"`][^'"`]+['"`]\s*,\s*href:\s*['"`]([^'"`]+)['"`]/g
const broken2 = []
let totalCrumbs = 0
for (const file of walk(srcDir)) {
  const src = fs.readFileSync(file, 'utf8')
  let bm
  while ((bm = bcRe.exec(src)) !== null) {
    let im
    while ((im = itemRe.exec(bm[1])) !== null) {
      totalCrumbs++
      const href = im[1]
      if (!href.startsWith('/')) continue
      const stripped = href.split('?')[0].split('#')[0]
      if (stripped.includes('${')) continue
      if (!routePatterns.some((rp) => rp.test(stripped))) {
        const lineNum = src.slice(0, bm.index).split('\n').length
        broken2.push({ file, lineNum, href })
      }
    }
  }
}
if (broken2.length === 0) {
  pass(`${totalCrumbs} breadcrumb hrefs all resolve`)
} else {
  fail(`${broken2.length} breadcrumb hrefs miss a route:`)
  broken2.forEach((b) => console.log(`    ${b.href}  ${b.file}:${b.lineNum}`))
}

// ── Check 3: template-literal path shapes ────────────────────────
// Allowlist: known enum-expansion patterns that don't fit the
// shape-matcher but resolve at runtime to real routes.
const ENUM_ALLOWLIST = [
  // /listings/${ch.toLowerCase()} → /listings/{amazon,ebay,shopify,
  // woocommerce,etsy} — all 5 routes exist.
  /^\/listings\/\$\{[^}]*\.toLowerCase\(\)\}/,
]
const tmplRe = /href=\{`([^`]+)`\}/g
const broken3 = []
let totalTmpl = 0
for (const file of walk(srcDir)) {
  const src = fs.readFileSync(file, 'utf8')
  let m
  while ((m = tmplRe.exec(src)) !== null) {
    const body = m[1]
    if (!body.startsWith('/')) continue
    const pathOnly = body.split('?')[0].split('#')[0]
    if (!pathOnly.includes('${')) continue
    totalTmpl++
    // Skip allowlisted patterns
    if (ENUM_ALLOWLIST.some((re) => re.test(body))) continue
    const shape = pathOnly.replace(/\$\{[^}]+\}/g, '[id]').replace(/\/+$/, '') || '/'
    const matched = [...routeSet].some((r) => {
      const rNorm = r.replace(/\[[^\]]+\]/g, '[id]')
      return rNorm === shape
    })
    if (!matched) {
      const lineNum = src.slice(0, m.index).split('\n').length
      broken3.push({ file, lineNum, body, shape })
    }
  }
}
if (broken3.length === 0) {
  pass(`${totalTmpl} template-literal path shapes all resolve`)
} else {
  fail(`${broken3.length} template-literal path shapes miss a route:`)
  const byShape = new Map()
  for (const b of broken3) {
    if (!byShape.has(b.shape)) byShape.set(b.shape, [])
    byShape.get(b.shape).push(b)
  }
  for (const [shape, items] of byShape) {
    console.log(`    ${shape}`)
    items.slice(0, 3).forEach((it) => console.log(`      ${it.file}:${it.lineNum}`))
  }
}

console.log('')
if (errors === 0) {
  console.log('All link-target checks pass ✓')
  process.exit(0)
} else {
  console.log(`${errors} check${errors === 1 ? '' : 's'} failed`)
  process.exit(1)
}
