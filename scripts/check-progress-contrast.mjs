#!/usr/bin/env node
/**
 * Guard: every progress-bar tone clears 3:1 on the grounds a bar is drawn on (WCAG 1.4.11 — a fill is a graphical
 * object that carries meaning: red = a required field is empty, yellow = only optional fields, green = nothing).
 *
 * ── Why this exists (the sheet's progress columns, 2026-09-26) ──────────────────────────────────────────────────────
 * The Owner asked for BRIGHT green, yellow and red. Bright yellow (#eab308) is 1.69:1 and the DS green-600 is 2.91:1 on
 * the grid's variation row (`--nds-grid-child-bg`, #eef1f5) — the row most sheet rows are. So each tone has an EDGE
 * token (`--nds-progress-<tone>-edge`): the 1px inset line the ground actually touches. This guard measures the EDGE
 * (or the fill, when a tone declares no edge) — the colour that meets the ground — never the fill behind it.
 *
 * ── Nothing here is a hand-kept list ────────────────────────────────────────────────────────────────────────────────
 *   · the TONES   — every `--nds-progress-<name>` in the generated tokens.css, except `-track` and `-edge`
 *   · the GROUNDS — the five plain grid row grounds (a cell always paints one of them) and `--nds-surface` (a bar
 *                   outside a grid), var() chains followed, in `:root` and in `.dark` (dark falls back to `:root`)
 * A tone added, re-toned or given an edge is picked up without editing this file.
 * ENFORCED in both themes: the sheet follows the theme, so a dark row is a real ground.
 * REPORTED only: the track against the same grounds — the number beside the bar carries the value, so the track is
 * a hint, not a meaning.
 *
 * ── It has been seen to fail ────────────────────────────────────────────────────────────────────────────────────────
 *   node scripts/check-progress-contrast.mjs --self-test
 * re-runs the enforced logic with every edge removed (the fill meets the ground), which must fail bright yellow and
 * green-600 on the light child row and pass red. A check that has never failed has not been shown to be a check.
 *
 * Usage:
 *   node scripts/check-progress-contrast.mjs                 # print the table
 *   node scripts/check-progress-contrast.mjs --check         # exit 1 if an enforced pair is below 3:1
 *   node scripts/check-progress-contrast.mjs --self-test
 *   node scripts/check-progress-contrast.mjs --tokens <path> # measure another copy (e.g. the Factory mirror)
 */

import { readFileSync } from 'node:fs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const argv = process.argv.slice(2)
const tokensAt = argv.indexOf('--tokens')
if (tokensAt >= 0 && !argv[tokensAt + 1]) throw new Error('--tokens requires a path')
const TOKENS_CSS = tokensAt >= 0 ? argv[tokensAt + 1] : `${ROOT}/apps/web/src/design-system/styles/tokens.css`
const BAR = 3

// ── WCAG maths ──────────────────────────────────────────────────────────────────────────────────────────────────────
const hexToRgb = (h) => {
  const s = h.replace('#', '').trim()
  const n = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16))
}
const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const ratio = (a, b) => { const x = lum(a), y = lum(b); const [hi, lo] = x >= y ? [x, y] : [y, x]; return (hi + 0.05) / (lo + 0.05) }
const r2 = (x) => Math.round(x * 100) / 100

