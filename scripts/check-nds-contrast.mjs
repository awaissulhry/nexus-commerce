#!/usr/bin/env node
/**
 * PLAN Step 4.0 (docs/product-cheat/PLAN.md, R-44/R-45) — text contrast of the design-system palette the studio and the DS
 * grid actually paint with (`--nds-*` in `apps/web/src/design-system/styles/tokens.css`), light and dark, at 7:1 (AAA)
 * and 4.5:1 (AA).
 *
 * ── Why this and not `check-contrast.mjs` ────────────────────────────────────────────────────────────────────────────
 * `check-contrast.mjs` measures the legacy `--text-*` tokens in `globals.css` through a hand-written colour map. The studio
 * references `--nds-*` only, so a gate there goes green or red about text the sheet never draws (PLAN-REVIEW-2026-09-22 §4).
 *
 * ── Nothing here is a hand-kept member list ──────────────────────────────────────────────────────────────────────────
 * Every colour is read from tokens.css at run time (`:root` and the `.dark` scope; a dark lookup falls back to `:root`, as the
 * cascade does), `var()` chains are followed, alpha is composited over the ground it is painted on. The PAIRS are derived
 * from token names, so a token added to a role is measured without editing this file:
 *   text     `--nds-text`, every `--nds-text-*` except `-disabled` (WCAG 1.4.3 exempts inactive UI) and `-inverse` (its own
 *            pair), and `--nds-primary` (link/accent text)          × surfaces `--nds-bg`, `--nds-surface`, `--nds-surface-*`
 *   status   every `--nds-X-text` that has a `--nds-X-soft`         (X-text on X-soft)
 *   pill     every `--nds-pill-X-fg` that has a `--nds-pill-X-bg`   (fg on bg)
 *   inverse  `--nds-text-inverse` on `--nds-primary`                (button labels)
 *   hover    `--nds-text-inverse` on `--nds-primary-hover`          (the same label on the hover fill — R-65)
 *
 * ── Two tiers, from a usage table the Owner rules ────────────────────────────────────────────────────────────────────
 *   body  (the default) AAA 7:1 · AA 4.5:1        ui  (large or UI-label text only) AAA 4.5:1 · AA 3:1
 * USAGE below is RULED (R-49, 2026-09-23): every text token, `--nds-text-3` and pill text included, is body text (strict 7:1).
 * A `to-rule` entry, if one is ever added, is counted at the body tier and also prints its ui verdict.
 *
 * ── Controls ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * Positive: `--nds-text` on `--nds-surface` (light) must measure 15–16 (Study 02: ~15.5). Negative: an absent token must
 * resolve to null. Either failing exits 2. A pair whose colour cannot be resolved is reported UNRESOLVED and counted as a
 * failure at both tiers — never as a pass.
 *
 * Usage:
 *   node scripts/check-nds-contrast.mjs                           # baseline: print, exit 0 (2 if a control fails)
 *   node scripts/check-nds-contrast.mjs --json                    # the same, as JSON
 *   node scripts/check-nds-contrast.mjs --max-failures 49 --max-aa-failures 8   # ratchet: exit 1 if either count GROWS
 *   node scripts/check-nds-contrast.mjs --tokens <path>           # measure a scratch copy (rehearsal; never edit the real file)
 */

import { readFileSync } from 'node:fs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const argv = process.argv.slice(2)
const opt = (name) => {
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${name} requires a value`)
  return argv[i + 1]
}
const TOKENS_CSS = opt('--tokens') ?? `${ROOT}/apps/web/src/design-system/styles/tokens.css`
const JSON_OUT = argv.includes('--json')
const intOpt = (name) => {
  const v = opt(name)
  if (v === undefined) return undefined
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a whole number`)
  return Number(v)
}
const MAX_AAA = intOpt('--max-failures')
const MAX_AA = intOpt('--max-aa-failures')

// ── the usage table — ruled by the Owner (R-49): strict 7:1 for all text ───────────────────────────────────────────
const TIERS = { body: { aaa: 7, aa: 4.5 }, ui: { aaa: 4.5, aa: 3 } }
/** Keyed by the FOREGROUND token. Anything not listed is body text. */
const USAGE = {
  '--nds-text-3': { tier: 'body', note: 'R-49: labels and metadata are still text — strict 7:1; it darkens in the AAA sweep (Step 4.3 #5)' },
}

