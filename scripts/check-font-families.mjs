#!/usr/bin/env node
/**
 * DS FONTS — every font the app's UI names must be one of the design system's (Owner, 2026-09-26: "I've started to see
 * Arial text in a lot of it, which goes against our design system … It must never happen again.").
 *
 * WHAT IT CHECKS
 *   1. Declarations in apps/web and apps/factory — CSS `font-family:` and `font:` shorthands, TS/TSX `fontFamily` props and
 *      attributes, `font:` style values and canvas `ctx.font =` — may only name the DS families through their tokens:
 *      `var(--nds-font-sans|mono|display)`, `var(--font-sans|mono|display)`, `inherit`, `unset`. A literal family (`Arial`,
 *      `Helvetica`, `-apple-system`, `ui-monospace`, `system-ui`, `sans-serif`…) fails. The fix is to name the token.
 *      So does any value that hands the text back to the BROWSER's font (2026-10-28): `initial` / `revert` /
 *      `revert-layer` on `font-family`, `font` or `all` (on a control that is 13.33 px Arial), and a system-font keyword as
 *      the whole `font` (`menu`, `caption`, `message-box`, `-webkit-small-control`…).
 *   2. Both root layouts' (web, Factory) `next/font` families declare `adjustFontFallback: false` and a fallback stack without Arial.
 *      Measured 2026-09-26 (`/tmp` sweep, 292 pages): next/font's default adds an "Inter Fallback" face that is
 *      `local("Arial")`, so every character the loaded Inter subsets lack (→ ≤ ≥ ✓ ↕ …) was drawn in Arial, and so was
 *      all text until Inter arrived. Without it a missing glyph falls to the system UI font, never to Arial.
 *   3. The DS base rule (2026-10-28, Owner: "remove it from everywhere in the design system so that it never gets reused"):
 *      a native <button>, <input>, <select>, <textarea> or <optgroup> does not inherit the page's font — the browser draws
 *      it in 13.33 px Arial (measured in Chromium). Both apps' `design-system/styles/primitives.css` must keep
 *      `:where(button, input, select, textarea, optgroup) { font: inherit; }` (all five, `font` not just `font-family`:
 *      the browser's 13.33 px reads as Arial too), and both root layouts must load that file, so every page has it.
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
const SCAN = ['apps/web/src', 'packages/ui/src', 'apps/factory/src']
const LAYOUTS = ['apps/web/src/app/layout.tsx', 'apps/factory/src/app/layout.tsx']
/** Where each app keeps the DS base rule, and the layout that must load it on every page. */
const BASE_RULE = [
  { css: 'packages/ui/src/styles/primitives.css', layout: 'apps/web/src/app/layout.tsx' },
  { css: 'apps/factory/src/design-system/styles/primitives.css', layout: 'apps/factory/src/app/layout.tsx' },
]
/** The native controls the browser draws in its own font unless told to inherit. */
export const CONTROLS = ['button', 'input', 'select', 'textarea', 'optgroup']

/** Files whose fonts are not this app's UI, or that DEFINE the tokens. Path prefix → reason. */
export const EXCEPTIONS = {
  'packages/ui/src/styles/tokens.css': 'defines --nds-font-* (the fallback stack after the web font)',
  'apps/factory/src/design-system/styles/tokens.css': 'Factory copy of the token definitions',
  'packages/ui/src/tokens/typography.ts': 'defines the JS font tokens',
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
  'apps/factory/src/app/(app)/inbox/_components/MessageBubble.tsx': 'a received email rendered in a sandboxed iframe (CSP blocks font loading): system UI stack, no Arial',
  'apps/factory/src/lib/financials/render-invoice.ts': 'a PDF drawn by the PDF library with its built-in Helvetica',
  'apps/factory/src/lib/quotes/render-pdf.ts': 'a PDF drawn by the PDF library with its built-in Helvetica',
  'apps/factory/src/lib/shipping/': 'shipping labels and manifests drawn by the PDF library with its built-in Helvetica',
  'packages/ui/src/tokens/css-vars.ts': 'generates the --nds-font-* definitions',
  'apps/factory/src/design-system/tokens/css-vars.ts': 'Factory copy of the --nds-font-* generator',
  'apps/factory/src/design-system/tokens/index.d.ts': 'generated type declarations of the font tokens',
  'apps/factory/src/design-system/tokens/typography.d.ts': 'generated type declarations of the font tokens',
  'packages/ui/src/grid/renderers/bandWidth.ts': 'canvas measurement: a plain family only when --nds-font-mono is absent (canvas cannot read var())',
  'apps/factory/src/design-system/grid/renderers/bandWidth.ts': 'Factory copy of the canvas measurement',
}

