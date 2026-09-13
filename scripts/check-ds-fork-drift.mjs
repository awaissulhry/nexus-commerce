#!/usr/bin/env node
/**
 * DS fork-drift ratchet — apps/web/src/design-system vs apps/factory/src/design-system
 *
 * WHY THIS EXISTS
 * apps/factory keeps a COPY of the design system, not an import of it. Measured 2026-08-25:
 * factory has zero files and zero CSS selectors that web does not have (0 of 218 + 123 + 100 + 2),
 * so it is a STALE SNAPSHOT of web's DS, never a deliberate variant.
 *
 * The failure mode this catches is silent and already happened. `Modal.tsx` was byte-identical in
 * both apps; a fix landed in web only, and 46 factory modal call sites kept rendering a dialog with
 * no accessible name. Nothing failed: two builds, four guards and tsc were all green, because a
 * stale copy is still valid code.
 *
 * THE RULE
 * A file present in BOTH apps and identical today must stay identical. Files that already differ
 * are frozen in the baseline and may keep differing — this is a ratchet, not a big-bang merge.
 * Converging one is progress: the guard reports it and asks you to drop it from the baseline so
 * the frozen set only ever shrinks.
 *
 *   node scripts/check-ds-fork-drift.mjs           # report
 *   node scripts/check-ds-fork-drift.mjs --check   # exit 1 on NEW drift (pre-push)
 *   node scripts/check-ds-fork-drift.mjs --write   # re-freeze the baseline (state WHY in the commit)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const WEB = join(ROOT, 'apps/web/src/design-system')
const FACTORY = join(ROOT, 'apps/factory/src/design-system')
const BASELINE = join(ROOT, 'scripts/ds-fork-baseline.json')
// SOURCE only. `.d.ts` beside a component is `tsc --emitDeclarationOnly` OUTPUT (see
// check-ds-dts-fresh.mjs) — gitignored in web, generated from the very .tsx this guard already
// compares. Including them made the ratchet fail the moment declarations were regenerated on one
// side (measured 2026-08-31: DataGrid.d.ts + MetricStrip.d.ts, after a regen fixed 66 of them),
// and the "fix" it demanded was to hand-copy build artifacts into factory. Nothing is lost: a
// declaration cannot drift while its source is identical, and a source that differs is caught
// directly.
// `.mjs` added 2026-09-03 (hub P14, DS.1). The DS ships TOOLING as well as components —
// `tools/token-guard.mjs` and `tools/api-guard.mjs` are in both apps — and `.mjs` sat outside this
// extension list, so neither was compared. That is the third member of the family this guard's own
// header describes: a stale copy is still valid code, and a stale GUARD is worse than a stale
// component because it reports on the tree it was pointed at while looking clean. Measured: the
// factory `token-guard.mjs` was an Aug-25 snapshot that scanned `apps/web`, so factory's DS had
// never been checked by it in any version, and nothing here could see that.
const EXT = /(?<!\.d)\.(tsx|ts|css|mjs)$/

const walk = (dir, base = dir, out = []) => {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, base, out)
    else if (EXT.test(name)) out.push(relative(base, p))
  }
  return out
}

const requiredMirrors = [
  'grid/editors/AxesPanelEditor.tsx', 'grid/renderers/variationTheme.tsx', 'grid/editors/sheetWriter.ts', 'grid/editors/sheetColumn.ts', 'grid/editors/shapeColumn.ts', 'grid/theme/grid.css',
  // MX.G (2026-09-13) — the Matrix cell kinds: the engine contract, the rules, the renderers, the sale editor, the column builder, the verbs, the barrels they surface through.
  'grid/matrix/contract.ts', 'grid/renderers/matrixCells.ts', 'grid/renderers/MatrixCellViews.tsx', 'grid/renderers/projection.ts', 'grid/renderers/index.ts',
  'grid/editors/SaleCellEditor.tsx', 'grid/editors/matrixColumn.ts', 'grid/editors/index.ts', 'grid/actions/matrixActions.ts', 'grid/actions/registry.ts',
]
const missingMirrors = requiredMirrors.filter(file => !existsSync(join(WEB, file)) || !existsSync(join(FACTORY, file)))
if (missingMirrors.length) {
  console.error('Missing required design-system counterparts:', missingMirrors.join(', '))
  process.exit(1)
}

const shared = walk(WEB).filter((f) => existsSync(join(FACTORY, f))).sort()
const differing = shared.filter(
  (f) => readFileSync(join(WEB, f), 'utf8') !== readFileSync(join(FACTORY, f), 'utf8'),
)

const mode = process.argv[2]

if (mode === '--write') {
  writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        note: 'Files the two DS copies already differ on. This list may only SHRINK. A shared file absent here must stay byte-identical in both apps.',
        updatedAt: new Date().toISOString().slice(0, 10),
        sharedFiles: shared.length,
        differing,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`✓ baseline written — ${differing.length} differing of ${shared.length} shared`)
  process.exit(0)
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
const frozen = new Set(base.differing)
const newDrift = differing.filter((f) => !frozen.has(f))
const converged = base.differing.filter((f) => !differing.includes(f))

console.log(`DS fork: ${shared.length} shared files · ${differing.length} differing · ${shared.length - differing.length} identical`)

if (converged.length) {
  console.log(`\n✓ converged since the baseline (drop from scripts/ds-fork-baseline.json):`)
  for (const f of converged) console.log(`   ${f}`)
}

if (newDrift.length) {
  console.error(`\n✗ NEW drift — these were identical in both apps and no longer are:`)
  for (const f of newDrift) console.error(`   ${f}`)
  console.error(
    `\n   apps/factory carries a COPY of the DS. A fix applied to one app is not applied to the\n` +
      `   platform — that is how Modal.tsx left 46 factory modals without an accessible name.\n` +
      `   Apply the same change to the other copy, or run --write and say why in the commit.`,
  )
  if (mode === '--check') process.exit(1)
} else {
  console.log(`\n✓ no new drift: every shared file that was identical still is`)
}
