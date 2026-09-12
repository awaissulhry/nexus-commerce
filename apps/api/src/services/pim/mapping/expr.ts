/**
 * PES.6.3 — the mapping formula engine.
 *
 * Rithum's template editor authors a channel field's value as an expression:
 *
 *     if(isblank($itemasin), "ean", "upc")
 *     $Brand + " " + $Title
 *     margin($basePrice, 20)                    ← "SE_AS_Price - 20% Margin"
 *
 * This is that language. It is a hand-written tokenizer + Pratt parser + tree-walking
 * evaluator — deliberately NOT `eval`, `new Function`, or a regex substitution:
 *   - an operator authors these, and an operator's typo must produce a warning on one cell,
 *     never a thrown 500 that takes the whole preview down;
 *   - the same string is stored in `Marketplace.schemaMapping` and replayed at PUBLISH time,
 *     so it must be as inert as data.
 *
 * It plugs into the EXISTING pipeline as one more `TransformOp` (`{type:'expr'}`), which means
 * `resolveChannelField` → `payload-preview` → `publish-validator` → `mapping-simulate` all get it
 * for free, and "what you preview == what ships" keeps holding. It never reads the database; the
 * caller hands it a value lookup.
 *
 * FAILURE MODEL — never throw. `evaluate()` returns `{ value: null, error }` and the resolver
 * turns that into a cell warning. A field whose formula is broken reads as UNRESOLVED, never as
 * a silently-empty success (reference_empty_column_four_causes).
 */

// ────────────────────────────────────────────────────────────────────
// Tokens
// ────────────────────────────────────────────────────────────────────

type TokKind = 'num' | 'str' | 'ident' | 'ref' | 'op' | 'punc' | 'eof'

interface Tok {
  kind: TokKind
  value: string
  /** Character offset in the source, for error messages. */
  pos: number
}

export class ExprSyntaxError extends Error {
  constructor(message: string, readonly pos: number) {
    super(message)
    this.name = 'ExprSyntaxError'
  }
}

const TWO_CHAR_OPS = new Set(['==', '!=', '<>', '<=', '>=', '&&', '||'])
const ONE_CHAR_OPS = new Set(['+', '-', '*', '/', '%', '<', '>', '=', '!', '&'])

/** `$foo`, `$foo.bar`, `{{ foo.bar }}` — a reference to a resolved attribute. */
function isRefStart(src: string, i: number): boolean {
  return src[i] === '$' || (src[i] === '{' && src[i + 1] === '{')
}

function isIdentChar(c: string): boolean {
  return /[A-Za-z0-9_.]/.test(c)
}

function tokenize(src: string): Tok[] {
  if (src.length > 16_384) throw new ExprSyntaxError('This formula is too long. Keep it under 16,384 characters.', 16_384)
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }

    // ── references ────────────────────────────────────────────────
    if (isRefStart(src, i)) {
      const start = i
      if (c === '$') {
        i++
        // `${...}` / `$[...]` allow spaces + punctuation in an attribute name.
        if (src[i] === '{' || src[i] === '[') {
          const close = src[i] === '{' ? '}' : ']'
          i++
          const from = i
          while (i < src.length && src[i] !== close) i++
          if (i >= src.length) throw new ExprSyntaxError(`unterminated ${c}${close === '}' ? '{' : '['} reference`, start)
          out.push({ kind: 'ref', value: src.slice(from, i).trim(), pos: start })
          i++ // closing brace
          continue
        }
        const from = i
        while (i < src.length && isIdentChar(src[i])) i++
        if (i === from) throw new ExprSyntaxError('`$` must be followed by an attribute name', start)
        // A trailing dot is punctuation, not part of the path (`$a.` → `a`).
        let name = src.slice(from, i)
        while (name.endsWith('.')) {
          name = name.slice(0, -1)
          i--
        }
        out.push({ kind: 'ref', value: name, pos: start })
        continue
      }
      // `{{ … }}`
      i += 2
      const from = i
      while (i < src.length && !(src[i] === '}' && src[i + 1] === '}')) i++
      if (i >= src.length) throw new ExprSyntaxError('unterminated `{{` reference', start)
      out.push({ kind: 'ref', value: src.slice(from, i).trim(), pos: start })
      i += 2
      continue
    }

    // ── strings ───────────────────────────────────────────────────
    if (c === '"' || c === "'") {
      const quote = c
      const start = i
      i++
      let buf = ''
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const esc = src[i + 1]
          buf += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc
          i += 2
          continue
        }
        buf += src[i]
        i++
      }
      if (i >= src.length) throw new ExprSyntaxError('unterminated string literal', start)
      i++ // closing quote
      out.push({ kind: 'str', value: buf, pos: start })
      continue
    }

    // ── numbers ───────────────────────────────────────────────────
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const start = i
      while (i < src.length && /[0-9.]/.test(src[i])) i++
      const raw = src.slice(start, i)
      if ((raw.match(/\./g) ?? []).length > 1) throw new ExprSyntaxError(`malformed number "${raw}"`, start)
      out.push({ kind: 'num', value: raw, pos: start })
      continue
    }

    // ── identifiers (function names + keywords) ───────────────────
    if (/[A-Za-z_]/.test(c)) {
      const start = i
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++
      out.push({ kind: 'ident', value: src.slice(start, i), pos: start })
      continue
    }

    // ── operators + punctuation ───────────────────────────────────
    const three = src.slice(i, i + 3)
    if (three === '===' || three === '!==') { out.push({ kind: 'op', value: three, pos: i }); i += 3; continue }
    const two = src.slice(i, i + 2)
    if (TWO_CHAR_OPS.has(two)) {
      out.push({ kind: 'op', value: two, pos: i })
      i += 2
      continue
    }
    if (ONE_CHAR_OPS.has(c)) {
      out.push({ kind: 'op', value: c, pos: i })
      i++
      continue
    }
    if (c === '(' || c === ')' || c === ',') {
      out.push({ kind: 'punc', value: c, pos: i })
      i++
      continue
    }

    throw new ExprSyntaxError(`unexpected character "${c}"`, i)
  }
  out.push({ kind: 'eof', value: '', pos: src.length })
  return out
}

