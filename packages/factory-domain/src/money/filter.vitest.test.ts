import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { GRAINS, type Grain } from '../auth/grains/grains'
import { amountMinor, output, unitPrice } from '../core/contracts'
import { filterForGrains, unheldMoneyInput } from './filter'
import { asMoney, grainedJson, grainOfSchema, isMarkedJson, looksLikeMoney, markMoney, money, notMoney, type Money } from './marked'

const held = (...grains: Grain[]): ReadonlySet<Grain> => new Set(grains)
const ALL = held(...GRAINS)

const line = output({
  sku: z.string(),
  unitPrice: money.price(unitPrice()),
  unitCost: money.cost(unitPrice()),
  marginPct: money.margin(z.string()).nullable(),
})
const answer = output({
  id: z.string(),
  totalLines: notMoney(z.number().int()),
  lines: z.array(line),
  totals: output({ amountMinor: money.price(amountMinor()) }).optional(),
  history: grainedJson(),
})

const sample = {
  id: 'q1',
  totalLines: 1,
  lines: [{ sku: 'JKT-1', unitPrice: '120.000000', unitCost: '80.000000', marginPct: '33.3' }],
  totals: { amountMinor: 12000 },
  history: { before: { unitCost: markMoney('cost', '75.000000'), note: 'n' }, after: { unitCost: markMoney('cost', '80.000000'), totalAmount: 5, list: [markMoney('margin', 1), 2] } },
}

describe('marked money', () => {
  it('marks a field with its grain, optional, and types it as Money', () => {
    expect(grainOfSchema(line.shape.unitCost)).toBe('cost')
    expect(grainOfSchema(line.shape.sku)).toBeUndefined()
    expect(line.shape.unitPrice.safeParse(undefined).success).toBe(true)
    const marked: Money<'cost', string> = asMoney('cost', '1.000000')
    // @ts-expect-error a plain string is not a cost: a handler states the grain of what it returns
    const unmarked: Money<'cost', string> = '1.000000'
    // @ts-expect-error a price is not a cost
    const price: Money<'cost', string> = asMoney('price', '1.000000')
    expect([marked, unmarked, price]).toHaveLength(3)
    expect(looksLikeMoney('unitCost')).toBe(true)
    expect(looksLikeMoney('sessionsEnded')).toBe(false)
  })

  it('keeps marked JSON recognisable and refuses an unknown grain', () => {
    expect(isMarkedJson(markMoney('price', 3))).toBe(true)
    expect(isMarkedJson({ $money: 'price', value: 3, extra: 1 })).toBe(false)
    expect(isMarkedJson({ $money: 'salary', value: 3 })).toBe(false)
    expect(() => markMoney('salary' as Grain, 1)).toThrow(/not a money grain/)
  })
})

describe('filterForGrains', () => {
  it('drops every marked field of a grain the caller lacks, at any depth, and never mutates the value', () => {
    const copy = structuredClone(sample)
    const seen = filterForGrains(answer, sample, held('price'))
    expect(seen.lines[0]).toEqual({ sku: 'JKT-1', unitPrice: '120.000000' })
    expect(seen.totals).toEqual({ amountMinor: 12000 })
    expect(seen.totalLines).toBe(1)
    expect(sample).toEqual(copy)
    expect(answer.safeParse(seen).success).toBe(true)
  })

  it('keeps everything for a caller with every grain and unwraps marked JSON', () => {
    const seen = filterForGrains(answer, sample, ALL)
    expect(seen.lines[0]).toEqual(sample.lines[0])
    expect(seen.history).toEqual({ before: { unitCost: '75.000000', note: 'n' }, after: { unitCost: '80.000000', totalAmount: 5, list: [1, 2] } })
  })

  it('filters audit JSON: unheld marked values go, unmarked money-looking keys go unless every grain is held', () => {
    expect(filterForGrains(answer, sample, held()).history).toEqual({ before: { note: 'n' }, after: { list: [null, 2] } })
    expect(filterForGrains(answer, sample, held('cost')).history).toEqual({ before: { unitCost: '75.000000', note: 'n' }, after: { unitCost: '80.000000', list: [null, 2] } })
  })

  it('follows unions to the option the value fits', () => {
    const union = z.discriminatedUnion('kind', [
      output({ kind: z.literal('a'), price: money.price(amountMinor()) }),
      output({ kind: z.literal('b'), cost: money.cost(amountMinor()) }),
    ])
    expect(filterForGrains(union, { kind: 'b', cost: 5 }, held('price'))).toEqual({ kind: 'b' })
    expect(filterForGrains(union, { kind: 'a', price: 5 }, held('price'))).toEqual({ kind: 'a', price: 5 })
    const loose = z.union([z.string(), output({ total: money.price(amountMinor()) })])
    expect(filterForGrains(loose, { total: 7 }, held())).toEqual({})
    expect(filterForGrains(loose, 'text', held())).toBe('text')
  })

  it('refuses money marked on list items, which it could not drop (fail closed)', () => {
    const list = output({ costs: z.array(money.cost(amountMinor())) })
    expect(() => filterForGrains(list, { costs: [1] }, held())).toThrow(/mark the field that holds the list/)
  })
})

describe('unheldMoneyInput', () => {
  it('names the marked fields a request sends without their grain', () => {
    const body = z.strictObject({ name: z.string(), unitCost: money.cost(unitPrice()), lines: z.array(z.object({ unitPrice: money.price(unitPrice()) })) })
    const value = { name: 'x', unitCost: '1', lines: [{ unitPrice: '2' }, {}] }
    expect(unheldMoneyInput(body, value, held('price'))).toEqual([{ path: 'unitCost', message: 'Needs the cost grain.' }])
    expect(unheldMoneyInput(body, value, held())).toEqual([
      { path: 'unitCost', message: 'Needs the cost grain.' },
      { path: 'lines/0/unitPrice', message: 'Needs the price grain.' },
    ])
    expect(unheldMoneyInput(body, { name: 'x' }, held())).toEqual([])
  })
})
