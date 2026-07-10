import { describe, it, expect } from 'vitest'
import { tokenizeClipboard } from './paste-tokenizer'

describe('tokenizeClipboard — legacy parity (no quotes)', () => {
  it('splits a simple TSV block', () => {
    expect(tokenizeClipboard('a\tb\nc\td')).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('normalizes CRLF and lone CR line endings', () => {
    expect(tokenizeClipboard('a\tb\r\nc\td\re\tf')).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f']])
  })

  it('drops trailing blank lines but preserves interior blank rows', () => {
    expect(tokenizeClipboard('a\n\nb\n\n\n')).toEqual([['a'], [''], ['b']])
  })

  it('keeps a single empty input as one empty cell', () => {
    expect(tokenizeClipboard('\n')).toEqual([['']])
  })

  it('returns [] for empty text', () => {
    expect(tokenizeClipboard('')).toEqual([])
  })

  it('preserves empty cells inside a row', () => {
    expect(tokenizeClipboard('a\t\tc')).toEqual([['a', '', 'c']])
  })
})

describe('tokenizeClipboard — RFC-4180 quoted fields', () => {
  it('keeps an embedded newline inside a quoted cell', () => {
    expect(tokenizeClipboard('"line1\nline2"\tb')).toEqual([['line1\nline2', 'b']])
  })

  it('keeps an embedded CRLF inside a quoted cell as \\n', () => {
    expect(tokenizeClipboard('"line1\r\nline2"\tb\r\nc\td')).toEqual([
      ['line1\nline2', 'b'],
      ['c', 'd'],
    ])
  })

  it('keeps an embedded tab inside a quoted cell', () => {
    expect(tokenizeClipboard('"a\tb"\tc')).toEqual([['a\tb', 'c']])
  })

  it('unescapes doubled quotes', () => {
    expect(tokenizeClipboard('"he said ""hi"""\tb')).toEqual([['he said "hi"', 'b']])
  })

  it('parses a multi-row block where only some cells are quoted', () => {
    expect(tokenizeClipboard('sku\tdesc\nA1\t"first line\nsecond line"\nA2\tplain')).toEqual([
      ['sku', 'desc'],
      ['A1', 'first line\nsecond line'],
      ['A2', 'plain'],
    ])
  })

  it('treats a quote mid-field as literal (unquoted field)', () => {
    expect(tokenizeClipboard('a"b\tc')).toEqual([['a"b', 'c']])
  })

  it('is lenient about text after the closing quote', () => {
    expect(tokenizeClipboard('"ab"cd\te')).toEqual([['abcd', 'e']])
  })

  it('handles a quoted empty cell', () => {
    expect(tokenizeClipboard('""\tb')).toEqual([['', 'b']])
  })

  it('handles a quoted cell at end of row and end of input', () => {
    expect(tokenizeClipboard('a\t"x\ny"')).toEqual([['a', 'x\ny']])
  })

  it('supports a custom delimiter (CSV)', () => {
    expect(tokenizeClipboard('a,"b,c",d', ',')).toEqual([['a', 'b,c', 'd']])
  })

  it('drops trailing blank rows after a quoted block', () => {
    expect(tokenizeClipboard('"x\ny"\tb\n\n')).toEqual([['x\ny', 'b']])
  })
})

describe('tokenizeClipboard — unbalanced quotes fall back to plain split', () => {
  it('does not swallow input when a leading quote never closes', () => {
    expect(tokenizeClipboard('"foo\tbar\nbaz\tqux')).toEqual([
      ['"foo', 'bar'],
      ['baz', 'qux'],
    ])
  })

  it('falls back for a lone quote cell', () => {
    expect(tokenizeClipboard('"')).toEqual([['"']])
  })
})
