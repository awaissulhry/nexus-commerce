/**
 * #730 — the preview line and the function hint. Each test names what the operator sees wrongly.
 */
import { describe, expect, it } from 'vitest'

import { errorMarkAt, functionHint, previewLine, signatureArgs, unknownRefNames } from './formulaPreview'

const base = { expr: '$brand', inFlight: false, response: null, lastGood: null }

describe('previewLine', () => {
  it('an empty expression is idle, not an error — a cleared field is how you abandon a formula', () => {
    expect(previewLine({ ...base, expr: '' })).toEqual({ kind: 'idle' })
    expect(previewLine({ ...base, expr: '   ' })).toEqual({ kind: 'idle' })
  })

  it('🔴 an in-flight request KEEPS the last good value — blanking flickers away the answer', () => {
    // Measured behaviour of the first version: the line cleared on every keystroke, so the value
    // was invisible exactly while the operator was typing towards it.
    expect(previewLine({ ...base, inFlight: true, lastGood: 'XAVIA Motorcyclist' }))
      .toEqual({ kind: 'checking', last: 'XAVIA Motorcyclist' })
  })

  it('🔴 a stale ERROR is not kept while checking — it accuses text already fixed', () => {
    // The asymmetry with the value above is deliberate: a one-keystroke-old value is informative,
    // a one-keystroke-old error is a claim about characters the operator has just corrected.
    const stale = { ok: false, error: 'unknown attribute $brnd at 0', errorPos: 0 }
    expect(previewLine({ expr: '$brand', inFlight: true, response: stale, lastGood: 'XAVIA' }))
      .toEqual({ kind: 'checking', last: 'XAVIA' })
  })

  it('a value is shown as a value', () => {
    expect(previewLine({ ...base, response: { ok: true, value: 'XAVIA' } })).toEqual({ kind: 'value', value: 'XAVIA' })
  })

  it('🔴 ok:true with a null value is EMPTY, never an error — the route distinguishes them', () => {
    expect(previewLine({ ...base, response: { ok: true, value: null } })).toEqual({ kind: 'empty' })
    expect(previewLine({ ...base, response: { ok: true, value: '' } })).toEqual({ kind: 'empty' })
  })

  it('an error carries its position', () => {
    expect(previewLine({ ...base, response: { ok: false, error: 'unknown attribute $brnd at 0', errorPos: 0 } }))
      .toEqual({ kind: 'error', message: 'unknown attribute $brnd at 0', pos: 0 })
  })

  it('an error with no position is still an error, positioned null rather than 0', () => {
    // `pos: 0` would underline the first character — a confident mark at a place nobody measured.
    expect(previewLine({ ...base, response: { ok: false, error: 'Circular reference: a → b' } }))
      .toEqual({ kind: 'error', message: 'Circular reference: a → b', pos: null })
  })

  it('ok:false with no message still says something rather than showing a blank error', () => {
    expect(previewLine({ ...base, response: { ok: false } })).toMatchObject({ kind: 'error', pos: null })
  })
})

describe('errorMarkAt — the server counts the EXPRESSION, the field holds the `=`', () => {
  it('🔴 shifts by the stripped prefix — without it the mark lands one character early', () => {
    // `="$brnd"` → the server says 1, the field's character 1 is `"`. The mark must be at 2.
    expect(errorMarkAt(1, 7, 1)).toBe(2)
  })

  it('null when there is no position', () => {
    expect(errorMarkAt(null, 10, 1)).toBeNull()
  })

  it('🔴 null when the position is past the text — never clamped into a plausible mark', () => {
    expect(errorMarkAt(20, 7, 1)).toBeNull()
    expect(errorMarkAt(7, 7, 1)).toBeNull()
    expect(errorMarkAt(-1, 7, 1)).toBeNull()
  })
})

describe('functionHint', () => {
  const docs = [
    { name: 'if', signature: 'if(condition, then, else?)', summary: 'Pick one of two values.' },
    { name: 'upper', signature: 'upper(text)', summary: 'UPPERCASE.' },
  ]

  it('names the signature and the active argument', () => {
    expect(functionHint({ name: 'if', nameStart: 0, argIndex: 1 }, docs)).toEqual({
      signature: 'if(condition, then, else?)',
      summary: 'Pick one of two values.',
      argIndex: 1,
      args: ['condition', 'then', 'else?'],
    })
  })

  it('🔴 case-insensitive — `IF(` runs perfectly and must not silently lose its hint', () => {
    expect(functionHint({ name: 'IF', nameStart: 0, argIndex: 0 }, docs)?.signature).toBe('if(condition, then, else?)')
  })

  it('null outside a call, and for a function the server does not document', () => {
    expect(functionHint(null, docs)).toBeNull()
    // No invented hint: the preview line carries the server's verdict and a hint would contradict it.
    expect(functionHint({ name: 'nosuchfn', nameStart: 0, argIndex: 0 }, docs)).toBeNull()
  })
})

describe('signatureArgs', () => {
  it('splits at top-level commas', () => {
    expect(signatureArgs('if(condition, then, else?)')).toEqual(['condition', 'then', 'else?'])
    expect(signatureArgs('coalesce(a, b, …)')).toEqual(['a', 'b', '…'])
  })

  it('a nested list does not fragment the argument it belongs to', () => {
    expect(signatureArgs('lookup(value, [a, b])')).toEqual(['value', '[a, b]'])
  })

  it('empty rather than throwing for shapes the docs might carry', () => {
    expect(signatureArgs('pi')).toEqual([])
    expect(signatureArgs('now()')).toEqual([])
  })
})

describe('unknownRefNames — the server wins, the local list only fills the gap', () => {
  it('before any answer, the local typing aid marks', () => {
    expect([...unknownRefNames(undefined, ['brnd'], false)]).toEqual(['brnd'])
  })

  it("🔴 once the server has answered, ONLY its list marks — the client sees the operator's view", () => {
    // The local list is computed from the columns currently on screen; the server's is computed
    // against the full key set for this row and market (#728/#729). Preferring the local one marks
    // a good reference red because the sheet is filtered — a false alarm on the trusted signal.
    expect([...unknownRefNames([], ['sku'], true)]).toEqual([])
    expect([...unknownRefNames([{ name: 'brnd' }], ['sku'], true)]).toEqual(['brnd'])
  })

  it('lower-cased, so one reference is never marked half-red', () => {
    expect(unknownRefNames([{ name: 'Brnd' }], [], true).has('brnd')).toBe(true)
  })
})
