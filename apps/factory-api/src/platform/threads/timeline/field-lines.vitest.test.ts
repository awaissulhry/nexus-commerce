import { describe, expect, it } from 'vitest'
import { GRAINS, type Grain } from '@nexus/factory-domain/auth/grains/grains'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { changeSummary } from '@nexus/factory-domain/threads/timeline'
import { fieldLinesOf, fieldLineText } from './field-lines'

/**
 * Field history on every record (B-W2b-399; PLT-076): "price 480 → 520 by Marco, 10:42" as lines, the same fields the timeline
 * names, values only for a reader who may see them, money only with its grain.
 */

const none: ReadonlySet<Grain> = new Set()
const price: ReadonlySet<Grain> = new Set(['price'])
const every: ReadonlySet<Grain> = new Set(GRAINS)

describe('fieldLinesOf', () => {
  it('one line per changed top-level field, sorted, from → to; an added field from null, a removed one to null', () => {
    const lines = fieldLinesOf({ status: 'DRAFT', note: 'a', same: 1, gone: true }, { status: 'SENT', note: 'b', same: 1, added: [1, 2] }, { held: none, values: true, unheldMoney: 'omit' })
    expect(lines).toEqual([
      { field: 'added', from: null, to: [1, 2], hidden: null },
      { field: 'gone', from: true, to: null, hidden: null },
      { field: 'note', from: 'a', to: 'b', hidden: null },
      { field: 'status', from: 'DRAFT', to: 'SENT', hidden: null },
    ])
  })

  it('names exactly the fields the timeline names (changeSummary), for every grain set', () => {
    const before = { status: 'DRAFT', unitPrice: markMoney('price', '480.00'), standardCost: markMoney('cost', '300.00'), total: '10', qty: 1 }
    const after = { status: 'SENT', unitPrice: markMoney('price', '520.00'), standardCost: markMoney('cost', '310.00'), total: '11', qty: 2 }
    for (const held of [none, price, every]) {
      expect(fieldLinesOf(before, after, { held, values: true, unheldMoney: 'omit' }).map((line) => line.field)).toEqual(changeSummary(before, after, held).fields)
    }
  })

  it('money: shown as marked with its grain; without it left out (timeline) or named as hidden (audit search); unmarked money-looking names fail closed', () => {
    const before = { unitPrice: markMoney('price', '480.00'), standardCost: markMoney('cost', '300.00'), total: '10' }
    const after = { unitPrice: markMoney('price', '520.00'), standardCost: markMoney('cost', '310.00'), total: '11' }
    expect(fieldLinesOf(before, after, { held: price, values: true, unheldMoney: 'omit' })).toEqual([{ field: 'unitPrice', from: markMoney('price', '480.00'), to: markMoney('price', '520.00'), hidden: null }])
    expect(fieldLinesOf(before, after, { held: price, values: true, unheldMoney: 'name' })).toEqual([
      { field: 'standardCost', from: null, to: null, hidden: 'GRAIN' },
      { field: 'total', from: null, to: null, hidden: 'GRAIN' },
      { field: 'unitPrice', from: markMoney('price', '480.00'), to: markMoney('price', '520.00'), hidden: null },
    ])
    expect(fieldLinesOf(before, after, { held: every, values: true, unheldMoney: 'omit' }).map((line) => line.field)).toEqual(['standardCost', 'total', 'unitPrice'])
  })

  it('without the right to the values: the field stays, its values do not', () => {
    expect(fieldLinesOf({ status: 'DRAFT' }, { status: 'SENT' }, { held: every, values: false, unheldMoney: 'omit' })).toEqual([{ field: 'status', from: null, to: null, hidden: 'VALUES' }])
  })

  it('not an object (a row without before or after): nothing to compare but the other side', () => {
    expect(fieldLinesOf(null, { status: 'ACTIVE' }, { held: none, values: true, unheldMoney: 'omit' })).toEqual([{ field: 'status', from: null, to: 'ACTIVE', hidden: null }])
    expect(fieldLinesOf('x', 3, { held: none, values: true, unheldMoney: 'omit' })).toEqual([])
  })
})

describe('fieldLineText', () => {
  it('says a line in one cell, money as its value, hidden ones in the caller’s words', () => {
    expect(fieldLineText({ field: 'unitPrice', from: markMoney('price', '480.00'), to: markMoney('price', '520.00'), hidden: null }, 'hidden')).toBe('unitPrice: 480.00 → 520.00')
    expect(fieldLineText({ field: 'qty', from: null, to: 2, hidden: null }, 'hidden')).toBe('qty: — → 2')
    expect(fieldLineText({ field: 'standardCost', from: null, to: null, hidden: 'GRAIN' }, 'nascosto')).toBe('standardCost (nascosto)')
  })
})
