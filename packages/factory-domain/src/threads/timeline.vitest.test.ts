import { describe, expect, it } from 'vitest'
import { GRAINS, type Grain } from '../auth/grains/grains'
import { markMoney } from '../money/marked'
import { changeSummary, compareNewestFirst, decodeCursor, encodeCursor, isAfterCursor, mergeNewestFirst, type Positioned } from './timeline'

const at = (iso: string) => new Date(iso)
const entry = (iso: string, id: string, label = id): Positioned & { label: string } => ({ at: at(iso), id, label })
const ID = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`

describe('timeline order and cursor (COL-002)', () => {
  it('sorts newest first, the larger id first at the same time', () => {
    const items = [entry('2026-10-28T08:00:00.000Z', ID(1)), entry('2026-10-28T09:00:00.000Z', ID(2)), entry('2026-10-28T08:00:00.000Z', ID(3))]
    expect(items.sort(compareNewestFirst).map((item) => item.id)).toEqual([ID(2), ID(3), ID(1)])
  })

  it('round-trips a cursor and refuses anything else', () => {
    const cursor = { at: at('2026-10-28T08:00:00.123Z'), id: ID(7) }
    const encoded = encodeCursor(cursor)
    expect(decodeCursor(encoded)).toEqual(cursor)
    for (const bad of ['', 'abc', `x_${ID(7)}`, "1_ABCDEF00-0000-7000-8000-000000000007", `${'9'.repeat(16)}_${ID(7)}`, '1_not-an-id']) expect(decodeCursor(bad)).toBeNull()
  })

  it('merges sources page by page with nothing lost or shown twice', () => {
    const messages = [entry('2026-10-28T10:00:00.000Z', ID(10)), entry('2026-10-28T08:00:00.000Z', ID(4)), entry('2026-10-28T07:00:00.000Z', ID(2))]
    const changes = [entry('2026-10-28T09:00:00.000Z', ID(9)), entry('2026-10-28T08:00:00.000Z', ID(5)), entry('2026-10-28T08:00:00.000Z', ID(3))]
    const files = [entry('2026-10-28T08:30:00.000Z', ID(6))]
    const all = [...messages, ...changes, ...files].sort(compareNewestFirst)
    // Read like the API: each source after the cursor, limit + 1 of each, then merge.
    const seen: string[] = []
    let cursor: Positioned | null = null
    for (let page = 0; page < 10; page++) {
      const after = (source: Positioned[]) => source.filter((item) => isAfterCursor(item, cursor)).slice(0, 3)
      const { items, more } = mergeNewestFirst([after(messages), after(changes), after(files)], 2)
      seen.push(...items.map((item) => item.id))
      if (!more) break
      cursor = items.at(-1)!
    }
    expect(seen).toEqual(all.map((item) => item.id))
  })
})

describe('change summary: no money without its grain', () => {
  const none = new Set<Grain>()
  const all = new Set<Grain>(GRAINS)

  it('names the status move and the changed fields, never a value', () => {
    expect(changeSummary({ status: 'DRAFT', name: 'A' }, { status: 'SENT', name: 'A' }, none)).toEqual({ status: { from: 'DRAFT', to: 'SENT' }, fields: ['status'] })
    expect(changeSummary(undefined, { name: 'New', status: 'OPEN' }, none)).toEqual({ status: { from: null, to: 'OPEN' }, fields: ['name', 'status'] })
    expect(changeSummary({ name: 'A' }, { name: 'A' }, none)).toEqual({ status: null, fields: [] })
  })

  it('names a marked money field only with its grain', () => {
    const before = { unitPrice: markMoney('price', '10.00'), note: 'x' }
    const after = { unitPrice: markMoney('price', '12.00'), note: 'y' }
    expect(changeSummary(before, after, none).fields).toEqual(['note'])
    expect(changeSummary(before, after, new Set<Grain>(['cost'])).fields).toEqual(['note'])
    expect(changeSummary(before, after, new Set<Grain>(['price'])).fields).toEqual(['note', 'unitPrice'])
  })

  it('names an unmarked money-looking field only with every grain (fail closed)', () => {
    const before = { totalCost: 100, colour: 'red' }
    const after = { totalCost: 120, colour: 'blue' }
    expect(changeSummary(before, after, new Set<Grain>(['cost', 'price'])).fields).toEqual(['colour'])
    expect(changeSummary(before, after, all).fields).toEqual(['colour', 'totalCost'])
  })

  it('takes a marked status as no status move', () => {
    expect(changeSummary({ status: markMoney('price', 'A') }, { status: markMoney('price', 'B') }, none)).toEqual({ status: null, fields: [] })
  })
})
