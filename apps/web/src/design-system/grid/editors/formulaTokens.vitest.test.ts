/**
 * #730 — the display tokeniser. Each test names what the operator sees wrongly if it is wrong.
 *
 * The governing property is TILING: every character belongs to exactly one token, so a renderer
 * built from these cannot silently drop what it could not colour. It is asserted on every input
 * below rather than once, because a dropped character is invisible until it is the one that matters.
 */
import { describe, expect, it } from 'vitest'

import { callAt, matchBrackets, refsOf, tokenizeForDisplay } from './formulaTokens'

/** Tokenise and assert the tiling property in one step. */
const tok = (src: string) => {
  const ts = tokenizeForDisplay(src)
  expect(ts.map((t) => t.text).join('')).toBe(src)
  for (let i = 1; i < ts.length; i++) expect(ts[i].start).toBe(ts[i - 1].end)
  return ts
}
const kinds = (src: string) => tok(src).filter((t) => t.kind !== 'ws').map((t) => t.kind)

describe('tokenizeForDisplay — boundaries follow the server lexer', () => {
  it('a simple reference', () => {
    expect(tok('$brand')[0]).toMatchObject({ kind: 'ref', value: 'brand', start: 0, end: 6 })
  })

  it('a dotted path is ONE reference', () => {
    expect(tok('$a.b')[0]).toMatchObject({ kind: 'ref', value: 'a.b' })
  })

  it('🔴 a TRAILING dot is punctuation, not part of the name — `$a.` reads as `a`', () => {
    expect(tok('$a.')[0]).toMatchObject({ kind: 'ref', value: 'a' })
  })

  it('brace references keep spaces in the name', () => {
    expect(tok('${a b}')[0]).toMatchObject({ kind: 'ref', value: 'a b' })
    expect(tok('$[a b]')[0]).toMatchObject({ kind: 'ref', value: 'a b' })
    expect(tok('{{ a.b }}')[0]).toMatchObject({ kind: 'ref', value: 'a.b' })
  })

  it('strings, numbers, identifiers, operators and punctuation are told apart', () => {
    expect(kinds('upper($a) + "x" * 2.5, 3')).toEqual([
      'ident', 'punc', 'ref', 'punc', 'op', 'str', 'op', 'num', 'punc', 'num',
    ])
  })

  it('🔴 two-character operators are ONE token — `<=` must not colour as `<` then `=`', () => {
    expect(tok('$a <= 2').filter((t) => t.kind === 'op').map((t) => t.text)).toEqual(['<='])
    expect(tok('$a != $b').filter((t) => t.kind === 'op').map((t) => t.text)).toEqual(['!='])
  })

  it('an escaped quote does not end the string', () => {
    const t = tok('"a\\"b"')[0]
    expect(t.kind).toBe('str')
    // `toMatchObject({unterminated: undefined})` would require the KEY to be present; it is only
    // set when the string is open, so the absence is the assertion.
    expect(t.unterminated).toBeUndefined()
    expect(t.end).toBe(6)
  })

  it('an unknown character is an `error` token, not a dropped one', () => {
    expect(kinds('$a # $b')).toEqual(['ref', 'error', 'ref'])
  })
})

describe('half-typed input — the states an editor lives in', () => {
  it('🔴 a lone `$` is a ref with an empty name, NOT an error — it is the autocomplete keystroke', () => {
    // Found by kind, not by index — the whitespace tokens are real tokens and counting past them
    // by hand is how this assertion was wrong the first time.
    const ts = tok('"x" + $')
    expect(ts.find((t) => t.kind === 'ref')).toMatchObject({ kind: 'ref', value: '', start: 6 })
  })

  it('🔴 an unterminated string is marked, not thrown — the server would refuse to tokenise at all', () => {
    expect(tok('"abc')[0]).toMatchObject({ kind: 'str', unterminated: true, value: 'abc' })
  })

  it('an unterminated brace reference is marked', () => {
    expect(tok('${abc')[0]).toMatchObject({ kind: 'ref', unterminated: true, value: 'abc' })
    expect(tok('{{ abc')[0]).toMatchObject({ kind: 'ref', unterminated: true })
  })

  it('the empty string tokenises to nothing rather than failing', () => {
    expect(tok('')).toEqual([])
  })
})

describe('refsOf — what gets outlined', () => {
  it('returns every reference in source order, with positions', () => {
    expect(refsOf(tok('$b + upper($a) + "$notme"')).map((r) => [r.value, r.start])).toEqual([
      ['b', 0], ['a', 11],
    ])
  })
})

describe('matchBrackets', () => {
  it('pairs the bracket the caret touches, either side of it', () => {
    expect(matchBrackets(tok('if(a)'), 2).pair).toEqual([2, 4])
    expect(matchBrackets(tok('if(a)'), 3).pair).toEqual([2, 4])
  })
  it('no pair when the caret is nowhere near one', () => {
    expect(matchBrackets(tok('if(a)'), 0).pair).toBeUndefined()
  })
  it('🔴 reports an unmatched bracket wherever the caret is — a missing `)` must not be invisible', () => {
    expect(matchBrackets(tok('if(a'), 0).unmatched).toEqual([2])
    expect(matchBrackets(tok('a)'), 0).unmatched).toEqual([1])
  })
  it('nested pairs match innermost to outermost', () => {
    expect(matchBrackets(tok('if(upper(a))'), 8).pair).toEqual([8, 10])
  })
})

describe('callAt — which signature to hint', () => {
  it('names the call the caret is inside, and the argument', () => {
    expect(callAt(tok('if(a, b)'), 4)).toMatchObject({ name: 'if', argIndex: 0 })
    expect(callAt(tok('if(a, b)'), 6)).toMatchObject({ name: 'if', argIndex: 1 })
  })

  it('🔴 the INNERMOST call wins — the hint is about the call being typed', () => {
    expect(callAt(tok('if(upper(x), y)'), 9)).toMatchObject({ name: 'upper', argIndex: 0 })
  })

  it("🔴 an inner call's comma does not advance the OUTER argument", () => {
    // `if(a, upper(b, c), d)` with the caret after the inner comma: `if` is on argument 1, not 2.
    expect(callAt(tok('if(a, upper(b, c), d)'), 15)).toMatchObject({ name: 'upper', argIndex: 1 })
    expect(callAt(tok('if(a, upper(b, c), d)'), 19)).toMatchObject({ name: 'if', argIndex: 2 })
  })

  it('null outside any call, and for bare grouping parentheses', () => {
    expect(callAt(tok('$a + 1'), 3)).toBeNull()
    expect(callAt(tok('($a + 1)'), 4)).toBeNull()
  })

  it('a closed call no longer captures the caret after it', () => {
    expect(callAt(tok('if(a) + 1'), 8)).toBeNull()
  })
})
