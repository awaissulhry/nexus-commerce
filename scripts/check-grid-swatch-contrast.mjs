#!/usr/bin/env node
/**
 * Guard: the formula reference palette clears 3:1 on the grounds the GRID actually paints.
 *
 * ── Why this exists (hub #737, P15) ─────────────────────────────────────────────────────────────
 * `colors.ts` certifies every tag swatch against the two PAGE grounds (`#ffffff`, `#18263b`). A
 * grid row is neither. The formula editor outlines the cell a `$reference` reads, and an outline is
 * a graphical object carrying meaning, so WCAG 1.4.11 asks 3:1 — against the ground it is drawn on.
 * On the grid's variation-row ground (`--nds-grid-child-bg`, `#eef1f5`) three swatches the DS
 * records as passing fall under that bar: Lime 2.73, Green 2.91, Red 3.45→ok but Lime/Green not.
 * "The list was right about a ground that is not the one being drawn on."
 *
 * ── What it derives, and why nothing here is a hand-kept list ────────────────────────────────────
 * Every input is read from source at run time:
 *   · the CYCLE          — `CYCLE_NAMES` in `grid/editors/formulaPalette.ts`
 *   · the swatch hexes   — `tagSwatches` in `tokens/colors.ts`, `palette.x[n]` resolved through the
 *                          generated `tokens.css` so the value is the one the app paints with
 *   · the GROUNDS        — every `--nds-grid-*bg` in the generated `tokens.css`, var() chains
 *                          followed, `color-mix(… N%, transparent)` composited over the row grounds
 *                          it is painted on top of
 * A hue added to the cycle, a ramp step re-toned, or a new grid ground minted is picked up without
 * editing this file. That is deliberate: the defect this guard exists for was a correct list about
 * the wrong ground, and a second hand-kept list would be the same bug one level up.
 *
 * ── Two tiers, and why the second is not enforced ───────────────────────────────────────────────
 * ENFORCED: the five plain row grounds (bg, child, hover, child-hover, selected). A cell always
 * paints one of them, so a hue that fails here is unusable, full stop.
 * REPORTED: the state tints (pending / saving / refused / ai-draft) composited over the row
 * grounds, and the dark tier. Both are real grounds, and today three hues fall below 3:1 on each —
 * but WHICH states an outline may land on is the editor owner's call (PES.2), and the studio
 * console is pinned light, so failing the push on them would be this guard deciding someone else's
 * design question. They print every run, loudly, and they are in the record.
 *
 * ── It has been seen to fail ────────────────────────────────────────────────────────────────────
 *   node scripts/check-grid-swatch-contrast.mjs --self-test
 * runs the ENFORCED logic against a deliberately bad cycle (the three hues the DS passes and the
 * grid fails) and exits 1 unless they are caught. A check that has never failed has not been shown
 * to be a check.
 *
 * Usage:
 *   node scripts/check-grid-swatch-contrast.mjs            # print the certification table
 *   node scripts/check-grid-swatch-contrast.mjs --check    # exit 1 if an enforced ground fails
 *   node scripts/check-grid-swatch-contrast.mjs --self-test
 */

import { readFileSync } from 'node:fs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
// A scratch token file permits a seeded-red rehearsal without editing shared tokens.
const tokensArg = process.argv.indexOf('--tokens-css')
if (tokensArg >= 0 && !process.argv[tokensArg + 1]) throw new Error('--tokens-css requires a path')
const TOKENS_CSS = tokensArg >= 0 ? process.argv[tokensArg + 1] : `${ROOT}/apps/web/src/design-system/styles/tokens.css`
const COLORS_TS = `${ROOT}/apps/web/src/design-system/tokens/colors.ts`
const PALETTE_TS = `${ROOT}/apps/web/src/design-system/grid/editors/formulaPalette.ts`

/** An outline is a graphical object (WCAG 1.4.11), not text. */
const BAR = 3

// ── WCAG maths ──────────────────────────────────────────────────────────────────────────────────
const hexToRgb = (h) => {
  const s = h.replace('#', '').trim()
  const n = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16))
}
const toHex = (rgb) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('')
const lin = (c) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const ratio = (fg, bg) => {
  const [a, b] = [lum(fg), lum(bg)]
  const [hi, lo] = a >= b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}
const r2 = (x) => Math.round(x * 100) / 100
/** `color-mix(in srgb, C N%, transparent)` painted over `base`. */
const composite = (tint, alpha, base) => tint.map((c, i) => Math.round(alpha * c + (1 - alpha) * base[i]))

// ── the token maps, straight from the file the app loads ────────────────────────────────────────
const css = readFileSync(TOKENS_CSS, 'utf8')
function blockOf(selector) {
  // Generated tokens use a selector list for the responsive dark scope. Match a
  // complete member, so `.dark body` alone cannot masquerade as the `.dark` tier.
  const blocks = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  const matching = blocks.filter((m) => m[1].split(',').some((part) => part.trim() === selector))
  if (!matching.length) throw new Error(`check-grid-swatch-contrast: ${TOKENS_CSS} has no block with selector ${selector}`)
  const map = new Map()
  for (const m of matching) {
    for (const line of m[2].split('\n')) {
      const kv = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*(.+?);\s*$/i)
      if (kv) map.set(kv[1], kv[2].trim())
    }
  }
  return map
}
const LIGHT = blockOf(':root')
const DARK = blockOf('.dark')

