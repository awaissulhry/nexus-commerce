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

// Speed (end check 11-19): the migrations are ~90 MB of SQL (the policy migrations write every policy again), and each
// ledger's patterns used to read all of it, ~8 times per ledger. Every pattern below starts with a statement head, so
// the heads are found once (one pass each) and a pattern is tried, sticky, only where one starts: the same matches as a
// search of the whole text (a match can start nowhere else, and no head can start inside another), in the same order.
const headsOf = (head) => [...all.matchAll(new RegExp(head, 'gi'))].map((match) => match.index)
const CREATE_HEADS = headsOf('CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:TRIGGER|FUNCTION)\\s')
const DROP_HEADS = headsOf('DROP\\s+(?:FUNCTION|TRIGGER)\\s')
// `[^;]*` cannot pass a semicolon: an ALTER TABLE can disable a trigger only when its own text, up to the next one, says so.
const DISABLE_HEADS = headsOf('ALTER\\s+TABLE\\s').filter((start) => {
  const end = all.indexOf(';', start)
  return /\bDISABLE\s+TRIGGER\b/i.test(all.slice(start, end === -1 ? undefined : end))
})
/** Every match of `source` (case-insensitive) in the migrations, as matchAll finds them: tried at `heads` only. */
function matchesAt(heads, source, first = false) {
  const sticky = new RegExp(source, 'iy')
  const found = []
  let end = 0
  for (const start of heads) {
    if (start < end) continue
    sticky.lastIndex = start
    const match = sticky.exec(all)
    if (!match) continue
    found.push(match)
    if (first) break
    end = start + match[0].length
  }
  return found
}
const firstAt = (heads, source) => matchesAt(heads, source, true)[0] ?? null

function functionRaises(fn) {
  const definitions = matchesAt(
    CREATE_HEADS,
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:(?:"public"|public)\\s*\\.\\s*)?${ident(fn)}\\s*\\(\\s*\\)[\\s\\S]*?\\$(\\w*)\\$([\\s\\S]*?)\\$\\1\\$`,
  )
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
    const found = firstAt(
      CREATE_HEADS,
      `CREATE\\s+(?:OR\\s+REPLACE\\s+)?TRIGGER\\s+${NAME}\\s+BEFORE\\s+${events}\\s+ON\\s+${tableRef(ledger.table)}\\s+FOR\\s+EACH\\s+${each}\\s+EXECUTE\\s+(?:FUNCTION|PROCEDURE)\\s+(?:(?:"public"|public)\\s*\\.\\s*)?${NAME}\\s*\\(\\s*\\)`,
    )
    if (!found) {
      violations.push(`${where} has no ${what} (write it in a hand-written migration of the module)`)
      continue
    }
    const [trigger, fn] = [unquote(found[1]), unquote(found[2])]
    if (!functionRaises(fn)) violations.push(`${where}: the function ${fn} of trigger ${trigger} does not RAISE EXCEPTION`)
    if (firstAt(DROP_HEADS, `DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?(?:(?:"public"|public)\\s*\\.\\s*)?${ident(fn)}`)) {
      violations.push(`${where}: a migration drops the function ${fn} of trigger ${trigger}`)
    }
    if (firstAt(DROP_HEADS, `DROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?${ident(trigger)}`)) {
      violations.push(`${where}: a migration drops trigger ${trigger}`)
    }
  }
  if (firstAt(DISABLE_HEADS, `ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?${tableRef(ledger.table)}[^;]*\\bDISABLE\\s+TRIGGER\\b`)) {
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
// Speed (end check 11-19): each ledger's two patterns, built once. A file is read for them only where a write on SOME
// ledger can start (a lookahead, so no position is skipped), and each ledger's own pattern is tried there, sticky, as
// matchAll would find it. A file with no write call and no UPDATE / DELETE FROM / TRUNCATE at all is not read further.
const WRITE_LIST = WRITES.join('|')
const SQL_HEAD = 'UPDATE|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?'
const SQL_TABLE = '(?:\\\\?"?public\\\\?"?\\s*\\.\\s*)?\\\\?"?'
const patterns = ledgers.map((ledger) => {
  const delegate = ledger.model.charAt(0).toLowerCase() + ledger.model.slice(1)
  return {
    ledger,
    delegate,
    call: new RegExp(`\\b${escape(delegate)}\\s*\\??\\.\\s*(${WRITE_LIST})\\s*\\(`, 'y'),
    sql: new RegExp(`\\b(${SQL_HEAD})\\s+(?:ONLY\\s+)?${SQL_TABLE}${escape(ledger.table)}\\b`, 'iy'),
  }
})
const ANY_CALL = new RegExp(`\\.\\s*(?:${WRITE_LIST})\\s*\\(`)
const ANY_SQL = new RegExp(`\\b(?:${SQL_HEAD})\\s`, 'i')
const CALL_AT = new RegExp(`\\b(?=(?:${patterns.map((entry) => escape(entry.delegate)).join('|')})\\s*\\??\\.\\s*(?:${WRITE_LIST})\\s*\\()`, 'g')
const SQL_AT = new RegExp(`\\b(?=(?:${SQL_HEAD})\\s+(?:ONLY\\s+)?${SQL_TABLE}(?:${ledgers.map((ledger) => escape(ledger.table)).join('|')})\\b)`, 'gi')
const startsOf = (code, test, at) => (test.test(code) ? [...code.matchAll(at)].map((match) => match.index) : [])
function* stickyMatches(pattern, code, starts) {
  let end = 0
  for (const start of starts) {
    if (start < end) continue
    pattern.lastIndex = start
    const match = pattern.exec(code)
    if (!match) continue
    end = start + match[0].length
    yield match
  }
}
let scanned = 0
for (const file of CODE_DIRS.flatMap((dir) => codeFiles(join(ROOT, dir)))) {
  scanned++
  const code = stripComments(readFileSync(file, 'utf8'))
  const callStarts = startsOf(code, ANY_CALL, CALL_AT)
  const sqlStarts = startsOf(code, ANY_SQL, SQL_AT)
  if (callStarts.length === 0 && sqlStarts.length === 0) continue
  for (const { ledger, delegate, call, sql } of patterns) {
    for (const match of stickyMatches(call, code, callStarts)) {
      violations.push(`${shown(file)}:${lineOf(code, match.index)}  ${delegate}.${match[1]}() on the append-only ${ledger.model}; write a new row instead`)
    }
    for (const match of stickyMatches(sql, code, sqlStarts)) {
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