// ────────────────────────────────────────────────────────────────────
// AST
// ────────────────────────────────────────────────────────────────────

export type Node =
  | { t: 'lit'; v: unknown }
  | { t: 'ref'; path: string }
  | { t: 'call'; name: string; args: Node[]; pos: number }
  | { t: 'bin'; op: string; l: Node; r: Node; pos: number }
  | { t: 'un'; op: string; v: Node; pos: number }

/** Binding powers — higher binds tighter. */
const BINDING: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '===': 3, '!==': 3, '==': 3, '!=': 3, '=': 3, '<>': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '&': 5, '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
}

class Parser {
  private i = 0
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.i]
  }
  private next(): Tok {
    return this.toks[this.i++]
  }
  private expect(kind: TokKind, value: string): Tok {
    const t = this.peek()
    if (t.kind !== kind || t.value !== value) {
      throw new ExprSyntaxError(`expected "${value}"${t.kind === 'eof' ? ' but the expression ended' : ` but found "${t.value}"`}`, t.pos)
    }
    return this.next()
  }

  parse(): Node {
    const n = this.parseExpr(0)
    const t = this.peek()
    if (t.kind !== 'eof') throw new ExprSyntaxError(`unexpected "${t.value}"`, t.pos)
    return n
  }

  private parseExpr(minBp: number): Node {
    let left = this.parseUnary()
    for (;;) {
      const t = this.peek()
      if (t.kind !== 'op') break
      const bp = BINDING[t.value]
      if (bp === undefined || bp < minBp) break
      this.next()
      const right = this.parseExpr(bp + 1)
      left = { t: 'bin', op: t.value, l: left, r: right, pos: t.pos }
    }
    return left
  }

  private parseUnary(): Node {
    const t = this.peek()
    if (t.kind === 'op' && (t.value === '-' || t.value === '!')) {
      this.next()
      return { t: 'un', op: t.value, v: this.parseUnary(), pos: t.pos }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): Node {
    const t = this.next()
    switch (t.kind) {
      case 'num':
        return { t: 'lit', v: Number(t.value) }
      case 'str':
        return { t: 'lit', v: t.value }
      case 'ref':
        if (!t.value) throw new ExprSyntaxError('empty attribute reference', t.pos)
        return { t: 'ref', path: t.value }
      case 'ident': {
        const lower = t.value.toLowerCase()
        if (lower === 'true') return { t: 'lit', v: true }
        if (lower === 'false') return { t: 'lit', v: false }
        if (lower === 'null') return { t: 'lit', v: null }
        // Anything else must be a call — a bare word is the classic "forgot the $" typo,
        // and saying so beats resolving it to null.
        if (!(this.peek().kind === 'punc' && this.peek().value === '(')) {
          throw new ExprSyntaxError(
            `unknown name "${t.value}" — attributes need a $ prefix ($${t.value}) and functions need parentheses`,
            t.pos,
          )
        }
        this.next() // '('
        const args: Node[] = []
        if (!(this.peek().kind === 'punc' && this.peek().value === ')')) {
          for (;;) {
            args.push(this.parseExpr(0))
            if (this.peek().kind === 'punc' && this.peek().value === ',') {
              this.next()
              continue
            }
            break
          }
        }
        this.expect('punc', ')')
        return { t: 'call', name: lower, args, pos: t.pos }
      }
      case 'punc':
        if (t.value === '(') {
          const inner = this.parseExpr(0)
          this.expect('punc', ')')
          return inner
        }
        throw new ExprSyntaxError(`unexpected "${t.value}"`, t.pos)
      case 'eof':
        throw new ExprSyntaxError('the expression is empty', t.pos)
      default:
        throw new ExprSyntaxError(`unexpected "${t.value}"`, t.pos)
    }
  }
}

