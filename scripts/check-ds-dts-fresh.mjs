#!/usr/bin/env node
/**
 * DS declaration freshness.
 *
 * The `.d.ts` files beside each component are `tsc --emitDeclarationOnly` output, committed so the
 * design-sync package and any consumer can read the API. They are NOT regenerated automatically,
 * so they go stale the moment a prop is added — silently, because nothing type-checks against
 * them inside this repo.
 *
 * Measured 2026-08-26: 19 components were missing 52 props between them, and `ButtonVariant`
 * listed 5 of its 10 members. A session planning a conversion from the declaration — which the
 * brief tells them to read — was planning against a component that does not exist. The one that
 * cost most was `DataGrid.size`: without it a dense grid converts at `md` and loses a third of
 * its visible rows.
 *
 * 🔴 NOT a pre-push guard, deliberately. These files are GITIGNORED (.gitignore:86) — they are
 * local build artifacts, not committed API. A pre-push check on them is VACUOUS: on a fresh
 * clone none exist, so it skips every file and passes. I wired one in and then proved it passes
 * with zero declarations present, which is the same empty-assertion trap this repo has been
 * caught by before.
 *
 * So this is a REGENERATOR. Run it after changing a component's props if you want the local
 * declarations to match. The durable fix is in the session brief: read the .tsx, never the .d.ts.
 *
 *   node scripts/check-ds-dts-fresh.mjs --write   # regenerate them in place
 */
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, existsSync, copyFileSync, mkdtempSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = new URL('..', import.meta.url).pathname
const DS = join(ROOT, 'apps/web/src/design-system')
const CFG = '.design-sync/ds-pkg/tsconfig.json'

if (!existsSync(join(ROOT, CFG))) {
  console.log(`✓ ds-dts: ${CFG} absent — nothing to check`)
  process.exit(0)
}

const out = mkdtempSync(join(tmpdir(), 'ds-dts-'))
try {
  execSync(`npx tsc -p ${CFG} --outDir ${out}`, { cwd: ROOT, stdio: 'pipe' })
} catch (e) {
  console.error('❌ ds-dts: the declaration build failed — fix the type errors first')
  console.error(String(e.stdout ?? e.message).split('\n').slice(0, 8).join('\n'))
  process.exit(1)
}

const walk = (dir, acc = []) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (n.endsWith('.d.ts')) acc.push(p)
  }
  return acc
}

const stale = []
const mode = process.argv[2]
for (const fresh of walk(out)) {
  const rel = relative(out, fresh)
  const committed = join(DS, rel)
  // A MISSING declaration is stale too — the gate that skipped them is what made the --check mode
  // vacuous on a clean clone. But "missing is stale" has to be READ that way, not thrown: this
  // line used to be a bare readFileSync on `committed`, which raised ENOENT and killed the whole
  // run on the first never-generated file (measured 2026-08-31: BenchmarkBar.d.ts). So --write
  // could never CREATE a declaration, only refresh one that already existed — the exact case the
  // comment above claims to cover.
  const current = existsSync(committed) ? readFileSync(committed, 'utf8') : null
  if (current !== null && readFileSync(fresh, 'utf8') === current) continue
  stale.push(rel)
  if (mode === '--write') copyFileSync(fresh, committed)
}

if (mode === '--write') {
  console.log(`✓ ds-dts: regenerated ${stale.length} declaration(s)`)
  process.exit(0)
}
if (stale.length) {
  console.error(`❌ ds-dts: ${stale.length} committed declaration(s) are stale:`)
  for (const s of stale) console.error(`   ${s}`)
  console.error(`\n   A .d.ts that omits a prop is worse than none: the brief tells sessions to read\n` +
                `   the component, and a stale declaration describes one that does not exist.\n` +
                `   Run: node scripts/check-ds-dts-fresh.mjs --write`)
  process.exit(1)
}
console.log('✓ ds-dts: every committed declaration matches its source')
