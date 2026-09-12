#!/usr/bin/env node
/**
 * typecheck-scoped — type-check a LANE'S files plus their transitive imports, not the whole app.
 *
 * WHY THIS EXISTS. `apps/web`'s full `tsc --noEmit` takes ~12 minutes and, with six lanes running
 * it at once, took the machine to load 20.6 and starved everyone (hub #520/#524/#532). It is also
 * the wrong instrument for the common case: a lane edits four files and wants to know whether IT
 * broke anything, not whether the app compiles.
 *
 * HOW. A temp tsconfig is generated OUTSIDE the repo that `extends` the owning workspace's real
 * config and replaces `include` with the exact files given. `tsc` then pulls each file's transitive
 * imports itself, so the check is complete for those files without walking the app.
 *
 * 🔴 TWO THINGS THAT ARE NOT INCIDENTAL:
 *
 * 1. **`incremental: false`.** `apps/web/tsconfig.json` sets `"incremental": true` with no explicit
 *    path, so every lane's run reads and writes ONE shared `tsconfig.tsbuildinfo` in the repo. A
 *    scoped run must not participate in that: if it writes a buildinfo the full gate later reads,
 *    a real check can skip files this tool "already did", and a scoped tool that degrades the gate
 *    it stands in for is worse than no tool (IO.1). A private per-run cache was the alternative and
 *    is pointless here — the temp dir is fresh each run, so it would never be warm.
 *
 * 2. **ZERO FILES IS A REFUSAL, NOT A PASS.** A glob that matches nothing must never report
 *    success: a check that can only fail to FIND its subject cannot tell you the subject changed.
 *    Same rule as `check-css-parse`'s zero-file abstain.
 *
 * USAGE
 *   node scripts/typecheck-scoped.mjs apps/web/src/design-system/components/Listbox.tsx …
 *   node scripts/typecheck-scoped.mjs $(git diff --name-only | grep -E '\.tsx?$')
 *
 * Paths may be repo-relative or absolute. Files are grouped by owning workspace and each group is
 * checked against its own tsconfig, so a mixed list works.
 *
 * ⚠ SCOPE, stated so a green is read correctly: this checks the given files and everything they
 * IMPORT. It does not check the files that import THEM. Changing an exported signature can leave
 * this green and break a consumer — for an API change, run the workspace's full `npm run typecheck`.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'

const REPO = resolve(new URL('..', import.meta.url).pathname)

/** Workspaces that own a tsconfig, longest path first so `apps/web` never captures a nested one. */
const WORKSPACES = ['apps/web', 'apps/factory', 'apps/api', 'packages/events', 'packages/shared']
  .filter((w) => existsSync(join(REPO, w, 'tsconfig.json')))
  .sort((a, b) => b.length - a.length)

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'))

if (args.length === 0) {
  console.error('✗ typecheck-scoped: no files given.')
  console.error('  A run with nothing to check is a refusal, not a pass — see the note in this file.')
  console.error('  usage: node scripts/typecheck-scoped.mjs <file.ts|tsx> [...]')
  process.exit(2)
}

// Resolve, de-duplicate, and drop anything that is not a real TS file on disk. A path that does not
// exist is reported rather than skipped: silently checking fewer files than asked is the same
// failure as checking none.
const missing = []
const files = []
for (const a of args) {
  const abs = isAbsolute(a) ? a : resolve(REPO, a)
  if (!existsSync(abs) || !statSync(abs).isFile()) { missing.push(a); continue }
  if (!/\.(ts|tsx|mts|cts)$/.test(abs) || abs.endsWith('.d.ts')) continue
  if (!files.includes(abs)) files.push(abs)
}
if (missing.length) {
  console.error(`✗ typecheck-scoped: ${missing.length} path(s) do not exist:`)
  for (const m of missing) console.error(`   ${m}`)
  process.exit(2)
}
if (files.length === 0) {
  console.error('✗ typecheck-scoped: none of the given paths are checkable .ts/.tsx source.')
  process.exit(2)
}