/** Parse an expression. Throws ExprSyntaxError with a character offset. */
export function parseExpr(src: string): Node {
  if (typeof src !== 'string' || src.trim() === '') {
    throw new ExprSyntaxError('the expression is empty', 0)
  }
  return new Parser(tokenize(src)).parse()
}

/** Rename literal rule references using the same lexer as evaluation. Text inside a string
 * and similarly named (case-sensitive) rules must never be rewritten as calls. */
export function renameRuleCalls(src: string, from: string, to: string): string {
  const tokens = tokenize(src)
  let result = src
  for (let i = tokens.length - 4; i >= 0; i--) {
    const [call, open, name, close] = tokens.slice(i, i + 4)
    if (call.kind !== 'ident' || call.value.toLowerCase() !== 'rule' || open.value !== '(' || name.kind !== 'str' || name.value !== from || close.value !== ')') continue
    const end = name.pos + src.slice(name.pos, close.pos).trimEnd().length
    result = result.slice(0, name.pos) + JSON.stringify(to) + result.slice(end)
  }
  return result
}

// ────────────────────────────────────────────────────────────────────
// Evaluation
// ────────────────────────────────────────────────────────────────────

export interface ExprContext {
  /** Resolve `$path` / `{{path}}` against the product. Returns undefined for an unknown path
   *  (which becomes null + a warning), null/'' for a known-but-empty one. */
  lookup: (path: string) => unknown
  /** Resolve `rule("name")` / a named-expression `ref`. Returns the expression BODY. */
  namedExpression?: (name: string) => string | undefined
}

export interface ExprResult {
  value: unknown
  /** Non-fatal notes (unknown attribute, division by zero, …). */
  warnings: string[]
  /** Set when the expression could not produce a value at all. */
  error?: string
}

/** Empty, using the same rule as the rest of the resolver: 0 and false are NOT empty. */
function blank(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'string' && v.trim() === '') return true
  if (Array.isArray(v)) return v.length === 0
  return false
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const cleaned = v.trim().replace(/[\s ]/g, '')
    if (cleaned === '') return null
    // Accept both "1.234,56" and "1,234.56" only when unambiguous; otherwise plain Number().
    const n = Number(cleaned.includes(',') && !cleaned.includes('.') ? cleaned.replace(',', '.') : cleaned)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function asText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map(asText).join(', ')
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return String(v)
}

function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  return !blank(v)
}

/** Deep-equality is not wanted here — operators compare scalars. */
function looseEq(a: unknown, b: unknown): boolean {
  if (blank(a) && blank(b)) return true
  const na = asNumber(a)
  const nb = asNumber(b)
  if (na !== null && nb !== null) return na === nb
  return asText(a).toLowerCase() === asText(b).toLowerCase()
}

interface EvalState {
  ctx: ExprContext
  warnings: string[]
  /** Guards a named expression that references itself. */
  stack: string[]
}

function evalNode(n: Node, s: EvalState): unknown {
  switch (n.t) {
    case 'lit':
      return n.v

    case 'ref': {
      const v = s.ctx.lookup(n.path)
      if (v === undefined) {
        s.warnings.push(`unknown attribute "${n.path}"`)
        return null
      }
      return v
    }

    case 'un': {
      const v = evalNode(n.v, s)
      if (n.op === '!') return !truthy(v)
      const num = asNumber(v)
      if (num === null) {
        s.warnings.push('unary "-" needs a number')
        return null
      }
      return -num
    }

    case 'bin':
      return evalBin(n, s)

    case 'call':
      return evalCall(n, s)
  }
}

function evalBin(n: Extract<Node, { t: 'bin' }>, s: EvalState): unknown {
  // Short-circuit before evaluating the right side.
  if (n.op === '&&') return truthy(evalNode(n.l, s)) ? truthy(evalNode(n.r, s)) : false
  if (n.op === '||') return truthy(evalNode(n.l, s)) ? true : truthy(evalNode(n.r, s))

  const l = evalNode(n.l, s)
  const r = evalNode(n.r, s)

  switch (n.op) {
    case '===':
      return l === r
    case '!==':
      return l !== r
    case '==':
    case '=':
      return looseEq(l, r)
    case '!=':
    case '<>':
      return !looseEq(l, r)
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const a = asNumber(l)
      const b = asNumber(r)
      // A null must never read as a zero here (reference_null_matches_every_lte).
      if (a === null || b === null) {
        s.warnings.push(`"${n.op}" skipped — one side is not a number`)
        return false
      }
      return n.op === '<' ? a < b : n.op === '<=' ? a <= b : n.op === '>' ? a > b : a >= b
    }
    case '&':
      return asText(l) + asText(r)
    case '+': {
      // Numeric when BOTH sides are numeric, concatenation otherwise — the rule an operator
      // expects from `$Brand + " " + $Title`.
      const a = asNumber(l)
      const b = asNumber(r)
      const lNum = typeof l === 'number' || (typeof l === 'string' && a !== null && l.trim() !== '')
      const rNum = typeof r === 'number' || (typeof r === 'string' && b !== null && r.trim() !== '')
      if (lNum && rNum) return (a as number) + (b as number)
      return asText(l) + asText(r)
    }
    case '-':
    case '*':
    case '/':
    case '%': {
      const a = asNumber(l)
      const b = asNumber(r)
      if (a === null || b === null) {
        s.warnings.push(`"${n.op}" needs numbers on both sides`)
        return null
      }
      if ((n.op === '/' || n.op === '%') && b === 0) {
        s.warnings.push('division by zero')
        return null
      }
      return n.op === '-' ? a - b : n.op === '*' ? a * b : n.op === '/' ? a / b : a % b
    }
    default:
      s.warnings.push(`unknown operator "${n.op}"`)
      return null
  }
}

