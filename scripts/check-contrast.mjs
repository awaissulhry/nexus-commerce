#!/usr/bin/env node
/**
 * P0 contrast linter (UI_REBUILD_STRATEGY.md).
 *
 * Asserts every semantic text/status token pair passes WCAG AA on both
 * surfaces, light AND dark. Hardcodes the same RGB triples as the CSS
 * vars in apps/web/src/app/globals.css — keep them in sync. Run in CI /
 * pre-deploy so a token regression (e.g. dropping a colour back toward
 * slate-400) fails the build instead of silently shipping.
 *
 *   node scripts/check-contrast.mjs
 *
 * Exit 1 if any required body-text pair is below 4.5:1.
 */

// ── WCAG relative luminance + contrast ratio ────────────────────────
function lin(c) {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
function lum([r, g, b]) {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
function ratio(fg, bg) {
  const a = lum(fg)
  const b = lum(bg)
  const [hi, lo] = a >= b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

const AA = 4.5 // normal body text

const LIGHT = {
  'text-primary': [15, 23, 42],
  'text-secondary': [71, 85, 105],
  'text-tertiary': [100, 116, 139],
  'text-link': [37, 99, 235],
  'surface-canvas': [248, 250, 252],
  'surface-card': [255, 255, 255],
  'success-soft': [236, 253, 245], 'success-strong': [4, 120, 87],
  'warning-soft': [255, 251, 235], 'warning-strong': [180, 83, 9],
  'danger-soft': [255, 241, 242], 'danger-strong': [190, 18, 60],
  'info-soft': [239, 246, 255], 'info-strong': [29, 78, 216],
}

const DARK = {
  'text-primary': [248, 250, 252],
  'text-secondary': [203, 213, 225],
  'text-tertiary': [148, 163, 184],
  'text-link': [96, 165, 250],
  'surface-canvas': [2, 6, 23],
  'surface-card': [15, 23, 42],
  'success-soft': [6, 46, 35], 'success-strong': [110, 231, 183],
  'warning-soft': [56, 33, 6], 'warning-strong': [252, 211, 77],
  'danger-soft': [60, 16, 24], 'danger-strong': [253, 164, 175],
  'info-soft': [17, 32, 66], 'info-strong': [147, 197, 253],
}

// Required pairs (must pass AA 4.5:1).
const BODY = ['text-primary', 'text-secondary', 'text-tertiary', 'text-link']
const STATUS = ['success', 'warning', 'danger', 'info']

let failures = 0
const rows = []

function check(mode, tokens) {
  for (const t of BODY) {
    for (const surf of ['surface-card', 'surface-canvas']) {
      const r = ratio(tokens[t], tokens[surf])
      const ok = r >= AA
      if (!ok) failures++
      rows.push([mode, `${t} on ${surf}`, r.toFixed(2), ok ? 'PASS' : 'FAIL'])
    }
  }
  for (const s of STATUS) {
    const r = ratio(tokens[`${s}-strong`], tokens[`${s}-soft`])
    const ok = r >= AA
    if (!ok) failures++
    rows.push([mode, `${s}-strong on ${s}-soft`, r.toFixed(2), ok ? 'PASS' : 'FAIL'])
  }
}

check('light', LIGHT)
check('dark', DARK)

const w = Math.max(...rows.map((r) => r[1].length))
console.log('\n  WCAG AA contrast check (≥ 4.5:1)\n')
for (const [mode, pair, r, verdict] of rows) {
  const mark = verdict === 'PASS' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
  console.log(`  ${mark} ${mode.padEnd(5)}  ${pair.padEnd(w)}  ${r.padStart(6)}  ${verdict}`)
}

if (failures > 0) {
  console.error(`\n  \x1b[31m${failures} token pair(s) below AA 4.5:1\x1b[0m\n`)
  process.exit(1)
}
console.log(`\n  \x1b[32mAll ${rows.length} pairs pass AA.\x1b[0m\n`)
