/**
 * GDS — a FORGIVING tokeniser for the formula editor's display layer (#730).
 *
 * 🔴 This is not a parser and it is never the authority on whether a formula is valid. The server's
 * `expr.ts` decides that, and its preview endpoint says so; this exists to answer "what is this run
 * of characters" while the operator is still typing, so the editor can colour it, outline the cells
 * a formula reads, and know which call the caret sits in. A client that decided validity here would
 * be the banked `reference_preview_must_run_the_engine` trap wearing a syntax highlighter.
 *
 * It differs from the server's lexer in exactly one way, deliberately: **it never throws.** Half a
 * string, a lone `$`, an unclosed `{{` are all normal mid-typing states, and an editor that stopped
 * colouring at the first of them would go blank exactly when the operator most needs to see what
 * they are writing. Those tokens come back marked `unterminated` instead.
 *
 * Token BOUNDARIES follow `expr.ts:59` exactly — `$a.b`, `${…}`, `$[…]`, `{{…}}`, two-char
 * operators before one-char, identifiers separate from refs — because the colour of a run and the
 * server's opinion of it must not disagree. Where the server would throw, this yields a token and
 * lets the preview line carry the error.
 */

export type TokenKind =
  /** `$brand`, `$a.b`, `${a b}`, `{{ a }}` — the things that read a cell. */
  | 'ref'
  /** A quoted literal. */
  | 'str'
  | 'num'
  /** A bare word: a function name, or a keyword. */
  | 'ident'
  | 'op'
  /** `(`, `)`, `,` */
  | 'punc'
  | 'ws'
  /** A character the language has no rule for. Coloured as an error; the server names it. */
  | 'error'

export interface Token {
  kind: TokenKind
  /** Offset of the first character, into the expression AS TYPED (the `=` already stripped). */
  start: number
  /** Offset one past the last character. */
  end: number
  /** The exact source slice. Concatenating every token's text reproduces the input. */
  text: string
  /** For a `ref`, the attribute name without its sigil and braces. For a `str`, the raw inner text. */
  value?: string
  /** A string or brace-reference the operator has not closed yet. Normal while typing. */
  unterminated?: boolean
}

const TWO_CHAR_OPS = new Set(['==', '!=', '<>', '<=', '>=', '&&', '||'])
const ONE_CHAR_OPS = new Set(['+', '-', '*', '/', '%', '<', '>', '=', '!', '&'])
const isIdentChar = (c: string) => /[A-Za-z0-9_.]/.test(c)

/**
 * Tokenise for display. Never throws; every character of `src` belongs to exactly one token, so a
 * renderer can rebuild the input from the tokens alone and cannot silently drop what it cannot
 * colour.
 */
export function tokenizeForDisplay(src: string): Token[] {
  const out: Token[] = []
  const push = (kind: TokenKind, start: number, end: number, extra?: Partial<Token>) =>
    out.push({ kind, start, end, text: src.slice(start, end), ...extra })
  let i = 0

  while (i < src.length) {
    const c = src[i]
    const start = i

    if (/\s/.test(c)) {
      while (i < src.length && /\s/.test(src[i])) i++
      push('ws', start, i)
      continue
    }

    // ── references: $name, $a.b, ${…}, $[…], {{ … }} ──────────────
    if (c === '$') {
      i++
      const brace = src[i] === '{' ? '}' : src[i] === '[' ? ']' : null
      if (brace) {
        i++
        const from = i
        while (i < src.length && src[i] !== brace) i++
        const closed = i < src.length
        const value = src.slice(from, i).trim()
        if (closed) i++
        push('ref', start, i, { value, ...(closed ? {} : { unterminated: true }) })
        continue
      }
      const from = i
      while (i < src.length && isIdentChar(src[i])) i++
      if (i === from) {
        /* A bare `$` is not an error yet — it is the keystroke that opens the autocomplete. It is a
           `ref` with an empty value so the editor can colour it and offer completions; the server
           says "`$` must be followed by an attribute name" only once the formula is submitted. */
        push('ref', start, i, { value: '' })
        continue
      }
      // A trailing dot is punctuation, not part of the path — `$a.` reads as `a`, per expr.ts.
      let name = src.slice(from, i)
      let end = i
      while (name.endsWith('.')) { name = name.slice(0, -1); end-- }
      push('ref', start, i, { value: name })
      void end
      continue
    }

    if (c === '{' && src[i + 1] === '{') {
      i += 2
      const from = i
      while (i < src.length && !(src[i] === '}' && src[i + 1] === '}')) i++
      const closed = i < src.length
      const value = src.slice(from, i).trim()
      if (closed) i += 2
      push('ref', start, i, { value, ...(closed ? {} : { unterminated: true }) })
      continue
    }

    // ── strings ───────────────────────────────────────────────────
    if (c === '"' || c === "'") {
      i++
      let buf = ''
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\' && i + 1 < src.length) { buf += src[i + 1]; i += 2; continue }
        buf += src[i]
        i++
      }
      const closed = i < src.length
      if (closed) i++
      push('str', start, i, { value: buf, ...(closed ? {} : { unterminated: true }) })
      continue
    }

    // ── numbers ───────────────────────────────────────────────────
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      while (i < src.length && /[0-9.]/.test(src[i])) i++
      push('num', start, i)
      continue
    }

    // ── identifiers: function names and keywords ──────────────────
    if (/[A-Za-z_]/.test(c)) {
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++
      push('ident', start, i)
      continue
    }

    // ── operators and punctuation ─────────────────────────────────
    if (src.slice(i, i + 3) === '===' || src.slice(i, i + 3) === '!==') { i += 3; push('op', start, i); continue }
    if (TWO_CHAR_OPS.has(src.slice(i, i + 2))) { i += 2; push('op', start, i); continue }
    if (ONE_CHAR_OPS.has(c)) { i++; push('op', start, i); continue }
    if (c === '(' || c === ')' || c === ',') { i++; push('punc', start, i); continue }

    i++
    push('error', start, i)
  }
  return out
}

