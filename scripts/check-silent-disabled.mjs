#!/usr/bin/env node
/**
 * U13 — a control that REFUSES must be able to say why.
 *
 * The defect this exists to stop, reported by the operator on 2026-08-19 as "the toggle button is
 * still not working":
 *
 *   A control carrying the `disabled` ATTRIBUTE cannot deliver an explanation. It takes no focus,
 *   so it is unreachable by keyboard; it takes no click; and Chrome does not render a `title`
 *   tooltip on one. So a `title` holding the reason for the refusal is written where nobody can
 *   read it.
 *
 *   Measured, coordinate-free, on the toggle this was found on:
 *     `b.disabled = true;  b.focus(); document.activeElement === b`  → false
 *     `b.disabled = false; b.focus(); document.activeElement === b`  → true   (held, aria-disabled)
 *   With the element merely held, a real Enter keypress produced the explanation and zero writes.
 *   (Do NOT try to measure this with mouse events from the Chrome harness — its coordinate clicks
 *   do not land and its `hover` is synthesized, so both report a meaningless zero.)
 *
 *   Every rule held below Auto by the graduation ceiling therefore refused in total silence — 14
 *   toggles across Bid / Keyword Harvest / Negative Targeting, and 14 notches on the Automations
 *   mode dial, which had been doing it since the dial shipped. The reason was written onto the one
 *   element in the DOM that cannot deliver it.
 *
 * WHAT THIS CHECKS. A JSX element with BOTH a `disabled` and a `title` attribute — parsed from the
 * TypeScript AST, never grepped, because a regex over source cannot tell an attribute from a
 * string that mentions one ([[reference_verification_probe_false_positives]]).
 *
 * THE ESCAPE, and it is a real fix rather than a pragma: also carry `aria-disabled`. That is the
 * shape the remedy takes —
 *
 *     disabled={busy}                     // transient, resolves itself, needs no explanation
 *     aria-disabled={held || busy}        // held: still live, so hover/click/focus can explain
 *     className={`… ${held ? 'held' : ''}`}
 *     onClick={() => { if (held) { explain(); return } write() }}
 *
 * — so an element that has thought about the distinction is exempt, and one that has not is
 * counted. `aria-disabled` alone (no `disabled`) is never flagged: it cannot swallow an event.
 *
 * RATCHET, not a gate: the pre-existing sites are named, not fixed, and the count may not grow.
 * Lower BASELINE whenever you clear some.
 */
import ts from 'typescript'
import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const ROOT = process.argv[2] ?? 'apps/web/src/app/marketing/ads/rules-automation'
/** Sites carrying `disabled` + `title` and no `aria-disabled`, measured 2026-08-19 after U13. */
const BASELINE = Number(process.env.SILENT_DISABLED_BASELINE ?? 27)

// Run from the repo root whatever the caller's cwd, and REFUSE to scan nothing: a ratchet that
// silently finds 0 files reports "✓" forever and is worse than no check at all.
process.chdir(execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim())
if (!existsSync(ROOT)) {
  console.error(`❌ silent-disabled: scan root ${ROOT} does not exist — the check would pass vacuously.`)
  process.exit(1)
}
const files = execSync(`find ${ROOT} -name '*.tsx'`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
if (files.length === 0) {
  console.error(`❌ silent-disabled: no .tsx found under ${ROOT} — the check would pass vacuously.`)
  process.exit(1)
}

const hits = []
for (const f of files) {
  const src = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const visit = (n) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const attrs = n.attributes.properties.filter(ts.isJsxAttribute).map((a) => a.name.getText())
      if (attrs.includes('disabled') && attrs.includes('title') && !attrs.includes('aria-disabled')) {
        const { line } = src.getLineAndCharacterOfPosition(n.getStart())
        hits.push(`${f}:${line + 1}  <${n.tagName.getText()}>`)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(src)
}

const n = hits.length
if (n > BASELINE) {
  console.error(`\n❌ silent-disabled ratchet: ${BASELINE} → ${n} — a control was given a reason it cannot deliver.`)
  console.error('   A `title` on a `disabled` element is never shown, and the element takes no focus and no click.')
  console.error('   Use `aria-disabled` + a held class and answer the click, or drop the title. Sites:\n')
  for (const h of hits) console.error(`   ${h}`)
  console.error('')
  process.exit(1)
}
if (n < BASELINE) {
  console.log(`✓ silent-disabled: ${n} site(s) — below the ${BASELINE} baseline. Lower BASELINE in this script to hold the ground.`)
} else {
  console.log(`✓ silent-disabled: ${n} site(s), at the ${BASELINE} baseline.`)
}
