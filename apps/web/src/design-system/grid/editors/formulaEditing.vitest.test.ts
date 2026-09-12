import { completionTokenAt, insertFieldReference } from './formulaEditing'
/**
 * D16 — the formula editor's rules. Each test names the thing an operator would be told wrongly.
 */
import { describe, expect, it } from 'vitest'

import {
  applyCompletion, coerceTyped, commitValue, completionsFor, formulaAvailability, formulaEditorChoice, FORMULA_BLOCKED_REASON, exprOf, inStringLiteral, isFormulaDraft, refTokenAt, unknownRefs,
  type FormulaCandidate,
} from './formulaEditing'

const FIELDS: FormulaCandidate[] = [
  { name: 'brand', kind: 'field', label: 'Brand' },
  { name: 'bullet_point', kind: 'field', label: 'Bullet Point' },
  { name: 'fabric_type', kind: 'field', label: 'Fabric Type' },
  { name: 'item_name', kind: 'field', label: 'Item Name' },
]
const FNS: FormulaCandidate[] = [
  { name: 'if', kind: 'function', label: 'if(condition, then, else?)', group: 'Logic' },
  { name: 'ifblank', kind: 'function', label: 'ifblank(value, fallback)', group: 'Logic' },
  { name: 'upper', kind: 'function', label: 'upper(text)', group: 'Text' },
]
const ALL = [...FIELDS, ...FNS]

describe('formula mode', () => {
  it('is the leading =, and survives leading spaces', () => {
    expect(isFormulaDraft('=$brand')).toBe(true)
    expect(isFormulaDraft('  =$brand')).toBe(true)
    expect(isFormulaDraft('Gale Jacket')).toBe(false)
    expect(isFormulaDraft('')).toBe(false)
  })

  it('🔴 strips ONLY the leading = — `=` is a real operator in the language', () => {
    // `expr.ts:187` has `=` in the equality tier, so a formula sent with its `=` still attached
    // parses as a comparison against nothing. §1.6(B) makes this the client's job and the server
    // refuses a stored expr beginning with `=`.
    expect(exprOf('=$brand')).toBe('$brand')
    expect(exprOf('=$a = $b')).toBe('$a = $b')
    expect(exprOf('Gale')).toBe('Gale')
    /* 🔴 Only the FIRST `=` is the mode switch. Added because a mutation to `replace(/^=+/, '')`
       passed every other test in this file — the docstring claimed "only the first" and nothing
       checked it, so the claim was decoration. `==a` is `= (mode) + =a (a broken expression)`, and
       the server must be the one to say so. */
    expect(exprOf('==a')).toBe('=a')
  })
})

describe('inStringLiteral — a $ inside quotes is TEXT', () => {
  it('knows inside from outside', () => {
    expect(inStringLiteral('"$brand"', 2)).toBe(true)
    expect(inStringLiteral('"a" + $brand', 8)).toBe(false)
  })
  it('honours an escaped quote', () => {
    // Without the escape rule this reads as "closed" and the reference inside looks live.
    expect(inStringLiteral('"a\\"b$c"', 6)).toBe(true)
  })
  it('handles single quotes', () => {
    expect(inStringLiteral("'$x'", 2)).toBe(true)
  })
})

describe('refTokenAt — which reference the caret is in', () => {
  it('finds a token being typed', () => {
    expect(refTokenAt('$bra', 4)).toEqual({ query: 'bra', start: 0, end: 4 })
  })
  it('finds the bare $ the moment it is pressed', () => {
    expect(refTokenAt('="x" + $', 8)).toEqual({ query: '', start: 7, end: 8 })
  })
  it('offers the prefix BEFORE the caret when editing mid-token', () => {
    // Caret after `$br` inside `$brand`: the operator is narrowing, not restarting.
    expect(refTokenAt('$brand', 3)).toEqual({ query: 'br', start: 0, end: 6 })
  })
  it('🔴 null when the caret has LEFT the token — an open menu about a token nobody is editing', () => {
    expect(refTokenAt('$brand + 1', 10)).toBeNull()
  })
  it('🔴 null inside a string literal — inserting there would silently do nothing', () => {
    expect(refTokenAt('="$bra"', 6)).toBeNull()
  })
  it('null when there is no $ at all', () => {
    expect(refTokenAt('brand', 5)).toBeNull()
  })
})