const rawValue = (name, mode) => (mode === 'dark' ? DARK.get(name) ?? LIGHT.get(name) : LIGHT.get(name))
/** Follow a var() chain to a literal. A dark lookup falls back to :root, exactly as the cascade does. */
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

// ── the cycle, read from the editor's own source ────────────────────────────────────────────────
const paletteSrc = readFileSync(PALETTE_TS, 'utf8')
const cycleMatch = paletteSrc.match(/const CYCLE_NAMES = \[([\s\S]*?)\] as const/)
if (!cycleMatch) throw new Error('check-grid-swatch-contrast: CYCLE_NAMES not found in formulaPalette.ts')
const CYCLE = [...cycleMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])

/** The map the editor ships as its record of this measurement — asserted against what we derive. */
const declared = new Map()
const declaredBlock = paletteSrc.match(/CYCLE_MEASURED_CONTRAST: Readonly<Record<string, number>> = \{([\s\S]*?)\}/)
if (declaredBlock) {
  for (const m of declaredBlock[1].matchAll(/([A-Za-z]+):\s*([0-9.]+)/g)) declared.set(m[1], Number(m[2]))
}

// ── the swatches, resolved through the same tokens the app paints with ──────────────────────────
const colorsSrc = readFileSync(COLORS_TS, 'utf8')
const swatchBlock = colorsSrc.match(/export const tagSwatches = \[([\s\S]*?)\] as const/)
if (!swatchBlock) throw new Error('check-grid-swatch-contrast: tagSwatches not found in colors.ts')
const SWATCHES = [...swatchBlock[1].matchAll(
  /\{\s*name:\s*'([^']+)',\s*hex:\s*(?:'(#[0-9a-fA-F]{3,6})'|palette\.([a-zA-Z]+)\[(\d+)\])\s*\}/g,
)].map((m) => ({
  name: m[1],
  hex: m[2] ?? resolve(`--nds-${m[3].toLowerCase()}-${m[4]}`, 'light'),
}))
const swatchHex = (name) => {
  const hit = SWATCHES.find((s) => s.name === name)
  if (!hit || !hit.hex) throw new Error(`check-grid-swatch-contrast: swatch "${name}" has no resolvable hex`)
  return hit.hex
}

// ── the grounds a CELL can paint ────────────────────────────────────────────────────────────────
/**
 * Plain row grounds. `--nds-grid-header-bg` / `-totals-bg` / `-strip-bg` / `-chrome-bg` are chrome,
 * not data cells; `--nds-grid-delta-bg` is a CHIP inside a cell (`grid.css:518`, a pill with its own
 * padding), not a cell ground — reporting it would send someone to fix correct code.
 */
const ROW_GROUNDS = ['--nds-grid-bg', '--nds-grid-child-bg', '--nds-grid-hover-bg', '--nds-grid-child-hover-bg', '--nds-grid-selected-bg']
/** State tints, applied to `.ag-cell` itself (grid.css:564/565/567/602) over the row ground beneath. */
const STATE_TINTS = ['--nds-grid-pending-bg', '--nds-grid-saving-bg', '--nds-grid-refused-bg', '--nds-grid-ai-draft-bg']
/** A tint is composited over the two grounds a data row can have. */
const TINT_BASES = ['--nds-grid-bg', '--nds-grid-child-bg']

