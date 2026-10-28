#!/usr/bin/env node
/**
 * check-append-only — RULE: the factory's ledgers are append-only (plan A1 §2.1 "Append-only" and §6.6, feature PLT-073):
 * a row is never changed or removed, a mistake is fixed with a new row. A model is a ledger when its doc comment in
 * packages/factory-db/prisma/schema/*.prisma has the line `/// @append-only`. For every such model:
 *   1. ownership: no runtime role is granted update or delete on it (packages/factory-db/ownership/*.json);
 *   2. migrations: packages/factory-db/prisma/migrations create a row trigger BEFORE UPDATE OR DELETE and a statement
 *      trigger BEFORE TRUNCATE on its table, each running a function whose (last) definition raises an exception, and
 *      no migration drops or disables those triggers or drops the function. The triggers hold for every login, the
 *      owner included; the missing grants hold for the runtime roles;
 *   3. code: no factory source calls update, updateMany, updateManyAndReturn, upsert, delete or deleteMany on its
 *      Prisma delegate (`auditLog.update(`), and no SQL text in it updates, deletes from or truncates its table.
 *      Scanned: apps/factory-api/src, apps/factory-web/src, packages/factory-db/{src,seed}, packages/factory-domain/src,
 *      packages/db-kit/src; .ts/.tsx/.mts/.js/.mjs files, comments ignored. Test files are not scanned (they prove the
 *      refusals), nor generated ones.
 * The audit log and the idempotency receipts must be marked, so dropping a marker cannot switch the rule off.
 *
 * Run: node scripts/factory/check-append-only.mjs [root] — root is the repository (default) or a copy of its layout (the
 * plant tests). Exit 1 on any violation, one per line.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)))
const DB = join(ROOT, 'packages/factory-db')
const SCHEMA_DIR = join(DB, 'prisma/schema')
const OWNERSHIP_DIR = join(DB, 'ownership')
const MIGRATIONS_DIR = join(DB, 'prisma/migrations')
const CODE_DIRS = ['apps/factory-api/src', 'apps/factory-web/src', 'packages/factory-db/src', 'packages/factory-db/seed', 'packages/factory-domain/src', 'packages/db-kit/src']
const REQUIRED = ['AuditLog', 'IdempotencyReceipt']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.next'])
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$/
const WRITES = ['update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany']

const posix = (path) => path.split(sep).join('/')
const shown = (path) => posix(relative(ROOT, path))
const violations = []
const listDir = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [])
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// --- the marked models -------------------------------------------------------------------------------------------
const ledgers = []
for (const entry of listDir(SCHEMA_DIR).filter((entry) => entry.isFile() && entry.name.endsWith('.prisma'))) {
  const lines = readFileSync(join(SCHEMA_DIR, entry.name), 'utf8').split('\n')
  lines.forEach((line, index) => {
    const model = /^\s*model\s+([A-Za-z_]\w*)\s*\{/.exec(line)
    if (!model) return
    const docs = []
    for (let above = index - 1; above >= 0 && /^\s*\/\/\//.test(lines[above]); above--) docs.push(lines[above].trim())
    if (!docs.some((doc) => /^\/\/\/\s*@append-only\s*$/.test(doc))) return
    let table = model[1]
    for (let below = index + 1; below < lines.length && !/^\s*\}/.test(lines[below]); below++) {
      const map = /@@map\(\s*"([^"]+)"\s*\)/.exec(lines[below])
      if (map) table = map[1]
    }
    ledgers.push({ model: model[1], table, file: `prisma/schema/${entry.name}` })
  })
}
for (const name of REQUIRED) {
  if (!ledgers.some((ledger) => ledger.model === name)) violations.push(`packages/factory-db/prisma/schema: model ${name} must be marked \`/// @append-only\``)
}

// --- 1. ownership -------------------------------------------------------------------------------------------------
for (const entry of listDir(OWNERSHIP_DIR).filter((entry) => entry.isFile() && entry.name.endsWith('.json'))) {
  let data
  try {
    data = JSON.parse(readFileSync(join(OWNERSHIP_DIR, entry.name), 'utf8'))
  } catch {
    continue // check-ownership reports a file that is not JSON
  }
  for (const ledger of ledgers) {
    const access = data?.models?.[ledger.model]?.access ?? {}
    for (const [role, grant] of Object.entries(access)) {
      const granted = (grant?.privileges ?? []).filter((privilege) => privilege === 'update' || privilege === 'delete')
      if (granted.length > 0) {
        violations.push(`packages/factory-db/ownership/${entry.name}: ${ledger.model} is append-only, but ${role} is granted ${granted.join(' and ')}`)
      }
    }
  }
}

// --- 2. migrations ------------------------------------------------------------------------------------------------
const stripSql = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
const migrations = listDir(MIGRATIONS_DIR)
  .filter((entry) => entry.isDirectory() && existsSync(join(MIGRATIONS_DIR, entry.name, 'migration.sql')))
  .map((entry) => entry.name)
  .sort()
  .map((folder) => ({ folder, sql: stripSql(readFileSync(join(MIGRATIONS_DIR, folder, 'migration.sql'), 'utf8')) }))
const all = migrations.map((migration) => migration.sql).join('\n')
const ident = (name) => `(?:"${escape(name)}"|${escape(name)}\\b)`
const tableRef = (table) => `(?:(?:"public"|public)\\s*\\.\\s*)?${ident(table)}`
const NAME = `("(?:[^"]+)"|[A-Za-z_]\\w*)`
const unquote = (name) => name.replace(/^"|"$/g, '')

function functionRaises(fn) {
  const definitions = [
    ...all.matchAll(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:(?:"public"|public)\\s*\\.\\s*)?${ident(fn)}\\s*\\(\\s*\\)[\\s\\S]*?\\$(\\w*)\\$([\\s\\S]*?)\\$\\1\\$`, 'gi')),
  ]
  const last = definitions.at(-1)
  return last !== undefined && /\bRAISE\s+EXCEPTION\b/i.test(last[2])
}

for (const ledger of ledgers) {
  const where = `packages/factory-db/prisma/migrations: ${ledger.model} ("${ledger.table}")`
  const wanted = [
    { what: 'row trigger BEFORE UPDATE OR DELETE', events: '(?:UPDATE\\s+OR\\s+DELETE|DELETE\\s+OR\\s+UPDATE)', each: 'ROW' },
    { what: 'statement trigger BEFORE TRUNCATE', events: 'TRUNCATE', each: 'STATEMENT' },
  ]
  for (const { what, events, each } of wanted) {
    const pattern = new RegExp(
      `CREATE\\s+(?:OR\\s+REPLACE\\s+)?TRIGGER\\s+${NAME}\\s+BEFORE\\s+${events}\\s+ON\\s+${tableRef(ledger.table)}\\s+FOR\\s+EACH\\s+${each}\\s+EXECUTE\\s+(?:FUNCTION|PROCEDURE)\\s+(?:(?:"public"|public)\\s*\\.\\s*)?${NAME}\\s*\\(\\s*\\)`,
      'i',
    )
    const found = pattern.exec(all)
    if (!found) {
      violations.push(`${where} has no ${what} (write it in a hand-written migration of the module)`)
      continue
    }
    const [trigger, fn] = [unquote(found[1]), unquote(found[2])]
    if (!functionRaises(fn)) violations.push(`${where}: the function ${fn} of trigger ${trigger} does not RAISE EXCEPTION`)
    if (new RegExp(`DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?(?:(?:"public"|public)\\s*\\.\\s*)?${ident(fn)}`, 'i').test(all)) {
      violations.push(`${where}: a migration drops the function ${fn} of trigger ${trigger}`)
    }
    if (new RegExp(`DROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?${ident(trigger)}`, 'i').test(all)) {
      violations.push(`${where}: a migration drops trigger ${trigger}`)
    }
  }
  if (new RegExp(`ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?${tableRef(ledger.table)}[^;]*\\bDISABLE\\s+TRIGGER\\b`, 'i').test(all)) {
    violations.push(`${where}: a migration disables a trigger of the table`)
  }
}

// --- 3. code ------------------------------------------------------------------------------------------------------
/** Blanks comments, keeps strings (SQL lives in them) and line breaks. */
function stripComments(source) {
  let out = ''
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      out += source.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1
      out += source.slice(i, j + 1)
      i = j + 1
    } else {
      out += c
      i++
    }
  }
  return out
}

