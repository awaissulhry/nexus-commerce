#!/usr/bin/env node
/**
 * check-dark-pin-parity — the light pin must cover every token `.dark` actually changes.
 *
 * `shared-shell.css` pins ~95 tokens back to their light values on `body:has(.h10-shell)`, so a
 * console page ignores the OS/`.dark` theme. That list is maintained BY HAND, and its own header
 * says so: "Adding a `.dark` override to a token in the DS means adding its pin HERE too."
 *
 * From a live miss (hub #583): DS.2 minted a `.dark` value for `--nds-chrome-bg`; the list did not
 * grow with it; a light-pinned `/products/next` took the dark value while `--nds-bg` stayed light.
 * When this guard was written it found FOUR more in the same state, three of them the provenance
 * inks — the marks that say where a cell's value came from, i.e. the surface that most needs to stay
 * legible when everything else is refusing. **An instruction in a comment is not a mechanism.**
 *
 * 🔴 THE RULE IS RESOLVED-VALUE PARITY, and it has been wrong twice — each time in a way that felt
 * obviously right. Iterate every `:root` token, resolve its `var()` chain under BOTH themes, and
 * demand a pin only where the two RESOLVED values differ.
 *
 *   presence-based  ("has a `.dark` entry")  → demanded 42 no-op pins. Rejected: padding this list
 *                                              is what let five real misses hide in it.
 *   text-based      ("its `.dark` text differs") → skipped 34 LIVE ALIASES. The `.dark` block was
 *                                              the guard's INDEX, so a token with no `.dark` entry
 *                                              was never examined at all.
 *   resolved-value  (this)                   → demands exactly the 34, skips the 8 inert.
 *
 * The alias hole was live and is why this exists: `--nds-topbar-bg` is `var(--nds-chrome-bg)` with
 * NO `.dark` entry of its own. DS.2 measured that an alias re-resolves only when its target is
 * redefined on the SAME element — `var()` is substituted where declared, and the RESOLVED value is
 * what inherits — so pinning the target on `body:has(.h10-shell)` does not re-pin an alias declared
 * up in `:root`. On `/products/next` with `.dark` forced, the topbar painted `rgb(30,48,80)` beside
 * a light-pinned rail. Text comparison could not see it; the texts are identical in both themes.
 *
 * 🔴 ABSENT IS NOT "DIFFERENT". `#7400bc !== undefined` is `true`, and that is how a token got
 * flagged in DS.2's first pass. A comparison is only made when BOTH themes resolve to a real value;
 * anything unresolvable is counted and reported separately, never as a difference.
 *
 * Comments are STRIPPED before parsing — a commented-out token is not a definition, and this repo
 * has now been bitten twice in one night by scanners counting comments as code (DS1-31, DS1-34).
 *
 *   node scripts/check-dark-pin-parity.mjs
 *   node scripts/check-dark-pin-parity.mjs --self-test
 */
import { readFileSync, existsSync } from 'fs'

const DARK_SHEETS = [
  'apps/web/src/design-system/styles/tokens.css',
  'apps/web/src/design-system/styles/tokens-global.css',
  'apps/web/src/app/globals.css',
]
const SHELL = 'apps/web/src/app/_shared/shared-shell.css'
/** The pin's selector. If this ever changes, the guard must fail loudly rather than find nothing. */
const PIN_SELECTOR = 'body:has(.h10-shell)'

/** CSS has only block comments, so this is complete for the language. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

const declarations = (body) => {
  const out = new Map()
  for (const m of body.matchAll(/(--nds-[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim())
  return out
}

/**
 * Tokens whose `.dark` value DIFFERS from their `:root` value, and which the pin does not restore.
 * Exported so the self-test can drive it over literals rather than over the tree.
 */
/**
 * Substitute `var(--x, fallback)` until nothing is left to substitute. Returns `undefined` when the
 * chain cannot be fully resolved, so callers can refuse to compare rather than compare a fragment.
 */
