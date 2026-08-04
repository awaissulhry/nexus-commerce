/**
 * RPT.12 — the custom-metric formula compiler.
 *
 * An operator writes `sales - cost` or `(sales - cost) / clicks` and gets a
 * metric that behaves exactly like a built-in one: aggregated in SQL, correct at
 * every grouping, correct in the totals row, and identical in the grid, the
 * export and the scheduled email.
 *
 * ── Safety ─────────────────────────────────────────────────────────────────
 * The formula is operator text that ends up inside a SQL query, so it is NEVER
 * interpolated. It is tokenised, every identifier is looked up in the report's
 * own metric registry, and only numbers, the four arithmetic operators and
 * parentheses are permitted. Anything else — a quote, a semicolon, a function
 * call, an unknown name — is rejected before compilation. The output SQL is
 * assembled solely from the registry's own expressions plus numeric literals
 * the tokeniser has already validated.
 *
 * ── Correctness ────────────────────────────────────────────────────────────
 * Two rules inherited from the engine, and both matter more here than they look:
 *
 * 1. The formula composes AGGREGATE expressions, so `sales - cost` compiles to
 *    `SUM(sales) - SUM(cost)`, not `SUM(sales - cost)` evaluated per row. Those
 *    differ the moment a grouping spans more than one row.
 * 2. Every division is wrapped in NULLIF(divisor, 0), so dividing by zero yields
 *    NULL rather than an error or a silent Infinity — the same rule that makes an
 *    undefined ACOS render as a dash instead of 0%.
 */

export interface FormulaError {
  message: string
  /** Character offset, when the problem is a specific token. */
  position?: number
}

type Token =
  | { kind: 'num'; value: string; pos: number }
  | { kind: 'id'; value: string; pos: number }
  | { kind: 'op'; value: '+' | '-' | '*' | '/'; pos: number }
  | { kind: 'lparen'; pos: number }
  | { kind: 'rparen'; pos: number }

/** Identifiers are metric ids: letters, digits, underscore; must start a letter. */
const ID_RE = /^[A-Za-z][A-Za-z0-9_]*/
const NUM_RE = /^\d+(\.\d+)?/

export function tokenize(input: string): { tokens: Token[]; error: FormulaError | null } {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const c = input[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue }
    if (c === '(') { tokens.push({ kind: 'lparen', pos: i }); i++; continue }
    if (c === ')') { tokens.push({ kind: 'rparen', pos: i }); i++; continue }
    if (c === '+' || c === '-' || c === '*' || c === '/') {
      tokens.push({ kind: 'op', value: c, pos: i }); i++; continue
    }
    const rest = input.slice(i)
    const num = NUM_RE.exec(rest)
    if (num) { tokens.push({ kind: 'num', value: num[0], pos: i }); i += num[0].length; continue }
    const id = ID_RE.exec(rest)
    if (id) { tokens.push({ kind: 'id', value: id[0], pos: i }); i += id[0].length; continue }
    // Everything else — quotes, semicolons, %, commas, anything that could begin
    // a second statement or a function call — is refused here, before any SQL
    // is assembled.
    return { tokens: [], error: { message: `Unexpected character "${c}"`, position: i } }
  }
  return { tokens, error: null }
}

/**
 * Recursive-descent parse into SQL, substituting each identifier for the
 * registry's own aggregate expression.
 *
 *   expr   := term (('+' | '-') term)*
 *   term   := factor (('*' | '/') factor)*
 *   factor := '-'? ( number | identifier | '(' expr ')' )
 */
export function compileFormula(
  formula: string,
  metricSql: Map<string, string>,
): { sql: string | null; error: FormulaError | null; usedMetrics: string[] } {
  const trimmed = (formula ?? '').trim()
  if (!trimmed) return { sql: null, error: { message: 'The formula is empty' }, usedMetrics: [] }
  if (trimmed.length > 500) {
    return { sql: null, error: { message: 'The formula is too long (500 characters max)' }, usedMetrics: [] }
  }

  const { tokens, error } = tokenize(trimmed)
  if (error) return { sql: null, error, usedMetrics: [] }
  if (!tokens.length) return { sql: null, error: { message: 'The formula is empty' }, usedMetrics: [] }

  const used = new Set<string>()
  let pos = 0
  let failure: FormulaError | null = null
  const peek = () => tokens[pos]
  const fail = (message: string, at?: number): null => {
    if (!failure) failure = { message, position: at }
    return null
  }

  function parseExpr(): string | null {
    let left = parseTerm()
    if (left === null) return null
    for (;;) {
      const t = peek()
      if (!t || t.kind !== 'op' || (t.value !== '+' && t.value !== '-')) break
      pos++
      const right = parseTerm()
      if (right === null) return null
      left = `(${left} ${t.value} ${right})`
    }
    return left
  }

  function parseTerm(): string | null {
    let left = parseFactor()
    if (left === null) return null
    for (;;) {
      const t = peek()
      if (!t || t.kind !== 'op' || (t.value !== '*' && t.value !== '/')) break
      pos++
      const right = parseFactor()
      if (right === null) return null
      left = t.value === '*'
        ? `(${left} * ${right})`
        // Division by zero must be NULL, never an error and never Infinity.
        : `(${left} / NULLIF(${right}, 0))`
    }
    return left
  }

  function parseFactor(): string | null {
    const t = peek()
    if (!t) return fail('The formula ends unexpectedly')
    if (t.kind === 'op' && t.value === '-') {
      pos++
      const inner = parseFactor()
      return inner === null ? null : `(-${inner})`
    }
    if (t.kind === 'num') { pos++; return t.value }
    if (t.kind === 'id') {
      pos++
      const sql = metricSql.get(t.value)
      if (!sql) return fail(`"${t.value}" is not a metric on this report`, t.pos)
      used.add(t.value)
      // Cast to numeric so integer metrics divide as decimals rather than
      // truncating — clicks/impressions must not come back 0.
      return `(${sql})::numeric`
    }
    if (t.kind === 'lparen') {
      pos++
      const inner = parseExpr()
      if (inner === null) return null
      const close = peek()
      if (!close || close.kind !== 'rparen') return fail('Missing a closing bracket', t.pos)
      pos++
      return inner
    }
    if (t.kind === 'rparen') return fail('Unexpected closing bracket', t.pos)
    return fail('Could not read the formula')
  }

  const sql = parseExpr()
  if (sql === null || failure) return { sql: null, error: failure, usedMetrics: [...used] }
  if (pos < tokens.length) {
    return { sql: null, error: { message: 'Unexpected trailing input', position: tokens[pos].pos }, usedMetrics: [...used] }
  }
  if (!used.size) {
    return {
      sql: null,
      error: { message: 'A formula must reference at least one metric — a constant is not a metric' },
      usedMetrics: [],
    }
  }
  return { sql, error: null, usedMetrics: [...used] }
}
