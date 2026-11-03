import { describe, expect, it } from 'vitest'
import { countsOf, doneStill, isRowCode, outCounts, reasonWords, repairHeld, repairTile, rowOfCode, withDone, type RepairQueue, type RepairRow } from './model'

const row = (id: string, code: string | null, extra: Partial<RepairRow> = {}): RepairRow => ({
  reworkId: id,
  workOrder: { id: `wo-${id}`, number: 'WO-1', status: 'IN_PROGRESS', dueDate: null, rush: false, holdReason: null, style: { code: 'S', name: 'Style' } },
  cell: { id: 'c', colourwayCode: 'NER', size: '50' },
  bundle: code ? { id: `b-${id}`, code, part: null } : null,
  quantity: 2,
  reason: { code: 'SEAM_OPEN', it: 'Cucitura aperta', en: 'Open seam' },
  description: null,
  foundAt: null,
  reworkAt: { seq: 20, code: 'OP20', name: 'Sew' },
  state: 'WAITING',
  here: false,
  station: null,
  inAt: null,
  since: '2026-11-03T08:00:00.000Z',
  held: false,
  version: 1,
  ...extra,
})

const queue = (rows: RepairRow[]): RepairQueue => ({ asOf: '2026-11-03T09:00:00.000Z', station: { id: 'st', code: 'REP-01', name: 'Repair 1' }, rows, counts: countsOf(rows) })

describe("My work's repair queue (MES-132)", () => {
  it('finds the row a scanned ticket names, whatever its case and spaces; a row with no bundle takes no scan', () => {
    const list = queue([row('a', 'B-0001'), row('b', null)])
    expect(rowOfCode(list, ' b-0001 ')?.reworkId).toBe('a')
    expect(rowOfCode(list, 'B-0002')).toBeNull()
    expect(isRowCode(list.rows[0]!, 'b-0001')).toBe(true)
    expect(isRowCode(list.rows[1]!, 'b-0001')).toBe(false)
  })

  it('moves a row at once when this tablet scanned it: in repair here, or gone once out', () => {
    const list = queue([row('a', 'B-1'), row('b', 'B-2')])
    const shown = withDone(list, [
      { reworkId: 'a', step: 'IN', at: '2026-11-03T09:05:00.000Z', clientEventId: 'q1' },
      { reworkId: 'b', step: 'OUT', at: '2026-11-03T09:06:00.000Z', clientEventId: null },
    ])!
    expect(shown.rows.map((entry) => [entry.reworkId, entry.state, entry.here, entry.station?.code])).toEqual([['a', 'IN_REPAIR', true, 'REP-01']])
    expect(shown.counts).toEqual({ here: 1, waiting: 0, inRepair: 1 })
  })

  it('drops a mark once the office shows the move', () => {
    const done = [
      { reworkId: 'a', step: 'IN' as const, at: 't', clientEventId: null },
      { reworkId: 'b', step: 'OUT' as const, at: 't', clientEventId: null },
    ]
    expect(doneStill(done, queue([row('a', 'B-1', { state: 'IN_REPAIR' }), row('b', 'B-2')])).map((entry) => entry.reworkId)).toEqual(['b'])
    expect(doneStill(done, queue([row('a', 'B-1')]))).toEqual([done[0]])
  })

  it("counts this station's repairs for the tile, else the site's; hidden at zero", () => {
    expect(repairTile(queue([row('a', 'B-1', { here: true }), row('b', 'B-2')]))).toEqual({ count: 1, here: true })
    expect(repairTile(queue([row('b', 'B-2')]))).toEqual({ count: 1, here: false })
    expect(repairTile(queue([]))).toBeNull()
    expect(repairTile(null)).toBeNull()
  })

  it('holds a held or closed work order; the scan out takes all good by default, or the good ones typed', () => {
    expect(repairHeld(row('a', 'B-1', { held: true }))).toBe('onHold')
    expect(repairHeld(row('a', 'B-1', { workOrder: { ...row('a', 'B').workOrder, status: 'COMPLETED' } }))).toBe('notOpen')
    expect(repairHeld(row('a', 'B-1'))).toBeNull()
    expect(outCounts(row('a', 'B-1'), null)).toEqual({ good: 2, scrap: 0 })
    expect(outCounts(row('a', 'B-1'), 1)).toEqual({ good: 1, scrap: 1 })
    expect(outCounts(row('a', 'B-1'), 3)).toBeNull()
    expect(reasonWords(row('a', 'B-1'), 'it')).toBe('Cucitura aperta')
    expect(reasonWords(row('a', 'B-1', { reason: { code: 'OLD', it: null, en: null } }), 'en')).toBe('OLD')
  })
})