/** Arity check helper — returns an error string or null. */
function arity(name: string, got: number, min: number, max = min): string | null {
  if (got < min || got > max) {
    const want = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min}–${max}`
    return `${name}() takes ${want} argument${want === '1' ? '' : 's'}, got ${got}`
  }
  return null
}

function evalCall(n: Extract<Node, { t: 'call' }>, s: EvalState): unknown {
  const { name, args } = n
  const fail = (msg: string) => {
    s.warnings.push(msg)
    return null
  }
  const a = (i: number) => evalNode(args[i], s)
  const num = (i: number) => asNumber(evalNode(args[i], s))
  const txt = (i: number) => asText(evalNode(args[i], s))

  switch (name) {
    // ── control flow (lazy — only the taken branch is evaluated) ──
    case 'if': {
      const err = arity('if', args.length, 2, 3)
      if (err) return fail(err)
      return truthy(evalNode(args[0], s))
        ? evalNode(args[1], s)
        : args.length === 3
          ? evalNode(args[2], s)
          : null
    }
    case 'ifblank': {
      // §1.6 — `ifblank(a, b)` is exactly `if(isblank(a), b, a)`. It exists because its ABSENCE
      // is the usual source of `#ERROR!` in spreadsheet formulas: an operator reaches for a
      // one-argument fallback, does not find one, and writes something that breaks on an empty
      // value. Lazy in `b`, like `if`.
      const err = arity('ifblank', args.length, 2)
      if (err) return fail(err)
      const v = evalNode(args[0], s)
      return blank(v) ? evalNode(args[1], s) : v
    }
    case 'coalesce': {
      if (args.length < 1) return fail('coalesce() needs at least 1 argument')
      for (const arg of args) {
        const v = evalNode(arg, s)
        if (!blank(v)) return v
      }
      return null
    }

    // ── predicates ────────────────────────────────────────────────
    case 'isblank':
      return arity('isblank', args.length, 1) ? fail(arity('isblank', args.length, 1)!) : blank(a(0))
    case 'notblank':
      return arity('notblank', args.length, 1) ? fail(arity('notblank', args.length, 1)!) : !blank(a(0))
    case 'contains':
      return arity('contains', args.length, 2) ? fail(arity('contains', args.length, 2)!) : txt(0).toLowerCase().includes(txt(1).toLowerCase())
    case 'startswith':
      return arity('startswith', args.length, 2) ? fail(arity('startswith', args.length, 2)!) : txt(0).toLowerCase().startsWith(txt(1).toLowerCase())
    case 'endswith':
      return arity('endswith', args.length, 2) ? fail(arity('endswith', args.length, 2)!) : txt(0).toLowerCase().endsWith(txt(1).toLowerCase())

    // ── text ──────────────────────────────────────────────────────
    case 'concat':
      return args.map((_, i) => txt(i)).join('')
    case 'text':
      return arity('text', args.length, 1) ? fail(arity('text', args.length, 1)!) : txt(0)
    case 'upper':
      return txt(0).toUpperCase()
    case 'lower':
      return txt(0).toLowerCase()
    case 'title':
      return txt(0).replace(/\b\w/g, (c) => c.toUpperCase())
    case 'trim':
      return txt(0).trim()
    case 'len':
      return txt(0).length
    case 'left': {
      const nn = num(1)
      return nn === null ? fail('left() needs a number') : txt(0).slice(0, Math.max(0, nn))
    }
    case 'right': {
      const nn = num(1)
      return nn === null ? fail('right() needs a number') : (nn <= 0 ? '' : txt(0).slice(-nn))
    }
    case 'substr': {
      const start = num(1)
      if (start === null) return fail('substr() needs a start position')
      const count = args.length > 2 ? num(2) : null
      const from = Math.max(0, start)
      return count === null ? txt(0).slice(from) : txt(0).slice(from, from + Math.max(0, count))
    }
    case 'replace': {
      const err = arity('replace', args.length, 3)
      if (err) return fail(err)
      // Literal replace-all. A regex here would be a footgun in an operator's hands.
      return txt(0).split(txt(1)).join(txt(2))
    }
    case 'split': {
      const err = arity('split', args.length, 2, 3)
      if (err) return fail(err)
      const parts = txt(0).split(txt(1))
      if (args.length === 2) return parts
      const idx = num(2)
      return idx === null ? fail('split() index must be a number') : (parts[idx] ?? null)
    }
    case 'join': {
      const err = arity('join', args.length, 2)
      if (err) return fail(err)
      const v = a(0)
      const sep = txt(1)
      return Array.isArray(v) ? v.map(asText).join(sep) : asText(v)
    }
    case 'countryname': {
      const fail = (message: string): never => { throw new Error(message) }
      const err = arity(name, args.length, 2)
      if (err) return fail(err)
      const value = a(0)
      if (blank(value)) return null
      const code = asText(value).trim().toUpperCase()
      if (!/^[A-Z]{2}$/.test(code)) return fail('countryname() needs a two-letter country code')
      try {
        const label = new Intl.DisplayNames([txt(1)], { type: 'region', fallback: 'none' }).of(code)
        return label && label !== code ? label : fail(`countryname() does not recognise ${code}`)
      } catch { return fail('countryname() needs a valid locale and country code') }
    }
    case 'measure': {
      const fail = (message: string): never => { throw new Error(message) }
      const err = arity(name, args.length, 2, 3)
      if (err) return fail(err)
      const amount = a(0), rawUnit = a(1)
      // A default unit alone does not claim that a product has a measured value.
      if (blank(amount)) return null
      if (typeof amount === 'boolean' || asNumber(amount) === null) return fail('measure() needs a numeric value')
      if (blank(rawUnit)) return fail('measure() needs a unit')
      const unit = asText(rawUnit).trim()
      const accepted = args.length === 3 ? txt(2).split('|').filter(Boolean) : []
      // Only spelling aliases, never unit conversion: the numeric value must not change.
      const aliases = [['kg', 'kilogram', 'kilograms'], ['g', 'gram', 'grams'], ['lb', 'lbs', 'pound', 'pounds'],
        ['oz', 'ounce', 'ounces'], ['mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres'],
        ['cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres'], ['m', 'meter', 'meters', 'metre', 'metres'],
        ['in', 'inch', 'inches'], ['ft', 'foot', 'feet']]
      const equivalent = aliases.find(group => group.includes(unit.toLowerCase())) ?? [unit.toLowerCase()]
      const target = accepted.length ? accepted.find(option => option.toLowerCase() === unit.toLowerCase())
        ?? accepted.find(option => equivalent.includes(option.toLowerCase())) : unit
      if (!target) return fail(`measure() unit "${unit}" is not accepted by the channel; convert it explicitly`)
      return { value: asNumber(amount), unit: target }
    }
    case 'pad': {
      // pad(value, width, char) — leading-zero SKUs and the like.
      const width = num(1)
      if (width === null) return fail('pad() needs a width')
      const ch = args.length > 2 ? txt(2) : '0'
      return txt(0).padStart(Math.max(0, width), ch || '0')
    }

    // ── numbers ───────────────────────────────────────────────────
    case 'number': {
      const v = num(0)
      return v === null ? fail(`number() — "${txt(0)}" is not numeric`) : v
    }
    case 'round': {
      const v = num(0)
      if (v === null) return fail('round() needs a number')
      const d = args.length > 1 ? (num(1) ?? 0) : 0
      const f = Math.pow(10, d)
      return Math.round(v * f) / f
    }
    case 'floor':
    case 'ceil':
    case 'abs': {
      const v = num(0)
      if (v === null) return fail(`${name}() needs a number`)
      return name === 'floor' ? Math.floor(v) : name === 'ceil' ? Math.ceil(v) : Math.abs(v)
    }
    case 'min':
    case 'max': {
      const vals: number[] = []
      for (let i = 0; i < args.length; i++) {
        const v = num(i)
        if (v !== null) vals.push(v)
      }
      if (vals.length === 0) return fail(`${name}() got no numbers`)
      return name === 'min' ? Math.min(...vals) : Math.max(...vals)
    }

    // ── commerce helpers ──────────────────────────────────────────
    // The three price formulas an operator actually writes. Spelled out because
    // "price / (1 - 0.2)" is the kind of arithmetic that gets typed wrong once and
    // then ships wrong for a year.
    case 'margin': {
      // Sell price that yields `pct` % GROSS MARGIN on `cost`: cost / (1 - pct/100).
      const cost = num(0)
      const pct = num(1)
      if (cost === null || pct === null) return fail('margin(cost, pct) needs two numbers')
      if (pct >= 100) return fail('margin() percentage must be below 100')
      return cost / (1 - pct / 100)
    }
    case 'markup': {
      // Cost plus `pct` %: cost * (1 + pct/100).
      const cost = num(0)
      const pct = num(1)
      if (cost === null || pct === null) return fail('markup(cost, pct) needs two numbers')
      return cost * (1 + pct / 100)
    }
    case 'discount': {
      const price = num(0)
      const pct = num(1)
      if (price === null || pct === null) return fail('discount(price, pct) needs two numbers')
      return price * (1 - pct / 100)
    }
    case 'vat': {
      // Gross from net (or net from gross with a negative rate is NOT offered — say what you mean).
      const net = num(0)
      const rate = num(1)
      if (net === null || rate === null) return fail('vat(net, ratePct) needs two numbers')
      return net * (1 + rate / 100)
    }
    case 'exvat': {
      const gross = num(0)
      const rate = num(1)
      if (gross === null || rate === null) return fail('exvat(gross, ratePct) needs two numbers')
      if (rate <= -100) return fail('exvat() rate must be above -100')
      return gross / (1 + rate / 100)
    }

    // ── named business rules ──────────────────────────────────────
    case 'rule': {
      const err = arity('rule', args.length, 1)
      if (err) return fail(err)
      const ruleName = txt(0)
      const body = s.ctx.namedExpression?.(ruleName)
      if (body === undefined) return fail(`no business rule named "${ruleName}"`)
      if (s.stack.includes(ruleName)) return fail(`business rule "${ruleName}" refers to itself`)
      let sub: Node
      try {
        sub = parseExpr(body)
      } catch (e: any) {
        return fail(`business rule "${ruleName}" does not parse — ${e?.message ?? 'syntax error'}`)
      }
      s.stack.push(ruleName)
      try {
        return evalNode(sub, s)
      } finally {
        s.stack.pop()
      }
    }

    default:
      return fail(`unknown function "${name}()"`)
  }
}

