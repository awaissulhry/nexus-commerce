#!/usr/bin/env node
/** PR.6: a glow-only focus rule is not a visible perimeter. Checks both DS forks, including untracked CSS. */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import postcss from 'postcss'
import assert from 'node:assert/strict'

const roots = process.argv.filter(a => !a.startsWith('--')).slice(2)
if (!roots.length) roots.push('apps/web/src/design-system', 'apps/factory/src/design-system')
function sheets(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? sheets(resolve(root, e.name)) : e.name.endsWith('.css') ? [resolve(root, e.name)] : [])
}
function inspect(css, file) {
  const result = { focus: 0, conforming: 0, delegated: 0, failures: [] }
  postcss.parse(css, { from: file }).walkRules(rule => {
    if (!rule.selector.includes(':focus-visible')) return
    result.focus++
    const values = new Map((rule.nodes ?? []).filter(n => n.type === 'decl').map(n => [n.prop, n.value]))
    const outline = values.get('outline')
    if (outline && !/^(none|0(?:px)?)(?:\s|$)/.test(outline)) { result.conforming++; return }
    // These controls put the outline on the row overlay or surrounding Field, not the inner label/input.
    if (rule.selector.trim() === '.nds-prow-action:focus-visible' &&
      /\.nds-prow-action:focus-visible::after\s*\{[^}]*outline:\s*2px solid/.test(css)) { result.delegated++; return }
    if (rule.selector.trim() === '.nds-readable .nds-field > input:focus-visible') {
      const field = readFileSync(resolve(file, '../primitives.css'), 'utf8')
      if (/\.nds-field:focus-within\s*\{[^}]*outline:\s*2px solid/.test(field)) { result.delegated++; return }
    }
    // Additive reveal/colour rules do not replace the inherited focus perimeter.
    if (!outline && !values.get('box-shadow')?.includes('--nds-focus-ring')) return
    result.failures.push(`${file}:${rule.source.start.line} ${rule.selector} has no visible outline`)
  })
  return result
}
const bad = inspect('/* .ignored:focus-visible { outline: 2px solid blue } */ .control:focus-visible { outline: none; box-shadow: var(--nds-focus-ring) }', '<seed>')
const good = inspect('.control:focus-visible { outline: 2px solid var(--nds-primary); outline-offset: 1px }', '<control>')
assert.equal(bad.focus, 1); assert.equal(bad.failures.length, 1); assert.equal(good.conforming, 1); assert.equal(good.failures.length, 0)
const delegate = inspect('.nds-prow-action:focus-visible { outline:none } .nds-prow-action:focus-visible::after { outline:2px solid var(--nds-primary) }', '<delegate>')
assert.equal(delegate.delegated, 1); assert.equal(delegate.failures.length, 0)
console.log('focus-visible positive control: 1 glow-only seed caught, 1 outlined control accepted; comment excluded')
let focus = 0, conforming = 0, delegated = 0
const failures = []
const files = roots.flatMap(sheets)
assert.ok(files.length, 'no stylesheets measured')
for (const file of files) {
  const result = inspect(readFileSync(file, 'utf8'), file)
  focus += result.focus; conforming += result.conforming; delegated += result.delegated; failures.push(...result.failures)
}
assert.ok(focus && conforming, 'no live focus rules/outlined controls measured')
console.log(`focus-visible: ${files.length} stylesheets; ${focus} focus rules; ${conforming} real outlines; ${delegated} delegates; ${failures.length} glow-only failures`)
for (const failure of failures) console.error(failure)
process.exitCode = failures.length ? 1 : 0
