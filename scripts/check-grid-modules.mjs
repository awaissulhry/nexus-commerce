#!/usr/bin/env node
/**
 * GDS §8 — the AG module gate.
 *
 * ## Why this exists, in two measured incidents on one night
 *
 * `design-system/grid/modules.ts` registers a CURATED list of AG modules rather than the wildcard,
 * because every module is bundled into the first route that renders a grid. That is the right call
 * and it has one failure mode, which is severe and completely silent:
 *
 *   **A feature whose module is not registered does not work, and says nothing in production.**
 *
 * AG reports the omission through `ValidationModule`, which is registered in DEVELOPMENT ONLY —
 * its whole job is printing message text, which a built page should not carry. So in production the
 * call returns `undefined`, the editor never opens, the API answers nothing, and the surface looks
 * exactly like a surface with no data.
 *
 * Both of these shipped into the Product Edit Studio and were found by eye, not by any gate:
 *
 *   1. `TextEditorModule` / `LargeTextEditorModule` / `CustomEditorModule` were absent, so EVERY
 *      TEXT CELL on the master sheet was silently uneditable while the number cells worked. The
 *      grid lab never caught it because the lab registers the wildcard.
 *   2. `CellApiModule` was absent, so `api.getCellValue` returned `undefined` — which meant a fix
 *      for a paste bug read as though it protected data and did nothing at all.
 *
 * ## What it does
 *
 * Scans the surfaces that render production grids for the FEATURES AG gates behind modules, and
 * fails when one is used without its module registered. It reads `modules.ts` itself, so it cannot
 * pass against a stale idea of what is registered.
 *
 * ## What it deliberately does NOT do
 *
 * It does not flag a registered module that nothing uses. That is a bundle question, not a
 * correctness one, and a guard that fails the push over a spare module trains people to bypass it.
 * The report prints unused modules as information at the bottom.
 *
 * 🔴 A FALSE POSITIVE IS WORSE THAN A FALSE NEGATIVE here — a gate that cries wolf gets disabled,
 * and then the real omission ships. So every marker below is a precise, low-ambiguity string, each
 * one is commented with the AG API it stands for, and anything uncertain is left out rather than
 * guessed at. The suite in `--self-test` proves the gate catches the two REAL incidents above.
 *
 *   node scripts/check-grid-modules.mjs              # report + gate (exit 1 on a miss)
 *   node scripts/check-grid-modules.mjs --self-test  # prove it catches the two known incidents
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const MODULES_FILE = 'apps/web/src/design-system/grid/modules.ts'

/**
 * Where production grids live. The grid LAB is excluded on purpose: it registers the wildcard
 * itself (`labModules.ts`), so a feature used only there is legitimately unregistered here — and
 * that exclusion is precisely why the lab could not catch either incident.
 */
