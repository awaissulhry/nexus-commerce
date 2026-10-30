import { describe, expect, it } from 'vitest'
import { canTransition } from '../../state/machine'
import { countSheetPaper, valuedList, valuedListPaper, valuedListRows, type PaperCompany, type PaperCount, type ValuedListLine } from './documents'
import {
  approveProblems,
  COUNT_RULES,
  countMoveNote,
  createProblems,
  differencePercent,
  differenceValue,
  isFiscalYearEnd,
  lineStatus,
  lineValue,
  needsApproval,
  plannedMoveOf,
  quantityProblem,
  recountSuggested,
  signOffProblems,
  snapshotFor,
  snapshotLines,
  stockCountMachine,
  submitProblems,
  type LineFacts,
} from './rules'

/**
 * The counts' rules (B-W2a-15; SCM-224, SCM-230, SCM-229): the states, the snapshot's instant and lines, a line's
 * difference and its COUNT move, the value of the differences and the approval, the four eyes, the refusals in words,
 * and the papers (count sheets, the year-end valued list adding up).
 */

const line = (expected: string, counted: string | null, extra: Partial<LineFacts> = {}): LineFacts => ({ expected, counted, recountRequested: false, recount: null, ...extra })

describe('the states', () => {
  it('moves DRAFT → COUNTING → SUBMITTED → APPROVED → APPLIED → SIGNED_OFF, sends back and cancels before the apply', () => {
    expect(canTransition(stockCountMachine, 'DRAFT', 'COUNTING').ok).toBe(true)
    expect(canTransition(stockCountMachine, 'SUBMITTED', 'COUNTING').ok).toBe(true)
    expect(canTransition(stockCountMachine, 'APPROVED', 'CANCELLED').ok).toBe(true)
    expect(canTransition(stockCountMachine, 'APPLIED', 'SIGNED_OFF').ok).toBe(true)
    expect(canTransition(stockCountMachine, 'APPLIED', 'CANCELLED').ok).toBe(false)
    expect(canTransition(stockCountMachine, 'COUNTING', 'APPROVED').ok).toBe(false)
    expect(stockCountMachine.finals).toEqual(['SIGNED_OFF', 'CANCELLED'])
  })
})

describe('making and starting', () => {
  it('a year-end inventory is taken as of 31 December; a cycle count has no date', () => {
    expect(createProblems({ kind: 'YEAR_END', inventoryDate: '2026-12-31' })).toEqual([])
    expect(createProblems({ kind: 'YEAR_END', inventoryDate: null })[0]!.path).toBe('body/inventoryDate')
    expect(createProblems({ kind: 'YEAR_END', inventoryDate: '2026-12-30' })[0]!.message).toMatch(/31 December/)
    expect(createProblems({ kind: 'CYCLE', inventoryDate: '2026-12-31' })[0]!.message).toBe('Only a year-end inventory has an inventory date.')
    expect(isFiscalYearEnd('2027-12-31')).toBe(true)
    expect(isFiscalYearEnd('2027-06-30')).toBe(false)
  })

  it('the snapshot: a cycle count at its start; a year-end inventory at the end of its day (Europe/Rome) when taken later', () => {
    const now = new Date('2027-01-04T08:00:00.000Z')
    expect(snapshotFor('CYCLE', null, now)).toEqual({ at: now })
    // 31 Dec 2026 ends at 1 Jan 00:00 in Rome (CET, UTC+1): 22:59:59.999Z.
    expect(snapshotFor('YEAR_END', '2026-12-31', now).at?.toISOString()).toBe('2026-12-31T22:59:59.999Z')
    const onTheDay = new Date('2026-12-31T15:00:00.000Z')
    expect(snapshotFor('YEAR_END', '2026-12-31', onTheDay)).toEqual({ at: onTheDay })
    expect(snapshotFor('YEAR_END', '2026-12-31', new Date('2026-12-30T22:59:59.000Z')).problem).toMatch(/starts on its inventory date/)
  })

  it('the snapshot lines: only what is held, in walking order, numbered 10, 20, …', () => {
    const key = (locationId: string, itemId: string, onHand: string, hideId: string | null = null) => ({ siteId: 's', locationId, itemId, itemColourId: null, lotId: hideId ? 'lot' : null, hideId, onHand })
    const path: Record<string, string> = { b: 'STORE/BIN-02', a: 'STORE/BIN-01' }
    const lines = snapshotLines([key('b', 'i1', '3'), key('a', 'i2', '0'), key('a', 'i1', '5.5'), key('a', 'leather', '51.8', 'h2'), key('a', 'leather', '-1', 'h9')], (k) => [path[k.locationId]!, k.itemId, k.hideId ?? ''])
    expect(lines.map((entry) => [entry.seq, entry.locationId, entry.itemId, entry.expected])).toEqual([
      [10, 'a', 'i1', '5.5000'],
      [20, 'a', 'leather', '51.8000'],
      [30, 'b', 'i1', '3.0000'],
    ])
  })
})

