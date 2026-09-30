#!/usr/bin/env node
/**
 * Product sheet plan P3 item 4 (docs/product-sheet-editing/REPORT-2026-09-30.md §2) — every sheet column kind and every
 * custom cell editor has a key-ownership test.
 *
 * WHY
 * Both P0 sheet bugs of 2026-09-29 (Enter and Tab closed every list with its OLD value; the first typed key was lost)
 * shipped with 105 green tests: nothing pressed a key in the editors that broke. A new column kind or a new pop-up editor
 * arrives the same way — wired into a builder, never driven by a key.
 *
 * THE RULE
 * - An EDITOR is a component a sheet hands to AG Grid: `cellEditor: <Name>` or an editor spec's `component: <Name>`,
 *   whose name ends in `Editor` or `Gateway`, in apps/web/src/design-system/grid/ or apps/web/src/app/products/.
 *   AG's own editors (`'agNumberCellEditor'`, strings) are AG's and not counted.
 * - A COLUMN KIND is a member of an exported `SheetColumnKind` union under apps/web/src/app/products/.
 * - COVERED means: some `*.vitest.test.ts(x)` under apps/web/src names it — the editor as a word, the kind as
 *   `kind: '<kind>'` — AND presses a key in it (`'Enter'` or `'Tab'` as a string). A mention alone is not a test.
 * - Every editor and kind must be covered, except the gaps listed in BASELINE below: the state of 2026-09-30, each by
 *   name. The list only shrinks: a baseline entry that is now covered, or that no longer exists, FAILS until it is
 *   removed, so a gap cannot be closed and silently reopened. Never add an entry to pass; write the test.
 *
 *   node scripts/check-sheet-editor-coverage.mjs             report
 *   node scripts/check-sheet-editor-coverage.mjs --check     exit 1 on a violation (CI: scripts/ci/run-static-gates.mjs)
 *   node scripts/check-sheet-editor-coverage.mjs --self-test planted faults must be refused
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './lib/strip-comments.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EDITOR_ROOTS = ['apps/web/src/design-system/grid/', 'apps/web/src/app/products/']
const KIND_ROOT = 'apps/web/src/app/products/'
const TEST_ROOT = 'apps/web/src/'

/** The gaps of 2026-09-30, each named. Remove an entry in the commit that adds its test. */
export const BASELINE = {
  editors: [
    'ChannelCategoryEditor', // eBay / Amazon category — report 1a row 12: Amazon Enter wrote the wrong value
    'EbayPolicyEditor',
    'FormulaUnavailableEditor',
    'Gateway', // _studio/shopify/ShopifyDraftCell.tsx — the Shopify draft cell's editor
    'ImpactProtectorsEditor',
    'MeasureEditor', // findings B08, B22
    'MediaEditorGateway',
    'ReferenceSelectEditor',
    'SaleCellEditor',
    'SlotListEditor', // its test mounts it with eventKey 'a' only; Enter / Tab appear in the key-hint text, never pressed
    'StructuredAttributeEditor',
  ],
  kinds: ['boolean', 'date', 'text'],
}