describe('completionsFor', () => {
  it('prefix matches beat contained ones, fields beat functions', () => {
    expect(completionsFor('i', ALL).map((c) => c.name)).toEqual(['item_name', 'if', 'ifblank', 'bullet_point', 'fabric_type'])
  })
  it('is case-insensitive, and a PREFIX match outranks a contained one', () => {
    // `fabric_type` genuinely contains "br" (fa-BR-ic), so it is offered — after `brand`, which
    // starts with it. Asserting exclusivity here would have been asserting a rule the editor does
    // not have and should not: a contained match is a useful offer, just a weaker one.
    expect(completionsFor('BR', FIELDS).map((c) => c.name)).toEqual(['brand', 'fabric_type'])
  })
  it('matches a label as well as a key, so "Fabric" finds fabric_type', () => {
    expect(completionsFor('Fabric', FIELDS).map((c) => c.name)).toEqual(['fabric_type'])
  })
  it('an empty query offers the fields first', () => {
    expect(completionsFor('', ALL)[0].kind).toBe('field')
  })
  it('respects the limit', () => {
    expect(completionsFor('', ALL, 2)).toHaveLength(2)
  })
  it('no match is an empty list, never everything', () => {
    expect(completionsFor('zzzz', ALL)).toEqual([])
  })
})

describe('applyCompletion', () => {
  it('replaces the whole token, not just what was typed', () => {
    // Caret mid-token: the tail (`and`) must go, or `$brand` becomes `$brandand`.
    const tok = refTokenAt('=$brand + 1', 4)!
    expect(applyCompletion('=$brand + 1', tok, FIELDS[0])).toEqual({ text: '=$brand + 1', caret: 7 })
  })
  it('completes a bare $ into a field and puts the caret after it', () => {
    const tok = refTokenAt('="x" + $', 8)!
    expect(applyCompletion('="x" + $', tok, FIELDS[0])).toEqual({ text: '="x" + $brand', caret: 13 })
  })
  it('🔴 a FUNCTION brings its parentheses and leaves the caret INSIDE them', () => {
    // The next thing typed after a function name is always an argument.
    const tok = refTokenAt('=$up', 4)!
    expect(applyCompletion('=$up', tok, FNS[2])).toEqual({ text: '=upper()', caret: 7 })
  })
})

describe('unknownRefs — a typing aid, never a verdict', () => {
  const keys = ['brand', 'fabric_type']
  it('reports a reference the sheet has no column for', () => {
    expect(unknownRefs('"x" + $athlete_typo', keys)).toEqual(['athlete_typo'])
  })
  it('is case-insensitive and does not repeat itself', () => {
    expect(unknownRefs('$BRAND + $brand', keys)).toEqual([])
    expect(unknownRefs('$nope + $nope', keys)).toEqual(['nope'])
  })
  it('🔴 ignores a $ inside a string — that is text, not a reference', () => {
    expect(unknownRefs('"$athlete_typo"', keys)).toEqual([])
  })
  it('says nothing about a formula that only uses real keys', () => {
    expect(unknownRefs('$brand + " " + $fabric_type', keys)).toEqual([])
  })
})

describe('commitValue — what a stopped edit actually saves', () => {
  it('a finished formula commits', () => {
    expect(commitValue('=upper($brand)', 'Xavia')).toBe('=upper($brand)')
  })

  it('plain text commits unchanged — the editor is an ordinary field until an `=`', () => {
    expect(commitValue('Xavia Racing', 'Xavia')).toBe('Xavia Racing')
    expect(commitValue('', 'Xavia')).toBe('')
  })

  it('🔴 a BARE `=` commits nothing — the mode switch is not a formula', () => {
    // The state a stray blur produces: open a cell by typing `=`, click away. Without this the
    // sheet sends an empty expr to the formula route, which refuses it with a 400 the operator
    // then has to read as a failed write for something they never asked to save.
    expect(commitValue('=', 'Xavia')).toBe('Xavia')
    expect(commitValue('=   ', 'Xavia')).toBe('Xavia')
    expect(commitValue('  =', 'Xavia')).toBe('Xavia')
  })

  it('🔴 a HALF-WRITTEN formula still commits — the server is the authority on finished', () => {
    // Deliberately not guessed at here. `=upper($fabric` is refused by the route with a position,
    // which the sheet surfaces; a client that silently dropped it would lose the operator's work
    // and tell them nothing.
    expect(commitValue('=upper($fabric', 'Xavia')).toBe('=upper($fabric')
  })
})

describe('formulaAvailability — the `=` editor must not open where it can never save', () => {
  it('a column the writer accepts is available', () => {
    expect(formulaAvailability({ formulaWritable: true })).toEqual({ kind: 'available' })
  })

  it('a column the writer refuses is blocked, with the one wording', () => {
    expect(formulaAvailability({ formulaWritable: false })).toEqual({ kind: 'blocked', reason: FORMULA_BLOCKED_REASON })
  })

  it('🔴 a cell that ALREADY holds a formula is available even on a refused column', () => {
    // Rules change. Refusing to open it would leave the operator with a computed value they can
    // neither read the rule of nor remove — the editor is the only way to see or clear it.
    expect(formulaAvailability({ formulaWritable: false, hasStoredFormula: true })).toEqual({ kind: 'available' })
  })

  it('🔴 an ABSENT flag is available, not blocked — unknown is not "no"', () => {
    // Reading absence as "no" would silently disable formulas against an older server, invisibly.
    // Allowing it means the server refuses and says why, which is visible and explained.
    expect(formulaAvailability({})).toEqual({ kind: 'available' })
    expect(formulaAvailability({ formulaWritable: undefined })).toEqual({ kind: 'available' })
  })

  it('the reason says what to do instead, and never claims the column is read-only', () => {
    expect(FORMULA_BLOCKED_REASON).toMatch(/type a value instead/i)
    expect(FORMULA_BLOCKED_REASON).not.toMatch(/read-only|not writable/i)
  })
})

