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
 * PR.6 correction: aria-disabled does not cancel a native disabled attribute. The former
 * unconditional exemption masked controls that still swallowed focus and events. Only a held
 * control with NO native disabled attribute is exempt now. Widened-root counts were recorded
 * before tightening this detector; the archived census makes the two effects distinguishable.
 *
 * RATCHET, not a gate: the pre-existing sites are named, not fixed, and the count may not grow.
 * Lower BASELINE whenever you clear some.
 */
import ts from 'typescript'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

process.chdir(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim())
const DEFAULT_ROOTS = {
  'apps/web/src/app/marketing/ads/rules-automation': 21,
  // First DS census under the original detector, 2026-09-13: 10 web / 8 Factory.
  // Frozen BEFORE tightening. New detector findings must be repaired, never re-baselined.
  'apps/web/src/design-system': 10,
  'apps/factory/src/design-system': 8,
}
const positional = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const roots = positional.length ? positional : Object.keys(DEFAULT_ROOTS)
const measure = process.argv.includes('--measure')
function filesIn(root) {
  assert.ok(existsSync(root), `scan root ${root} does not exist`)
  return readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? filesIn(resolve(root, e.name)) : e.name.endsWith('.tsx') ? [resolve(root, e.name)] : [])
}
function inspect(text, file) {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const hits = []
  function visit(n) {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const attrs = n.attributes.properties.filter(ts.isJsxAttribute).map(a => a.name.getText(src))
      if (attrs.includes('disabled') && attrs.includes('title')) {
        const { line } = src.getLineAndCharacterOfPosition(n.getStart(src))
        hits.push(`${relative(process.cwd(), file)}:${line + 1} <${n.tagName.getText(src)}>`)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(src)
  return hits
}
assert.equal(inspect('<button disabled title="Reason" />', '/seed.tsx').length, 1)
assert.equal(inspect('<button aria-disabled title="Reason" />', '/control.tsx').length, 0)
assert.equal(inspect('<button disabled aria-disabled title="Reason" />', '/masked-seed.tsx').length, 1)
console.log('silent-disabled positive control: native-disabled seed caught; held-only control accepted')
let failed = false
for (const root of roots) {
  const files = filesIn(root)
  assert.ok(files.length, `no .tsx files measured under ${root}`)
  const hits = files.flatMap(file => inspect(readFileSync(file, 'utf8'), file))
  const baseline = Number(process.env.SILENT_DISABLED_BASELINE ?? DEFAULT_ROOTS[root] ?? 0)
  console.log(`${root}: ${files.length} files; ${hits.length} sites; baseline ${baseline}${measure ? ' (measurement only)' : ''}`)
  for (const hit of hits) console.log(`  ${hit}`)
  if (hits.length > baseline) failed = true
}
process.exitCode = measure ? 0 : failed ? 1 : 0