export function resolveValue(raw, map) {
  if (raw === undefined) return undefined
  let out = String(raw)
  for (let i = 0; i < 24 && out.includes('var('); i++) {
    let changed = false
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (m, name, fb) => {
      const v = map.get(name)
      if (v !== undefined) { changed = true; return v }
      if (fb !== undefined) { changed = true; return fb.trim() }
      return m
    })
    if (!changed) break
  }
  return out.includes('var(') ? undefined : out.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function analyse({ darkSources, shellSource }) {
  const root = new Map()
  const darkOverride = new Map()
  for (const src of darkSources) {
    for (const m of stripComments(src).matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const sel = m[1].trim().split('\n').pop().trim()
      const into = /(^|[\s,])\.dark\b/.test(sel) ? darkOverride : /(^|[\s,]):root\b/.test(sel) ? root : null
      if (!into) continue
      for (const [k, v] of declarations(m[2])) if (!into.has(k)) into.set(k, v)
    }
  }
  // The dark theme is `:root` OVERLAID with `.dark` — an alias keeps its `:root` text and changes
  // meaning only because what it points at changed underneath it. That is the whole finding.
  const darkMap = new Map(root)
  for (const [k, v] of darkOverride) darkMap.set(k, v)

  const shell = stripComments(shellSource)
  if (!shell.includes(PIN_SELECTOR)) {
    return { pinSelectorMissing: true, missing: [], noop: [], unresolvable: [], drift: [], superseded: [], root, darkOverride }
  }
  /**
   * EVERY block in the shell sheet that targets this element, in source order — not just the pin
   * list. `shared-shell.css:606` re-declares `--nds-rail-bg: var(--nds-chrome-bg)` on a selector list
   * that includes `body:has(.h10-shell)` itself, later and at equal specificity, so it wins there.
   * A model that read only the pin block would resolve `--nds-topbar-bg: var(--nds-rail-bg)` through
   * the pin's own rail-bg (`var(--nds-rail-surface)` = #f1f3f5) and report drift on a line that is
   * correct. Reading one block and calling it the cascade is how the hub's #601 ruling went wrong.
   */
  const onElement = [...shell.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter((m) => m[1].includes(PIN_SELECTOR))
    .map((m) => declarations(m[2]))
  const block = onElement[0]
  const pinned = new Set(block.keys())
  const context = new Map(root)
  for (const decls of onElement) for (const [k, v] of decls) context.set(k, v)
  const laterDecl = new Set(onElement.slice(1).flatMap((d) => [...d.keys()]))

  const missing = []
  const noop = []
  const unresolvable = []
  for (const [token, rawLight] of root) {
    const light = resolveValue(rawLight, root)
    const dark = resolveValue(darkMap.get(token), darkMap)
    // 🔴 Both must resolve. `undefined !== '#7400bc'` is true and would manufacture a difference.
    if (light === undefined || dark === undefined) { unresolvable.push(token); continue }
    if (light === dark) { noop.push(token); continue }
    if (pinned.has(token)) continue
    missing.push({ token, lightValue: light, darkValue: dark, alias: /var\(/.test(rawLight) })
  }
  /**
   * 🔴 A PIN CAN BE PRESENT AND WRONG. Presence-where-different is not enough once a pin is allowed
   * to hold a literal: the literal is a second copy of a value that lives somewhere else, and copies
   * drift. `--nds-chrome-bg: #18263b` is a literal by necessity (it is the root of the chrome chain;
   * pointing it at rail-bg closes a cycle), so the check that makes it safe is that it still RESOLVES
   * to the token's own `:root` light value. Hub #605.
   *
   * Tokens re-declared by a LATER block on the same element are skipped: their effective value is
   * that block's decision, not the pin's, and the chrome block deliberately overrides 14 rail tokens.
   */
  const drift = []
  const superseded = []
  for (const [token, rawPin] of block) {
    if (laterDecl.has(token)) { superseded.push(token); continue }
    const want = resolveValue(root.get(token), root)
    const got = resolveValue(rawPin, context)
    if (want === undefined || got === undefined) continue
    if (want !== got) drift.push({ token, want, got, raw: rawPin })
  }
  return { pinSelectorMissing: false, root, darkOverride, pinned, missing, noop, unresolvable, drift, superseded }
}

if (process.argv.includes('--self-test')) {
  const rootBlock = ':root{--nds-chrome-bg:#18263b;--nds-bg:#fff;--nds-same:red;}'
  const darkBlock = '.dark{--nds-chrome-bg:#1e3050;--nds-bg:#111;--nds-same:red;}'
  const cases = [
    ['the #583 control — --nds-chrome-bg has a dark value and is NOT pinned',
      [rootBlock + darkBlock], `${PIN_SELECTOR}, .h10-shell {\n  --nds-bg: #fff;\n}`, ['--nds-chrome-bg']],
    ['pinned, so not reported',
      [rootBlock + darkBlock], `${PIN_SELECTOR}, .h10-shell {\n  --nds-bg: #fff;\n  --nds-chrome-bg: #18263b;\n}`, []],
    ['a dark value IDENTICAL to :root needs no pin (--nds-same)',
      [':root{--nds-same:red;}.dark{--nds-same:red;}'], `${PIN_SELECTOR}, .h10-shell {\n  --nds-x: 1;\n}`, []],
    ['a COMMENTED-OUT dark override is not an override',
      [':root{--nds-c:#fff;}.dark{/* --nds-c: #000; */}'], `${PIN_SELECTOR}, .h10-shell {\n  --nds-x: 1;\n}`, []],
    ['a token pinned only inside a COMMENT is not pinned',
      [rootBlock + darkBlock], `${PIN_SELECTOR}, .h10-shell {\n  --nds-bg: #fff;\n  /* --nds-chrome-bg: #18263b; */\n}`, ['--nds-chrome-bg']],
    ['🔴 the #597 ALIAS — no `.dark` entry of its own, but its TARGET differs by theme',
      [':root{--nds-chrome-bg:#18263b;--nds-topbar-bg:var(--nds-chrome-bg);}.dark{--nds-chrome-bg:#1e3050;}'],
      `${PIN_SELECTOR}, .h10-shell {\n  --nds-chrome-bg: #18263b;\n}`, ['--nds-topbar-bg']],
    ['an alias whose target is theme-STABLE needs no pin',
      [':root{--nds-purple-700:#6d28d9;--nds-prov:var(--nds-purple-700);}.dark{--nds-bg:#111;}'],
      `${PIN_SELECTOR}, .h10-shell {\n  --nds-x: 1;\n}`, []],
    ['🔴 absent is NOT different — an unresolvable chain is never a finding',
      [':root{--nds-broken:var(--nds-does-not-exist);}.dark{--nds-bg:#111;}'],
      `${PIN_SELECTOR}, .h10-shell {\n  --nds-x: 1;\n}`, []],
    ['a var() FALLBACK resolves rather than counting as unresolvable',
      [':root{--nds-fb:var(--nds-missing, #abc);}.dark{--nds-bg:#111;}'],
      `${PIN_SELECTOR}, .h10-shell {\n  --nds-x: 1;\n}`, []],
  ]
  const driftCases = [
    ['🔴 a pin holding a WRONG literal is reported as drift',
      [rootBlock + darkBlock], `${PIN_SELECTOR}, .h10-shell {\n  --nds-chrome-bg: #999999;\n}`, ['--nds-chrome-bg']],
    ['a pin holding the RIGHT literal is not',
      [rootBlock + darkBlock], `${PIN_SELECTOR}, .h10-shell {\n  --nds-chrome-bg: #18263b;\n}`, []],
    ['a pin via a var() alias that resolves correctly is not drift',
      [':root{--nds-p700:#6d28d9;--nds-ink:#6d28d9;}.dark{--nds-ink:#c4b5fd;}'],
      `${PIN_SELECTOR}, .h10-shell {\n  --nds-ink: var(--nds-p700);\n}`, []],
    ['a token re-declared by a LATER block on the same element is superseded, not drift',
      [':root{--nds-chrome-bg:#18263b;--nds-rail-bg:var(--nds-rail-surface);--nds-rail-surface:#f1f3f5;}.dark{--nds-chrome-bg:#1e3050;}'],
      `${PIN_SELECTOR}, .h10-shell {\n  --nds-chrome-bg: #18263b;\n  --nds-rail-bg: var(--nds-rail-surface);\n}\n.x, ${PIN_SELECTOR} {\n  --nds-rail-bg: var(--nds-chrome-bg);\n}`, []],
  ]
  let bad = 0
  for (const [name, darkSources, shellSource, want] of driftCases) {
    const got = analyse({ darkSources, shellSource }).drift.map((d) => d.token).sort()
    const ok = JSON.stringify(got) === JSON.stringify([...want].sort())
    if (!ok) bad++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — expected [${want}], got [${got}]`)
  }
  for (const [name, darkSources, shellSource, want] of cases) {
    const got = analyse({ darkSources, shellSource }).missing.map((m) => m.token).sort()
    const ok = JSON.stringify(got) === JSON.stringify([...want].sort())
    if (!ok) bad++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — expected [${want}], got [${got}]`)
  }
  // The pin selector disappearing must FAIL, not quietly find nothing.
  const gone = analyse({ darkSources: [rootBlock + darkBlock], shellSource: '.something-else { --nds-bg: #fff; }' })
  const okGone = gone.pinSelectorMissing === true
  if (!okGone) bad++
  console.log(`  ${okGone ? 'PASS' : 'FAIL'}  the pin selector vanishing is an ERROR, not an empty result`)
  console.log(bad === 0
    ? '\n[ok] self-test: the #583 control is caught, identical values are not demanded, comments count on neither side'
    : `\n[fail] self-test: ${bad} case(s) wrong`)
  process.exit(bad === 0 ? 0 : 1)
}

console.log('  comments: stripped')

const present = DARK_SHEETS.filter((f) => existsSync(f))
if (present.length === 0 || !existsSync(SHELL)) {
  console.log(`[fail] dark-pin parity: could not read its inputs (${present.length} theme sheet(s), shell ${existsSync(SHELL)}) — a guard that cannot fail`)
  process.exit(1)
}

const r = analyse({
  darkSources: present.map((f) => readFileSync(f, 'utf8')),
  shellSource: readFileSync(SHELL, 'utf8'),
})

if (r.pinSelectorMissing) {
  console.log(`[fail] dark-pin parity: \`${PIN_SELECTOR}\` not found in ${SHELL} — the pin has moved or been renamed.`)
  console.log('  Nothing was checked. Point this guard at the new selector rather than deleting it.')
  process.exit(1)
}

console.log(`dark-pin parity: ${r.root.size} :root token(s) · ${r.darkOverride.size} .dark entries · ${r.pinned.size} pinned · ${r.noop.length} resolve identically (no pin needed) · ${r.unresolvable.length} unresolvable (not compared) · ${r.missing.length} missing · ${r.drift.length} drifted · ${r.superseded.length} superseded by a later block`)
if (r.drift.length) {
  console.log(`\n  ❌ ${r.drift.length} pin(s) no longer resolve to the token's :root light value:\n`)
  for (const d of r.drift) console.log(`     ${d.token}\n        pin \`${d.raw}\` resolves to ${d.got}, but :root light is ${d.want}`)
  console.log('\n  A pin is a COPY of a value that lives in the token file. Copies drift, and a drifted')
  console.log('  pin is invisible to a presence check: the entry is there and neither value looks wrong.\n')
}
if (r.missing.length) {
  console.log(`\n  ❌ ${r.missing.length} token(s) change under .dark and are NOT pinned back on ${PIN_SELECTOR}:\n`)
  for (const m of r.missing) console.log(`     ${m.token}${m.alias ? '  (ALIAS — no .dark entry of its own; its target changes underneath it)' : ''}\n        light ${m.lightValue}   dark ${m.darkValue}`)
  console.log(`\n  A light-pinned console page will render these with their DARK values, while every`)
  console.log(`  neighbouring token stays light. That is a coherence failure, not a contrast one —`)
  console.log(`  each surface can pass AA on its own while the page as a whole is wrong.`)
  console.log(`  Add the :root value to the pin block in ${SHELL}.\n`)
  process.exit(1)
}
// 🔴 NAME the abstains, never just count them (DS1-33). "2 unresolvable" below a ✓ reads as
// housekeeping; the two names read as a boundary someone can check — and DS.2 did, confirming both
// are real font stacks (`--nds-font-mono` resolves to "JetBrains Mono", … ui-monospace) rather than
// broken tokens. Font families are theme-independent, so not comparing them is correct, not a gap.
if (r.unresolvable.length) {
  console.log(`  not compared (var() chain reaches outside these sheets): ${r.unresolvable.join(', ')}`)
}
// `superseded` is an ABSTAIN too — these pins are not drift-checked because a later block on the
// same element overrides them. Named, not counted, for the same reason as above (DS1-33).
if (r.superseded.length) {
  console.log(`  pinned but overridden by a later block on the same element, so not drift-checked: ${r.superseded.join(', ')}`)
}
console.log('✓ every token .dark changes is pinned back to its light value')
process.exit(r.drift.length ? 1 : 0)