// Group by owning workspace.
const groups = new Map()
const orphans = []
for (const f of files) {
  const rel = relative(REPO, f)
  const ws = WORKSPACES.find((w) => rel === w || rel.startsWith(`${w}/`))
  if (!ws) { orphans.push(rel); continue }
  if (!groups.has(ws)) groups.set(ws, [])
  groups.get(ws).push(f)
}
if (orphans.length) {
  console.error(`✗ typecheck-scoped: ${orphans.length} file(s) belong to no workspace with a tsconfig:`)
  for (const o of orphans) console.error(`   ${o}`)
  console.error(`  workspaces: ${WORKSPACES.join(', ')}`)
  process.exit(2)
}

const out = mkdtempSync(join(tmpdir(), 'tsc-scoped-'))
let failed = 0

for (const [ws, group] of groups) {
  const wsAbs = join(REPO, ws)
  const base = join(wsAbs, 'tsconfig.json')
  const cfg = join(out, `${ws.replace(/\//g, '-')}.json`)

  // 🔴 Every line below that looks redundant was paid for by IO.1 measuring it (#531):
  //
  // `next-env.d.ts` — NOT optional. Without it every `import s from './x.module.css'` reports
  //   TS2307 "Cannot find module", and a scoped run that omits it emits confident FALSE POSITIVES
  //   on any file using CSS modules. IO.1 lost time treating three of those as real errors.
  //   Included only where it exists, so a workspace without Next is unaffected.
  //
  // `baseUrl` + `paths` — restated. `extends` resolves `baseUrl` relative to the EXTENDING file,
  //   so an out-of-tree config silently loses every `@/…` import. Silently: you get
  //   module-not-found, not a config error. Restating is harmless if TS ever resolves it the other
  //   way and essential if it does not — this is a case where belt AND braces costs two lines.
  //
  // `incremental: false` — a scoped run must not write a `.tsbuildinfo` the full gate might later
  //   read, or a real check can skip files this tool "already did": a scoped tool that degrades
  //   the gate it stands in for is worse than no tool. A private warm cache was the alternative,
  //   but the temp dir is fresh per run so it would never be warm — paying the write for nothing.
  const extra = []
  const nextEnv = join(wsAbs, 'next-env.d.ts')
  if (existsSync(nextEnv)) extra.push(nextEnv)

  writeFileSync(cfg, JSON.stringify({
    extends: base,
    compilerOptions: {
      noEmit: true,
      incremental: false,
      baseUrl: wsAbs,
      paths: { '@/*': ['./src/*'] },
    },
    // `files` is exact — tsc adds each one's transitive imports itself. `include: []` stops the
    // base config's `"include": ["src", …]` dragging the whole app back in.
    files: [...group, ...extra],
    include: [],
  }, null, 2))

  const started = Date.now()
  let code = 0
  let stdout = ''
  let ran = true
  try {
    stdout = execFileSync('npx', ['tsc', '-p', cfg], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    code = e.status ?? null
    stdout = `${e.stdout ?? ''}${e.stderr ?? ''}`
    // 🔴 tsc exits 0 (clean) or 1/2 (diagnostics). ANYTHING else — 127 command-not-found, a null
    // status from a signal — means it never ran, and an empty error list then means nothing.
    // Two of IO.1's runs reported zero errors for exactly this reason (one wrapped in `timeout`,
    // which does not exist on macOS; one after a failed `cd`), and so did mine tonight.
    if (code !== 1 && code !== 2) ran = false
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  const errors = (stdout.match(/error TS/g) ?? []).length

  if (!ran) {
    failed = 1
    console.error(`✗ ${ws}: tsc DID NOT RUN (exit ${code === null ? 'signal' : code}) — this is not a pass.`)
    console.error(stdout.trimEnd() || '   (no output)')
    continue
  }
  if (code === 0) {
    console.log(`✓ ${ws}: ${group.length} file(s) given + ${extra.length} ambient + transitive imports — clean in ${secs}s`)
  } else {
    failed = 1
    console.error(`✗ ${ws}: ${errors} error(s) across ${group.length} file(s) in ${secs}s`)
    console.error(stdout.trimEnd())
  }
}

if (!failed) {
  console.log(`\n  scope: the files given and everything they IMPORT — not their consumers.`)
  console.log(`  An exported-signature change can be green here and break a caller; for that, run the`)
  console.log(`  workspace's own \`npm run typecheck\`.`)
}
process.exit(failed)
