#!/usr/bin/env node
//
// Shared policy file ⇄ migration parity.
//
// Row-level security has TWO builders:
//   • scripts/workspace-policies.mjs, which the disposable test database applies;
//   • prisma/migrations/*, which every deployed database applies.
// Each file in workspaces/*.sql is read by the first and copied, byte for byte, into
// the tail of a migration for the second. If the two drift, tests pass against
// policies that production does not have — or production enforces a rule no test
// has ever run.
//
// That is not hypothetical. On 2026-09-16 a hand-written policy existed in the
// deployed database and NOT in the test database, from birth; it was found because
// a test could not read its own table. Every pair since has been compared by hand.
// This is that comparison, made permanent.
//
// Fails on:
//   • a workspaces/*.sql the generator does not read            (dead — or forgotten)
//   • a file the generator reads that does not exist            (the generator would throw)
//   • a file with no entry in workspaces/policy-migrations.json (no migration carries it)
//   • an entry naming a migration that does not exist
//   • 🔴 a migration whose migration.sql does not END WITH the file's exact bytes
//   • zero files found                                          (an empty result is not a pass)
//
//   node packages/database/scripts/check-policy-migration-parity.mjs

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { policyMigrationBody } from './policy-migration-body.mjs'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const workspacesDir = join(pkgRoot, 'workspaces')
const migrationsDir = join(pkgRoot, 'prisma', 'migrations')
const generatorPath = join(pkgRoot, 'scripts', 'workspace-policies.mjs')
const manifestPath = join(workspacesDir, 'policy-migrations.json')

function fail(lines) {
  console.error(`\n❌ policy ⇄ migration parity FAILED\n\n${lines.join('\n')}\n`)
  process.exit(1)
}

const onDisk = readdirSync(workspacesDir).filter(f => f.endsWith('.sql')).sort()
if (onDisk.length === 0) fail([`No .sql files in ${workspacesDir} — the check would have passed with nothing to compare.`])

const generator = readFileSync(generatorPath, 'utf8')
const readByGenerator = [...new Set([...generator.matchAll(/workspaces\/([A-Za-z0-9_.-]+\.sql)/g)].map(m => m[1]))].sort()

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (error) {
  fail([`Could not read ${manifestPath}: ${error.message}`])
}
const entries = Object.fromEntries(Object.entries(manifest).filter(([key]) => !key.startsWith('//')))

const problems = []
const unread = onDisk.filter(f => !readByGenerator.includes(f))
const missing = readByGenerator.filter(f => !onDisk.includes(f))
if (unread.length) problems.push('Not read by scripts/workspace-policies.mjs — dead, or its sql.push was forgotten:', ...unread.map(f => `    ${f}`), '')
if (missing.length) problems.push('Read by the generator but not on disk:', ...missing.map(f => `    ${f}`), '')

const stale = Object.keys(entries).filter(f => !onDisk.includes(f))
if (stale.length) problems.push('Listed in policy-migrations.json but no such file:', ...stale.map(f => `    ${f}`), '')

let compared = 0
for (const file of onDisk) {
  const migration = entries[file]
  if (!migration) {
    problems.push(`${file}: no entry in policy-migrations.json — which migration applies it to deployed databases?`, '')
    continue
  }
  const migrationPath = join(migrationsDir, migration, 'migration.sql')
  if (!existsSync(migrationPath)) {
    problems.push(`${file}: names migration "${migration}", which does not exist.`, '')
    continue
  }
  const body = readFileSync(join(workspacesDir, file), 'utf8')
  // A transaction wrapper is structural; the shared tail still matches exact bytes.
  const sql = policyMigrationBody(readFileSync(migrationPath, 'utf8'))
  compared++
  if (!sql.endsWith(body)) {
    // Say WHERE they part, so the fix is not a hunt through two long SQL files.
    const tail = sql.slice(Math.max(0, sql.length - body.length))
    let at = 0
    while (at < body.length && at < tail.length && body[at] === tail[at]) at++
    const line = body.slice(0, at).split('\n').length
    problems.push(
      `${file}: ${migration}/migration.sql does NOT end with this file's bytes.`,
      `    first difference near line ${line} of ${file}:`,
      `      file      : ${JSON.stringify(body.split('\n')[line - 1] ?? '').slice(0, 110)}`,
      `      migration : ${JSON.stringify(tail.split('\n')[line - 1] ?? '').slice(0, 110)}`,
      '    If the FILE is the intended change, write a NEW migration ending with its bytes',
      '    and point this entry at it. Never edit a migration that has already been applied.',
      '',
    )
  }
}

if (problems.length) fail(problems)

console.log(`✓ policy ⇄ migration parity: all ${compared} shared policy files match the migration that carries them.`)