/**
 * Evaluate an expression string. Never throws: a syntax error comes back as `error`.
 */
export function evaluateExpr(src: string, ctx: ExprContext): ExprResult {
  let ast: Node
  try {
    ast = parseExpr(src)
  } catch (e: any) {
    const at = e instanceof ExprSyntaxError ? ` at character ${e.pos + 1}` : ''
    return { value: null, warnings: [], error: `${e?.message ?? 'syntax error'}${at}` }
  }
  const state: EvalState = { ctx, warnings: [], stack: [] }
  try {
    const value = evalNode(ast, state)
    return { value: value === undefined ? null : value, warnings: state.warnings }
  } catch (e: any) {
    // Defence in depth — evalNode is written not to throw, but a formula must never
    // be able to take down a whole preview.
    return { value: null, warnings: state.warnings, error: `evaluation failed — ${e?.message ?? 'unknown'}` }
  }
}

/**
 * Parse-only check for the editor + the write path. Returns null when valid.
 */
export function validateExpr(src: string): { message: string; pos: number } | null {
  try {
    parseExpr(src)
    return null
  } catch (e: any) {
    return { message: e?.message ?? 'syntax error', pos: e instanceof ExprSyntaxError ? e.pos : 0 }
  }
}

/**
 * Every attribute path an expression reads, and every business rule it calls with a literal name.
 * Drives the editor's "this formula depends on…" list and lets the batch resolver prefetch.
 *
 * Returns **null when the expression does not parse** — deliberately, not an empty list. An empty
 * list is a real answer (`"New"` and `1 + 1` genuinely depend on nothing), so returning it for a
 * broken formula made "unparseable" and "self-contained" indistinguishable, and a stored rule that
 * no longer parses would have listed as having no dependencies instead of being reported as
 * broken. `evaluateExpr` already draws this distinction with its `error`; this now matches it.
 */