// ── WCAG maths ──────────────────────────────────────────────────────────────────────────────────────────────────────
const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const ratio = (a, b) => { const x = lum(a), y = lum(b); const [hi, lo] = x >= y ? [x, y] : [y, x]; return (hi + 0.05) / (lo + 0.05) }
const r2 = (x) => Math.round(x * 100) / 100
const toHex = (rgb) => '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')
/** Paint `top` (with its alpha) over an opaque `under`. */
const over = (top, under) => top.rgb.map((c, i) => top.a * c + (1 - top.a) * under[i])

// ── the token maps, straight from the file the app loads ────────────────────────────────────────────────────────────
const css = readFileSync(TOKENS_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
function blockOf(selector) {
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].split(',').some((p) => p.trim() === selector))
  if (!blocks.length) throw new Error(`check-nds-contrast: ${TOKENS_CSS} has no block with selector ${selector}`)
  const map = new Map()
  for (const m of blocks) for (const d of m[2].split(';')) {
    const kv = d.match(/^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/i)
    if (kv) map.set(kv[1], kv[2].trim())
  }
  return map
}
const LIGHT = blockOf(':root')
const DARK = blockOf('.dark')
const raw = (name, mode) => (mode === 'dark' ? DARK.get(name) ?? LIGHT.get(name) : LIGHT.get(name))

/** Substitute every var() (with its fallback) until a literal remains; null when a name is absent or the chain loops. */
function substitute(value, mode, depth = 0) {
  if (value == null || depth > 20) return null
  let out = ''
  let i = 0
  while (i < value.length) {
    const at = value.indexOf('var(', i)
    if (at < 0) { out += value.slice(i); break }
    out += value.slice(i, at)
    let d = 0, j = at + 3
    for (; j < value.length; j++) { if (value[j] === '(') d++; else if (value[j] === ')' && --d === 0) break }
    const inner = value.slice(at + 4, j)
    const comma = inner.indexOf(',')
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim()
    const fallback = comma < 0 ? null : inner.slice(comma + 1).trim()
    const got = raw(name, mode)
    const rep = got != null ? substitute(got, mode, depth + 1) : (fallback != null ? substitute(fallback, mode, depth + 1) : null)
    if (rep == null) return null
    out += rep
    i = j + 1
  }
  return out.trim()
}

/** A literal CSS colour → { rgb:[r,g,b], a } or null. Handles #hex(3/4/6/8), rgb()/rgba() (comma or space + slash), transparent, color-mix(in srgb, …). */
function parseColor(v) {
  if (v == null) return null
  const s = v.trim().toLowerCase()
  if (s === 'transparent') return { rgb: [0, 0, 0], a: 0 }
  let m = s.match(/^#([0-9a-f]{3,8})$/)
  if (m) {
    let h = m[1]
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
    if (h.length !== 6 && h.length !== 8) return null
    return { rgb: [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16)), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 }
  }
  m = s.match(/^rgba?\(\s*([^)]*)\)$/)
  if (m) {
    const parts = m[1].replace(/\s*\/\s*/, ' / ').split(/[\s,]+/).filter(Boolean)
    const slash = parts.indexOf('/')
    const nums = (slash < 0 ? parts : parts.slice(0, slash)).map((p) => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p)))
    let alpha = slash >= 0 ? parts[slash + 1] : nums.length === 4 ? String(nums.pop()) : '1'
    const a = alpha.endsWith('%') ? parseFloat(alpha) / 100 : parseFloat(alpha)
    if (nums.length !== 3 || nums.some((n) => !Number.isFinite(n)) || !Number.isFinite(a)) return null
    return { rgb: nums, a }
  }
  m = s.match(/^color-mix\(\s*in\s+srgb\s*,([\s\S]*)\)$/)
  if (m) {
    const args = []
    let d = 0, cur = ''
    for (const ch of m[1]) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { args.push(cur); cur = '' } else cur += ch }
    args.push(cur)
    if (args.length !== 2) return null
    const side = (x) => { const pm = x.trim().match(/^([\s\S]*?)\s+(\d+(?:\.\d+)?)%$/); return pm ? { c: parseColor(pm[1]), p: Number(pm[2]) / 100 } : { c: parseColor(x), p: null } }
    const A = side(args[0]), B = side(args[1])
    if (!A.c || !B.c) return null
    const pa = A.p ?? (B.p != null ? 1 - B.p : 0.5), pb = B.p ?? 1 - pa
    const wa = A.c.a * pa, wb = B.c.a * pb, a = wa + wb
    if (a === 0) return { rgb: [0, 0, 0], a: 0 }
    return { rgb: A.c.rgb.map((c, i) => (c * wa + B.c.rgb[i] * wb) / a), a }
  }
  return null
}

