#!/usr/bin/env node
/**
 * P3 guardrail 3 (2026-09-30) — a cell editor or column kind the product sheet can mount must be NAMED by a test that
 * commits through it.
 *
 * THE STORY. On 2026-09-29 the Owner could not choose a value in the sheet: Enter and Tab closed every list with its OLD
 * value, the chevron did nothing, the first typed key was lost, an open list refused a typed value (issues #25, #27, #28).
 * 105 tests covered that path and all were green: they called a panel's `onCommit` themselves or checked that a function
 * existed. No test pressed a key in a real editor until a value was saved, and nothing noticed when a builder started
 * mounting an editor no test had ever driven.
 *
 * THE RULE. Parsed from the TypeScript AST, never grepped:
 *   R1  every editor the sheet's column builders can mount (`cellEditor:` / `component:` in the builders and the engine
 *       factories they spread) has a case in the Enter/Tab node test (`CASES` in sheetEditorKeys.vitest.test.ts);
 *   R2  … and a driver in the browser commit sweep (`DRIVERS` in apps/web/smoke/sheet/drivers.ts) with a keyboard, a
 *       mouse and a paste arm — each a gesture or `{ na: '<reason>' }` — or a written `abstain` reason;
 *   R3  every studio `SheetColumnKind` is served by some driver's `kinds` (a driver that abstains serves nothing), and has
 *       an open mode in `EDITOR_MODE_BY_KIND`;
 *   R4  the studio's web copies of `SheetColumnKind` equal the API's union;
 *   R5  the sweep's `NETWORK_STUBS` (reads it answers itself) may not grow;
 *   R6  the sweep's `KNOWN_DEFECTS` (found, not fixed yet) may not grow.
 *   R7  an already driven editor/gesture may not be replaced with an abstention.
 *
 * RATCHET: `scripts/sheet-editor-coverage-baseline.json` names the gaps that existed when this landed. They may only go:
 * a gap not in the baseline fails; `--write` refuses to add one and only drops the ones that closed.
 * `SHEET_EDITOR_COVERAGE_BASELINE=<path>` reads another baseline (as SILENT_DISABLED_BASELINE / BUTTON_VOCAB_BASELINE do).
 *
 *   node scripts/check-sheet-editor-coverage.mjs             # list every editor, kind and gap
 *   node scripts/check-sheet-editor-coverage.mjs --check     # exit 1 on a gap the baseline does not name (CI)
 *   node scripts/check-sheet-editor-coverage.mjs --write     # shrink the baseline to today's gaps (never grows it)
 *   node scripts/check-sheet-editor-coverage.mjs --self-test # the rules catch what they claim to
 */
import ts from 'typescript'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const STUDIO = 'apps/web/src/app/products/[id]/edit/_studio'
const BUILDERS = [
  `${STUDIO}/sheet/master/channelColumns.tsx`,
  `${STUDIO}/sheet/master/columns.tsx`,
  `${STUDIO}/media/productMediaColumn.tsx`,
  `${STUDIO}/shopify/ShopifyDraftCell.tsx`,
  'apps/web/src/design-system/grid/editors/shapeColumn.ts',
  'apps/web/src/design-system/grid/editors/slotListColumn.ts',
  'apps/web/src/design-system/grid/editors/SelectCellEditor.tsx',
  'apps/web/src/design-system/grid/editors/sheet.ts',
  'apps/web/src/design-system/grid/editors/FormulaCellEditor.tsx',
]
/** Components a builder names that are not editors of their own: they wrap the editor that holds the value. */
const WRAPPERS = { FormulaAwareEditor: 'wraps the column\'s own editor to catch a typed `=`; the editor inside is the one tested' }
const UNIT_TEST = `${STUDIO}/sheet/sheetEditorKeys.vitest.test.ts`
const SWEEP = 'apps/web/smoke/sheet/drivers.ts'
const OPEN_GESTURE = 'apps/web/src/design-system/grid/editors/openGesture.ts'
const API_KINDS = 'apps/api/src/services/pim/sheet-columns.service.ts'
const WEB_KINDS = [`${STUDIO}/sheet/master/types.ts`, `${STUDIO}/sheet/channel/types.ts`, `${STUDIO}/drawer/types.ts`]
const BASELINE = process.env.SHEET_EDITOR_COVERAGE_BASELINE ?? join(ROOT, 'scripts/sheet-editor-coverage-baseline.json')