/**
 * #723 — every DIRECT `$ref` in `src`, with the character offset it was typed at.
 *
 * Uses the real tokenizer, never a regex over the source. A second scanner for
 * "what counts as a reference" is a mirror of this one and drifts from it the
 * first time either changes — and it would have to re-answer questions the
 * tokenizer already answers (a `$ref` inside a string literal is not a
 * reference; a bracketed `$[a b]` form is one).
 *
 * DIRECT only: a ref pulled in transitively through `rule("name")` has no
 * position in the text the operator typed, and pointing at an offset in someone
 * else's rule body would be worse than pointing nowhere.
 *
 * Returns [] when `src` does not tokenize — the caller already reports syntax
 * errors, and inventing positions for unparseable text helps nobody.
 */
export function exprRefPositions(src: string): Array<{ name: string; pos: number }> {
  try {
    return tokenize(src)
      .filter((t) => t.kind === 'ref')
      .map((t) => ({ name: t.value, pos: t.pos }))
  } catch {
    return []
  }
}

export function exprDependencies(src: string): { attributes: string[]; rules: string[] } | null {
  const attributes = new Set<string>()
  const rules = new Set<string>()
  let ast: Node
  try {
    ast = parseExpr(src)
  } catch {
    return null
  }
  const walk = (n: Node): void => {
    switch (n.t) {
      case 'ref':
        attributes.add(n.path)
        break
      case 'call':
        if (n.name === 'rule' && n.args[0]?.t === 'lit' && typeof n.args[0].v === 'string') {
          rules.add(n.args[0].v)
        }
        n.args.forEach(walk)
        break
      case 'bin':
        walk(n.l)
        walk(n.r)
        break
      case 'un':
        walk(n.v)
        break
      case 'lit':
        break
    }
  }
  walk(ast)
  return { attributes: [...attributes].sort(), rules: [...rules].sort() }
}