describe('commitValue on a NUMBER column — the string assumption (#775)', () => {
  it('🔴 a plain number round-trips as a NUMBER, not the string the text field produced', () => {
    // The editor is a text field, so everything arrives as a string. Storing "105" where 105 belongs
    // sorts as text, compares as text and reaches the writer as text, with nothing complaining.
    expect(commitValue('105', '0', 'number')).toBe(105)
    expect(commitValue('105.5', '0', 'number')).toBe(105.5)
    expect(commitValue('-3', '0', 'number')).toBe(-3)
  })

  it('a formula is still the formula — the interception reads the text, not a number', () => {
    expect(commitValue('=basePrice * 2', '0', 'number')).toBe('=basePrice * 2')
  })

  it('🔴 an unparseable entry is returned AS TYPED, not swallowed', () => {
    // The original would silently discard their typing; null would delete the cell. The string goes
    // to the server, is refused, and the refusal is visible and correctable.
    expect(commitValue('abc', '0', 'number')).toBe('abc')
  })

  it('blank clears, the way every other column clears', () => {
    expect(commitValue('', '105', 'number')).toBe('')
    expect(commitValue('   ', '105', 'number')).toBe('')
  })

  it('a bare `=` still commits nothing, on a number column too', () => {
    expect(commitValue('=', '105', 'number')).toBe('105')
  })

  it('text columns are untouched by the kind — the default cannot change behaviour', () => {
    expect(commitValue('105', 'x')).toBe('105')
    expect(commitValue('105', 'x', 'text')).toBe('105')
    expect(coerceTyped('105', 'text')).toBe('105')
  })
})

describe('formulaEditorChoice — the four rules both scopes must share (#775)', () => {
  it('an ordinary keystroke gets the column\'s own editor', () => {
    expect(formulaEditorChoice({ eventKey: 'a', formulaWritable: true })).toEqual({ use: 'fallback' })
    expect(formulaEditorChoice({ eventKey: null, formulaWritable: true })).toEqual({ use: 'fallback' })
  })

  it('`=` on a writable column opens the formula editor', () => {
    expect(formulaEditorChoice({ eventKey: '=', formulaWritable: true })).toEqual({ use: 'formula' })
  })

  it('🔴 a cell that already HOLDS a formula always opens it — whatever key, whatever the gate', () => {
    // Opening its VALUE would silently offer to replace the rule with its own output; and if the
    // gate has narrowed since, this is the only way left to see or clear the formula.
    expect(formulaEditorChoice({ eventKey: 'Enter', storedExpr: 'upper($brand)' })).toEqual({ use: 'formula' })
    expect(formulaEditorChoice({ eventKey: 'a', storedExpr: 'upper($brand)', formulaWritable: false })).toEqual({ use: 'formula' })
  })

  it('🔴 `=` on a refused column falls back — the cell explains why in its tooltip', () => {
    expect(formulaEditorChoice({ eventKey: '=', formulaWritable: false })).toEqual({ use: 'fallback' })
  })

  it('🔴 an ABSENT gate opens the editor — unknown is not "no"', () => {
    // An older server that does not send the flag must not silently lose formulas everywhere; the
    // server refuses visibly instead. Same arm as `formulaAvailability`.
    expect(formulaEditorChoice({ eventKey: '=' })).toEqual({ use: 'formula' })
  })
})


it('never opens another listing’s stored formula on a row excluded by scope', () => {
  expect(formulaEditorChoice({ rowWritable: false, storedExpr: 'upper($brand)', eventKey: '=', formulaWritable: true })).toEqual({ use: 'fallback' })
})


describe('guided formula entry', () => {
  it('offers guidance immediately after = and while typing a function', () => {
    expect(completionTokenAt('=', 1)).toEqual({ query: '', start: 1, end: 1 })
    expect(completionTokenAt('=UPP', 4)).toEqual({ query: 'UPP', start: 1, end: 4 })
    expect(completionTokenAt('=$brand & ', 10)?.query).toBe('')
    expect(completionTokenAt('="literal"', 5)).toBeNull()
  })
  it('inserts a picked field at the caret and replaces selected text', () => {
    expect(insertFieldReference('=', 1, 1, 'brand')).toEqual({ text: '=$brand', caret: 7 })
    expect(insertFieldReference('=$br & " Jacket"', 4, 4, 'brand')?.text).toBe('=$brand & " Jacket"')
    expect(insertFieldReference('=upper($name)', 7, 12, 'brand')?.text).toBe('=upper($brand)')
    expect(insertFieldReference('="text"', 3, 3, 'brand')).toBeNull()
  })
})
