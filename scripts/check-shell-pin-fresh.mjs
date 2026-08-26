#!/usr/bin/env node
/**
 * Shell-pin freshness.
 *
 * `.h10-shell` (and `body:has(.h10-shell)`) pins every token `.dark` redefines, so the ads
 * console — which pins its own ground light — does not end up with flipped text on an unflipped
 * background. Measured 2026-08-26 before the pin: `--nds-text` was 1.11:1 on that ground.
 *
 * A PIN CAN GO STALE, and silently. Found the same day: three separate pin blocks had
 * accumulated in shared-shell.css, and five of their entries no longer matched the DS's light
 * value — because they pin THROUGH THE RAMP (`--nds-text-3: var(--nds-grey-500)`) and a ramp
 * reference rots the moment a role diverges from its ramp. `--nds-text-3` had been re-toned to
 * #7e8796 to clear the 3:1 icon floor; the pin dragged it back to #8a93a1 (2.74 on grey-100)
 * inside the console. Only source order was saving it.
 *
 * Session 56 put the rule well: a pin must name a LITERAL, or it inherits the drift it exists to
 * prevent. This guard is the alternative to that discipline — it lets a pin be written either
 * way and simply fails when it stops agreeing with the DS.
 *
 * TWO CHECKS
 *   1. COMPLETE — every token `.dark` redefines is pinned.
 *   2. FRESH    — every pin resolves to the DS's own LIGHT value.
 *
 *   node scripts/check-shell-pin-fresh.mjs           # report
 *   node scripts/check-shell-pin-fresh.mjs --check   # exit 1 on a missing or stale pin
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const TOKENS = join(ROOT, 'apps/web/src/design-system/styles/tokens.css')
const SHELL = join(ROOT, 'apps/web/src/app/_shared/shared-shell.css')

if (!existsSync(TOKENS) || !existsSync(SHELL)) {
  console.log('✓ shell-pin: tokens.css or shared-shell.css absent — nothing to check')
  process.exit(0)
}

const V = readFileSync(TOKENS, 'utf8')
const at = V.indexOf('\n.dark {')
const LIGHT = at < 0 ? V : V.slice(0, at)
const DARK = at < 0 ? '' : V.slice(at)

const lightDefs = new Map([...LIGHT.matchAll(/(--nds-[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
const flips = new Set([...DARK.matchAll(/(--nds-[a-z0-9-]+):/g)].map((m) => m[1]))

/**
 * Resolve a value expression through the LIGHT definitions only.
 *
 * Expands EMBEDDED `var()`, not just a bare one. The first version handled `var(--x)` alone and
 * duly reported `--nds-shadow-rail` stale because the pin says `rgba(20, 28, 38, 0.13)` and the
 * DS says `rgb(var(--nds-shadow-rgb) / 0.13)` — identical values, different notation. A guard
 * that cries wolf on a correct pin gets ignored on a real one.
 */
function resolve(expr, depth = 0) {
  let e = String(expr).trim()
  if (depth > 8) return normalise(e)
  const before = e
  e = e.replace(/var\((--nds-[a-z0-9-]+)\)/g, (whole, name) => {
    const next = lightDefs.get(name)
    return next == null ? whole : next.trim()
  })
  return e === before ? normalise(e) : resolve(e, depth + 1)
}

/** Compare by VALUE, not by notation: rgb()/rgba() spacing and separators differ freely. */
function normalise(v) {
  return String(v)
    .toLowerCase()
    .replace(/rgba?\(([^)]*)\)/g, (_, inner) => `rgb(${inner.split(/[\s,/]+/).filter(Boolean).join(' ')})`)
    .replace(/\s+/g, ' ')
    .trim()
}

const shell = readFileSync(SHELL, 'utf8')
// every .h10-shell rule that sets --nds-* tokens, in source order
const pins = new Map()
for (const m of shell.matchAll(/(?:^|,|\s)(?:body:has\(\.h10-shell\)|\.h10-shell)[^{}]*\{([^{}]*)\}/g)) {
  for (const d of m[1].matchAll(/(--nds-[a-z0-9-]+):\s*([^;]+);/g)) pins.set(d[1], d[2].trim()) // later wins
}

const missing = [...flips].filter((t) => !pins.has(t)).sort()
const stale = []
for (const [tok, expr] of pins) {
  const declared = lightDefs.get(tok)
  if (declared == null) continue
  const a = resolve(expr)
  const b = resolve(declared)
  if (a.toLowerCase() !== b.toLowerCase()) stale.push({ tok, expr, got: a, want: b })
}

if (missing.length || stale.length) {
  if (missing.length) {
    console.error(`❌ shell-pin INCOMPLETE: ${missing.length} token(s) that .dark flips are not pinned:`)
    for (const t of missing) console.error(`   ${t}`)
  }
  if (stale.length) {
    console.error(`❌ shell-pin STALE: ${stale.length} pin(s) no longer match the DS light value:`)
    for (const s of stale) console.error(`   ${s.tok}: pinned ${s.expr} = ${s.got}, DS light = ${s.want}`)
    console.error(`\n   A stale pin that looks authoritative is worse than no pin: it silently drags a\n` +
                  `   token back to a value the DS has moved away from, inside this console only.`)
  }
  if (process.argv[2] === '--check') process.exit(1)
} else {
  console.log(`✓ shell-pin: ${pins.size} pin(s), all fresh — every token .dark flips is pinned to its DS light value`)
}
