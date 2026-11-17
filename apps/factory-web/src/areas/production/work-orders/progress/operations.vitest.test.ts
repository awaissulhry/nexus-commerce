import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { LOCALES } from '../../../../lib/i18n/locales'
import { leftKeys, renderView, textOf } from '../../../../lib/record-thread/parts/testing'
import { wipOf, wipWithUnplanned, workOrder } from '../../_shared/fixtures'
import { designScreen } from './fixtures'
import { linesOutput, operationRows } from './model'

/**
 * F-PR-06 — Operations & WIP (06-tree A.4 Tab 4, O-WO-ops): ONE operation table, the By operation / By size switch gone — each
 * operation row opens to its sizes; the biggest pile marked in the table (the W2a flow strip went into it); an operation at a
 * workshop marked; output per line from the final operation; no worker anywhere. Figures by hand from the made-up WIP (six
 * operations; 20 ASM-CORPO arrived 20, waiting 4, good 16; 50 IMB waiting 6, the biggest pile).
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
const WO = workOrder('IN_PROGRESS')

describe('F-PR-06 — one operation table, rows open to sizes', () => {
  it('a row per operation in the routing’s order, its figures and standard minutes', () => {
    const rows = operationRows(WO, wipOf())
    expect(rows.map((row) => `${row.seq} ${row.code}`)).toEqual(['10 TAGLIO', '20 ASM-CORPO', '30 CUC-IMP', '35 STIRO', '40 CTRL', '50 IMB'])
    expect(rows[1]).toMatchObject({ arrived: 20, waiting: 4, good: 16, scanned: true, final: false, outsourced: false, bundles: { done: 4, waiting: 1, notReached: 0 } })
    expect(rows[5]).toMatchObject({ final: true, waiting: 6 })
    expect(rows[3]!.scanned).toBe(false)
  })

  it('each operation’s sizes: the work order’s cells in order, the good at that operation (cut for 10/20, sewn for 30, finished after)', () => {
    const rows = operationRows(WO, wipOf())
    expect(rows[1]!.sizes.map((size) => [size.cell, size.quantity, size.good])).toEqual([
      ['BLK 48', 4, 4],
      ['BLK 50', 6, 6],
      ['BLK 52', 6, 6],
      ['BLK 54', 4, 4],
      ['RED 50', 3, 3],
      ['RED 52', 3, 0],
    ])
    expect(rows[2]!.sizes.map((size) => size.good)).toEqual([4, 4, 4, 0, 0, 0])
    // An operation with no count per size opens to nothing.
    expect(operationRows(WO, { ...wipOf(), operations: wipOf().operations.map((op) => ({ ...op, cells: [] })) })[0]!.sizes).toEqual([])
  })

  it('the biggest pile is marked once (an unplanned operation never: nothing waits for it); none when nothing waits', () => {
    const rows = operationRows(WO, wipWithUnplanned())
    expect(rows.filter((row) => row.bottleneck).map((row) => row.code)).toEqual(['IMB'])
    expect(rows.find((row) => row.code === 'REINF')).toMatchObject({ unplanned: true, bottleneck: false })
    expect(operationRows(WO, wipOf(true)).some((row) => row.bottleneck)).toBe(false)
  })

  it('an operation at a subcontract work centre is marked as at a workshop', () => {
    const wip = wipOf()
    const rows = operationRows(WO, { ...wip, operations: wip.operations.map((op) => (op.seq === 30 ? { ...op, workCentreKind: 'SUBCONTRACT' } : op)) })
    expect(rows.filter((row) => row.outsourced).map((row) => row.seq)).toEqual([30])
  })

  it('finished per line: the final operation’s good garments summed per line', () => {
    expect(linesOutput(wipOf())).toEqual([])
    expect(linesOutput(wipOf(true))).toEqual([{ id: expect.any(String), code: 'L1', name: 'Linea giacche', good: 26 }])
  })
})

describe('F-PR-06 — the screen', () => {
  it('no By operation / By size switch; each operation has a “Per size” disclosure; the biggest pile is said', () => {
    const html = draw('operations')
    const text = textOf(html)
    expect(text).not.toContain('Good per size')
    expect(text).not.toContain('Per operation')
    expect(html).toContain('nds-disclosure')
    expect(text).toContain('Per size (6)')
    expect(text).toContain('Biggest pile')
    // The flow strip went into the table: one drawing of the operations.
    expect(html).not.toContain('fw-wd-flow')
  })

  it('a workshop’s operation says it is at a workshop, counted by the scans of what came back', () => {
    const text = textOf(draw('operations-workshop'))
    expect(text).toContain('At a workshop')
    expect(text).toContain('Counted by the scans of what came back.')
  })

  it('per operation, size and line only (the model has no person); corrections waiting are a door to Labour', () => {
    for (const row of operationRows(WO, wipOf())) expect(Object.keys(row).filter((key) => key === 'worker' || key === 'station')).toEqual([])
    expect(draw('operations')).toMatch(/production\/labour\?kind=CORRECTION|home\/today/)
  })

  it('every case draws in it and en with no key left', () => {
    for (const item of designScreen.cases) {
      for (const locale of LOCALES) expect(leftKeys(renderView(view, item.model, locale), ['ops', 'flow', 'extra', 'tab', 'part', 'kind']), `${item.id} (${locale})`).toEqual([])
    }
  })
})
