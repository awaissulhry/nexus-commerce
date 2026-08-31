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
 * THREE CHECKS
 *   1. COMPLETE — every token `.dark` redefines is pinned.
 *   2. FRESH    — every pin resolves to the DS's own LIGHT value.
 *   3. SCOPE    — the pin still reaches PORTALS.
 *
 * The third exists because Session 1 spotted that the first two are blind to it. The pin's
 * selector was narrowed once already — it read `.h10-shell` alone, and the eight DS components
 * that portal into `document.body` rendered outside it: a light console whose every dropdown was
 * dark. COMPLETE and FRESH both passed at every point in that sequence, because the SET OF
 * SURFACES REACHED changed while the pins themselves stayed correct. Asserting the selector is a
 * static approximation of "which surfaces does this reach" — the real question is only fully
 * answerable at runtime, but this catches the one regression that has actually happened.
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

// 3. SCOPE — every flipped token must be pinned by a PORTAL-REACHING block.
// Comments are STRIPPED first. The block above the portal rule explains itself using the very
// string being searched for, so testing the raw file made the check unfailable — narrowing the
// selector left the prose behind and the guard stayed green.
const shellCode = shell.replace(/\/\*[\s\S]*?\*\//g, ' ')
const PORTAL_SCOPE = /body:has\(\.h10-shell\)/

// Per-BLOCK, not per-file. There are three `.h10-shell` pin blocks; testing whether the portal
// form exists anywhere meant narrowing one block still passed, because the other two matched.
// What we actually want is stronger and just as static: every token `.dark` flips must be pinned
// by a block whose OWN selector reaches portals. A token pinned only shell-side is unreachable
// inside a Listbox or a Modal, and nothing else here can see that.
const portalPinned = new Set()
for (const m of shellCode.matchAll(/([^{}]*?)\{([^{}]*)\}/g)) {
  const selector = m[1]
  if (!/\.h10-shell/.test(selector)) continue
  if (!PORTAL_SCOPE.test(selector)) continue
  for (const d of m[2].matchAll(/(--nds-[a-z0-9-]+):/g)) portalPinned.add(d[1])
}
const notPortalScoped = [...flips].filter((t) => !portalPinned.has(t)).sort()
const scopeLost = notPortalScoped.length > 0

/**
 * CHROME-GOVERNED PINS (TB, operator decision 2026-08-31).
 *
 * The bar and the rail became ONE deliberately dark surface — a dark frame around a light
 * workspace. That is NOT dark mode: the console's CONTENT is still pinned light, and the
 * 2026-08-05 "no dark mode here" decision still governs it. Only the chrome changed.
 *
 * So for these tokens the DS LIGHT value is no longer the right reference — `.h10-shell` pins
 * them to `tokens/chrome.ts` on purpose, and checking them against light would fail forever on a
 * correct pin, which is how a guard gets switched off.
 *
 * They are NOT exempted. FRESH still runs; it just resolves them against the chrome token they
 * are supposed to equal. A pin that drifts from chrome still fails, and a chrome token renamed
 * out from under the pin still fails — the guard keeps its teeth, pointed at the right target.
 */
const CHROME_PIN = new Map([
  ['--nds-rail-bg', '--nds-chrome-bg'],
  ['--nds-rail-border', '--nds-chrome-border'],
  ['--nds-rail-text', '--nds-chrome-fg'],
  ['--nds-rail-text-2', '--nds-chrome-fg-2'],
  ['--nds-rail-text-strong', '--nds-chrome-fg-strong'],
  ['--nds-rail-icon', '--nds-chrome-icon'],
  ['--nds-rail-chev', '--nds-chrome-chev'],
  ['--nds-rail-item-hover', '--nds-chrome-item-hover'],
  ['--nds-rail-item-hover-2', '--nds-chrome-item-hover-2'],
  ['--nds-rail-chip-bg', '--nds-chrome-chip-bg'],
  ['--nds-rail-chip-active-bg', '--nds-chrome-chip-active-bg'],
  ['--nds-rail-chip-active-fg', '--nds-chrome-chip-active-fg'],
  ['--nds-rail-ft', '--nds-chrome-ft'],
  ['--nds-shadow-rail', '--nds-chrome-shadow-rail'],
])

const missing = [...flips].filter((t) => !pins.has(t)).sort()
const stale = []
const chromeMissing = []
for (const [tok, expr] of pins) {
  const chromeRef = CHROME_PIN.get(tok)
  if (chromeRef) {
    // The chrome token must exist — a rename that left this map behind is exactly the silent
    // drift this guard exists to catch, so it fails loudly rather than skipping.
    const chromeVal = lightDefs.get(chromeRef)
    if (chromeVal == null) {
      chromeMissing.push({ tok, chromeRef })
      continue
    }
    const a = resolve(expr)
    const b = resolve(chromeVal)
    if (a.toLowerCase() !== b.toLowerCase()) {
      stale.push({ tok, expr, got: a, want: b, ref: chromeRef })
    }
    continue
  }
  const declared = lightDefs.get(tok)
  if (declared == null) continue
  const a = resolve(expr)
  const b = resolve(declared)
  if (a.toLowerCase() !== b.toLowerCase()) stale.push({ tok, expr, got: a, want: b })
}
if (chromeMissing.length) {
  console.error(`❌ shell-pin CHROME: ${chromeMissing.length} pin(s) reference a chrome token that no longer exists:`)
  for (const c of chromeMissing) console.error(`   ${c.tok} → ${c.chromeRef} (not defined in tokens.css)`)
  process.exit(1)
}

if (missing.length || stale.length || scopeLost) {
  if (scopeLost) {
    console.error(`❌ shell-pin SCOPE: ${notPortalScoped.length} flipped token(s) are pinned only shell-side,`)
    console.error(`   so they are unreachable inside a portal: ${notPortalScoped.slice(0, 6).join(', ')}`)
    console.error(`   Eight DS components portal into document.body — Listbox, Menu, Combobox,`)
    console.error(`   MultiSelect, HoverCard, Modal, Drawer, Toast. Scoped to \`.h10-shell\` alone the`)
    console.error(`   pin cannot reach them, and the console renders light with dark dropdowns.`)
    console.error(`   Nothing else here can see that: every pin stays correct and every popover stays`)
    console.error(`   internally above AA. It is a coherence failure, not a contrast one.\n`)
  }
  if (missing.length) {
    console.error(`❌ shell-pin INCOMPLETE: ${missing.length} token(s) that .dark flips are not pinned:`)
    for (const t of missing) console.error(`   ${t}`)
  }
  if (stale.length) {
    console.error(`❌ shell-pin STALE: ${stale.length} pin(s) no longer match their reference value:`)
    for (const s of stale) console.error(`   ${s.tok}: pinned ${s.expr} = ${s.got}, ${s.ref ? `chrome ${s.ref}` : 'DS light'} = ${s.want}`)
    console.error(`\n   A stale pin that looks authoritative is worse than no pin: it silently drags a\n` +
                  `   token back to a value the DS has moved away from, inside this console only.`)
  }
  // A dangling `else` here binds to the preceding `if`, which is how the first version of
  // this banner ran only when there was nothing to report. Explicit condition.
  if (process.argv[2] !== '--check') {
    console.error(
      `\n   ⚠️  REPORT MODE — this exits 0 despite the failure above. The gate is\n` +
        `   \`--check\`, which exits 1. A guard with two modes has two exit codes, and\n` +
        `   testing the wrong one is indistinguishable from testing nothing.`,
    )
  }

  if (process.argv[2] === '--check') process.exit(1)
} else {
  console.log(`✓ shell-pin: ${pins.size} pin(s), all fresh, portal scope intact`)
}