/**
 * Transitive dependencies: follow `rule("name")` into each named rule's body and keep walking.
 *
 * `exprDependencies` deliberately lists DIRECT refs only — it takes just a source string and has
 * no way to open a named rule. But "which fields break if I edit this rule?" needs the closure: a
 * business rule referenced THROUGH another rule is invisible to the shallow walk, and a cell
 * formula reading a field that is itself a formula is a second hop again.
 *
 * Cycles are REPORTED, not thrown and not silently truncated — `cycle` names the loop in the order
 * it was entered, so the editor can say which rules form it. The evaluator already refuses a
 * self-referencing rule at run time (`rule()`'s stack guard); this is the same rule at author time.
 *
 * Returns null when `src` itself does not parse — same contract as `exprDependencies`.
 */
export function exprDependenciesDeep(
  src: string,
  expressions: Record<string, string> = {},
): { attributes: string[]; rules: string[]; cycle: string[] | null; unresolved: string[] } | null {
  const direct = exprDependencies(src)
  if (direct === null) return null

  const attributes = new Set<string>(direct.attributes)
  const rules = new Set<string>()
  /** Named rules that are referenced but have no body in `expressions`, or whose body is broken. */
  const unresolved = new Set<string>()
  let cycle: string[] | null = null

  const visit = (name: string, path: string[]): void => {
    if (cycle) return
    if (path.includes(name)) {
      cycle = [...path.slice(path.indexOf(name)), name]
      return
    }
    if (rules.has(name)) return // already expanded on another branch
    rules.add(name)

    const body = expressions[name]
    if (body === undefined) {
      unresolved.add(name)
      return
    }
    const deps = exprDependencies(body)
    if (deps === null) {
      // A referenced rule that no longer parses: named, not silently skipped.
      unresolved.add(name)
      return
    }
    for (const a of deps.attributes) attributes.add(a)
    for (const r of deps.rules) visit(r, [...path, name])
  }

  for (const r of direct.rules) visit(r, [])

  return {
    attributes: [...attributes].sort(),
    rules: [...rules].sort(),
    cycle,
    unresolved: [...unresolved].sort(),
  }
}

/** The function catalogue, for the editor's autocomplete + help. */
export interface ExprFunctionDoc {
  name: string
  signature: string
  group: 'Logic' | 'Text' | 'Number' | 'Pricing' | 'Rules'
  summary: string
}

/**
 * What `$key` reads — §1.6(I). Served alongside the function list so the editor can state it.
 *
 * A reference resolves against the SAME coordinate the formula is being written for:
 *   - master scope  → `resolveAttributes({ product, parent, locale })`, no channel listing. It
 *     never sees a channel layer (verified: no key resolves from `channelOverride`/
 *     `channelExplicit` in a master resolve).
 *   - channel scope → the same resolver WITH that channel's listing, so a per-coordinate override
 *     wins (verified on AMAZON·DE: `title`, `description`, `price`, `bulletPoints` resolve from
 *     `channelExplicit` — the German title, not the master one).
 *
 * ⚠ The resolver LAYERS: `categoryAttributes.<key>` sits above the legacy `Product.<key>` column,
 * so where both exist `$key` is the JSONB attribute. On the GALE fixture `Product.brand` is
 * `"Xavia"` while `categoryAttributes.brand` is `"XAVIA RACING WWW.XAVIARACING.IT"`, and `$brand`
 * is the latter in BOTH scopes — it is master data either way, not a marketplace-facing value.
 * Use `$categoryAttributes.brand` / a distinct key when you need to be unambiguous.
 */
export const EXPR_REFERENCE_HELP = {
  comparison: 'Use === for an exact match and !== for a difference. Text matching is case-sensitive; numbers and text are distinct.',
  syntax: ['$key', '$a.b.c', '{{ key }}', '${key with spaces}'],
  resolvesAgainst:
    "The same coordinate you are editing: a master cell reads the master row; a channel cell reads that channel's resolved value, so an override on that coordinate wins.",
  layering:
    'Attributes layer. `categoryAttributes.<key>` sits above the legacy `Product.<key>` column, so where a product has both, `$key` is the attribute — not the column the sheet may be showing. Reference the full path when you need to be certain which one you mean.',
  unknown:
    'An unknown attribute warns and resolves to nothing rather than failing silently; a formula that produces no value while warning is reported as an error, never as an empty success.',
} as const