/* ── the AST readers ──────────────────────────────────────────────────────────────────────────────────────── */

const parse = (text, file) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
const unwrap = (n) => { while (n && (ts.isAsExpression(n) || ts.isParenthesizedExpression(n) || ts.isSatisfiesExpression?.(n) || ts.isNonNullExpression(n))) n = n.expression; return n }
const nameOf = (n) => (ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : ts.isComputedPropertyName(n) && ts.isStringLiteral(n.expression) ? n.expression.text : null)

/** Editor ids a builder can mount: the value of every `cellEditor:` or `component:` that names one. */
export function editorsIn(text, file) {
  const found = new Set()
  const visit = (n) => {
    if (ts.isPropertyAssignment(n) && ['cellEditor', 'component'].includes(nameOf(n.name) ?? '')) {
      const value = unwrap(n.initializer)
      if (ts.isIdentifier(value) && value.text !== 'undefined') found.add(value.text)
      else if (ts.isStringLiteral(value) && /^ag[A-Z]\w*CellEditor$/.test(value.text)) found.add(value.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(parse(text, file))
  return found
}

/** The object literal assigned to `const <name>` (optionally typed / exported). */
function objectLiteral(text, file, name) {
  let out = null
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      const value = unwrap(n.initializer)
      if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value)) out = value
    }
    if (!out) ts.forEachChild(n, visit)
  }
  visit(parse(text, file))
  return out
}

/** `CASES` keys of the node test. */
export function unitCases(text, file = 'unit.ts') {
  const object = objectLiteral(text, file, 'CASES')
  if (!object) throw new Error(`${file}: no \`const CASES = { … }\``)
  return new Set(object.properties.map((p) => p.name && nameOf(p.name)).filter(Boolean))
}

/** `DRIVERS` of the sweep: per editor, which arms are gestures or reasons, whether it abstains, and its kinds. */
export function sweepDrivers(text, file = 'drivers.ts') {
  const object = objectLiteral(text, file, 'DRIVERS')
  if (!object) throw new Error(`${file}: no \`const DRIVERS = { … }\``)
  const drivers = new Map()
  for (const p of object.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isObjectLiteralExpression(unwrap(p.initializer))) continue
    const fields = new Map(unwrap(p.initializer).properties.filter(ts.isPropertyAssignment).map((f) => [nameOf(f.name), unwrap(f.initializer)]))
    const arm = (key) => {
      const v = fields.get(key)
      if (!v) return 'missing'
      if (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) return 'gesture'
      if (ts.isObjectLiteralExpression(v)) {
        const na = v.properties.find((q) => ts.isPropertyAssignment(q) && nameOf(q.name) === 'na')
        return na && ts.isStringLiteralLike(unwrap(na.initializer)) && unwrap(na.initializer).text.trim() ? 'reason' : 'missing'
      }
      return 'missing'
    }
    const abstain = fields.get('abstain')
    const kinds = fields.get('kinds')
    drivers.set(nameOf(p.name), {
      keyboard: arm('keyboard'), mouse: arm('mouse'), paste: arm('paste'),
      abstain: abstain && ts.isStringLiteralLike(abstain) && abstain.text.trim() ? abstain.text : null,
      kinds: kinds && ts.isArrayLiteralExpression(kinds) ? kinds.elements.filter(ts.isStringLiteralLike).map((e) => e.text) : [],
    })
  }
  return drivers
}

/** Entries of an array constant (`NETWORK_STUBS`, `KNOWN_DEFECTS`). */
export function listLength(text, file, name) {
  const list = objectLiteral(text, file, name)
  if (!list || !ts.isArrayLiteralExpression(list)) throw new Error(`${file}: no \`const ${name} = [ … ]\``)
  return list.elements.length
}
export const networkStubCount = (text, file = 'drivers.ts') => listLength(text, file, 'NETWORK_STUBS')

