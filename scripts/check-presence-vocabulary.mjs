#!/usr/bin/env node
/** PR.7: listing prose only, with an exact-text ratchet and built-in positive controls. */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const scope = 'apps/web/src/app/products/[id]/edit/_studio'
const baselinePath = join(root, 'scripts/presence-vocabulary-baseline.json')
const banned = /\b(?:live|delist|unlist|unpublish|deactivate|archive|retire|take down|resolve|preflight|soft-delete|remove)\b/gi
const displayKeys = new Set(['label', 'title', 'description', 'hint', 'sentence', 'message', 'reason', 'unavailable', 'consequences', 'sideEffects', 'subtitle', 'aria-label', 'placeholder', 'emptyState'])
const findings = []
function scanText(file, line, value) {
  for (const match of value.matchAll(banned)) findings.push({ file, line, word: match[0].toLowerCase(), text: value.trim().replace(/\s+/g, ' ') })
}
function prose(node) {
  let current = node
  while (current.parent) {
    const p = current.parent
    if (ts.isJsxExpression(p) || ts.isJsxAttribute(p)) return true
    if (ts.isPropertyAssignment(p)) return displayKeys.has(p.name.getText().replace(/['"]/g, ''))
    if (ts.isBinaryExpression(p) || ts.isCaseClause(p) || ts.isImportDeclaration(p) || ts.isLiteralTypeNode(p)) return false
    if (ts.isCallExpression(p)) {
      return /(?:toast|alert|confirm|Error|setError|refused|message)$/i.test(p.expression.getText())
    }
    if (ts.isFunctionLike(p)) return !!p.name && /(?:label|hint|sentence|copy|note|reason|message)/i.test(p.name.getText())
    current = p
  }
  return false
}
function scanSource(file, content) {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const visit = node => {
    if (ts.isJsxText(node)) scanText(file, source.getLineAndCharacterOfPosition(node.pos).line + 1, node.text)
    else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && prose(node)) {
      scanText(file, source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (/\.tsx?$/.test(entry.name) && !/\.(?:d|test|spec|vitest\.test)\.tsx?$/.test(entry.name)) scanSource(relative(root, path), readFileSync(path, 'utf8'))
  }
}
// A scanner that finds no data comparisons but catches actual JSX/prose must prove both arms.
scanSource('positive-control.tsx', `const state = 'LIVE'; const x = <span title="Live listing">Deactivate listing</span>; const meta = { label: 'Unpublish' };`)
if (findings.length !== 3) throw new Error(`Vocabulary positive control expected 3 prose findings, got ${findings.length}`)
findings.length = 0
walk(join(root, scope))
// No flat-file editor is inside this scope; its typed 'deactivate' enum remains data, untouched.
const prefixes = ['products.hardDelete.', 'listings.', 'studio.', 'products.listing.', 'products.lifecycle.']
for (const locale of ['en', 'it']) {
  const file = `apps/web/src/lib/i18n/messages/${locale}.json`
  for (const [key, value] of Object.entries(JSON.parse(readFileSync(join(root, file), 'utf8')))) {
    if (prefixes.some(prefix => key.startsWith(prefix)) && typeof value === 'string') scanText(`${file}#${key}`, 1, value)
  }
}
const keyOf = f => JSON.stringify([f.file, f.word, f.text])
const counts = new Map()
for (const f of findings) counts.set(keyOf(f), (counts.get(keyOf(f)) ?? 0) + 1)
if (process.argv.includes('--record-initial-baseline')) {
  if (existsSync(baselinePath)) throw new Error('Baseline already exists. This command cannot raise the ratchet.')
  writeFileSync(baselinePath, JSON.stringify({ description: 'Initial measured prose cohort; delete entries as corrected, never add a new allowance.', entries: Object.fromEntries(counts) }, null, 2) + '\n')
}
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')).entries : {}
const unexpected = findings.filter(f => (counts.get(keyOf(f)) ?? 0) > (baseline[keyOf(f)] ?? 0))
const errors = []
// Derive every union from the sole DS authority, never a second enumerated list.
const authority = join(root, 'apps/web/src/design-system/grid/renderers/presence.ts')
const ds = ts.createSourceFile(authority, readFileSync(authority, 'utf8'), ts.ScriptTarget.Latest, true)
for (const name of ['PresenceIntent', 'ChannelFact', 'PresenceVerdict']) {
  const declaration = ds.statements.find(n => ts.isTypeAliasDeclaration(n) && n.name.text === name)
  const members = declaration && ts.isUnionTypeNode(declaration.type) ? declaration.type.types.filter(ts.isLiteralTypeNode).map(n => n.literal.getText(ds)) : []
  if (members.length < 2) errors.push(`Cannot derive ${name} members from the DS authority`)
  else console.log(`${name}: ${members.length} members from DS source`)
}
const meta = join(root, scope, 'presence/meta.ts')
if (!existsSync(meta)) errors.push('Studio presence/meta.ts has not landed with its wire consumers')
for (const file of ['sheet/master/useMasterSheetAdapter.tsx', 'sheet/channel/useChannelSheetAdapter.tsx', 'drawer/panes/ListingsPane.tsx', 'sheet/SheetFooterNote.tsx']) {
  const source = readFileSync(join(root, scope, file), 'utf8')
  if (!/from\s+['"][^'"]*presence\/meta['"]/.test(source)) errors.push(`${file} does not consume the canonical presence meta`)
}
const projection = readFileSync(join(root, 'apps/api/src/services/pim/family-projection.service.ts'), 'utf8')
if ((projection.match(/excludedReason\(/g) ?? []).length < 3) errors.push('Both excluded-variant producer sites must call excludedReason')
if (process.argv.includes('--seed-red')) errors.push('Seeded banned label: Live listing (positive scanner control above)')
console.log(`Presence vocabulary: ${findings.length} findings in the ratchet; ${unexpected.length} new, ${errors.length} contract failures; controls 3/3`)
for (const f of unexpected) console.log(`${f.file}:${f.line}: ${f.word}: ${f.text}`)
for (const error of errors) console.log(`ERROR: ${error}`)
process.exitCode = unexpected.length || errors.length ? 1 : 0
