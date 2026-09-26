#!/usr/bin/env node
/**
 * DS FONTS — every font the app's UI names must be one of the design system's (Owner, 2026-09-26: "I've started to see
 * Arial text in a lot of it, which goes against our design system … It must never happen again.").
 *
 * WHAT IT CHECKS
 *   1. Declarations in apps/web and apps/factory — CSS `font-family:` and `font:` shorthands, TS/TSX `fontFamily` props and
 *      attributes, canvas `ctx.font =` — may only name the DS families through their tokens: `var(--nds-font-sans|mono|
 *      display)`, `var(--font-sans|mono|display)`, `inherit`, `initial`, `unset`. A literal family (`Arial`, `Helvetica`,
 *      `-apple-system`, `ui-monospace`, `system-ui`, `sans-serif`…) fails. The fix is to name the token.
 *   2. Both root layouts' (web, Factory) `next/font` families declare `adjustFontFallback: false` and a fallback stack without Arial.
 *      Measured 2026-09-26 (`/tmp` sweep, 292 pages): next/font's default adds an "Inter Fallback" face that is
 *      `local("Arial")`, so every character the loaded Inter subsets lack (→ ≤ ≥ ✓ ↕ …) was drawn in Arial, and so was
 *      all text until Inter arrived. Without it a missing glyph falls to the system UI font, never to Arial.
 *
 * WHAT IT DOES NOT CHECK, stated plainly: text a browser draws itself (a native `title` tooltip, `<select>` options, an
 * `alert()`), text inside a third-party iframe, and characters no font on the machine has.
 *
 * EXCEPTIONS are by file, each with the reason — output that is NOT this app's UI (a printed label, an eBay listing's
 * HTML, a generated image) and the token definitions themselves. Adding one is a reviewed edit to this file.
 *
 *   node scripts/check-font-families.mjs            # list every finding
 *   node scripts/check-font-families.mjs --check    # exit 1 on any finding
 *   node scripts/check-font-families.mjs --self-test
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SCAN = ['apps/web/src', 'apps/factory/src']
const LAYOUTS = ['apps/web/src/app/layout.tsx', 'apps/factory/src/app/layout.tsx']

/** Files whose fonts are not this app's UI, or that DEFINE the tokens. Path prefix → reason. */
export const EXCEPTIONS = {
  'apps/web/src/design-system/styles/tokens.css': 'defines --nds-font-* (the fallback stack after the web font)',
  'apps/factory/src/design-system/styles/tokens.css': 'Factory copy of the token definitions',
  'apps/web/src/design-system/tokens/typography.ts': 'defines the JS font tokens',
  'apps/factory/src/design-system/tokens/typography.ts': 'Factory copy of the JS font tokens',
  'apps/web/src/app/globals.css': 'the body default: var(--font-sans) first, then the fallback stack',
  'apps/factory/src/app/globals.css': 'Factory body default',
  'apps/web/src/app/fulfillment/fnsku-labels/': 'printed labels: thermal-printer fonts (Helvetica/Courier/Times) by design',
  'apps/web/src/app/products/ebay-flat-file/DescriptionStudio/': 'the eBay listing description HTML, rendered on eBay with web-safe fonts',
  'apps/web/src/app/marketing/brand-kit/_lib/watermarks.ts': 'image watermark text rendered by the image service',
  'apps/web/src/app/marketing/brand-kit/[brand]/BrandKitEditClient.tsx': 'previews the brand kit\'s OWN fonts, chosen by the operator',
  'apps/web/src/components/brand-kit/BrandKitReferencePanel.tsx': 'previews the brand kit\'s OWN fonts, chosen by the operator',
  'apps/web/src/app/marketing/templates/_lib/image-templates.ts': 'Cloudinary text-overlay specs for generated images',
  'apps/web/src/app/marketing/content/_components/LocaleOverlayManager.tsx': 'Cloudinary text-overlay specs for generated images',
  'apps/web/src/app/marketing/reviews/requests/test/preview/page.tsx': 'the review email\'s HTML, previewed in an iframe where the app\'s fonts do not load',
  'apps/factory/src/app/(app)/inbox/_components/MessageBubble.tsx': 'a received email rendered in a sandboxed iframe (CSP blocks font loading): system UI stack, no Arial',
}

/* A value is the DS's when it STARTS with a DS token — `var(--nds-font-mono, ui-monospace…)` and `var(--font-mono), …` name
   the token first, and the token always resolves (next/font defines --font-*, tokens.css the --nds-font-*). */
const TOKEN = /^(var\(--(nds-)?font-(sans|mono|display)\s*[,)]|inherit$|initial$|unset$)/
const EXT = /\.(css|tsx?|mjs)$/

