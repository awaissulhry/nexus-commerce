#!/usr/bin/env node
/**
 * Radius ratchet — every `border-radius` that does NOT name a DS scale step.
 *
 * WHY THIS EXISTS
 * Measured 2026-08-25: the ads console had **1,421 border-radius declarations and not one used a
 * DS token**. 851 were exactly a scale step written as a bare literal; those now name it. The
 * remaining 570 are genuinely off-scale — 5px ×157, 4px ×101, 9px ×97, 3px ×34, 2px ×21, 11px ×10.
 *
 * They are NOT simply wrong, which is why this guard freezes them instead of banning them. Look at
 * what they style: 2px is on tab underline indicators, 3px on bars and swatches, 5px on small
 * chips. Small elements need small radii, and the DS scale starts at 6px with nothing between 8
 * and 10. The scale is incomplete; whether it grows or the console curates down to fewer steps is
 * a DESIGN decision, and snapping 570 elements on a guess changes how the product looks.
 *
 * What this guard does in the meantime: stops the number growing. A new off-scale radius fails the
 * push; naming an existing one lowers the count. When the scale question is settled, the number
 * walks to whatever the answer says it should be.
 *
 * It is also why the drift kept happening: `.h10-aig-card` at 10px beside `.h10-spw-card` at 12px
 * was invisible because neither declared which scale it was on. 40 concepts still render at two or
 * more radii — `-chip` uses five different values.
 *
 *   node scripts/check-css-radius-ratchet.mjs           # census
 *   node scripts/check-css-radius-ratchet.mjs --check   # exit 1 if any file rose
 *   node scripts/check-css-radius-ratchet.mjs --baseline
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = new URL('..', import.meta.url).pathname
const SCAN = join(ROOT, 'apps/web/src/app')
const BASELINE = join(ROOT, 'scripts/css-radius-baseline.json')

let tracked = new Set()
try {
/* 🔴 DISCLOSED EDIT by DS.1 under hub ruling #591 — ENUMERATION ONLY. No rule, threshold or
   baseline is touched.

   The rationale below was deliberate and is preserved because it is right in the general case: in a
   shared tree, another session's untracked work-in-progress should not fail your push. **It is wrong
   for this programme.** Nothing here is committed; the whole rebuild lands in ONE push on the
   Owner's word, so at that moment every untracked file IS part of the push — ~563 of them. Excluding
   them means every green this gate printed was over a subset nobody chose, and the surfaces it has
   never read are the new ones. `--exclude-standard` keeps `.gitignore` honoured. */
  tracked = new Set([
/* 🔴 TWO globs, and the second is not redundant (hub #601). A `git ls-files` double-star pattern
   does NOT match a file sitting directly in the named directory — measured 0 vs 1 — so
   `apps/web/src/app/globals.css` had never been scanned by this ratchet, tracked or not, since
   before the untracked union. A double-star that reads as "everything below here" silently means
   "everything at least one directory below here". Found while proving an untracked control: the
   control did not move, and the scratch file was simply too shallow to be seen.

   (The glob is spelled out in the execSync call below rather than in this comment on purpose — a
   star immediately followed by a slash ENDS a block comment, which is the #262 incident, and I put
   it here on the first attempt.) */
    ...execSync('git ls-files "apps/web/src/app/**/*.css" "apps/web/src/app/*.css"', { cwd: ROOT, encoding: 'utf8' }).split('\n'),
    ...execSync('git ls-files --others --exclude-standard "apps/web/src/app/**/*.css" "apps/web/src/app/*.css"', { cwd: ROOT, encoding: 'utf8' }).split('\n'),
  ].filter(Boolean))
} catch { /* not a git tree — scan everything */ }

function* walk(dir) {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (p.endsWith('.css')) yield p
  }
}

/** border-radius declarations whose value is neither a var() nor `0`. */
function offScale(css) {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = []
  for (const m of body.matchAll(/border-radius:\s*([^;}]+)/g)) {
    const v = m[1].trim()
    if (v.startsWith('var(')) continue
    if (/^0(px)?$/.test(v)) continue
    if (/^inherit|initial|unset$/.test(v)) continue
    out.push(v)
  }
  return out
}

const counts = {}
for (const p of walk(SCAN)) {
  const rel = relative(ROOT, p)
  if (tracked.size && !tracked.has(rel)) continue
  const n = offScale(readFileSync(p, 'utf8')).length
  if (n) counts[relative(join(ROOT, 'apps/web/src'), p)] = n
}
const total = Object.values(counts).reduce((a, b) => a + b, 0)
const mode = process.argv[2] ?? '--census'

if (mode === '--baseline') {
  writeFileSync(BASELINE, JSON.stringify({
    note: 'border-radius declarations that name no DS scale step. This may only FALL. A file absent here is held at zero. See the script header for why these are frozen rather than banned.',
    updatedAt: new Date().toISOString().slice(0, 10),
    total, files: counts,
  }, null, 2) + '\n')
  console.log(`baseline written: ${Object.keys(counts).length} files, ${total} off-scale radii`)
  process.exit(0)
}

if (mode === '--census') {
  console.log(`${Object.keys(counts).length} stylesheet(s) carry ${total} radius literal(s) naming no scale step\n`)
  for (const [f, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(n).padStart(5)}  ${f}`)
  }
  process.exit(0)
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
const risen = Object.entries(counts).filter(([f, n]) => n > (base.files[f] ?? 0))
if (risen.length) {
  console.error(`❌ radius ratchet: ${risen.length} stylesheet(s) gained radius literals:`)
  for (const [f, n] of risen) {
    const was = base.files[f] ?? 0
    console.error(`   ${f}: ${was} → ${n}`)
    if (!was) console.error('     New stylesheet — start it on var(--nds-radius-*). See /DESIGN.md for the scale.')
  }
  console.error('\n   If the value genuinely has no scale step, say so in the commit and re-baseline.')
  process.exit(1)
}
console.log(`✓ radius ratchet: ${total} off-scale (baseline ${base.total}) — no stylesheet rose`)
