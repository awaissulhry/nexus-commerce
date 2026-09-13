#!/usr/bin/env node
/** PR.6: status fill tokens cannot be body ink. Border/background properties are graphical, not text. */
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
  const result = { colors: 0, textRoles: 0, failures: [] }
  postcss.parse(css, { from: file }).walkDecls('color', decl => {
    result.colors++
    if (/var\(--nds-(?:success|warning|danger)-text\)/.test(decl.value)) result.textRoles++
    if (!/var\(--nds-(?:success|warning|danger)\)/.test(decl.value)) return
    result.failures.push(`${file}:${decl.source.start.line} ${decl.parent.selector ?? ''}: ${decl.value} is a fill token used as text`)
  })
  return result
}
const control = inspect('.body { color: var(--nds-danger); border-color: var(--nds-danger) } .text { color: var(--nds-danger-text); background: var(--nds-warning) }', '<control>')
assert.equal(control.failures.length, 1); assert.equal(control.colors, 2); assert.equal(control.textRoles, 1)
console.log('token-role positive control: 1 seeded text misuse caught, 1 text-role accepted, border/background excluded')
const files = roots.flatMap(sheets)
assert.ok(files.length, 'no stylesheets measured')
let colors = 0, textRoles = 0
const failures = []
for (const file of files) {
  const result = inspect(readFileSync(file, 'utf8'), file)
  colors += result.colors; textRoles += result.textRoles; failures.push(...result.failures)
}
assert.ok(colors && textRoles, 'no live colors/text-role controls measured')
console.log(`token-role: ${files.length} stylesheets; ${colors} color declarations; ${textRoles} text-role controls; ${failures.length} text misuses`)
for (const failure of failures) console.error(failure)
process.exitCode = failures.length ? 1 : 0
