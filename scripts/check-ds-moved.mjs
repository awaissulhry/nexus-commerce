#!/usr/bin/env node
/**
 * The design system lives in packages/ui (`@nexus/ui`): `apps/web/src/design-system` must not exist again.
 *
 * WHY THIS EXISTS
 * On 2026-10-28 the design system moved from apps/web/src/design-system to packages/ui/src as one `git mv`. The web still
 * imports it as `@/design-system/*`, and apps/web/tsconfig.json and apps/web/vitest.config.ts send that to
 * packages/ui/src. A branch cut before the move can bring files back to the old folder: git's rename detection carries
 * most edits across, but a file that is NEW on such a branch lands at the old path. There nothing imports it, or a
 * session keeps editing a second copy while the screen shows the other one. Both look like work and change nothing.
 *
 * THE RULE (strict, no baseline): the path apps/web/src/design-system does not exist — no file and no folder, tracked,
 * untracked or ignored. The fix: move each file to the same place under packages/ui/src (merge by hand when that file
 * exists there too), then delete the old folder.
 *
 *   node scripts/check-ds-moved.mjs              # exit 1 while the old folder exists
 *   node scripts/check-ds-moved.mjs --self-test  # the check, on a planted folder in a temporary directory
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const OLD = 'apps/web/src/design-system'
const NEW = 'packages/ui/src'

/** The files under `<root>/apps/web/src/design-system` (relative to root): null when the old path does not exist. */
export function strayFiles(root) {
  const old = join(root, OLD)
  if (!existsSync(old)) return null
  if (!statSync(old).isDirectory()) return [OLD]
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(relative(root, p))
    }
  }
  walk(old)
  return out.sort()
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'check-ds-moved-'))
  let failed = 0
  try {
    if (strayFiles(root) !== null) { failed++; console.error('✗ self-test: a tree without the old folder was flagged') }
    mkdirSync(join(root, OLD), { recursive: true })
    const empty = strayFiles(root)
    if (!Array.isArray(empty) || empty.length !== 0) { failed++; console.error('✗ self-test: an empty old folder was not caught') }
    mkdirSync(join(root, OLD, 'grid'))
    writeFileSync(join(root, OLD, 'grid', 'Planted.tsx'), 'export {}\n')
    const planted = strayFiles(root)
    if (planted?.join() !== `${OLD}/grid/Planted.tsx`) { failed++; console.error(`✗ self-test: a planted file was not named (${planted})`) }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  if (failed) process.exit(1)
  console.log('✓ ds-moved self-test: no old folder passes; an empty old folder and a planted file are both caught')
}

if (process.argv.includes('--self-test')) { selfTest(); process.exit(0) }

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const stray = strayFiles(ROOT)
if (stray === null) {
  console.log(`✓ ds-moved: ${OLD} does not exist; the design system lives in ${NEW} (@nexus/ui)`)
  process.exit(0)
}
console.error(`✗ ds-moved: ${OLD} exists again${stray.length ? ` with ${stray.length} file(s)` : ' (an empty folder)'} — the design system lives in ${NEW} (@nexus/ui).`)
for (const f of stray.slice(0, 30)) console.error(`  ${f}  →  ${NEW}${f.slice(OLD.length)}`)
if (stray.length > 30) console.error(`  … and ${stray.length - 30} more`)
console.error(`\n  Move each file to the same place under ${NEW} (merge by hand when it exists there too), then delete ${OLD}.`)
console.error('  Rule + why: scripts/check-ds-moved.mjs header.')
process.exit(1)