/** A token's colour in a mode, or null (absent, a non-colour value, an unresolvable chain). */
const colorOf = (name, mode) => parseColor(substitute(raw(name, mode), mode))

// ── the pairs, derived from token names ─────────────────────────────────────────────────────────────────────────────
const NAMES = [...new Set([...LIGHT.keys(), ...DARK.keys()])]
const has = (n) => NAMES.includes(n)
const TEXT = [...NAMES.filter((n) => n === '--nds-text' || (/^--nds-text-[a-z0-9-]+$/.test(n) && !/-(disabled|inverse)$/.test(n))), ...(has('--nds-primary') ? ['--nds-primary'] : [])]
const SURFACES = NAMES.filter((n) => n === '--nds-bg' || n === '--nds-surface' || /^--nds-surface-[a-z0-9-]+$/.test(n))
const PAIRS = []
for (const t of TEXT) for (const s of SURFACES) PAIRS.push({ group: 'text', fg: t, bg: s })
for (const n of NAMES) { const m = n.match(/^--nds-([a-z0-9]+)-text$/); if (m && has(`--nds-${m[1]}-soft`)) PAIRS.push({ group: 'status', fg: n, bg: `--nds-${m[1]}-soft` }) }
for (const n of NAMES) { const m = n.match(/^--nds-pill-([a-z0-9-]+)-fg$/); if (m && has(`--nds-pill-${m[1]}-bg`)) PAIRS.push({ group: 'pill', fg: n, bg: `--nds-pill-${m[1]}-bg` }) }
if (has('--nds-text-inverse') && has('--nds-primary')) PAIRS.push({ group: 'inverse', fg: '--nds-text-inverse', bg: '--nds-primary' })
// R-65 (A-51 §3): the hover fill carries the same label. Paired whenever a primary exists, so a hover token that is MISSING
// resolves to null and counts as a failure; a theme with no hover of its own falls back to :root's (dark text on the light
// fill measured 2.66 before the sweep); a hover lighter than the rest fill (blue-700 under blue-800: 5.98) fails the bar.
if (has('--nds-text-inverse') && has('--nds-primary')) PAIRS.push({ group: 'hover', fg: '--nds-text-inverse', bg: '--nds-primary-hover' })
/** Stated, not measured: a `--nds-*-text` token with no derivable ground. */
const UNPAIRED = NAMES.filter((n) => /^--nds-[a-z0-9]+-text$/.test(n) && !has(n.replace(/-text$/, '-soft')))
/** The page ground a translucent background is composited over. */
const PAGE = '--nds-surface'

function measure(mode) {
  const page = colorOf(PAGE, mode)
  const rows = []
  for (const p of PAIRS) {
    const usage = USAGE[p.fg] ?? { tier: 'body' }
    const counted = TIERS[usage.tier === 'to-rule' ? 'body' : usage.tier]
    const fgC = colorOf(p.fg, mode), bgC = colorOf(p.bg, mode)
    if (!fgC || !bgC || !page || page.a < 1) {
      rows.push({ mode, ...p, tier: usage.tier, ratio: null, unresolved: [!fgC && p.fg, !bgC && p.bg, (!page || page.a < 1) && PAGE].filter(Boolean), belowAAA: true, belowAA: true })
      continue
    }
    const bg = bgC.a < 1 ? over(bgC, page.rgb) : bgC.rgb
    const fg = fgC.a < 1 ? over(fgC, bg) : fgC.rgb
    const r = ratio(fg, bg)
    const row = { mode, ...p, tier: usage.tier, ratio: r2(r), fgHex: toHex(fg), bgHex: toHex(bg), belowAAA: r < counted.aaa, belowAA: r < counted.aa }
    if (usage.tier === 'to-rule') row.ifUi = { belowAAA: r < TIERS.ui.aaa, belowAA: r < TIERS.ui.aa }
    rows.push(row)
  }
  return rows
}

