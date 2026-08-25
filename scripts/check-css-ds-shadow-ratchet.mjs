#!/usr/bin/env node
/**
 * DS-shadow ratchet — the selectors that beat the design system without meaning to.
 *
 * A page rule whose last compound is a BARE element the DS also renders shadows the primitive:
 *
 *     .h10-aig-field input      (0,2,1)   beats   .nds-field > input   (0,1,1)
 *     .az-pager select          (0,1,1)   ties it, and app CSS loads second
 *
 * Measured 2026-08-25: **202 such rules in ads.css and 95 in amazon.css — 291 across 158 wrapper
 * classes.** Every one is a place where dropping in an `<Input>`/`<Button>`/`<Select>` renders
 * something that is design-system markup and page-stylesheet pixels. For a WRAPPED control
 * (`Input`, `Select`, `Textarea`) the tell is a box inside a box: `borderTopWidth: 1px` on both
 * the `.nds-field` and its inner `<input>`.
 *
 * This is why it is a ratchet and not a ban: 291 rules cannot be fixed in one change, and until
 * they are, each one silently caps the DS alignment programme. Freezing the count stops the
 * bucket filling while it is being emptied.
 *
 * ── The two fixes, because they are not the same fix ────────────────────────────────────────
 *
 * For a control the DS WRAPS — `Input` (`.nds-field > input`), `Select` (`.nds-select select`),
 * `Textarea` — use the child combinator:
 *
 *     .h10-aig-field input   →   .h10-aig-field > input
 *
 * Today's raw `<input>` is a direct child so nothing renders differently; the DS input is a
 * GRANDCHILD, so the rule stops matching the moment it converts. Verify per site that every
 * current match really is a direct child — `>` can only remove matches, and getting it wrong
 * silently unstyles a control.
 *
 * 🔴 It does NOT work for buttons. `Button` and `ToolbarButton` render a bare `<button>` in the
 * same position the raw one occupied, so `.az-pager .nav > button` still matches. Those need
 * class exclusion: `button:not(.nds-btn):not(.nds-tbtn)`.
 *
 * Best of all, check the call sites first — a wrapper with none can simply be deleted. 89 rules
 * went that way on 2026-08-25. Four checks were needed to trust that census, and the last two
 * caught 9 false positives between them: a plain-substring scan (a delimiter-bounded grep misses
 * `.h10-am-fpanel`, which is in 9 files), a dynamic-composition scan (`` `h10-spw-${…}` `` can
 * build a class no grep will find), and a compound-anchor check — `.h10-menu.adjbud` is written
 * `className="h10-menu adjbud"`, so no substring test for `h10-menu.adjbud` can see it, and it
 * is live.
 *
 *   node scripts/check-css-ds-shadow-ratchet.mjs            # census
 *   node scripts/check-css-ds-shadow-ratchet.mjs --baseline # write scripts/css-ds-shadow-baseline.json
 *   node scripts/check-css-ds-shadow-ratchet.mjs --check    # non-zero exit if any file rose
 *
 * KNOWN LIMIT, stated rather than hidden: this counts SELECTORS, not confirmed collisions. A
 * shadowing rule only bites where a DS component is actually nested inside that wrapper, which
 * needs the DOM to confirm — `document.querySelectorAll('.h10-cd-field .nds-field').length`, any
 * hit is a double border. The selector count is the right thing to freeze because it is the
 * hazard surface; proving each one live is a separate, per-page job.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execSync } from 'node:child_process'
import postcss from 'postcss'

const ROOT = new URL('..', import.meta.url).pathname
const SCAN = join(ROOT, 'apps/web/src/app')
const BASELINE = join(ROOT, 'scripts/css-ds-shadow-baseline.json')

/** Elements the design system renders itself, and therefore must not be styled past. */
const DS_ELEMENTS = new Set(['input', 'select', 'button', 'textarea'])

let tracked = new Set()
try {
  tracked = new Set(execSync('git ls-files "apps/web/src/app/**/*.css"', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean))
} catch { /* not a git tree — scan everything */ }