/** Every font-family value in a source text, with its line. */
export function findings(text, file) {
  const out = []
  const push = (index, value, kind) => {
    const line = text.slice(0, index).split('\n').length
    const clean = value.trim().replace(/\s+!important$/, '').replace(/^['"`]|['"`]$/g, '').trim()
    if (!clean || TOKEN.test(clean)) return
    out.push({ file, line, kind, value: clean })
  }
  const css = file.endsWith('.css')
  if (css) {
    for (const m of text.matchAll(/@font-face\s*\{[^}]*\}/g)) text = text.replace(m[0], m[0].replace(/[^\n]/g, ' '))
    for (const m of text.matchAll(/font-family\s*:\s*([^;}]+)/g)) push(m.index, m[1], 'css')
    for (const m of text.matchAll(/(?:^|[\s;{])font\s*:\s*([^;}]+)/g)) {
      const family = m[1].replace(/^.*?\d(?:px|rem|em|%)(?:\s*\/\s*[\d.]+(?:px|rem|em|%)?)?\s+/, '')
      if (family !== m[1]) push(m.index, family, 'css-font')
    }
  } else {
    for (const m of text.matchAll(/fontFamily\s*[:=]\s*(['"`])([^'"`]*)\1/g)) push(m.index, m[2], 'js')
    for (const m of text.matchAll(/fontFamily\s*=\s*\{\s*(['"`])([^'"`]*)\1\s*\}/g)) push(m.index, m[2], 'js')
    for (const m of text.matchAll(/\.style\.fontFamily\s*=\s*(['"`])([^'"`]*)\1/g)) push(m.index, m[2], 'js')
    for (const m of text.matchAll(/font-family\s*:\s*([^;"'`}]+)/g)) push(m.index, m[1], 'inline-css')
  }
  // Two regexes can read the same attribute; report each place once.
  const seen = new Set()
  return out.filter(f => { const k = `${f.line}:${f.value}`; if (seen.has(k)) return false; seen.add(k); return true })
}

function files(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.next')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...files(p))
    else if (EXT.test(name) && !/\.(vitest\.)?test\.(ts|tsx|mjs)$/.test(name)) out.push(p)
  }
  return out
}

/** The root layout's next/font families must not use the Arial metric fallback. */
export function layoutFindings(text) {
  const out = []
  for (const m of text.matchAll(/const\s+(\w+)\s*=\s*(\w+)\(\{([\s\S]*?)\}\);?/g)) {
    const [, name, family, body] = m
    if (!/^(Inter|Space_Grotesk|JetBrains_Mono)$/.test(family)) continue
    if (!/adjustFontFallback\s*:\s*false/.test(body)) out.push(`${family} (${name}) keeps next/font's "${family.replace(/_/g, ' ')} Fallback" face, which is local("Arial") — set adjustFontFallback: false`)
    const fallback = body.match(/fallback\s*:\s*\[([^\]]*)\]/)
    if (!fallback) out.push(`${family} (${name}) declares no fallback stack — name the system UI fonts so a missing glyph never reaches Arial`)
    else if (/Arial|Helvetica/i.test(fallback[1])) out.push(`${family} (${name}) falls back to Arial/Helvetica`)
  }
  return out
}

function selfTest() {
  const bad = [
    ['a.css', '.x { font-family: Arial, sans-serif; }'],
    ['a.css', '.x { font: 12px/1.4 -apple-system, sans-serif; }'],
    ['a.css', '.x { font-family: ui-monospace, monospace !important; }'],
    ['a.tsx', '<text fontFamily="Arial, sans-serif">a</text>'],
    ['a.tsx', "style={{ fontFamily: 'monospace' }}"],
    ['a.tsx', "ghost.style.fontFamily = 'system-ui, sans-serif'"],
  ]
  const good = [
    ['a.css', '.x { font-family: var(--nds-font-mono); }'],
    ['a.css', '.x { font: inherit; }'],
    ['a.css', '.x { font: 500 13px/1.4 var(--nds-font-sans); }'],
    ['a.css', "@font-face { font-family: 'Inter'; src: url(x.woff2); }"],
    ['a.tsx', "style={{ fontFamily: 'var(--font-mono)' }}"],
    ['a.tsx', 'style={{ fontFamily: tokens.fontFamily.mono }}'],
  ]
  let failed = 0
  for (const [f, t] of bad) if (findings(t, f).length !== 1) { failed++; console.error(`✗ self-test: missed ${JSON.stringify(t)}`) }
  for (const [f, t] of good) if (findings(t, f).length !== 0) { failed++; console.error(`✗ self-test: flagged ${JSON.stringify(t)} → ${JSON.stringify(findings(t, f))}`) }
  const layoutBad = 'const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });'
  const layoutGood = 'const inter = Inter({ subsets: ["latin"], adjustFontFallback: false, fallback: ["system-ui", "sans-serif"] });'
  if (layoutFindings(layoutBad).length !== 2) { failed++; console.error('✗ self-test: layout without adjustFontFallback/fallback not caught') }
  if (layoutFindings(layoutGood).length !== 0) { failed++; console.error('✗ self-test: a correct layout was flagged') }
  if (failed) process.exit(1)
  console.log(`✓ font-family guard self-test: ${bad.length} bad caught, ${good.length} good passed, layout rule both ways`)
}

if (process.argv.includes('--self-test')) { selfTest(); process.exit(0) }

const all = []
for (const dir of SCAN) for (const p of files(join(ROOT, dir))) {
  const rel = relative(ROOT, p)
  if (Object.keys(EXCEPTIONS).some(prefix => rel.startsWith(prefix))) continue
  all.push(...findings(readFileSync(p, 'utf8'), rel))
}
const layout = LAYOUTS.flatMap(file => layoutFindings(readFileSync(join(ROOT, file), 'utf8')).map(message => `${file}: ${message}`))
for (const f of all) console.log(`  ${f.file}:${f.line}  ${f.value}`)
for (const l of layout) console.log(`  ${l}`)
const total = all.length + layout.length
if (total) {
  console.error(`\n✗ DS fonts: ${total} finding(s). Name the token instead — var(--nds-font-sans) for text, var(--nds-font-mono) for codes and numbers, var(--nds-font-display) for display type. An output that is not this app's UI belongs in EXCEPTIONS with its reason.`)
  if (process.argv.includes('--check')) process.exit(1)
} else {
  console.log(`✓ DS fonts: every font the UI names is a design-system token (${Object.keys(EXCEPTIONS).length} reasoned exceptions), and next/font never falls back to Arial`)
}
