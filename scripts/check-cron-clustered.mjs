#!/usr/bin/env node
/**
 * EV.4 §guard — every scheduled job goes through the cluster-safe wrapper.
 *
 * WHY
 * node-cron is per-process. 117 jobs registered directly against it means a
 * second API replica runs all 117 a second time — two order syncs, two
 * repricing evaluators, two ads autopilots, all writing to one database. This
 * platform has a recorded incident of exactly that shape, lasting 7.5 hours.
 *
 * lib/cron/clustered.ts wraps node-cron with a per-tick Redis claim. A file
 * that imports node-cron DIRECTLY bypasses it and is invisible in review — the
 * import line looks identical to the 109 that were migrated.
 *
 * THE RULE
 * Only lib/cron/clustered.ts may import 'node-cron'. Everything else imports
 * the wrapper.
 *
 *   node scripts/check-cron-clustered.mjs
 */
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WRAPPER = 'apps/api/src/lib/cron/clustered.ts'

const list = (cmd) => {
  try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean) } catch { return [] }
}
const files = [...new Set([
  ...list('git ls-files "apps/api/src/"'),
  ...list('git ls-files --others --exclude-standard "apps/api/src/"'),
])].filter((f) => f.endsWith('.ts'))

const offenders = []
for (const rel of files) {
  if (rel === WRAPPER) continue
  let src
  try { src = readFileSync(join(ROOT, rel), 'utf8') } catch { continue }
  if (!src.includes('node-cron')) continue
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteralLike(st.moduleSpecifier) && st.moduleSpecifier.text === 'node-cron') {
      const { line } = sf.getLineAndCharacterOfPosition(st.getStart(sf))
      offenders.push(`${rel}:${line + 1}`)
    }
  }
}

if (offenders.length) {
  console.error(`\n❌ clustered cron: ${offenders.length} file(s) import node-cron directly:\n`)
  for (const o of offenders) console.error(`   ${o}`)
  console.error(
    `\n   node-cron is PER-PROCESS. A job registered against it runs once per replica —\n` +
      `   two order syncs, two repricing runs, two autopilots, one database.\n` +
      `   Import ${WRAPPER} instead; it is a drop-in with the same schedule/validate.\n`,
  )
  process.exit(1)
}
console.log(`✓ clustered cron: every scheduled job goes through the cluster-safe wrapper (${files.length} files scanned)`)