/** Every `ref` token, in source order — what the editor outlines and colours. */
export const refsOf = (tokens: readonly Token[]): Token[] => tokens.filter((t) => t.kind === 'ref')

export interface BracketMatch {
  /** Offsets of the pair the caret is touching, when there is one. */
  pair?: [number, number]
  /** Offsets of every bracket with no partner — coloured as an error, never silently. */
  unmatched: number[]
}

/**
 * Bracket matching for the caret, and the unmatched ones wherever they are.
 *
 * 🔴 Unmatched brackets are reported even when the caret is elsewhere. An editor that only
 * highlights the pair under the cursor leaves a missing `)` invisible until the operator happens to
 * stand next to it, and the server's message ("unexpected end") points at the end of the line rather
 * than at the bracket that opened.
 */
export function matchBrackets(tokens: readonly Token[], caret: number): BracketMatch {
  const stack: number[] = []
  const pairs = new Map<number, number>()
  const unmatched: number[] = []
  for (const t of tokens) {
    if (t.kind !== 'punc') continue
    if (t.text === '(') stack.push(t.start)
    else if (t.text === ')') {
      const open = stack.pop()
      if (open == null) unmatched.push(t.start)
      else { pairs.set(open, t.start); pairs.set(t.start, open) }
    }
  }
  unmatched.push(...stack)
  unmatched.sort((a, b) => a - b)

  // The caret "touches" a bracket when it sits either side of it.
  for (const [a, b] of pairs) {
    if (caret === a || caret === a + 1) return { pair: a < b ? [a, b] : [b, a], unmatched }
  }
  return { unmatched }
}

export interface CallContext {
  /** The function name as typed. */
  name: string
  /** Offset of the name token — the hint anchors here. */
  nameStart: number
  /** Which argument the caret is in, 0-based. */
  argIndex: number
}

/**
 * Which function call the caret is inside, for the signature hint.
 *
 * Innermost wins: in `if(upper($a), …)` with the caret in `upper`'s parentheses, the hint is
 * `upper`'s. Commas are counted only at THIS call's depth, so `if(a, upper(b, c), d)` reports
 * argument 1 for `if`, never 2 — the inner call's comma belongs to the inner call.
 */
export function callAt(tokens: readonly Token[], caret: number): CallContext | null {
  const open: Array<{ name: string; nameStart: number; args: number }> = []
  for (let n = 0; n < tokens.length; n++) {
    const t = tokens[n]
    if (t.start >= caret) break
    if (t.kind === 'punc' && t.text === '(') {
      // The identifier immediately before the `(` names the call; a bare `(` is just grouping.
      let p = n - 1
      while (p >= 0 && tokens[p].kind === 'ws') p--
      const id = p >= 0 && tokens[p].kind === 'ident' ? tokens[p] : null
      open.push(id ? { name: id.text, nameStart: id.start, args: 0 } : { name: '', nameStart: -1, args: 0 })
    } else if (t.kind === 'punc' && t.text === ')') {
      open.pop()
    } else if (t.kind === 'punc' && t.text === ',' && open.length > 0) {
      open[open.length - 1].args++
    }
  }
  for (let k = open.length - 1; k >= 0; k--) {
    if (open[k].name) return { name: open[k].name, nameStart: open[k].nameStart, argIndex: open[k].args }
  }
  return null
}