const KEY_PRESS = /['"](Enter|Tab)['"]/

/** Pure: the inventory and the verdict, from file contents. Exported for the self-test. */
export function audit({ sources, kindSources, tests }, baseline = BASELINE) {
  const editors = new Map()
  for (const [file, text] of sources) {
    for (const m of stripComments(text).matchAll(/\b(?:cellEditor|component)\s*:\s*([A-Z][A-Za-z0-9]*)\b/g)) {
      if (/(Editor|Gateway)$/.test(m[1]) && !editors.has(m[1])) editors.set(m[1], file)
    }
  }
  const kinds = new Map()
  for (const [file, text] of kindSources) {
    const union = stripComments(text).match(/export\s+type\s+SheetColumnKind\s*=([^;\n]+(?:\n\s*\|[^;\n]+)*)/)
    if (!union) continue
    for (const m of union[1].matchAll(/'([A-Za-z]+)'/g)) if (!kinds.has(m[1])) kinds.set(m[1], file)
  }
  const keyTests = tests.filter(([, text]) => KEY_PRESS.test(text))
  const editorCovered = (name) => keyTests.some(([, text]) => new RegExp(`\\b${name}\\b`).test(text))
  const kindCovered = (kind) => keyTests.some(([, text]) => new RegExp(`kind:\\s*['"]${kind}['"]`).test(text))

  const problems = []
  const allowed = { editors: new Set(baseline.editors), kinds: new Set(baseline.kinds) }
  for (const [name, file] of editors) {
    const covered = editorCovered(name)
    if (!covered && !allowed.editors.has(name)) problems.push(`editor ${name} (${file}) has no key-ownership test: a *.vitest.test.ts that names it and presses 'Enter' or 'Tab'`)
    if (covered && allowed.editors.has(name)) problems.push(`editor ${name} is covered now — remove it from BASELINE.editors in scripts/check-sheet-editor-coverage.mjs`)
  }
  for (const [kind, file] of kinds) {
    const covered = kindCovered(kind)
    if (!covered && !allowed.kinds.has(kind)) problems.push(`column kind '${kind}' (${file}) has no editor test: a *.vitest.test.ts with kind: '${kind}' that presses 'Enter' or 'Tab'`)
    if (covered && allowed.kinds.has(kind)) problems.push(`column kind '${kind}' is covered now — remove it from BASELINE.kinds in scripts/check-sheet-editor-coverage.mjs`)
  }
  for (const name of allowed.editors) if (!editors.has(name)) problems.push(`BASELINE.editors names ${name}, which no sheet uses any more — remove it`)
  for (const kind of allowed.kinds) if (!kinds.has(kind)) problems.push(`BASELINE.kinds names '${kind}', which no SheetColumnKind has any more — remove it`)
  return { editors, kinds, problems, covered: { editors: [...editors.keys()].filter(editorCovered), kinds: [...kinds.keys()].filter(kindCovered) } }
}

function selfTest() {
  const src = [['a.tsx', `const def = { cellEditor: FooEditor, cellEditorPopup: true }; const spec = { component: BarEditor }; const ag = { cellEditor: 'agTextCellEditor' }; const r = { component: RowRenderer }`]]
  const kinds = [['types.ts', `export type SheetColumnKind = 'text' | 'number'`]]
  const good = [['x.vitest.test.ts', `FooEditor BarEditor kind: 'text' kind: 'number' press('Enter')`]]
  const base = { editors: [], kinds: [] }
  const failures = []
  const expectProblems = (label, input, baseline, want) => {
    const got = audit(input, baseline).problems
    if (want ? !got.some((p) => p.includes(want)) : got.length) failures.push(`${label}: ${want ? `expected a problem naming "${want}"` : 'expected none'}; got ${JSON.stringify(got)}`)
  }
  expectProblems('all covered', { sources: src, kindSources: kinds, tests: good }, base, null)
  expectProblems('a new editor without a test', { sources: [...src, ['b.tsx', 'x = { cellEditor: NewEditor }']], kindSources: kinds, tests: good }, base, 'editor NewEditor')
  expectProblems('a new kind without a test', { sources: src, kindSources: [['t.ts', `export type SheetColumnKind = 'text' | 'number' | 'colour'`]], tests: good }, base, `'colour'`)
  expectProblems('a mention without a key press is not a test', { sources: src, kindSources: kinds, tests: [['x.vitest.test.ts', `FooEditor BarEditor kind: 'text' kind: 'number'`]] }, base, 'editor FooEditor')
  expectProblems('a covered baseline entry must be removed', { sources: src, kindSources: kinds, tests: good }, { editors: ['FooEditor'], kinds: [] }, 'covered now')
  expectProblems('a baseline entry for nothing must be removed', { sources: src, kindSources: kinds, tests: good }, { editors: ['GoneEditor'], kinds: [] }, 'GoneEditor')
  expectProblems('a bare Gateway is an editor', { sources: [...src, ['g.tsx', 'x = { cellEditor: Gateway }']], kindSources: kinds, tests: good }, base, 'editor Gateway')
  expectProblems('an editor in a comment is not an editor', { sources: [['c.tsx', '// cellEditor: GhostEditor']], kindSources: kinds, tests: good }, base, null)
  if (failures.length) { for (const f of failures) console.error(`✗ ${f}`); process.exit(1) }
  console.log('✓ sheet editor coverage self-test: 8 planted cases judged as expected')
}

if (process.argv.includes('--self-test')) { selfTest(); process.exit(0) }

// The index plus untracked files: a guard that reads only `git ls-files` is blind to what a session just wrote.
const listed = (...patterns) => [...new Set([
  ...execFileSync('git', ['ls-files', ...patterns], { cwd: ROOT, encoding: 'utf8' }).split('\n'),
  ...execFileSync('git', ['ls-files', '--others', '--exclude-standard', ...patterns], { cwd: ROOT, encoding: 'utf8' }).split('\n'),
].filter(Boolean))]
const read = (files) => files.flatMap((f) => { try { return [[f, readFileSync(join(ROOT, f), 'utf8')]] } catch { return [] } })
const isTest = (f) => /\.(vitest\.)?test\.tsx?$/.test(f)

const sources = read(listed(...EDITOR_ROOTS.flatMap((r) => [`${r}**/*.ts`, `${r}**/*.tsx`])).filter((f) => !isTest(f)))
const kindSources = read(listed(`${KIND_ROOT}**/*.ts`, `${KIND_ROOT}**/*.tsx`).filter((f) => !isTest(f)))
const tests = read(listed(`${TEST_ROOT}**/*.vitest.test.ts`, `${TEST_ROOT}**/*.vitest.test.tsx`))
const result = audit({ sources, kindSources, tests })

if (result.editors.size === 0 || result.kinds.size === 0) {
  console.error('✗ sheet editor coverage: found no editors or no column kinds — the patterns no longer match the code; could not measure')
  process.exit(1)
}
console.log(`sheet editor coverage: ${result.covered.editors.length}/${result.editors.size} editors and ${result.covered.kinds.length}/${result.kinds.size} column kinds have a key test; baseline gaps ${BASELINE.editors.length} editors, ${BASELINE.kinds.length} kinds`)
if (result.problems.length) {
  for (const p of result.problems) console.error(`✗ ${p}`)
  if (process.argv.includes('--check')) process.exit(1)
} else {
  console.log('✓ no new editor or column kind without a key test')
}