/** Members of `type SheetColumnKind = 'a' | 'b' …`. */
export function kindUnion(text, file) {
  let members = null
  const visit = (n) => {
    if (ts.isTypeAliasDeclaration(n) && n.name.text === 'SheetColumnKind' && ts.isUnionTypeNode(n.type)) {
      members = n.type.types.filter(ts.isLiteralTypeNode).map((t) => t.literal.text)
    }
    if (!members) ts.forEachChild(n, visit)
  }
  visit(parse(text, file))
  if (!members) throw new Error(`${file}: no \`type SheetColumnKind = … | …\``)
  return members
}

export function modeKinds(text, file) {
  const object = objectLiteral(text, file, 'EDITOR_MODE_BY_KIND')
  if (!object) throw new Error(`${file}: no \`const EDITOR_MODE_BY_KIND = { … }\``)
  return new Set(object.properties.map((p) => p.name && nameOf(p.name)).filter(Boolean))
}

/* ── the rules ────────────────────────────────────────────────────────────────────────────────────────────── */

/** Every gap, as a stable string. `sources` maps a path to its text (the real files, or a self-test's). */
export function gaps(sources) {
  const read = (file) => { if (!(file in sources)) throw new Error(`missing source: ${file}`); return sources[file] }
  const editors = new Map()
  for (const file of BUILDERS) for (const id of editorsIn(read(file), file)) if (!(id in WRAPPERS)) editors.set(id, [...(editors.get(id) ?? []), file])
  const cases = unitCases(read(UNIT_TEST), UNIT_TEST)
  const drivers = sweepDrivers(read(SWEEP), SWEEP)
  const out = []
  for (const id of [...editors.keys()].sort()) {
    if (!cases.has(id)) out.push(`R1 editor ${id}: no Enter/Tab case in ${UNIT_TEST}`)
    const d = drivers.get(id)
    if (!d) { out.push(`R2 editor ${id}: no driver in ${SWEEP}`); continue }
    if (!d.abstain) for (const arm of ['keyboard', 'mouse', 'paste']) if (d[arm] === 'missing') out.push(`R2 editor ${id}: the ${arm} arm is neither a gesture nor { na: '<reason>' }`)
  }
  const apiKinds = kindUnion(read(API_KINDS), API_KINDS)
  // A kind served only by an abstaining driver is not swept.
  const served = new Set([...drivers.values()].filter((d) => !d.abstain).flatMap((d) => d.kinds))
  const modes = modeKinds(read(OPEN_GESTURE), OPEN_GESTURE)
  for (const kind of apiKinds) {
    if (!served.has(kind)) out.push(`R3 kind ${kind}: no driver serves it`)
    if (!modes.has(kind)) out.push(`R3 kind ${kind}: no open mode in EDITOR_MODE_BY_KIND`)
  }
  for (const file of WEB_KINDS) {
    const web = kindUnion(read(file), file)
    const missing = apiKinds.filter((k) => !web.includes(k))
    const extra = web.filter((k) => !apiKinds.includes(k))
    if (missing.length || extra.length) out.push(`R4 ${file}: SheetColumnKind differs from the API (${[...missing.map((k) => `-${k}`), ...extra.map((k) => `+${k}`)].join(' ')})`)
  }
  const abstentions = [...drivers].flatMap(([id, driver]) => driver.abstain ? [`${id}: all gestures`]
    : ['keyboard', 'mouse', 'paste'].filter(arm => driver[arm] === 'reason').map(arm => `${id}: ${arm}`)).sort()
  return { gaps: out, abstentions, editors, cases, drivers, stubs: networkStubCount(read(SWEEP), SWEEP), known: listLength(read(SWEEP), SWEEP, 'KNOWN_DEFECTS'), kinds: apiKinds }
}

/* ── self-test: a check that cannot fail is not passing ───────────────────────────────────────────────────── */

