import { describe, expect, it } from 'vitest'
import { DATE_ONLY_KEYS } from '@nexus/factory-domain/planning/promise/date-only'
import type { AskedCell } from '@nexus/factory-domain/sales/change-requests/rules'
import { earliestAskOf, freezeOf, impactAskOf, impactFrom, impactLinesOf } from './impact'

/**
 * B-PR-25 — what the impact before Send asks of planning and of the freeze rules, pure (production plan §3 "Before Send it sees:
 * what is frozen, priced or not, earliest date"; 08-backend §4.2 "only a date leaves it, never a load or a line"; wall test PW-P06,
 * pure part). The database half (the customer's own rule, the kept impact, another customer's 404) is
 * change-requests.pg.vitest.test.ts.
 */

const L10 = '00000000-0000-7000-8000-0000000000a1'
const L20 = '00000000-0000-7000-8000-0000000000a2'
const FOREIGN = '00000000-0000-7000-8000-0000000000ff'
const cell = (orderLineId: string, size: string | null, quantityBefore: number, quantity: number): AskedCell => ({ orderLineId, size, quantityBefore, quantity })
const stages = (order: 'RELEASED' | null, sizes: Record<string, Record<string, 'RELEASED' | 'CUT' | null>> = {}) => ({
  order: { stage: order, on: null },
  lines: new Map(Object.entries(sizes).map(([lineId, bySize]) => [lineId, { line: { stage: Object.values(bySize).find((stage) => stage !== null) ?? null, on: null }, sizes: new Map(Object.entries(bySize).map(([size, stage]) => [size, { stage, on: null }])) }])),
})

describe('B-PR-25 what planning is asked (a date only)', () => {
  it('a change asks planning only with a date or added pieces: the order’s open lines as planned, and the added pieces alone', () => {
    expect(earliestAskOf('CHANGE', [cell(L10, '50', 2, 1)], null, [L10, L20])).toBeNull()
    expect(earliestAskOf('CHANGE', [cell(L10, '50', 2, 4), cell(L10, '52', 3, 3), cell(L20, '50', 1, 2)], null, [L10, L20])).toEqual({
      wanted: null,
      lines: [
        { lineId: L10, sizes: null },
        { lineId: L20, sizes: null },
      ],
      extra: [
        { lineId: L10, sizes: [{ size: '50', quantity: 2 }] },
        { lineId: L20, sizes: [{ size: '50', quantity: 1 }] },
      ],
    })
    expect(earliestAskOf('CHANGE', [], '2026-12-20', [L10])).toEqual({ wanted: '2026-12-20', lines: [{ lineId: L10, sizes: null }], extra: [] })
  })

  it('a rush only with its need-by date; a split for its first part’s sizes; a pause, a resume, a sample round and a cancel never', () => {
    expect(earliestAskOf('RUSH', [], null, [L10])).toBeNull()
    expect(earliestAskOf('RUSH', [], '2026-12-01', [L10])).toEqual({ wanted: '2026-12-01', lines: [{ lineId: L10, sizes: null }], extra: [] })
    expect(earliestAskOf('SPLIT_SHIPMENT', [cell(L10, '50', 2, 1), cell(L10, '52', 3, 3)], null, [L10, L20])).toEqual({ wanted: null, lines: [{ lineId: L10, sizes: ['50', '52'] }], extra: [] })
    for (const kind of ['HOLD', 'RESUME', 'SAMPLE_ROUND', 'CANCEL'] as const) expect(earliestAskOf(kind, [cell(L10, null, 5, 1)], null, [L10]), kind).toBeNull()
  })
})

describe('B-PR-25 what the freeze rules read', () => {
  it('a change reads only the cells that move, its date and its address; a rush and a split their date; the rest nothing', () => {
    expect(impactAskOf('CHANGE', [cell(L10, '50', 2, 4), cell(L10, '52', 3, 3), cell(L20, null, 1, 0)], { requestedDate: '2026-12-20', shipToAddressId: 'addr' })).toEqual({ kind: 'CHANGE', cells: [{ lineId: L10, size: '50' }], requestedDate: '2026-12-20', shipTo: true })
    expect(impactAskOf('RUSH', [], { requestedDate: '2026-12-01', shipToAddressId: null })).toEqual({ kind: 'RUSH', requestedDate: '2026-12-01' })
    expect(impactAskOf('HOLD', [], { requestedDate: '2026-12-01', shipToAddressId: null })).toEqual({ kind: 'HOLD', requestedDate: null })
  })

  it('wall (PW-P06, pure): the impact names only the order’s own lines, holds no number and its date is a date only', () => {
    const rules = [{ id: 'rule-1', field: 'SIZE_QUANTITY' as const, frozenFrom: 'RELEASED' as const, action: 'CHANGE_REQUEST' as const, active: true, note: null }]
    const lines = impactLinesOf(
      [
        { id: L10, seq: 10, kind: 'SIZE_GRID', closedShortQuantity: null, sizes: [{ size: '50' }, { size: '52' }] },
        { id: L20, seq: 20, kind: 'FEE', closedShortQuantity: null, sizes: [] },
      ],
      stages('RELEASED', { [L10]: { '50': 'RELEASED', '52': null } }),
    )
    expect(lines.map((line) => line.id)).toEqual([L10])
    const ask = impactAskOf('CHANGE', [cell(L10, '50', 2, 4), cell(FOREIGN, '50', 1, 3)], { requestedDate: null, shipToAddressId: null })
    const impact = impactFrom(ask, lines, { stages: stages('RELEASED', { [L10]: { '50': 'RELEASED' } }), rules }, null, { date: '2026-12-11', partial: false, meetsWanted: null })
    expect(impact.frozen.map((item) => [item.lineId, item.size, item.state])).toEqual([[L10, '50', 'CHANGE_REQUEST']])
    expect(impact.priced).toBe(true)
    expect(JSON.stringify(impact)).not.toContain(FOREIGN)
    expect(JSON.stringify(impact)).not.toContain('rule-1')
    const numbers = (value: unknown): unknown[] => (typeof value === 'number' ? [value] : Array.isArray(value) ? value.flatMap(numbers) : value !== null && typeof value === 'object' ? Object.values(value).flatMap(numbers) : [])
    expect(numbers(impact)).toEqual([])
    expect(Object.keys(impact.earliest!).filter((key) => key !== 'words').sort()).toEqual([...DATE_ONLY_KEYS].sort())
    // The freeze a screen shows: its state and words, never the rule.
    expect(freezeOf(rules, 'SIZE_QUANTITY', 'RELEASED')).toEqual({ state: 'CHANGE_REQUEST', words: expect.objectContaining({ en: expect.any(String) }) })
    expect(freezeOf(rules, 'SIZE_QUANTITY', null)).toEqual({ state: 'OPEN', words: expect.objectContaining({ en: 'Still open' }) })
  })
})