function* walk(dir) {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (p.endsWith('.css')) yield p
  }
}

/**
 * Selectors that end in a bare DS element inside a descendant/child chain.
 *
 * Parsed with postcss, never regexed over the raw file. A comment reading
 * `specificity (0,2,1) vs (0,1,1)` looks exactly like a selector list to a regex, and rewriting
 * on that basis corrupted ads.css once already — the fragments `(0,` and `2,` were emitted as
 * selectors and the malformedness check missed it, because that check ran on comment-stripped
 * text and was blind to the damage.
 */
function shadowing(css) {
  const out = []
  let root
  try { root = postcss.parse(css) } catch { return out }
  root.walkRules((rule) => {
    if (rule.parent?.type === 'atrule' && /^(keyframes|font-face)/.test(rule.parent.name)) return
    for (const sel of rule.selectors) {
      // keep the combinators — whether the last one is `>` decides the verdict for wrapped controls
      const tokens = sel.trim().split(/\s*([>+~])\s*|\s+/).filter(Boolean)
      if (tokens.length < 2) continue
      const last = tokens[tokens.length - 1]
      const combinator = tokens[tokens.length - 2]
      const base = last.replace(/(::?[a-z-]+(\([^)]*\))?|\[[^\]]*\])+$/gi, '')
      if (!DS_ELEMENTS.has(base)) continue

      // A `:not(.nds-*)` exclusion is the fix for BOTH kinds — the rule can no longer reach a
      // design-system control.
      if (/:not\([^)]*\.nds-/.test(last)) continue

      // For a control the DS WRAPS, `>` IS the fix: the DS input is a grandchild of the wrapper,
      // so a child combinator can no longer reach it. Not counted.
      if (combinator === '>' && base !== 'button') continue

      // `>` is NOT a fix for buttons — the DS renders a bare <button> in the same position — so
      // `.x > button` still counts.
      out.push(sel)
    }
  })
  return out
}

const counts = {}
for (const p of walk(SCAN)) {
  const rel = relative(ROOT, p)
  if (tracked.size && !tracked.has(rel)) continue
  const n = shadowing(readFileSync(p, 'utf8')).length
  if (n) counts[relative(join(ROOT, 'apps/web/src'), p)] = n
}
const total = Object.values(counts).reduce((a, b) => a + b, 0)
const mode = process.argv[2] ?? '--census'

if (mode === '--baseline') {
  writeFileSync(BASELINE, JSON.stringify({
    note: 'Selectors ending in a bare input/select/button/textarea inside a descendant chain — they shadow the DS primitive. This may only FALL. A file absent here is held at zero. See the script header for the two fixes and why they differ.',
    updatedAt: new Date().toISOString().slice(0, 10),
    total, files: counts,
  }, null, 2) + '\n')
  console.log(`baseline written: ${Object.keys(counts).length} files, ${total} shadowing selectors`)
  process.exit(0)
}

if (mode === '--census') {
  console.log(`${Object.keys(counts).length} stylesheet(s) carry ${total} selector(s) that shadow a DS primitive\n`)
  for (const [f, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(n).padStart(5)}  ${f}`)
  }
  process.exit(0)
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
const risen = Object.entries(counts).filter(([f, n]) => n > (base.files[f] ?? 0))
if (risen.length) {
  console.error(`❌ DS-shadow ratchet: ${risen.length} stylesheet(s) gained selectors that beat the design system:`)
  for (const [f, n] of risen) {
    const was = base.files[f] ?? 0
    console.error(`   ${f}: ${was} → ${n}`)
    if (!was) console.error('     New stylesheet — never style a bare input/select/button/textarea through a descendant selector.')
  }
  console.error('\n   Wrapped controls (Input/Select/Textarea): use `>` so the rule stops at the DS wrapper.')
  console.error('   Buttons: the DS renders a bare <button>, so `>` cannot help — use :not(.nds-btn):not(.nds-tbtn).')
  process.exit(1)
}
console.log(`✓ DS-shadow ratchet: ${total} shadowing selector(s) (baseline ${base.total}) — no stylesheet rose`)
