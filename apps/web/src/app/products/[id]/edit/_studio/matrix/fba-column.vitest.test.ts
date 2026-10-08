import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { FBA_SEND_COPY } from '@nexus/shared/fba-send'

import { buildMatrixColumns, CASE_COL, FBA_COL, fbaInboundText, fbaTooltip, fbaUnitsOf, STOCK_COL } from './columns'
import { MATRIX_COPY, type MatrixFbaInbound, type MatrixFbaPlan, type MatrixRowRead } from './contract'
import { parseMatrixRead } from './source'

/**
 * The FBA qty column (Owner 2026-10-06): the Matrix shows Amazon's FBA units next to Stock, and the column is LOCKED —
 * FBA quantity is Amazon's number and nothing in Nexus may write it (feedback_fba_quantity_untouchable).
 */
const row = (id: string, fba: MatrixRowRead['fba'], role: MatrixRowRead['role'] = 'variant', fbaInbound?: MatrixFbaInbound | null): MatrixRowRead => ({
  id, sku: id.toUpperCase(), role, stock: { available: 4, uncounted: false, locations: [] }, basePrice: 10, status: 'ACTIVE', cells: {},
  ...(fba === undefined ? {} : { fba }),
  ...(fbaInbound === undefined ? {} : { fbaInbound }),
})
const inbound = (over: Partial<MatrixFbaInbound> = {}): MatrixFbaInbound => ({ units: 24, working: 12, shipped: 12, receiving: 0, readAt: '2026-10-07T08:15:00.000Z', planned: 0, ...over })
const ROWS: Record<string, MatrixRowRead> = {
  counted: row('counted', { units: 14, locations: [{ code: 'AMAZON-EU-FBA', units: 14 }], updatedAt: '2026-01-02T03:04:05.000Z' }),
  zero: row('zero', { units: 0, locations: [{ code: 'AMAZON-EU-FBA', units: 0 }], updatedAt: null }),
  none: row('none', null),
  unread: row('unread', undefined),
  parent: row('parent', { units: 20, locations: [{ code: 'AMAZON-EU-FBA', units: 20 }], updatedAt: null }, 'parent'),
  inbound: row('inbound', { units: 92, locations: [{ code: 'AMAZON-EU-FBA', units: 92 }], updatedAt: null }, 'variant', inbound()),
  planned: row('planned', { units: 5, locations: [{ code: 'AMAZON-EU-FBA', units: 5 }], updatedAt: null }, 'variant', inbound({ units: 0, working: 0, shipped: 0, receiving: 0, readAt: null, planned: 24 })),
  noFbaInbound: row('noFbaInbound', null, 'variant', inbound({ units: 6, working: 6, shipped: 0 })),
  // "Mark shipped" (Owner 2026-10-07): Nexus's shipped units show at once; the "+N" is the bigger count, never the sum.
  sentOnly: row('sentOnly', { units: 4, locations: [{ code: 'AMAZON-EU-FBA', units: 4 }], updatedAt: null }, 'variant', inbound({ units: 0, working: 0, shipped: 0, receiving: 0, readAt: null, sent: 21 })),
  sentCounted: row('sentCounted', { units: 4, locations: [{ code: 'AMAZON-EU-FBA', units: 4 }], updatedAt: null }, 'variant', inbound({ units: 21, working: 0, shipped: 21, receiving: 0, sent: 21 })),
  amazonMore: row('amazonMore', { units: 4, locations: [{ code: 'AMAZON-EU-FBA', units: 4 }], updatedAt: null }, 'variant', inbound({ units: 30, working: 0, shipped: 30, receiving: 0, sent: 5 })),
}
const PLANS: MatrixFbaPlan[] = [{ id: 'cplan000000a1b2c3', name: 'Nexus IT 2026-10-08 #a1b2c3', status: 'WAITING_FOR_CHOICE', units: 24 }]