describe('a line', () => {
  it('its status, final count, difference, percentage and the COUNT move it posts', () => {
    expect(lineStatus(line('10', null))).toBe('UNCOUNTED')
    expect(lineStatus(line('10', '9', { recountRequested: true }))).toBe('RECOUNT_DUE')
    expect(lineStatus(line('10', '9', { recountRequested: true, recount: '10' }))).toBe('COUNTED')
    expect(differencePercent(line('120', '118.5'))).toBe('-1.3')
    expect(differencePercent(line('0', '4'))).toBeNull()
    expect(plannedMoveOf({ ...line('120', '118.5'), locationId: 'bin' })).toEqual({ direction: 'OUT', fromLocationId: 'bin', toLocationId: null, baseQuantity: '1.5000' })
    expect(plannedMoveOf({ ...line('0', '6'), locationId: 'bin' })).toEqual({ direction: 'IN', fromLocationId: null, toLocationId: 'bin', baseQuantity: '6.0000' })
    // The recount replaces the count.
    expect(plannedMoveOf({ ...line('10', '7', { recountRequested: true, recount: '10' }), locationId: 'bin' })).toBeNull()
  })

  it('a recount is suggested for a hide that differs, for what was found where nothing was expected, and over 5 %', () => {
    expect(recountSuggested({ ...line('51.8', '0'), hideId: 'h' })).toBe(true)
    expect(recountSuggested({ ...line('0', '2'), hideId: null })).toBe(true)
    expect(recountSuggested({ ...line('100', '94'), hideId: null })).toBe(true)
    expect(recountSuggested({ ...line('100', '95'), hideId: null })).toBe(false)
    expect(recountSuggested({ ...line('100', '100'), hideId: 'h' })).toBe(false)
  })

  it('a quantity is a decimal from 0 with four places; a hide never more than the area it measured', () => {
    expect(quantityProblem('118.5', 'x')).toBeNull()
    expect(quantityProblem('-1', 'x')?.path).toBe('x')
    expect(quantityProblem('1.23456', 'x')?.message).toMatch(/4 decimals/)
    expect(quantityProblem('52', 'x', '51.8')?.message).toMatch(/at most 51.8000/)
  })

  it('the COUNT move says why: the count, the line and its reason', () => {
    expect(countMoveNote('CNT-2026-0001', 10, 'COUNT_ERROR', 'Roll measured short.')).toBe('Count CNT-2026-0001 line 10: COUNT_ERROR — Roll measured short.')
    expect(countMoveNote('CNT-2026-0001', 20, null, null)).toBe('Count CNT-2026-0001 line 20')
  })
})