/* A value is the DS's when it STARTS with a DS token — `var(--nds-font-mono, ui-monospace…)` and `var(--font-mono), …` name
   the token first, and the token always resolves (next/font defines --font-*, tokens.css the --nds-font-*). */
const TOKEN = /^(var\(--(nds-)?font-(sans|mono|display)\s*[,)]|inherit$|unset$)/
/* The browser's own font, by keyword: `initial` / `revert` / `revert-layer` give an element back to the browser's default
   (a control's is 13.33 px Arial), and a system-font keyword is the whole `font` of the operating system's UI. */
const BROWSER_FONT = /^(initial|revert|revert-layer|caption|icon|menu|message-box|small-caption|status-bar|-webkit-[a-z-]+)$/i
const RESET_ALL = /^(initial|revert|revert-layer)$/i
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
  const bare = (value) => value.trim().replace(/\s+!important$/, '').replace(/^['"`]|['"`]$/g, '').trim()
  /** A `font:` shorthand: its family (after the size) must be a token, and the whole value must not be the browser's font. */
  const shorthand = (index, value, kind) => {
    if (BROWSER_FONT.test(bare(value))) return push(index, value, kind)
    const family = value.replace(/^.*?\d(?:px|rem|em|%)(?:\s*\/\s*[\d.]+(?:px|rem|em|%)?)?\s+/, '')
    if (family !== value) push(index, family, kind)
  }
  /** `all: initial | revert | revert-layer` resets the font with everything else. */
  const resetAll = (index, value, kind) => { if (RESET_ALL.test(bare(value))) push(index, value, kind) }
  const css = file.endsWith('.css')
  if (css) {
    for (const m of text.matchAll(/@font-face\s*\{[^}]*\}/g)) text = text.replace(m[0], m[0].replace(/[^\n]/g, ' '))
    for (const m of text.matchAll(/font-family\s*:\s*([^;}]+)/g)) push(m.index, m[1], 'css')
    for (const m of text.matchAll(/(?:^|[\s;{])font\s*:\s*([^;}]+)/g)) shorthand(m.index, m[1], 'css-font')
    for (const m of text.matchAll(/(?:^|[\s;{])all\s*:\s*([^;}]+)/g)) resetAll(m.index, m[1], 'css-all')
  } else {
    // Comments are prose, not declarations (same length, so line numbers stay true).
    text = text.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\w])\/\/[^\n]*/g, (c, lead) => lead + ' '.repeat(c.length - lead.length))
    for (const m of text.matchAll(/fontFamily\s*[:=]\s*(['"`])([^'"`]*)\1/g)) push(m.index, m[2], 'js')
    for (const m of text.matchAll(/fontFamily\s*=\s*\{\s*(['"`])([^'"`]*)\1\s*\}/g)) push(m.index, m[2], 'js')
    for (const m of text.matchAll(/\.style\.fontFamily\s*=\s*(['"`])([^'"`]*)\1/g)) push(m.index, m[2], 'js')
    // A `font` shorthand in a style object (`font: '12px var(--font-mono)'`) or on a canvas (`ctx.font = …`); a template
    // with `${…}` is built at run time and is not read here.
    for (const m of text.matchAll(/(?:[{,]\s*|\.)font\s*[:=]\s*(['"`])([^'"`]*)\1/g)) if (!m[2].includes('${')) shorthand(m.index, m[2], 'js-font')
    for (const m of text.matchAll(/[{,]\s*all\s*:\s*(['"`])([^'"`]*)\1/g)) resetAll(m.index, m[2], 'js-all')
    for (const m of text.matchAll(/font-family\s*:\s*([^;"'`}]+)/g)) push(m.index, m[1], 'inline-css')
    /* A font LIST kept in a string and used through a variable (`const mono = "ui-monospace, …"; fontFamily: mono`) —
       the after-sweep found 143 catalog elements rendered this way that the rules above could not see. A string is a
       font list when it names a font family or a generic one and is nothing else (a comma list of names). */
    if (LAYOUTS.includes(file)) return dedupe(out)
    for (const m of text.matchAll(/(['"`])((?:\s*(?:'[^'\n]*'|"[^"\n]*"|[\w -]+)\s*,)*\s*(?:ui-monospace|monospace|sans-serif|serif|system-ui|-apple-system|BlinkMacSystemFont|Arial|Helvetica|Menlo|SFMono-Regular|Consolas|'?Segoe UI'?)\s*(?:,\s*(?:'[^'\n]*'|"[^"\n]*"|[\w -]+)\s*)*)\1/g)) {
      if (/[<>{}();=]/.test(m[2])) continue
      push(m.index, m[2], 'js-stack')
    }
  }
  return dedupe(out)
}

/** Two rules can read the same place; report each place once. */
function dedupe(list) {
  const seen = new Set()
  return list.filter(f => { const k = `${f.line}:${f.value}`; if (seen.has(k)) return false; seen.add(k); return true })
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

/**
 * The DS base rule in a stylesheet: one rule whose selector names all five native controls and whose block says
 * `font: inherit`. Returns what is wrong (empty = the rule is there).
 */
export function baseRuleFindings(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].replace(/:where\(|\)/g, ' ').split(/[\s,]+/).map((x) => x.trim().toLowerCase())
    if (!/(^|[;{\s])font\s*:\s*inherit\s*(!important\s*)?(;|$)/.test(m[2].trim())) continue
    const missing = CONTROLS.filter((c) => !selectors.includes(c))
    if (missing.length === 0) return []
  }
  return [`no rule gives every native control the page's font — keep \`:where(${CONTROLS.join(', ')}) { font: inherit; }\` (a control left to the browser is drawn in 13.33 px Arial)`]
}

/** The layout must load the stylesheet that holds the base rule, or a page could render without it. */
export function layoutLoadsBaseRule(layoutText, cssFile) {
  // The web's DS is @nexus/ui (packages/ui/src), still imported as `@/design-system/…`; the frozen factory keeps its own copy.
  const name = cssFile.replace(/^(packages\/ui\/src|apps\/[^/]+\/src\/design-system)\//, '')
  return new RegExp(`import\\s+["']@/design-system/${name.replace(/[.]/g, '\\.')}["']`).test(layoutText)
    ? []
    : [`does not import @/design-system/${name}, which holds the DS base rule (native controls inherit the font)`]
}

function selfTest() {
  const bad = [
    ['a.css', '.x { font-family: Arial, sans-serif; }'],
    ['a.css', '.x { font: 12px/1.4 -apple-system, sans-serif; }'],
    ['a.css', '.x { font-family: ui-monospace, monospace !important; }'],
    ['a.tsx', '<text fontFamily="Arial, sans-serif">a</text>'],
    ['a.tsx', "style={{ fontFamily: 'monospace' }}"],
    ['a.tsx', "ghost.style.fontFamily = 'system-ui, sans-serif'"],
    ['a.tsx', "const mono = \"ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace\""],
    // The browser's own font, by keyword (2026-10-28).
    ['a.css', '.x button { font-family: initial; }'],
    ['a.css', 'button.y { font: revert; }'],
    ['a.css', '.x { font: -webkit-small-control; }'],
    ['a.css', '.x input { all: revert; }'],
    ['a.css', '.x { font: menu !important; }'],
    ['a.tsx', "style={{ font: '13px Arial' }}"],
    ['a.tsx', "ctx.font = '12px sans-serif'"],
    ['a.tsx', "style={{ all: 'initial' }}"],
    ['a.tsx', "style={{ fontFamily: 'revert' }}"],
  ]
  const good = [
    ['a.css', '.x { font-family: var(--nds-font-mono); }'],
    ['a.css', '.x { font: inherit; }'],
    ['a.css', '.x { font: 500 13px/1.4 var(--nds-font-sans); }'],
    ['a.css', "@font-face { font-family: 'Inter'; src: url(x.woff2); }"],
    ['a.tsx', "style={{ fontFamily: 'var(--font-mono)' }}"],
    ['a.tsx', 'style={{ fontFamily: tokens.fontFamily.mono }}'],
    ['a.tsx', "const note = 'Pick a serif or a sans-serif face in the brand kit.'"],
    ['a.css', '.x { all: unset; }'],
    ['a.css', ':where(button, input, select, textarea, optgroup) { font: inherit; }'],
    ['a.tsx', "style={{ font: '12.5px var(--font-mono), monospace' }}"],
    ['a.tsx', "style={{ font: 'inherit', fontWeight: 700 }}"],
    ['a.tsx', 'ctx.font = `${weight} ${size}px ${family}`'],
  ]
  let failed = 0
  for (const [f, t] of bad) if (findings(t, f).length !== 1) { failed++; console.error(`✗ self-test: missed ${JSON.stringify(t)}`) }
  for (const [f, t] of good) if (findings(t, f).length !== 0) { failed++; console.error(`✗ self-test: flagged ${JSON.stringify(t)} → ${JSON.stringify(findings(t, f))}`) }
  const layoutBad = 'const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });'
  const layoutGood = 'const inter = Inter({ subsets: ["latin"], adjustFontFallback: false, fallback: ["system-ui", "sans-serif"] });'
  if (layoutFindings(layoutBad).length !== 2) { failed++; console.error('✗ self-test: layout without adjustFontFallback/fallback not caught') }
  if (layoutFindings(layoutGood).length !== 0) { failed++; console.error('✗ self-test: a correct layout was flagged') }
  const baseBad = [
    '.nds-btn { font-family: inherit; }',
    ':where(button, input, select, textarea) { font: inherit; }',
    ':where(button, input, select, textarea, optgroup) { font-family: inherit; }',
    '/* :where(button, input, select, textarea, optgroup) { font: inherit; } */',
  ]
  const baseGood = [
    ':where(button, input, select, textarea, optgroup),\n:where(input)::file-selector-button {\n  font: inherit;\n}',
    'button, input, select, textarea, optgroup { font: inherit; }',
  ]
  for (const css of baseBad) if (baseRuleFindings(css).length !== 1) { failed++; console.error(`✗ self-test: base rule missing but not caught: ${JSON.stringify(css)}`) }
  for (const css of baseGood) if (baseRuleFindings(css).length !== 0) { failed++; console.error(`✗ self-test: base rule present but flagged: ${JSON.stringify(css)}`) }
  if (layoutLoadsBaseRule('import "@/design-system/styles/tokens.css";', BASE_RULE[0].css).length !== 1) { failed++; console.error('✗ self-test: a layout without primitives.css not caught') }
  if (layoutLoadsBaseRule('import "@/design-system/styles/primitives.css";', BASE_RULE[0].css).length !== 0) { failed++; console.error('✗ self-test: a layout loading primitives.css was flagged') }
  if (failed) process.exit(1)
  console.log(`✓ font-family guard self-test: ${bad.length} bad caught, ${good.length} good passed, layout rule both ways, base rule ${baseBad.length} missing caught / ${baseGood.length} present passed, layout import both ways`)
}

if (process.argv.includes('--self-test')) { selfTest(); process.exit(0) }

const all = []
for (const dir of SCAN) for (const p of files(join(ROOT, dir))) {
  const rel = relative(ROOT, p)
  if (Object.keys(EXCEPTIONS).some(prefix => rel.startsWith(prefix))) continue
  all.push(...findings(readFileSync(p, 'utf8'), rel))
}
const layout = [
  ...LAYOUTS.flatMap(file => layoutFindings(readFileSync(join(ROOT, file), 'utf8')).map(message => `${file}: ${message}`)),
  ...BASE_RULE.flatMap(({ css, layout: file }) => [
    ...baseRuleFindings(readFileSync(join(ROOT, css), 'utf8')).map(message => `${css}: ${message}`),
    ...layoutLoadsBaseRule(readFileSync(join(ROOT, file), 'utf8'), css).map(message => `${file}: ${message}`),
  ]),
]
for (const f of all) console.log(`  ${f.file}:${f.line}  ${f.value}`)
for (const l of layout) console.log(`  ${l}`)
const total = all.length + layout.length
if (total) {
  console.error(`\n✗ DS fonts: ${total} finding(s). Name the token instead — var(--nds-font-sans) for text, var(--nds-font-mono) for codes and numbers, var(--nds-font-display) for display type. An output that is not this app's UI belongs in EXCEPTIONS with its reason.`)
  if (process.argv.includes('--check')) process.exit(1)
} else {
  console.log(`✓ DS fonts: every font the UI names is a design-system token (${Object.keys(EXCEPTIONS).length} reasoned exceptions), next/font never falls back to Arial, and every native control inherits the DS font (base rule in both apps)`)
}