type Def = Record<string, unknown>
function shared(plans: MatrixFbaPlan[] = []): Def[] {
  const defs = buildMatrixColumns({
    coordinates: [], cellsOf: () => null, rowOf: (id: string) => ROWS[id] ?? null, tracker: null, sheetColumns: [], locale: 'it', market: 'IT',
    axesRef: { current: [] }, rowMenuRef: { current: () => [] }, onPickFulfilment: () => undefined, rowsRef: { current: [] },
    fbaPlansOf: () => plans,
  } as never) as Def[]
  return (defs.find((g) => g.groupId === 'grp-shared')!.children as Def[])
}
const fbaDef = () => shared().find((d) => d.colId === FBA_COL)!
const call = <T,>(fn: unknown, params: unknown): T => (fn as (p: unknown) => T)(params)

describe('the FBA qty column on the Matrix', () => {
  it('sits in the Shared group after Stock and Case (Step 3), headed "FBA qty"', () => {
    expect(shared().map((d) => d.colId)).toEqual(['basePrice', STOCK_COL, CASE_COL, FBA_COL])
    expect(fbaDef().headerName).toBe('FBA qty')
  })

  it('🔴 is locked in its DEFINITION: not editable, not movable, no fill handle, no paste, no editor, no setter', () => {
    const d = fbaDef()
    expect(d.editable).toBe(false)
    expect(d.suppressMovable).toBe(true)
    expect(d.suppressFillHandle).toBe(true)
    expect(d.suppressPaste).toBe(true)
    expect(d.cellEditor).toBeUndefined()
    expect(d.cellEditorSelector).toBeUndefined()
    expect(d.valueSetter).toBeUndefined()
    expect(d.field).toBeUndefined()
    // The DS locked cell's parts (value + lock glyph named with the reason) and the locked tint on every row.
    expect(d.cellRendererParams).toMatchObject({ kind: 'integer', reason: MATRIX_COPY.fbaLocked })
    expect(paint('counted')).toContain(`aria-label="${MATRIX_COPY.fbaLocked}"`)
    expect(paint('counted')).toContain('nds-cell-locked')
    for (const id of Object.keys(ROWS)) expect(call<boolean>((d.cellClassRules as Record<string, unknown>)['nds-cell-is-locked'], { data: { id } })).toBe(true)
  })

  it('shows the units Nexus mirrors; a measured 0 is 0; no FBA row and not read are both "—", never 0', () => {
    const d = fbaDef()
    const value = (id: string) => call<number | null>(d.valueGetter, { data: { id } })
    expect(value('counted')).toBe(14)
    expect(value('zero')).toBe(0)
    expect(value('none')).toBeNull()
    expect(value('unread')).toBeNull()
    expect(value('parent')).toBe(20)
    // Copy, export and sort read the same number; an empty cell copies as nothing, not 0.
    expect(call<string>(d.valueFormatter, { value: 0 })).toBe('0')
    expect(call<string>(d.valueFormatter, { value: null })).toBe('')
    expect(fbaUnitsOf(ROWS.unread)).toBeNull()
  })

  it('the tooltip says how many, where, when, and — on every row — why it is locked; the three empties say different things', () => {
    const counted = fbaTooltip(ROWS.counted)
    expect(counted).toContain('14 units at Amazon (AMAZON-EU-FBA 14)')
    expect(counted).toContain('Last updated in Nexus')
    expect(fbaTooltip(ROWS.zero)).toBe(`0 units at Amazon (AMAZON-EU-FBA 0) · ${MATRIX_COPY.fbaLocked}`)
    expect(fbaTooltip(ROWS.parent)).toMatch(/^Family total: 20 units at Amazon/)
    expect(fbaTooltip(ROWS.none)).toBe(`${MATRIX_COPY.fbaNone} · ${MATRIX_COPY.fbaLocked}`)
    expect(fbaTooltip(ROWS.unread)).toBe(`${MATRIX_COPY.fbaNotRead} · ${MATRIX_COPY.fbaLocked}`)
    for (const r of Object.values(ROWS)) expect(fbaTooltip(r)).toContain(MATRIX_COPY.fbaLocked)
    expect(call<string>(fbaDef().tooltipValueGetter, { data: { id: 'counted' } })).toBe(counted)
  })
})