function selfTest() {
  const real = Object.fromEntries([...BUILDERS, UNIT_TEST, SWEEP, OPEN_GESTURE, API_KINDS, ...WEB_KINDS].map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]))
  const base = gaps(real).gaps
  const expectNew = (label, mutate, pattern) => {
    const sources = { ...real }
    mutate(sources)
    const found = gaps(sources).gaps.filter((g) => !base.includes(g))
    if (!found.some((g) => pattern.test(g))) { console.error(`✗ self-test: ${label} was not caught (new gaps: ${JSON.stringify(found)})`); process.exit(1) }
  }
  // A builder mounts an editor nobody tests → R1 and R2.
  expectNew('a new editor in a builder', (s) => { s[BUILDERS[0]] += '\nconst x = { cellEditor: BrandNewEditor }\n' }, /R1 editor BrandNewEditor/)
  expectNew('a new editor without a driver', (s) => { s[BUILDERS[0]] += '\nconst y = { component: BrandNewEditor as never }\n' }, /R2 editor BrandNewEditor: no driver/)
  // A driver that drops its paste arm without a reason → R2.
  expectNew('an arm with no gesture and no reason', (s) => { s[SWEEP] = s[SWEEP].replace(/(SelectPanelEditor: \{[\s\S]*?)paste: async/, '$1paste: { na: "" }, _paste: async') }, /R2 editor SelectPanelEditor: the paste arm/)
  // A kind the API adds → R3 (no driver, no mode) and R4 (the web copies lag).
  expectNew('a new API kind', (s) => { s[API_KINDS] = s[API_KINDS].replace("export type SheetColumnKind = 'text'", "export type SheetColumnKind = 'rating' | 'text'") }, /R4 .*-rating/)
  expectNew('a kind no driver serves', (s) => { s[API_KINDS] = s[API_KINDS].replace("export type SheetColumnKind = 'text'", "export type SheetColumnKind = 'rating' | 'text'") }, /R3 kind rating: no driver/)
  // A covered editor passes: the real sources have no R1/R2 gap for SelectPanelEditor.
  if (base.some((g) => /editor SelectPanelEditor/.test(g))) { console.error('✗ self-test: a covered editor (SelectPanelEditor) was flagged'); process.exit(1) }
  // R5: one more stub is caught against the baseline.
  const stubs = networkStubCount(real[SWEEP], SWEEP)
  const more = networkStubCount(real[SWEEP].replace('export const NETWORK_STUBS = [', "export const NETWORK_STUBS = [{ url: /x/, body: {} },"), SWEEP)
  if (more !== stubs + 1) { console.error('✗ self-test: an added network stub was not counted'); process.exit(1) }
  // R6: one more known defect is counted.
  const known = listLength(real[SWEEP], SWEEP, 'KNOWN_DEFECTS')
  const moreKnown = listLength(real[SWEEP].replace(/(export const KNOWN_DEFECTS[^=]*= \[)/, "$1{ editors: [], path: 'paste', reason: 'x' },"), SWEEP, 'KNOWN_DEFECTS')
  if (moreKnown !== known + 1) { console.error('✗ self-test: an added known defect was not counted'); process.exit(1) }
  const abstaining = { ...real, [SWEEP]: real[SWEEP].replace('SelectPanelEditor: {', "SelectPanelEditor: { abstain: 'No longer tested',") }
  if (!gaps(abstaining).abstentions.includes('SelectPanelEditor: all gestures') || gaps(real).abstentions.includes('SelectPanelEditor: all gestures')) {
    console.error('✗ self-test: replacing a driven editor with an abstention was not detected'); process.exit(1)
  }
  console.log(`✓ sheet editor coverage self-test: new editor (R1, R2), missing arm (R2), new kind (R3, R4), an added stub (R5), an added known defect (R6), and a new abstention (R7) caught; a covered editor passes`)
}

if (process.argv.includes('--self-test')) { selfTest(); process.exit(0) }

/* ── the run ──────────────────────────────────────────────────────────────────────────────────────────────── */

const files = [...BUILDERS, UNIT_TEST, SWEEP, OPEN_GESTURE, API_KINDS, ...WEB_KINDS]
for (const f of files) if (!existsSync(join(ROOT, f))) { console.error(`✗ sheet editor coverage: ${f} is missing — a moved file must be moved here too`); process.exit(1) }
const result = gaps(Object.fromEntries(files.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')])))
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null
const allowed = new Set(baseline?.gaps ?? [])
const fresh = result.gaps.filter((g) => !allowed.has(g))
const closed = [...allowed].filter((g) => !result.gaps.includes(g))
const stubsRose = baseline && result.stubs > baseline.networkStubs
const knownRose = baseline && result.known > (baseline.knownDefects ?? 0)
const newAbstentions = result.abstentions.filter(item => !(baseline?.abstentions ?? []).includes(item))

console.log(`sheet editors: ${[...result.editors.keys()].sort().join(', ')}`)
console.log(`  (wrappers, not editors: ${Object.keys(WRAPPERS).join(', ')})`)
console.log(`node test cases: ${result.cases.size} · sweep drivers: ${result.drivers.size} · kinds: ${result.kinds.join(', ')} · network stubs: ${result.stubs} · known defects: ${result.known} · abstentions: ${result.abstentions.length}`)
for (const g of result.gaps) console.log(`  ${allowed.has(g) ? '· (baseline)' : '✗'} ${g}`)
for (const g of closed) console.log(`  ↓ closed — drop it from the baseline: ${g}`)

if (process.argv.includes('--write')) {
  // The first --write records the gaps that existed when the rule landed; every later one may only drop gaps.
  if (baseline && fresh.length) { console.error(`✗ --write refuses to add a gap; cover it instead:\n  ${fresh.join('\n  ')}`); process.exit(1) }
  if (baseline && newAbstentions.length) { console.error(`✗ --write refuses new abstentions: ${newAbstentions.join(", ")}`); process.exit(1) }
  if (knownRose || stubsRose) { console.error('✗ --write refuses to raise the network stubs or the known defects'); process.exit(1) }
  const stubs = baseline ? Math.min(baseline.networkStubs, result.stubs) : result.stubs
  const known = baseline ? Math.min(baseline.knownDefects ?? 0, result.known) : result.known
  writeFileSync(BASELINE, JSON.stringify({
    note: 'P3 guardrail 3 — sheet editors and kinds no test drives. Entries may only be REMOVED (cover the gap); networkStubs and knownDefects may only go down.',
    updatedAt: new Date().toISOString().slice(0, 10), networkStubs: stubs, knownDefects: known, abstentions: result.abstentions, gaps: result.gaps.filter((g) => allowed.has(g) || !baseline),
  }, null, 2) + '\n')
  console.log(`✓ baseline written: ${result.gaps.length} gap(s), ${stubs} network stub(s), ${known} known defect(s)`)
  process.exit(0)
}
if (process.argv.includes('--check')) {
  if (!baseline) { console.error('✗ sheet editor coverage: no baseline — run with --write once'); process.exit(1) }
  if (fresh.length || stubsRose || knownRose || newAbstentions.length) {
    if (newAbstentions.length) console.error(`✗ sheet editor coverage: new abstentions (R7): ${newAbstentions.join(", ")}`)
    if (fresh.length) console.error(`\n✗ sheet editor coverage: ${fresh.length} new gap(s). A sheet editor or column kind needs a case in ${UNIT_TEST} and a driver in ${SWEEP} (every arm a gesture or a written reason).`)
    if (stubsRose) console.error(`✗ sheet editor coverage: NETWORK_STUBS grew from ${baseline.networkStubs} to ${result.stubs}. The sweep answers only reads that need the network; seed the rest.`)
    if (knownRose) console.error(`✗ sheet editor coverage: KNOWN_DEFECTS grew from ${baseline.knownDefects ?? 0} to ${result.known}. Fix the defect the sweep found; do not excuse it.`)
    process.exit(1)
  }
  console.log(`✓ sheet editor coverage inventory accepted (reasons are coverage gaps, not exercised editors) (${allowed.size} baselined gap(s), ${result.stubs} network stub(s), ${result.known} known defect(s))`)
}
