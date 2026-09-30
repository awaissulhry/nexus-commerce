import { describe, expect, it } from 'vitest'
import { coerceForShape, type ShapeWriteFacts } from './sheet-values.js'

const scalar: ShapeWriteFacts = { kind: 'number', label: 'Partner ID' }
const list: ShapeWriteFacts = { ...scalar, shape: 'list', cardinality: { min: 0, max: null } }
const reason = 'Partner ID is outside the safe whole-number range (-9007199254740991 to 9007199254740991). It has not been rounded or saved.'

describe('unsafe integer storage boundary', () => {
  it.each(['9007199254740993', '-9007199254740993', '9007199254740992', '-9007199254740992', '9.007199254740993e15'])(
    'refuses %s with its cell name, including clients that already rounded JSON numbers', text => {
      for (const raw of [text, Number(text), JSON.parse(text)]) {
        expect(coerceForShape(scalar, raw)).toEqual({ ok: false, error: reason })
        expect(coerceForShape(list, [7, raw])).toEqual({ ok: false, error: reason })
        expect(coerceForShape(list, JSON.stringify([7, raw]))).toEqual({ ok: false, error: reason })
        expect(coerceForShape({ ...scalar, shape: 'measure' }, { value: raw, unit: 'kg' })).toEqual({ ok: false, error: reason })
      }
    })

  it.each([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 0, -1, 1, -1.25, 0.125])('preserves supported number %s exactly', value => {
    for (const raw of [value, String(value)]) {
      expect(coerceForShape(scalar, raw)).toEqual({ ok: true, value })
      expect(coerceForShape(list, [raw])).toEqual({ ok: true, value: [value] })
      expect(coerceForShape(list, JSON.stringify([raw]))).toEqual({ ok: true, value: [value] })
    }
  })

  it('keeps field-specific lower bounds and text IDs', () => {
    expect(coerceForShape({ ...list, validation: { minimum: 1 } }, [-1])).toEqual({ ok: false, error: 'Partner ID must be at least 1' })
    expect(coerceForShape({ kind: 'text' }, '9007199254740993')).toEqual({ ok: true, value: '9007199254740993' })
    expect(coerceForShape({ kind: 'text', shape: 'list' }, ['9007199254740993'])).toEqual({ ok: true, value: ['9007199254740993'] })
  })
})
