#!/usr/bin/env node
/**
 * Expand/contract gate for Prisma migrations (docs/ci-plan.md §4.2).
 *
 * WHY
 * Railway runs migrations in the pre-deploy step, BEFORE the new code starts. For a while the old
 * API, worker, scheduler and web keep running against the new schema, and a rollback never undoes
 * a migration. A migration that drops, renames or tightens something the running code still reads
 * breaks production during every deploy, and again on every rollback.
 *
 * THE RULES
 * 1. A migration folder that exists on the base may not change or disappear. `prisma migrate deploy`
 *    never re-reads an applied migration, so an edit to one is silently skipped in production and
 *    only fresh databases see it.
 * 2. A NEW migration may only expand the schema. These statements fail it:
 *      DROP TABLE · DROP COLUMN · RENAME · ALTER COLUMN … TYPE · SET NOT NULL · DROP TYPE ·
 *      ADD COLUMN … NOT NULL without DEFAULT
 *    unless the migration carries the contract header, which records that the expand shipped first
 *    and that no running code still reads the old shape:
 *      -- contract: expands in <migration folder>, readers removed in <commit sha>
 * Folders already on the base are grandfathered for rule 2; they are held by rule 1.
 *
 * BASE
 *   NEXUS_MIGRATION_BASE=<sha> if set (CI sets it: PR base, or the push's `before`), otherwise
 *   `git merge-base HEAD origin/main`. No base = exit 2: "could not measure" is not a pass.
 *
 *   node scripts/check-migration-expand-contract.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = 'packages/database/prisma/migrations'

const RULES = [
  ['DROP TABLE', /\bDROP\s+TABLE\b/i],
  ['DROP COLUMN', /\bDROP\s+COLUMN\b/i],
  ['RENAME', /\bRENAME\s+(?:COLUMN\b|TO\b|CONSTRAINT\b|VALUE\b|"?\w)/i],
  ['ALTER COLUMN … TYPE', /\bALTER\s+COLUMN\s+"?[\w]+"?\s+(?:SET\s+DATA\s+)?TYPE\b/i],
  ['SET NOT NULL', /\bSET\s+NOT\s+NULL\b/i],
  ['DROP TYPE', /\bDROP\s+TYPE\b/i],
]
const CONTRACT = /^\s*--\s*contract:\s*expands in\s+\S+.*readers removed in\s+[0-9a-f]{7,40}\b/im

/** Statements with comments removed. Exported for the self-test. */
export function statements(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .split(';')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** Every rule a migration breaks, as `rule: statement` lines. Empty when it only expands. */
export function destructive(sql) {
  const found = []
  for (const statement of statements(sql)) {
    for (const [name, re] of RULES) if (re.test(statement)) found.push(`${name}: ${statement.slice(0, 140)}`)
    if (/\bADD\s+COLUMN\b/i.test(statement) && /\bNOT\s+NULL\b/i.test(statement) && !/\bDEFAULT\b/i.test(statement)) {
      found.push(`ADD COLUMN … NOT NULL without DEFAULT: ${statement.slice(0, 140)}`)
    }
  }
  return found
}

export const hasContractHeader = sql => CONTRACT.test(sql)

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
}

function main() {
  let base = process.env.NEXUS_MIGRATION_BASE?.trim()
  try {
    base = base ? git('rev-parse', '--verify', `${base}^{commit}`) : git('merge-base', 'HEAD', 'origin/main')
  } catch {
    console.error(`✗ could not resolve the base commit (${base || 'merge-base HEAD origin/main'}). Fetch the history, or set NEXUS_MIGRATION_BASE.`)
    process.exit(2)
  }

  // Rule 1: every file the base has under the migrations folder is byte-identical on disk.
  const baseBlobs = new Map(git('ls-tree', '-r', base, '--', DIR).split('\n').filter(Boolean).map(line => {
    const [meta, path] = line.split('\t')
    return [path, meta.split(' ')[2]]
  }))
  if (baseBlobs.size === 0) {
    console.error(`✗ the base ${base.slice(0, 9)} has no files under ${DIR} — refusing to call that a pass.`)
    process.exit(2)
  }
  const present = [...baseBlobs.keys()].filter(path => existsSync(join(ROOT, path)))
  const diskBlobs = present.length ? execFileSync('git', ['hash-object', '--stdin-paths'], { cwd: ROOT, input: present.join('\n'), encoding: 'utf8' }).trim().split('\n') : []
  const diskBlob = new Map(present.map((path, i) => [path, diskBlobs[i]]))
  const changed = [...baseBlobs].filter(([path, blob]) => diskBlob.get(path) !== blob).map(([path]) => `${path} ${diskBlob.has(path) ? 'changed' : 'deleted'}`)

  // Rule 2: new folders only expand, unless they carry the contract header.
  const baseFolders = new Set([...baseBlobs.keys()].map(path => path.slice(DIR.length + 1).split('/')[0]))
  const newFolders = readdirSync(join(ROOT, DIR)).filter(name => statSync(join(ROOT, DIR, name)).isDirectory() && !baseFolders.has(name))
  const refused = []
  for (const folder of newFolders) {
    const file = join(ROOT, DIR, folder, 'migration.sql')
    if (!existsSync(file)) continue
    const sql = readFileSync(file, 'utf8')
    const found = destructive(sql)
    if (found.length && !hasContractHeader(sql)) refused.push(`${folder}\n${found.map(f => `    ${f}`).join('\n')}`)
  }

  console.log(`migrations: base ${base.slice(0, 9)} · ${baseBlobs.size} shipped files checked · ${newFolders.length} new folder(s)`)
  if (changed.length) {
    console.error(`\n✗ shipped migrations were edited or deleted (rule 1):\n${changed.map(c => `  ${c}`).join('\n')}\n  Put the change in a NEW migration folder instead.`)
  }
  if (refused.length) {
    console.error(`\n✗ new migrations that contract the schema (rule 2):\n${refused.map(r => `  ${r}`).join('\n')}`)
    console.error('  Ship the expand first; drop or tighten in a later release. When that later release is due, add:')
    console.error('    -- contract: expands in <migration folder>, readers removed in <commit sha>')
  }
  process.exit(changed.length || refused.length ? 1 : 0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