/** The FBA qty cell as AG paints it for a row (its value is the column's own getter). */
function paint(id: string): string {
  const d = fbaDef()
  const value = call<number | null>(d.valueGetter, { data: { id } })
  return renderToStaticMarkup(createElement(d.cellRenderer as never, { ...(d.cellRendererParams as object), value, data: { id } } as never))
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

describe('Send to FBA (Step 4): the FBA qty cell shows Amazon\'s inbound "+N"', () => {
  it('"92 +24": the number stays the value (sort, copy, export read 92), "+24" muted after it, the lock stays', () => {
    const d = fbaDef()
    expect(call<number | null>(d.valueGetter, { data: { id: 'inbound' } })).toBe(92)
    expect(call<string>(d.valueFormatter, { value: 92 })).toBe('92')
    const html = paint('inbound')
    expect(text(html)).toBe('92 +24')
    expect(html).toContain('<span class="nds-cell-muted">+24</span>')
    expect(html).toContain(`aria-label="${MATRIX_COPY.fbaLocked}"`)
    // Still locked in its definition: nothing can write it.
    expect(d.editable).toBe(false)
    expect(d.valueSetter).toBeUndefined()
  })

  it('no "+N" without Amazon inbound: nothing read, null, 0 inbound with only Nexus-planned units', () => {
    expect(text(paint('counted'))).toBe('14')
    expect(text(paint('unread'))).toBe('—')
    expect(text(paint('planned'))).toBe('5')
    expect(fbaInboundText(ROWS.planned)).toBeNull()
    expect(fbaInboundText(ROWS.counted)).toBeNull()
    expect(fbaInboundText({ fbaInbound: null })).toBeNull()
    expect(fbaInboundText(ROWS.inbound)).toBe(FBA_SEND_COPY.inbound(24))
    // No FBA row yet, units on their way: the empty dash, never a 0, then "+6".
    expect(text(paint('noFbaInbound'))).toBe('— +6')
  })

  it('"+N" right after "Mark shipped": the bigger of Amazon\'s inbound and Nexus\'s shipped units, never the sum', () => {
    // Shipped by Nexus, Amazon has not read it yet: "+21" at once.
    expect(fbaInboundText(ROWS.sentOnly)).toBe('+21')
    expect(text(paint('sentOnly'))).toBe('4 +21')
    // Amazon's read now includes the same 21: still "+21", never "+42".
    expect(fbaInboundText(ROWS.sentCounted)).toBe('+21')
    expect(text(paint('sentCounted'))).toBe('4 +21')
    // Amazon counts more than Nexus sent: Amazon's number.
    expect(fbaInboundText(ROWS.amazonMore)).toBe('+30')
    // Planned only (not shipped): still no "+N", with or without a `sent` of 0.
    expect(fbaInboundText({ fbaInbound: inbound({ units: 0, working: 0, shipped: 0, receiving: 0, readAt: null, planned: 24, sent: 0 }) })).toBeNull()
    expect(fbaInboundText(ROWS.planned)).toBeNull()
    // The value stays the FBA number (sort, copy, export).
    expect(call<number | null>(fbaDef().valueGetter, { data: { id: 'sentOnly' } })).toBe(4)
  })

  it('the tooltip adds one line when Nexus shipped more than Amazon counts, and only then', () => {
    const sentLine = FBA_SEND_COPY.sentNotCounted(21)
    expect(sentLine).toBe('21 shipped by Nexus — Amazon has not counted them yet')
    expect(fbaTooltip(ROWS.sentOnly)).toBe(`4 units at Amazon (AMAZON-EU-FBA 4) · ${sentLine} · ${MATRIX_COPY.fbaLocked}`)
    expect(fbaTooltip(ROWS.sentCounted)).not.toContain('shipped by Nexus')
    expect(fbaTooltip(ROWS.sentCounted)).toContain('inbound 21 (working 0, shipped 21, receiving 0)')
    expect(fbaTooltip(ROWS.amazonMore)).not.toContain('shipped by Nexus')
    expect(fbaTooltip(ROWS.inbound)).not.toContain('shipped by Nexus')
  })

  it('the tooltip: at Amazon · inbound with its breakdown · when Amazon read it · the units in open Nexus plans · locked', () => {
    const tip = fbaTooltip(ROWS.inbound, PLANS)
    expect(tip).toMatch(/^92 units at Amazon \(AMAZON-EU-FBA 92\) · inbound 24 \(working 12, shipped 12, receiving 0\) · read .+ · /)
    expect(tip.endsWith(MATRIX_COPY.fbaLocked)).toBe(true)
    expect(fbaTooltip(ROWS.planned, PLANS)).toBe(`5 units at Amazon (AMAZON-EU-FBA 5) · 24 in Nexus plan #a1b2c3 · ${MATRIX_COPY.fbaLocked}`)
    expect(fbaTooltip(ROWS.planned)).toBe(`5 units at Amazon (AMAZON-EU-FBA 5) · 24 in open Nexus plans · ${MATRIX_COPY.fbaLocked}`)
    // The column reads the family's plans at paint time.
    expect(call<string>(shared(PLANS).find((x) => x.colId === FBA_COL)!.tooltipValueGetter, { data: { id: 'planned' } })).toContain('#a1b2c3')
    // The product sheet's call (no inbound on its rows) is unchanged.
    expect(fbaTooltip({ role: 'variant', fba: null })).toBe(`${MATRIX_COPY.fbaNone} · ${MATRIX_COPY.fbaLocked}`)
  })

  it('the Matrix read carries fbaInbound per row and the family\'s open plans; absent stays absent, malformed reads as not read', () => {
    const parsed = parseMatrixRead({
      coordinates: [], productId: 'root',
      fbaPlans: [...PLANS, { id: 'x', status: 'NOT_A_STATUS' }, { name: 'no id', status: 'QUEUED' }],
      rows: [
        { id: 'a', fbaInbound: { units: 24, working: 12, shipped: 12, receiving: 0, readAt: '2026-10-07T08:15:00.000Z', planned: 3 } },
        { id: 'b', fbaInbound: null },
        { id: 'c' },
        { id: 'd', fbaInbound: { units: 'many' } },
        { id: 'e', fbaInbound: { units: 0, working: 0, shipped: 0, receiving: 0, readAt: null, planned: 0, sent: 21 } },
        { id: 'f', fbaInbound: { units: 0, working: 0, shipped: 0, receiving: 0, readAt: null, planned: 2, sent: -3 } },
      ],
    }, 'root')
    if (!('read' in parsed)) throw new Error(parsed.problem)
    expect(parsed.read.fbaPlans).toEqual(PLANS)
    expect(parsed.read.rows.map((r) => r.fbaInbound)).toEqual([
      { units: 24, working: 12, shipped: 12, receiving: 0, readAt: '2026-10-07T08:15:00.000Z', planned: 3 }, null, undefined, undefined,
      { units: 0, working: 0, shipped: 0, receiving: 0, readAt: null, planned: 0, sent: 21 },
      { units: 0, working: 0, shipped: 0, receiving: 0, readAt: null, planned: 2 },
    ])
    // `sent` absent (an older server) or not a number ≥ 0 stays absent — no key at all.
    expect('sent' in parsed.read.rows[0]!.fbaInbound!).toBe(false)
    expect('sent' in parsed.read.rows[5]!.fbaInbound!).toBe(false)
    const older = parseMatrixRead({ coordinates: [], rows: [] }, 'root')
    expect('read' in older && 'fbaPlans' in older.read).toBe(false)
  })
})