// ── the token maps, straight from the file the app loads ────────────────────────────────────────────────────────────
const css = readFileSync(TOKENS_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
function blockOf(selector) {
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].split(',').some((p) => p.trim() === selector))
  if (!blocks.length) throw new Error(`check-progress-contrast: ${TOKENS_CSS} has no block with selector ${selector}`)
  const map = new Map()
  for (const m of blocks) for (const line of m[2].split('\n')) {
    const kv = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*(.+?);\s*$/i)
    if (kv) map.set(kv[1], kv[2].trim())
  }
  return map
}
const LIGHT = blockOf(':root')
const DARK = blockOf('.dark')
const rawValue = (name, mode) => (mode === 'dark' ? DARK.get(name) ?? LIGHT.get(name) : LIGHT.get(name))
function resolve(name, mode) {
  let v = rawValue(name, mode)
  let hops = 0
  while (v && /^var\(/.test(v) && hops++ < 20) {
    const inner = v.match(/^var\(\s*(--[a-z0-9-]+)/i)
    if (!inner) return null
    v = rawValue(inner[1], mode)
  }
  return v ? v.trim() : null
}

const TONES = [...LIGHT.keys()]
  .filter((n) => n.startsWith('--nds-progress-') && !n.endsWith('-edge') && n !== '--nds-progress-track')
  .map((n) => n.slice('--nds-progress-'.length))
if (!TONES.length) throw new Error(`check-progress-contrast: no --nds-progress-* tone in ${TOKENS_CSS}`)
const GROUNDS = ['--nds-grid-bg', '--nds-grid-child-bg', '--nds-grid-hover-bg', '--nds-grid-child-hover-bg', '--nds-grid-selected-bg', '--nds-surface']

function literal(name, mode) {
  const v = resolve(name, mode)
  if (!v || !v.startsWith('#')) throw new Error(`check-progress-contrast: ${name} (${mode}) did not resolve to a hex literal — got ${v}`)
  return v
}

/** Every (mode × tone × ground) pair. `withEdges: false` measures the bare fill — the self-test's bad case. */
function certify({ withEdges }) {
  const rows = []
  for (const mode of ['light', 'dark']) for (const tone of TONES) {
    const edgeName = `--nds-progress-${tone}-edge`
    const meets = withEdges && rawValue(edgeName, mode) ? edgeName : `--nds-progress-${tone}`
    const fg = literal(meets, mode)
    for (const g of GROUNDS) {
      const bg = literal(g, mode)
      rows.push({ mode, tone, via: meets.endsWith('-edge') ? 'edge' : 'fill', fg, ground: g.replace('--nds-', ''), bg, value: r2(ratio(hexToRgb(fg), hexToRgb(bg))) })
    }
  }
  return rows
}

if (argv.includes('--self-test')) {
  const bare = certify({ withEdges: false }).filter((r) => r.mode === 'light' && r.ground === 'grid-child-bg')
  const failing = new Set(bare.filter((r) => r.value < BAR).map((r) => r.tone))
  const ok = failing.has('partial') && failing.has('complete') && !failing.has('missing')
  console.log(`self-test: without edges, the light child row fails [${[...failing].join(', ') || 'nothing'}]`)
  if (!ok) {
    console.error('✗ self-test FAILED — bare bright yellow and green-600 must fail 3:1 on #eef1f5, and red must pass.')
    process.exit(1)
  }
  console.log('✓ self-test passed: the check fails when it should, and only then.')
  process.exit(0)
}

const rows = certify({ withEdges: true })
const failures = rows.filter((r) => r.value < BAR)
const grounds = GROUNDS.map((g) => g.replace('--nds-', ''))
console.log(`\nprogress-contrast — ${TONES.length} tones × ${GROUNDS.length} grounds × 2 themes (bar ${BAR}:1, measured at the colour that meets the ground)\n`)
for (const mode of ['light', 'dark']) {
  console.log(`── ${mode} ${'─'.repeat(90)}`)
  console.log('  ' + 'tone'.padEnd(18) + grounds.map((g) => g.slice(0, 14).padEnd(15)).join(''))
  for (const tone of TONES) {
    const mine = rows.filter((r) => r.mode === mode && r.tone === tone)
    console.log('  ' + `${tone} (${mine[0].via})`.padEnd(18) + mine.map((r) => `${r.value < BAR ? '🔴' : '  '}${String(r.value).padEnd(13)}`).join(''))
  }
  const track = literal('--nds-progress-track', mode)
  console.log('  ' + 'track (reported)'.padEnd(18) + GROUNDS.map((g) => `  ${String(r2(ratio(hexToRgb(track), hexToRgb(literal(g, mode))))).padEnd(13)}`).join(''))
  console.log('')
}
if (failures.length) {
  console.error(`❌ progress-contrast: ${failures.length} pair(s) below ${BAR}:1`)
  for (const f of failures) console.error(`   ${f.mode} · ${f.tone} ${f.via} ${f.fg} on ${f.ground} ${f.bg} = ${f.value}`)
  console.error('\n   Give the tone a darker (light) or lighter (dark) --nds-progress-<tone>-edge in tokens/css-vars.ts; never lower the bar.')
  if (argv.includes('--check')) process.exit(1)
} else {
  console.log(`✓ every progress tone clears ${BAR}:1 on all ${GROUNDS.length} grounds, light and dark`)
}