describe('the value of the differences and the approval (SCM-229)', () => {
  it('Σ |difference| × unit cost, rounded once; a line without a cost or in another currency makes the value unknown', () => {
    const value = differenceValue(
      [
        { ...line('120', '118.5'), unitCost: '3.100000', currency: 'EUR' },
        { ...line('51.8', '0'), unitCost: '4.200000', currency: 'EUR' },
        { ...line('0', '6'), unitCost: '6.500000', currency: 'EUR' },
        { ...line('5', '5'), unitCost: null, currency: 'EUR' },
      ],
      'EUR',
    )
    // 1.5 × 3.10 + 51.8 × 4.20 + 6 × 6.50 = 4.65 + 217.56 + 39.00 = 261.21
    expect(value).toEqual({ amount: 26_121, lines: 3, unvalued: 0, otherCurrency: 0 })
    expect(needsApproval(value)).toBe(false)
    expect(needsApproval({ ...value, amount: COUNT_RULES.approvalLimitMinor + 1 })).toBe(true)
    expect(needsApproval(differenceValue([{ ...line('1', '0'), unitCost: null, currency: 'EUR' }], 'EUR'))).toBe(true)
    expect(needsApproval(differenceValue([{ ...line('1', '0'), unitCost: '1', currency: 'USD' }], 'EUR'))).toBe(true)
    expect(lineValue(line('120', '118.5'), '3.100000', 'EUR')).toBe(-465)
  })

  it('over the limit, the approver counted or recounted no line that differs; under it anyone who may approve', () => {
    const lines = [
      { ...line('10', '9'), seq: 10, countedById: 'ann', recountedById: null },
      { ...line('5', '5'), seq: 20, countedById: 'bob', recountedById: null },
      { ...line('8', '8', { recountRequested: true, recount: '7' }), seq: 30, countedById: 'cid', recountedById: 'bob' },
    ]
    expect(approveProblems(true, 'ann', lines)[0]).toMatchObject({ code: 'OWN_VARIANCE', message: expect.stringMatching(/\(10\)/) })
    expect(approveProblems(true, 'bob', lines)[0]!.message).toMatch(/\(30\)/)
    expect(approveProblems(true, 'dan', lines)).toEqual([])
    expect(approveProblems(false, 'ann', lines)).toEqual([])
  })
})

describe('the refusals in words', () => {
  it('submit: lines not counted, recounts due, differences without a reason', () => {
    const problems = submitProblems([
      { ...line('1', null), seq: 10, reasonCode: null },
      { ...line('1', '2', { recountRequested: true }), seq: 20, reasonCode: null },
      { ...line('1', '0'), seq: 30, reasonCode: null },
      { ...line('1', '0'), seq: 40, reasonCode: 'COUNT_ERROR' },
      { ...line('1', '1'), seq: 50, reasonCode: null },
    ])
    expect(problems.map((problem) => problem.code)).toEqual(['UNCOUNTED', 'RECOUNT_DUE', 'NO_REASON'])
    expect(problems[2]!.message).toBe('1 line(s) that differ say no reason (30); pick one from the adjustment reasons.')
  })

  it('sign-off: a year-end inventory, applied, its number typed', () => {
    expect(signOffProblems({ kind: 'CYCLE', status: 'APPLIED', number: 'C' }, 'C')[0]!.code).toBe('NOT_YEAR_END')
    expect(signOffProblems({ kind: 'YEAR_END', status: 'APPROVED', number: 'C' }, 'C')[0]!.code).toBe('NOT_APPLIED')
    expect(signOffProblems({ kind: 'YEAR_END', status: 'APPLIED', number: 'CNT-2026-0007' }, 'cnt-2026-0007')[0]!.code).toBe('PHRASE')
    expect(signOffProblems({ kind: 'YEAR_END', status: 'APPLIED', number: 'CNT-2026-0007' }, ' CNT-2026-0007 ')).toEqual([])
  })
})