function codeFiles(dir) {
  return listDir(dir).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : codeFiles(path)
    return /\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !TEST.test(entry.name) ? [path] : []
  })
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length
let scanned = 0
for (const file of CODE_DIRS.flatMap((dir) => codeFiles(join(ROOT, dir)))) {
  scanned++
  const code = stripComments(readFileSync(file, 'utf8'))
  for (const ledger of ledgers) {
    const delegate = ledger.model.charAt(0).toLowerCase() + ledger.model.slice(1)
    const call = new RegExp(`\\b${escape(delegate)}\\s*\\??\\.\\s*(${WRITES.join('|')})\\s*\\(`, 'g')
    for (const match of code.matchAll(call)) {
      violations.push(`${shown(file)}:${lineOf(code, match.index)}  ${delegate}.${match[1]}() on the append-only ${ledger.model}; write a new row instead`)
    }
    const sql = new RegExp(`\\b(UPDATE|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?)\\s+(?:ONLY\\s+)?(?:\\\\?"?public\\\\?"?\\s*\\.\\s*)?\\\\?"?${escape(ledger.table)}\\b`, 'gi')
    for (const match of code.matchAll(sql)) {
      violations.push(`${shown(file)}:${lineOf(code, match.index)}  SQL ${match[1].toUpperCase().replace(/\s+/g, ' ')} on the append-only ${ledger.table}`)
    }
  }
}

if (violations.length > 0) {
  console.error(`check-append-only: ${violations.length} violation(s)\n  ${violations.join('\n  ')}`)
  process.exit(1)
}
console.log(
  `check-append-only: ok (${ledgers.length} append-only model(s): ${ledgers.map((ledger) => ledger.model).join(', ')}; ` +
    `no update or delete grant, refusing triggers in the migrations, no update or delete in ${scanned} source file(s))`,
)