const SCAN_DIRS = ['apps/web/src/design-system/grid', 'apps/web/src/app']
const EXCLUDE = [/apps\/web\/src\/app\/design\/grid-lab\//, /\.vitest\.test\./, /\/node_modules\//]

/**
 * feature marker → the module AG gates it behind.
 *
 * Each `test` is a string or RegExp matched against file source. They are written to be
 * unambiguous: a bare word like "pagination" would match prose, so the markers carry their syntax
 * (`pagination=`, `api.getCellValue`).
 */
const FEATURES = [
  { module: 'TextEditorModule', why: "cellEditor: 'agTextCellEditor'", test: /'agTextCellEditor'/ },
  { module: 'LargeTextEditorModule', why: "cellEditor: 'agLargeTextCellEditor'", test: /'agLargeTextCellEditor'/ },
  { module: 'NumberEditorModule', why: "cellEditor: 'agNumberCellEditor'", test: /'agNumberCellEditor'/ },
  { module: 'SelectEditorModule', why: "cellEditor: 'agSelectCellEditor'", test: /'agSelectCellEditor'/ },
  // AG.1 (#184). Every `select` column on a studio sheet goes through `selectEditor()`, which
  // returns this editor — 23 columns on GALE-JACKET master alone. It replaced a DS `Listbox`
  // mounted as a React editor that could not be opened at all, so the failure this detector guards
  // is not hypothetical: unregister it and those cells silently stop opening an editor again, in
  // production only, because `ValidationModule` is dev-only.
  { module: 'RichSelectModule', why: "cellEditor: 'agRichSelectCellEditor'", test: /'agRichSelectCellEditor'/ },
  // `<...>` allows a TYPE PARAMETER between the name and the paren — `getCellValue<unknown>({…})`
  // is how it is actually written, and a marker without this reported the module as unused while
  // the call sat three files away.
  { module: 'CellApiModule', why: 'api.getCellValue()', test: /\.getCellValue\s*(<[^>]*>)?\s*\(/ },
  { module: 'ScrollApiModule', why: 'api.ensureColumnVisible() / ensureIndexVisible()', test: /\.(ensureColumnVisible|ensureIndexVisible)\s*\(/ },
  { module: 'ClipboardModule', why: 'processDataFromClipboard / api.pasteFromClipboard', test: /processDataFromClipboard|\.pasteFromClipboard\s*\(/ },
  { module: 'UndoRedoEditModule', why: 'undoRedoCellEditing / api.undoCellEditing()', test: /undoRedoCellEditing|\.undoCellEditing\s*\(|\.redoCellEditing\s*\(/ },
  { module: 'CellSelectionModule', why: 'cellSelection (range + fill handle)', test: /cellSelection\s*[:=]/ },
  { module: 'TreeDataModule', why: 'treeData + getDataPath', test: /\btreeData\b\s*[:=]?|getDataPath\s*[:=]/ },
  { module: 'MasterDetailModule', why: 'masterDetail', test: /\bmasterDetail\b\s*[:=]/ },
  { module: 'PaginationModule', why: 'pagination', test: /\bpagination\s*[:=]|paginationPageSize/ },
  { module: 'RowSelectionModule', why: 'rowSelection', test: /\browSelection\s*[:=]|\.getSelectedNodes\s*\(/ },
  { module: 'CsvExportModule', why: 'api.exportDataAsCsv()', test: /\.exportDataAsCsv\s*\(/ },
  { module: 'GridStateModule', why: 'initialState / api.getState()', test: /\binitialState\s*[:=]|\.getState\s*\(\s*\)/ },
  { module: 'ColumnApiModule', why: 'api.applyColumnState() / getColumnState()', test: /\.(applyColumnState|getColumnState)\s*\(/ },
  { module: 'ColumnAutoSizeModule', why: 'api.autoSizeColumns() / sizeColumnsToFit()', test: /\.(autoSizeColumns|autoSizeAllColumns|sizeColumnsToFit)\s*\(/ },
  { module: 'RowAutoHeightModule', why: 'content-driven column autoHeight', test: /\bautoHeight\s*:\s*(true|autoRows)\b/ },
  { module: 'RowApiModule', why: 'api.getRowNode() / forEachNode()', test: /\.(getRowNode|forEachNode)\s*\(/ },
  { module: 'RenderApiModule', why: 'api.refreshCells() / redrawRows()', test: /\.(refreshCells|redrawRows)\s*\(/ },
  { module: 'QuickFilterModule', why: 'quickFilterText', test: /quickFilterText/ },
  { module: 'PinnedRowModule', why: 'pinnedTopRowData / pinnedBottomRowData', test: /pinned(Top|Bottom)RowData/ },
  { module: 'ContextMenuModule', why: 'getContextMenuItems', test: /getContextMenuItems/ },
  /* 🔴 Added after PES.3 found (#548) that `TooltipModule` had NEVER been registered, so every
     `tooltipValueGetter` and `headerTooltip` in the app was inert — and THIS GATE PASSED ALL NIGHT,
     printing TooltipModule under "registered, and this gate has NO detector for them". It was
     telling the truth and it read as reassurance. A gate's green is bounded by its detector list;
     the unchecked line is the boundary, and nobody reads a boundary as a warning. This engine leans
     on tooltips by design — refusal reasons, provenance, `absent` explanations all live there — so
     the missing module quietly deleted the explanation channel three rulings chose. */
  /* 🔴 `api`-SCOPED on purpose. `/\.(add|remove)EventListener\(/` matches 602 lines in the scanned
     tree — every DOM listener, every EventSource — and a detector that fires on 602 unrelated files
     is a detector nobody trusts. Requiring an `…api.` receiver takes it to the 3 real grid-API call
     sites (`useGridState.ts` ×2, `ChannelSheet.tsx`). Measured before it was written, not after. */
  { module: 'EventApiModule', why: 'api.addEventListener() / api.removeEventListener()', test: /\w*[aA]pi\s*\.\s*(add|remove)EventListener\s*\(/ },
  { module: 'TooltipModule', why: 'tooltipValueGetter / headerTooltip / headerTooltipValueGetter', test: /\btooltipValueGetter\b|\bheaderTooltip(ValueGetter)?\b/ },
  { module: 'ColumnMenuModule', why: 'getMainMenuItems', test: /getMainMenuItems/ },
  { module: 'CustomFilterModule', why: 'a React component as colDef.filter', test: /useGridFilter\s*\(/ },
  { module: 'CustomEditorModule', why: 'a React component as colDef.cellEditor', test: /cellEditor:\s*[A-Z][A-Za-z]*\b/ },
  { module: 'ServerSideRowModelModule', why: 'rowModelType="serverSide"', test: /rowModelType\s*[:=]\s*["']serverSide["']|["']serverSide["']/ },
  { module: 'ServerSideRowModelApiModule', why: 'api.refreshServerSide()', test: /\.refreshServerSide\s*\(/ },
  { module: 'ClientSideRowModelApiModule', why: 'api.applyTransaction()', test: /\.applyTransaction\s*\(/ },
  { module: 'RowGroupingModule', why: 'rowGroup / groupDefaultExpanded', test: /\browGroup\b\s*[:=]|groupDefaultExpanded/ },
  { module: 'AggregationModule', why: 'aggFunc', test: /\baggFunc\b\s*[:=]/ },
  { module: 'CellStyleModule', why: 'cellClassRules / cellStyle', test: /cellClassRules|cellStyle\s*[:=]/ },
  { module: 'RowStyleModule', why: 'rowClassRules / getRowStyle', test: /rowClassRules|getRowStyle/ },
  { module: 'LocaleModule', why: 'localeText', test: /localeText/ },
]

/**
 * Blank comments, preserving newlines. Ported from `check-global-exposure.mjs` (DS1-31).
 *
 * 🔴 The FEATURES scan used to read raw source, so `modules.ts` itself appeared in this gate's own
 * output as a *user* of tooltips — the comment explaining why `TooltipModule` is registered names
 * the very APIs it gates. Second instance in one night, in two doors by different lanes: the file
 * most likely to explain a defect is the file that just fixed it.
 *
 * Strings are deliberately NOT blanked: half the detectors below key on string literals
 * (`'agTextCellEditor'`), so blanking strings would disable them outright.
 */
/* Shared with `check-global-exposure` and `check-token-resolution` — ONE implementation, in
   `scripts/lib/strip-comments.mjs` (hub #684). This file carried a byte-for-byte copy that
   differed only in the formatting of its `//` branch; a copied scanner is a scanner that can
   drift, and a drifted scanner is the miss nothing else can see. Re-exported because this
   module already exported it. */
export { stripComments } from './lib/strip-comments.mjs'
import { stripComments } from './lib/strip-comments.mjs'

/**
 * Registered modules that this gate deliberately does NOT detect, each with the reason printed.
 * An undocumented entry prints as a bare warning instead — see DS1-33: an unchecked list below a ✓
 * reads as housekeeping, and that is how `TooltipModule` sat inert for a night.
 */
const DOCUMENTED_UNCHECKED = {
  ClientSideRowModelModule:
    'the DEFAULT row model — its absence breaks every grid at mount, so the failure cannot be silent and needs no gate',
}

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(join(ROOT, dir)) } catch { return out }
  for (const e of entries) {
    const rel = join(dir, e)
    if (EXCLUDE.some((rx) => rx.test(rel))) continue
    const abs = join(ROOT, rel)
    if (statSync(abs).isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(e)) out.push(rel)
  }
  return out
}

/**
 * Which modules `modules.ts` actually registers, read from the source list, not from a guess.
 *
 * 🔴 COMMENTS ARE STRIPPED FIRST, and that is the whole correctness of this function. The module
 * list is heavily commented — each entry says what needs it — so `TextEditorModule` appears inside
 * a `//` line explaining the entry as well as in the entry itself. A matcher that reads the raw
 * block counts the COMMENT as a registration, which means deleting the real entry changes nothing
 * it can see: the gate would pass against precisely the bug it exists to catch. The self-test
 * caught this on its second run, having been written to catch exactly that incident.
 */
function registeredModules(source) {
  const block = source
    .slice(source.indexOf('const PRODUCTION_MODULES'), source.indexOf('let registered'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
  return new Set([...block.matchAll(/\b([A-Z][A-Za-z]*Module)\b/g)].map((m) => m[1]))
}

export function analyse({ modulesSource, files }) {
  const registered = registeredModules(modulesSource)
  const missing = new Map()
  const usedModules = new Set()

  for (const { rel, text: raw } of files) {
    const text = stripComments(raw)
    for (const f of FEATURES) {
      const hit = typeof f.test === 'string' ? text.includes(f.test) : f.test.test(text)
      if (!hit) continue
      usedModules.add(f.module)
      if (registered.has(f.module)) continue
      const entry = missing.get(f.module) ?? { module: f.module, why: f.why, files: [] }
      if (entry.files.length < 4) entry.files.push(rel)
      missing.set(f.module, entry)
    }
  }
  /**
   * 🔴 Two different statements, kept apart on purpose.
   *
   * `unused` — this gate HAS a detector for the module and the detector did not fire.
   * `unchecked` — this gate has NO detector, so it can say nothing at all about the module.
   *
   * Collapsing them would report "registered but unused" for a module that is used constantly and
   * simply has no marker, which is a false claim in the one direction that matters: it invites
   * someone to delete a registration the gate never actually checked. A gate must not overstate
   * what it knows.
   */
  const detectable = new Set(FEATURES.map((f) => f.module))
  const rest = [...registered].filter((m) => m !== 'ValidationModule')
  const unused = rest.filter((m) => detectable.has(m) && !usedModules.has(m))
  const unchecked = rest.filter((m) => !detectable.has(m))
  return { missing: [...missing.values()], unused, unchecked, registered: [...registered] }
}

/* ── self-test: prove the gate catches the two REAL incidents ────────────────────────────────── */
if (process.argv.includes('--self-test')) {
  const modulesSource = readFileSync(join(ROOT, MODULES_FILE), 'utf8')
  const files = [
    { rel: 'fake/sheet.tsx', text: "cellEditor: 'agTextCellEditor'\ncellEditor: 'agLargeTextCellEditor'" },
    { rel: 'fake/paste.ts', text: 'params.api.getCellValue({ rowNode, colKey })' },
    { rel: 'fake/cols.tsx', text: "headerTooltip: 'why this column'\ntooltipValueGetter: (p) => p.value" },
    { rel: 'fake/ads-grid.tsx', text: 'api.autoSizeColumns(columns)\nautoHeight: true' },
  ]
  // 'gm', not 'm': the module name appears in the IMPORT block as well as in PRODUCTION_MODULES,
  // and a single replace removes only the import — leaving the registration in place and the
  // self-test quietly proving nothing. (Caught by this very self-test on its first run.)
  const strip = (src, mod) => src.replace(new RegExp(`^\\s*${mod},\\s*$`, 'gm'), '')
  const cases = [
    { name: 'text editors missing (every text cell silently uneditable)', mod: 'TextEditorModule' },
    { name: 'CellApiModule missing (getCellValue silently undefined)', mod: 'CellApiModule' },
    { name: 'TooltipModule missing (every tooltip in the app inert — the #548 incident)', mod: 'TooltipModule' },
    { name: 'ColumnAutoSizeModule missing (advertising columns cannot fit their content)', mod: 'ColumnAutoSizeModule' },
    { name: 'RowAutoHeightModule missing (multiline advertising rows are clipped)', mod: 'RowAutoHeightModule' },
  ]
  let bad = 0
  const clean = analyse({ modulesSource, files })
  if (clean.missing.length) { console.error(`❌ self-test: the CURRENT tree should be clean, got ${clean.missing.map((m) => m.module).join(', ')}`); bad++ }
  else console.log('✓ self-test: the current tree passes')
  for (const c of cases) {
    const r = analyse({ modulesSource: strip(modulesSource, c.mod), files })
    if (r.missing.some((m) => m.module === c.mod)) console.log(`✓ self-test: caught — ${c.name}`)
    else { console.error(`❌ self-test: DID NOT CATCH — ${c.name}`); bad++ }
  }
  process.exit(bad ? 1 : 0)
}

/* ── the gate ────────────────────────────────────────────────────────────────────────────────── */
const modulesSource = readFileSync(join(ROOT, MODULES_FILE), 'utf8')
const files = SCAN_DIRS.flatMap((d) => walk(d)).map((rel) => ({ rel, text: readFileSync(join(ROOT, rel), 'utf8') }))
const { missing, unused, unchecked } = analyse({ modulesSource, files })

// 🔴 One header line, always, pass or fail (hub #566). Whether a text scanner strips comments
// changes what its output MEANS, and it was inferable-only until two doors were caught counting a
// comment as usage on the same night. The property is now stated by every scanner in the gate set.
console.log('  comments: stripped')

if (missing.length) {
  console.error(`❌ AG module gate: ${missing.length} feature(s) used without their module registered in ${MODULES_FILE}:\n`)
  for (const m of missing) {
    console.error(`   ${m.module}  — needed for ${m.why}`)
    for (const f of m.files) console.error(`      ${relative('.', f)}`)
  }
  console.error(
    `\n   🔴 AG reports this only through ValidationModule, which is DEVELOPMENT-ONLY. In production\n` +
      `   the call returns undefined and the feature silently does nothing — an editor that never\n` +
      `   opens, an API that answers nothing. Two of these shipped before this gate existed.\n` +
      `   Register the module in ${MODULES_FILE} and say in the commit what uses it.`,
  )
  process.exit(1)
}

console.log(`✓ AG module gate: every gated feature used across ${files.length} file(s) has its module registered`)
if (unused.length) console.log(`  registered, and this gate's detector did not fire — bundle weight, not a failure: ${unused.join(', ')}`)
const documented = unchecked.filter((m) => DOCUMENTED_UNCHECKED[m])
const undocumented = unchecked.filter((m) => !DOCUMENTED_UNCHECKED[m])
for (const m of documented) console.log(`  no detector BY DECISION — ${m}: ${DOCUMENTED_UNCHECKED[m]}`)
if (undocumented.length) {
  console.log(`  🔴 registered, and this gate has NO detector for them — it can say nothing either way: ${undocumented.join(', ')}`)
  console.log('     This line is the gate\u2019s BOUNDARY, not a footnote: TooltipModule sat here while every')
  console.log('     tooltip in the app was inert (#548). Give each one a detector, or a documented reason.')
}