function groundsFor(mode) {
  const plain = ROW_GROUNDS.map((n) => {
    const v = resolve(n, mode)
    if (!v || !v.startsWith('#')) throw new Error(`check-grid-swatch-contrast: ${n} (${mode}) did not resolve to a literal — got ${v}`)
    return { label: n.replace('--nds-grid-', ''), rgb: hexToRgb(v), enforced: true }
  })
  const tinted = []
  for (const t of STATE_TINTS) {
    const raw = rawValue(t, mode) ?? ''
    const mix = raw.match(/color-mix\(in srgb, var\((--[a-z0-9-]+)\) (\d+)%/i)
    if (!mix) continue
    const tintHex = resolve(mix[1], mode)
    if (!tintHex || !tintHex.startsWith('#')) continue
    for (const base of TINT_BASES) {
      const baseHex = resolve(base, mode)
      tinted.push({
        label: `${t.replace('--nds-grid-', '').replace('-bg', '')}/${base.replace('--nds-grid-', '').replace('-bg', '') || 'bg'}`,
        rgb: composite(hexToRgb(tintHex), Number(mix[2]) / 100, hexToRgb(baseHex)),
        enforced: false,
      })
    }
  }
  return [...plain, ...tinted]
}

// ── the certification ───────────────────────────────────────────────────────────────────────────
function certify(cycle) {
  const rows = []
  for (const mode of ['light', 'dark']) {
    const grounds = groundsFor(mode)
    for (const name of cycle) {
      const fg = hexToRgb(swatchHex(name))
      for (const g of grounds) {
        rows.push({ mode, name, ground: g.label, enforced: g.enforced && mode === 'light', value: r2(ratio(fg, g.rgb)), groundHex: toHex(g.rgb) })
      }
    }
  }
  return rows
}

const CHECK = process.argv.includes('--check')
const SELF_TEST = process.argv.includes('--self-test')

if (SELF_TEST) {
  // The three hues `colors.ts` passes and the grid's variation row fails. If the enforced tier does
  // not catch these, it is not a check.
  const bad = ['Lime', 'Green', 'Indigo']
  const failures = certify(bad).filter((r) => r.enforced && r.value < BAR)
  const caught = new Set(failures.map((f) => f.name))
  const ok = caught.has('Lime') && caught.has('Green') && !caught.has('Indigo')
  console.log(`self-test: enforced tier caught [${[...caught].join(', ') || 'nothing'}]`)
  if (!ok) {
    console.error('✗ self-test FAILED — the enforced tier must fail Lime and Green on the grid row grounds and pass Indigo.')
    process.exit(1)
  }
  console.log('✓ self-test passed: the check fails when it should, and only then.')
  process.exit(0)
}

const rows = certify(CYCLE)
const enforcedFailures = rows.filter((r) => r.enforced && r.value < BAR)
const reportedFailures = rows.filter((r) => !r.enforced && r.value < BAR)

const groundOrder = [...new Set(rows.filter((r) => r.mode === 'light').map((r) => r.ground))]
console.log(`\ngrid-swatch-contrast — ${CYCLE.length} cycle hues × ${groundOrder.length} cell grounds × 2 tiers (bar ${BAR}:1)\n`)
for (const mode of ['light', 'dark']) {
  console.log(`── ${mode} ─────────────────────────────────────────────────────────────────`)
  console.log('  ' + 'hue'.padEnd(9) + groundOrder.map((g) => g.slice(0, 12).padEnd(13)).join(''))
  for (const name of CYCLE) {
    const cells = groundOrder.map((g) => {
      const hit = rows.find((r) => r.mode === mode && r.name === name && r.ground === g)
      return hit ? `${hit.value < BAR ? '🔴' : '  '}${String(hit.value).padEnd(11)}` : ''.padEnd(13)
    })
    console.log('  ' + name.padEnd(9) + cells.join(''))
  }
  console.log('')
}

if (declared.size) {
  const drift = []
  for (const [name, stated] of declared) {
    const worstPlain = Math.min(...rows.filter((r) => r.mode === 'light' && r.name === name && r.enforced).map((r) => r.value))
    // The editor records the worst of the two grounds it measured (bg + child); allow 0.02 rounding.
    const worstTwo = Math.min(
      ...rows.filter((r) => r.mode === 'light' && r.name === name && (r.ground === 'bg' || r.ground === 'child-bg')).map((r) => r.value),
    )
    if (Math.abs(worstTwo - stated) > 0.02) drift.push(`${name}: file says ${stated}, derived ${worstTwo} (worst of bg + child-bg; worst of all enforced ${worstPlain})`)
  }
  if (drift.length) {
    console.log('🔴 CYCLE_MEASURED_CONTRAST has drifted from the tokens:')
    for (const d of drift) console.log('   ' + d)
    console.log('')
  } else {
    console.log(`✓ CYCLE_MEASURED_CONTRAST matches the derived values for all ${declared.size} hues\n`)
  }
}

if (reportedFailures.length) {
  console.log('⚠ REPORTED (not enforced) — real grounds, below the bar, owner decision:')
  for (const f of reportedFailures) console.log(`   ${f.mode} · ${f.name} on ${f.ground} (${f.groundHex}) = ${f.value}`)
  console.log('   The state tints land on `.ag-cell` itself; which of them an outline may sit on is the')
  console.log('   editor owner\'s call, and the studio console is pinned light. Not failing the push on it.\n')
}

if (enforcedFailures.length) {
  console.error(`❌ grid-swatch-contrast: ${enforcedFailures.length} enforced ground(s) below ${BAR}:1`)
  for (const f of enforcedFailures) console.error(`   ${f.name} on ${f.ground} (${f.groundHex}) = ${f.value}`)
  console.error('\n   A hue in the reference cycle must clear 3:1 on every plain row ground — a cell always')
  console.error('   paints one of them. Swap the hue in CYCLE_NAMES for one that clears, or re-tone the')
  console.error('   swatch in tokens/colors.ts; never lower the bar.')
  if (CHECK) process.exit(1)
} else {
  console.log(`✓ every cycle hue clears ${BAR}:1 on all ${ROW_GROUNDS.length} plain row grounds (light)`)
}