export const EXPR_FUNCTIONS: ExprFunctionDoc[] = [
  { name: 'if',        signature: 'if(condition, then, else?)', group: 'Logic',   summary: 'Pick one of two values. Only the taken branch is evaluated.' },
  { name: 'ifblank',   signature: 'ifblank(value, fallback)',    group: 'Logic',   summary: 'The value, or the fallback when it is empty. Short for if(isblank(x), y, x).' },
  { name: 'coalesce',  signature: 'coalesce(a, b, …)',          group: 'Logic',   summary: 'First value that is not empty.' },
  { name: 'isblank',   signature: 'isblank(value)',             group: 'Logic',   summary: 'True when empty. 0 and false are NOT empty.' },
  { name: 'notblank',  signature: 'notblank(value)',            group: 'Logic',   summary: 'The opposite of isblank.' },
  { name: 'contains',  signature: 'contains(text, part)',       group: 'Logic',   summary: 'Case-insensitive substring test.' },
  { name: 'startswith',signature: 'startswith(text, part)',     group: 'Logic',   summary: 'Case-insensitive prefix test.' },
  { name: 'endswith',  signature: 'endswith(text, part)',       group: 'Logic',   summary: 'Case-insensitive suffix test.' },
  { name: 'concat',    signature: 'concat(a, b, …)',            group: 'Text',    summary: 'Join values as text. `&` also joins text; `+` adds numeric values.' },
  { name: 'text',      signature: 'text(value)',                group: 'Text',    summary: 'Force a value to text.' },
  { name: 'upper',     signature: 'upper(text)',                group: 'Text',    summary: 'UPPERCASE.' },
  { name: 'lower',     signature: 'lower(text)',                group: 'Text',    summary: 'lowercase.' },
  { name: 'title',     signature: 'title(text)',                group: 'Text',    summary: 'Title Case.' },
  { name: 'trim',      signature: 'trim(text)',                 group: 'Text',    summary: 'Strip surrounding whitespace.' },
  { name: 'len',       signature: 'len(text)',                  group: 'Text',    summary: 'Character count.' },
  { name: 'left',      signature: 'left(text, n)',              group: 'Text',    summary: 'First n characters.' },
  { name: 'right',     signature: 'right(text, n)',             group: 'Text',    summary: 'Last n characters.' },
  { name: 'substr',    signature: 'substr(text, start, len?)',  group: 'Text',    summary: 'Slice from a 0-based position.' },
  { name: 'replace',   signature: 'replace(text, find, with)',  group: 'Text',    summary: 'Replace every literal occurrence.' },
  { name: 'split',     signature: 'split(text, sep, index?)',   group: 'Text',    summary: 'Split; with an index, take one part.' },
  { name: 'join',      signature: 'join(list, sep)',            group: 'Text',    summary: 'Join a list (e.g. bullet points).' },
  { name: 'countryname', signature: 'countryname(code, locale)', group: 'Text', summary: 'Translate a two-letter country code into its region name.' },
  { name: 'measure', signature: 'measure(value, unit, acceptedUnits?)', group: 'Number', summary: 'Build a value/unit pair. Accepted units are separated by |. Normalises unit spelling without converting amounts.' },
  { name: 'pad',       signature: 'pad(text, width, char?)',    group: 'Text',    summary: 'Left-pad, default "0".' },
  { name: 'number',    signature: 'number(value)',              group: 'Number',  summary: 'Parse to a number.' },
  { name: 'round',     signature: 'round(n, decimals?)',        group: 'Number',  summary: 'Round to decimals (default 0).' },
  { name: 'floor',     signature: 'floor(n)',                   group: 'Number',  summary: 'Round down.' },
  { name: 'ceil',      signature: 'ceil(n)',                    group: 'Number',  summary: 'Round up.' },
  { name: 'abs',       signature: 'abs(n)',                     group: 'Number',  summary: 'Absolute value.' },
  { name: 'min',       signature: 'min(a, b, …)',               group: 'Number',  summary: 'Smallest number.' },
  { name: 'max',       signature: 'max(a, b, …)',               group: 'Number',  summary: 'Largest number.' },
  { name: 'margin',    signature: 'margin(cost, pct)',          group: 'Pricing', summary: 'Sell price giving pct% gross margin: cost / (1 - pct/100).' },
  { name: 'markup',    signature: 'markup(cost, pct)',          group: 'Pricing', summary: 'Cost plus pct%: cost × (1 + pct/100).' },
  { name: 'discount',  signature: 'discount(price, pct)',       group: 'Pricing', summary: 'Price less pct%.' },
  { name: 'vat',       signature: 'vat(net, ratePct)',          group: 'Pricing', summary: 'Add VAT to a net price.' },
  { name: 'exvat',     signature: 'exvat(gross, ratePct)',      group: 'Pricing', summary: 'Strip VAT from a gross price.' },
  { name: 'rule',      signature: 'rule("name")',               group: 'Rules',   summary: 'Run a saved business rule by name.' },
]
