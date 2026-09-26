#!/usr/bin/env node
/**
 * Guard: a SHADOW-valued token is never used where a colour or a length belongs.
 *
 * ── Why this exists (2026-09-27) ────────────────────────────────────────────────────────────────────────────────────
 * `--nds-focus-ring` is `0 0 0 2px rgb(var(--nds-focus-rgb) / 0.12)` — a box-shadow value. Written as
 * `outline: 2px solid var(--nds-focus-ring)` it expands to nonsense, the browser drops the whole declaration, and the
 * control has NO visible keyboard focus with no error anywhere. Found on `DetailPopover` (its trigger and its panel —
 * every readiness and progress card) after the grid had already hit the same trap once (grid.css, the sheet note).
 *
 * ── What it derives (nothing here is a hand-kept list) ──────────────────────────────────────────────────────────────
 *   · SHADOW TOKENS — every `--nds-*` in the generated tokens.css whose value, var() chains followed, has the shape of a
 *                     shadow: two or more lengths AND a colour (`0 6px 22px rgb(…)`). An RGB channel triple
 *                     (`--nds-shadow-rgb: 20 28 38`) has no colour and is not one. A new shadow token is picked up.
 *   · USES          — every declaration in apps/web/src and apps/factory/src stylesheets whose value names one of them.
 *                     Allowed only in `box-shadow`, `text-shadow`, `filter` and a custom property (an alias).
 *
 *   node scripts/check-shadow-token-use.mjs            # report, exit 1 on a misuse
 *   node scripts/check-shadow-token-use.mjs --self-test
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const TOKENS_CSS = `${ROOT}/apps/web/src/design-system/styles/tokens.css`
const SCAN = [`${ROOT}/apps/web/src`, `${ROOT}/apps/factory/src`]
const ALLOWED_PROPS = new Set(['box-shadow', 'text-shadow', 'filter'])

function tokenMap(css) {
  const map = new Map()
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--nds-[a-z0-9-]+)\s*:\s*([^;]+);/gi)) if (!map.has(m[1])) map.set(m[1], m[2].trim())
  return map
}
function resolve(map, value, depth = 0) {
  if (depth > 20) return value
  return value.replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)/gi, (whole, name) => (map.has(name) ? resolve(map, map.get(name), depth + 1) : whole))
}
const LENGTH = /(^|\s)-?\d*\.?\d+(px|rem|em)?(?=\s)/g
const isShadow = (resolved) => (resolved.match(LENGTH) ?? []).length >= 2 && /(rgba?\(|hsla?\(|#[0-9a-f]{3,8}\b)/i.test(resolved)

function shadowTokens(css) {
  const map = tokenMap(css)
  return [...map.keys()].filter((name) => isShadow(resolve(map, map.get(name))))
}

/** Every misuse in one stylesheet's text. */
function misuses(text, tokens) {
  const out = []
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  for (const m of stripped.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/gi)) {
    const prop = m[1].toLowerCase()
    if (ALLOWED_PROPS.has(prop) || prop.startsWith('--')) continue
    const used = tokens.filter((t) => new RegExp(`var\\(\\s*${t.replace(/[-]/g, '\\-')}\\s*[,)]`).test(m[2]))
    if (!used.length) continue
    const line = stripped.slice(0, m.index).split('\n').length
    out.push({ line, prop, tokens: used, text: m[0].trim().slice(0, 120) })
  }
  return out
}

function* stylesheets(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) yield* stylesheets(p)
    else if (name.endsWith('.css')) yield p
  }
}

const tokens = shadowTokens(readFileSync(TOKENS_CSS, 'utf8'))
if (!tokens.includes('--nds-focus-ring')) {
  console.error('✗ check-shadow-token-use: --nds-focus-ring was not recognised as a shadow token — the derivation is broken.')
  process.exit(2)
}

if (process.argv.includes('--self-test')) {
  const bad = misuses('.a:focus-visible { outline: 2px solid var(--nds-focus-ring); }\n.b { border-color: var(--nds-shadow-card); }', tokens)
  const good = misuses('.a:focus-visible { outline: 2px solid var(--nds-primary); box-shadow: var(--nds-focus-ring); }\n.b { --alias: var(--nds-focus-ring); }', tokens)
  const rgb = tokens.includes('--nds-shadow-rgb')
  console.log(`self-test: ${tokens.length} shadow tokens derived; bad caught ${bad.length}/2; good flagged ${good.length}/0; channel triple excluded: ${!rgb}`)
  if (bad.length !== 2 || good.length !== 0 || rgb) { console.error('✗ self-test FAILED'); process.exit(1) }
  console.log('✓ self-test passed: the check fails when it should, and only then.')
  process.exit(0)
}

const found = []
for (const root of SCAN) for (const file of stylesheets(root)) for (const m of misuses(readFileSync(file, 'utf8'), tokens)) found.push({ file: relative(ROOT, file), ...m })
if (found.length) {
  console.error(`❌ shadow-token misuse: ${found.length} declaration(s) use a box-shadow value where a colour or length belongs:`)
  for (const f of found) console.error(`   ${f.file}:${f.line}  ${f.text}   (${f.tokens.join(', ')})`)
  console.error('\n   A shadow token is only valid in box-shadow / text-shadow / filter. For a focus outline use var(--nds-primary).')
  process.exit(1)
}
console.log(`✓ no shadow token used as a colour or length (${tokens.length} shadow tokens, ${SCAN.length} source trees)`)
