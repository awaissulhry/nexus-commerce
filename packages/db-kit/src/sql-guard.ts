import { TenantScopeError } from './scope'

/**
 * The raw-SQL guard. The tenant adapter runs `checkStatement` on EVERY statement it is given (Prisma's own and raw SQL)
 * before it reaches the server. A statement passes only if it is ONE plain query that cannot change or escape the
 * transaction's scope:
 *   - it starts with SELECT, INSERT, UPDATE, DELETE or WITH (COMMIT and ROLLBACK, the whole statement, are reported as
 *     transaction control; the adapter allows them only where Prisma's engine sends them);
 *   - no second statement (a `;` only at the very end);
 *   - no name that changes settings or runs SQL from a string: set_config, pg_settings (an UPDATE on it is SET),
 *     query_to_xml and friends, ts_stat, ts_rewrite, dblink, large objects;
 *   - no `SELECT … INTO` (it creates a table, a temporary one survives on a pooled connection);
 *   - no `$` other than a `$1` placeholder (dollar quoting could hide text from this guard) and no `U&` escapes (they
 *     can spell a forbidden name).
 *
 * The lexer follows PostgreSQL's: nested block comments, `''` and E'…' escapes, quoted identifiers (checked like plain
 * names). A plain '…' string is read twice, as standard_conforming_strings on and off; the statement must pass both
 * readings, so a backslash cannot make this guard see a literal where the server sees code.
 *
 * This is a static check and the first wall. The database is the second: see `lockSetConfigSql` (policy-sql.ts).
 */

export type StatementKind = 'query' | 'commit' | 'rollback'

const QUERY_STARTS = new Set(['select', 'insert', 'update', 'delete', 'with'])
const FORBIDDEN_NAMES = new Set([
  'set_config',
  'pg_settings',
  'query_to_xml',
  'query_to_xmlschema',
  'query_to_xml_and_xmlschema',
  'cursor_to_xml',
  'cursor_to_xmlschema',
  'ts_stat',
  'ts_rewrite',
  'dblink',
  'dblink_exec',
  'loread',
  'lowrite',
])
const forbiddenName = (name: string): boolean => FORBIDDEN_NAMES.has(name) || name.startsWith('lo_') || name.startsWith('dblink_')

type Token = { kind: 'word'; text: string; quoted: boolean } | { kind: 'punct'; text: string } | { kind: 'literal' } | { kind: 'param' }

const refuse = (reason: string): never => {
  throw new TenantScopeError('statement_refused', `Statement refused by the tenant scope: ${reason}.`)
}

const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80

/** PostgreSQL's tokens, coarse: words (plain or quoted), literals, `$n` placeholders, single punctuation characters. */
function tokenize(sql: string, backslashEscapes: boolean): Token[] {
  const tokens: Token[] = []
  const n = sql.length
  let i = 0
  const readString = (escapes: boolean): void => {
    // sql[i] is the opening quote.
    i++
    for (;;) {
      if (i >= n) refuse('an unterminated string')
      const c = sql[i]
      if (escapes && c === '\\') {
        i += 2
        continue
      }
      if (c === "'") {
        if (sql[i + 1] === "'") {
          i += 2
          continue
        }
        i++
        break
      }
      i++
    }
    tokens.push({ kind: 'literal' })
  }
  while (i < n) {
    const c = sql[i] as string
    const next = sql[i + 1]
    if (/\s/.test(c)) {
      i++
    } else if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i++
    } else if (c === '/' && next === '*') {
      let depth = 1
      i += 2
      while (depth > 0) {
        if (i >= n) refuse('an unterminated comment')
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else i++
      }
    } else if (c === "'") {
      readString(backslashEscapes)
    } else if (c === '"') {
      let text = ''
      i++
      for (;;) {
        if (i >= n) refuse('an unterminated quoted identifier')
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            text += '"'
            i += 2
            continue
          }
          i++
          break
        }
        text += sql[i]
        i++
      }
      tokens.push({ kind: 'word', text, quoted: true })
    } else if (c === '$') {
      if (next === undefined || !/[0-9]/.test(next)) refuse('a "$" that is not a $n placeholder')
      i++
      while (i < n && /[0-9]/.test(sql[i] as string)) i++
      tokens.push({ kind: 'param' })
    } else if (isIdentStart(c)) {
      const start = i
      while (i < n && isIdentPart(sql[i] as string)) i++
      const word = sql.slice(start, i)
      const lower = word.toLowerCase()
      if (lower === 'u' && sql[i] === '&') refuse('a U& escape')
      if (sql[i] === "'" && lower === 'e') {
        readString(true)
      } else if (sql[i] === "'" && (lower === 'x' || lower === 'b' || lower === 'n')) {
        readString(backslashEscapes)
      } else {
        tokens.push({ kind: 'word', text: word, quoted: false })
      }
    } else if (/[0-9]/.test(c) || (c === '.' && next !== undefined && /[0-9]/.test(next))) {
      i++
      while (i < n && /[0-9A-Za-z_.]/.test(sql[i] as string)) i++
      tokens.push({ kind: 'literal' })
    } else {
      tokens.push({ kind: 'punct', text: c })
      i++
    }
  }
  return tokens
}

function classify(tokens: Token[]): StatementKind {
  const body = tokens.at(-1)?.kind === 'punct' && (tokens.at(-1) as { text: string }).text === ';' ? tokens.slice(0, -1) : tokens
  const first = body[0]
  if (first === undefined) return refuse('an empty statement')
  if (body.some((token) => token.kind === 'punct' && token.text === ';')) refuse('more than one statement')
  if (first.kind !== 'word' || first.quoted) return refuse('a statement that does not start with a keyword')
  const keyword = first.text.toLowerCase()
  if (body.length === 1 && (keyword === 'commit' || keyword === 'rollback')) return keyword
  if (!QUERY_STARTS.has(keyword)) refuse(`a ${keyword.toUpperCase()} statement (only SELECT, INSERT, UPDATE, DELETE and WITH)`)
  body.forEach((token, index) => {
    if (token.kind !== 'word') return
    const name = token.text.toLowerCase()
    if (forbiddenName(name)) refuse(`the name ${name}`)
    if (!token.quoted && name === 'into') {
      const before = body[index - 1]
      if (before?.kind !== 'word' || before.quoted || before.text.toLowerCase() !== 'insert') refuse('SELECT … INTO')
    }
  })
  return 'query'
}

/**
 * Throws `TenantScopeError('statement_refused')` unless the statement is one plain query or the bare COMMIT or ROLLBACK
 * that Prisma's engine sends to end a transaction; returns which of the three it is.
 */
export function checkStatement(sql: string): StatementKind {
  if (typeof sql !== 'string') return refuse('no statement text')
  const standard = classify(tokenize(sql, false))
  const escaped = classify(tokenize(sql, true))
  if (standard !== escaped) refuse('a statement that reads differently with backslash escapes')
  return standard
}