// ── controls ────────────────────────────────────────────────────────────────────────────────────────────────────────
const posFg = colorOf('--nds-text', 'light'), posBg = colorOf('--nds-surface', 'light')
const positive = posFg && posBg ? r2(ratio(posFg.rgb, posBg.rgb)) : null
const negative = colorOf('--nds-zz-control-never-declared', 'light')
const controls = { positive, positiveOk: positive != null && positive >= 15 && positive <= 16, negative, negativeOk: negative === null }

const rows = [...measure('light'), ...measure('dark')]
const summary = (sel) => ({ pairs: sel.length, belowAAA: sel.filter((r) => r.belowAAA).length, belowAA: sel.filter((r) => r.belowAA).length })
const result = {
  tokens: TOKENS_CSS,
  controls,
  light: summary(rows.filter((r) => r.mode === 'light')),
  dark: summary(rows.filter((r) => r.mode === 'dark')),
  total: summary(rows),
  unresolved: rows.filter((r) => r.ratio === null).map((r) => ({ mode: r.mode, fg: r.fg, bg: r.bg, missing: r.unresolved })),
  unpairedText: UNPAIRED,
  usage: USAGE,
  failing: rows.filter((r) => r.belowAAA),
}
let exit = 0
if (!controls.positiveOk || !controls.negativeOk) exit = 2
else if ((MAX_AAA !== undefined && result.total.belowAAA > MAX_AAA) || (MAX_AA !== undefined && result.total.belowAA > MAX_AA)) exit = 1
result.ratchet = { maxAAA: MAX_AAA ?? null, maxAA: MAX_AA ?? null, failed: exit === 1 }

if (JSON_OUT) {
  console.log(JSON.stringify({ ...result, rows }, null, 1))
} else {
  console.log(`check-nds-contrast — ${TOKENS_CSS.replace(`${ROOT}/`, '')}`)
  console.log(`controls: --nds-text on --nds-surface (light) = ${positive} ${controls.positiveOk ? '✓' : '✗ (expected 15–16)'} · absent token → ${negative === null ? 'null ✓' : '✗ resolved'}`)
  for (const r of rows.filter((x) => x.belowAAA)) {
    const tag = r.ratio === null ? 'UNRESOLVED' : r.belowAA ? 'below AA ' : 'below AAA'
    const extra = r.ratio === null ? `missing ${r.unresolved.join(', ')}` : `${r.fgHex} on ${r.bgHex}${r.ifUi ? ` · tier TO RULE (as ui: ${r.ifUi.belowAAA ? (r.ifUi.belowAA ? 'below AA' : 'below AAA') : 'passes AAA'})` : ''}`
    console.log(`  ${tag}  ${r.ratio === null ? '   —  ' : r.ratio.toFixed(2).padStart(6)}  ${r.mode.padEnd(5)}  ${r.group.padEnd(7)}  ${r.fg} on ${r.bg}  ${extra}`)
  }
  for (const m of ['light', 'dark', 'total']) console.log(`${m.padEnd(5)}: ${result[m].pairs} pairs · ${result[m].belowAAA} below AAA · ${result[m].belowAA} below AA`)
  if (UNPAIRED.length) console.log(`not measured (no derivable ground): ${UNPAIRED.join(', ')}`)
  if (MAX_AAA !== undefined || MAX_AA !== undefined) console.log(`ratchet: max ${MAX_AAA ?? '—'} below AAA, ${MAX_AA ?? '—'} below AA → ${exit === 1 ? 'FAILED — a count grew' : 'held'}`)
  if (exit === 2) console.log('CONTROL FAILED — nothing above can be trusted')
}
process.exit(exit)