describe('the papers', () => {
  const company: PaperCompany = { name: 'Pelletteria Inventata S.r.l.', lines: ['Sede legale: Via Finta 1, 20100 Milano MI'], legal: 'Pelletteria Inventata S.r.l. · P. IVA IT00000000000' }
  const count: PaperCount = { number: 'CNT-2026-0003', kind: 'YEAR_END', site: 'A1 · Plant A1', scope: null, countTeam: 'Team A', snapshotAt: new Date('2026-12-31T22:59:59.999Z'), inventoryDate: '2026-12-31' }
  const entry = (overrides: Partial<ValuedListLine>): ValuedListLine => ({
    itemId: 'leather',
    itemCode: 'LEA-100',
    itemName: 'Cowhide',
    itemKind: 'LEATHER',
    uom: 'FT2',
    colour: 'BLK',
    lotId: 'lot1',
    lot: 'LOT-1',
    hideId: null,
    quantity: '0',
    unitCost: '4.200000',
    method: 'LOT_COST',
    currency: 'EUR',
    ...overrides,
  })

  it('the valued list: hides summed per lot, nothing held left out, each row rounded once and the totals their sums', () => {
    const list = valuedList(
      [
        entry({ hideId: 'h1', quantity: '53.2' }),
        entry({ hideId: 'h2', quantity: '51.8' }),
        entry({ hideId: 'h3', quantity: '0' }),
        entry({ itemId: 'lining', itemCode: 'LIN-200', itemName: 'Lining', itemKind: 'LINING', uom: 'M', colour: 'GRY', lotId: 'lot2', lot: 'LOT-2', quantity: '118.5', unitCost: '3.100000', method: 'STANDARD_COST' }),
        entry({ itemId: 'thread', itemCode: 'THR-1', itemName: 'Thread', itemKind: 'THREAD', uom: 'CONE', colour: null, lotId: null, lot: null, quantity: '4', unitCost: null, method: null }),
      ],
      'EUR',
    )
    expect(list.rows.map((row) => [row.itemCode, row.hides, row.quantity, row.value])).toEqual([
      ['LEA-100', 2, '105.0000', 44_100],
      ['LIN-200', 0, '118.5000', 36_735],
      ['THR-1', 0, '4.0000', null],
    ])
    expect(list.total).toBe(80_835)
    expect(list.total).toBe(list.rows.reduce((sum, row) => sum + (row.value ?? 0), 0))
    expect(list.kinds.map((kind) => [kind.kind, kind.value, kind.unvalued])).toEqual([
      ['LEATHER', 44_100, 0],
      ['LINING', 36_735, 0],
      ['THREAD', 0, 1],
    ])
    expect(list.unvalued).toBe(1)

    const paper = valuedListPaper(count, list, company, { language: 'it', preview: false, signedOff: { at: new Date('2027-01-05T10:00:00.000Z'), by: 'Ada Rossi' }, at: new Date('2027-01-05T10:00:00.000Z') })
    expect(paper.title).toBe('Inventario valorizzato')
    expect(paper.totals.at(-1)).toEqual({ label: 'Totale inventario', value: '€ 808,35', strong: true })
    expect(paper.notes).toContain("Inventario redatto ai sensi dell'art. 2217 del Codice civile.")
    expect(paper.facts.find((fact) => fact.label === 'Inventario al')?.value).toBe('31/12/2026')
    expect(paper.table.rows[2]![8]).toBe('senza costo')
    expect(valuedListPaper(count, list, company, { language: 'en', preview: true, signedOff: null, at: new Date() }).banner).toMatch(/^PREVIEW/)

    const rows = valuedListRows(list, 'en')
    expect(rows[0]![0]).toBe('Item')
    expect(rows[1]![6]).toEqual({ quantity: '105.0000' })
    expect(rows.at(-1)).toEqual(['Inventory total', '', '', '', '', '', null, '', null, '', { minor: 80_835, currency: 'EUR' }])
  })

  it('the count sheets: with the expected quantities, or blind', () => {
    const lines = [{ seq: 10, location: 'BIN-01', itemCode: 'LIN-200', itemName: 'Lining', colour: 'GRY', lot: 'LOT-2', hide: null, expected: '120', uom: 'M' }]
    const withExpected = countSheetPaper(count, lines, company, { language: 'en', withExpected: true, at: new Date() })
    expect(withExpected.table.columns.map((column) => column.label)).toContain('Expected')
    expect(withExpected.table.rows[0]).toEqual(['10', 'BIN-01', 'LIN-200', 'Lining', 'GRY', 'LOT-2', '', '120', '', 'M'])
    const blind = countSheetPaper(count, lines, company, { language: 'it', withExpected: false, at: new Date() })
    expect(blind.table.columns.map((column) => column.label)).not.toContain('Attesa')
    expect(blind.notes[0]).toMatch(/Foglio cieco/)
    expect(blind.table.columns.reduce((sum, column) => sum + column.width, 0)).toBe(1000)
    expect(withExpected.table.columns.reduce((sum, column) => sum + column.width, 0)).toBe(1000)
  })
})
