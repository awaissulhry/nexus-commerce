import { describe, expect, it } from 'vitest'
import { amendmentDiff, amendmentProblems, amendStateProblem, amountMoves, customerAsked, leftOutOf, nextRevision, snapshotOf, totalGoesUp, type AmendableLine, type SnapshotHeader, type SnapshotLine } from './amendments' // B-OL-005: + amountMoves, customerAsked, totalGoesUp
import { AUTOMATIC_REASONS, isAutomaticReason, reasonOr } from './reasons' // B-OL-004
import { putBackReasonWords, requestReasonWords, serverReasonOf, SERVER_REASON_CODES } from './reasons' // B-OC-012

const header: SnapshotHeader = { customerRef: 'PO-1', requestedDate: null, promiseDate: '2026-12-20', paymentTerms: 'Bonifico', currency: 'EUR', taxMode: 'IT_B2B', netAmount: 624_000, vatAmount: 137_280, grossAmount: 761_280 }
const blk: SnapshotLine = {
  id: 'L1',
  seq: 10,
  kind: 'SIZE_GRID',
  styleId: 'S',
  colourwayId: 'BLK',
  description: 'Jacket BLK',
  note: null,
  quantity: 8,
  unitPrice: '450',
  netAmount: 360_000,
  vatRatePct: '22.00',
  vatAmount: 79_200,
  closedShortQuantity: null,
  sizes: [
    { size: '50', quantity: 2, unitPrice: null },
    { size: '52', quantity: 4, unitPrice: null },
    { size: '54', quantity: 2, unitPrice: null },
  ],
}
const red: SnapshotLine = { ...blk, id: 'L2', seq: 20, colourwayId: 'RED', description: 'Jacket RED', quantity: 6, unitPrice: '440', netAmount: 264_000, vatAmount: 58_080, sizes: [{ size: '52', quantity: 6, unitPrice: null }] }

describe('the snapshot and the difference (SAL-217)', () => {
  it('lists lines added, removed and changed, sizes old → new and the money change', () => {
    const before = snapshotOf(header, [red, blk])
    expect(before.lines.map((line) => line.id)).toEqual(['L1', 'L2'])
    const changed: SnapshotLine = { ...blk, quantity: 10, netAmount: 450_000, sizes: [{ size: '50', quantity: 2, unitPrice: null }, { size: '52', quantity: 6, unitPrice: null }, { size: '54', quantity: 2, unitPrice: null }] }
    const added: SnapshotLine = { ...blk, id: 'N1', seq: 30, colourwayId: 'TAN', quantity: 2, netAmount: 90_000, sizes: [{ size: '48', quantity: 2, unitPrice: null }] }
    const after = snapshotOf({ ...header, netAmount: 540_000, grossAmount: 658_800, requestedDate: '2026-12-01' }, [changed, added])
    const diff = amendmentDiff(before, after)
    expect(diff.lines.map((line) => [line.change, line.lineId, line.piecesBefore, line.piecesAfter])).toEqual([
      ['CHANGED', 'L1', 8, 10],
      ['REMOVED', 'L2', 6, 0],
      ['ADDED', 'N1', 0, 2],
    ])
    expect(diff.lines[0]!.sizes).toEqual([{ size: '52', before: 4, after: 6 }])
    expect(diff.header).toEqual([{ field: 'requestedDate', before: null, after: '2026-12-01' }])
    expect([diff.netBefore, diff.netAfter, diff.reacceptanceNeeded, diff.empty]).toEqual([624_000, 540_000, true, false])
  })

  it('a price change alone is a change; the same order is no change and needs no new acceptance', () => {
    const before = snapshotOf(header, [blk])
    const priced = amendmentDiff(before, snapshotOf(header, [{ ...blk, unitPrice: '455' }]))
    expect(priced.lines[0]).toMatchObject({ change: 'CHANGED', unitPrice: { before: '450', after: '455' }, sizes: [] })
    expect(priced.reacceptanceNeeded).toBe(false)
    expect(amendmentDiff(before, snapshotOf(header, [blk])).empty).toBe(true)
  })
})

describe('what an amendment may do (SAL-209)', () => {
  const current: AmendableLine[] = [
    { id: 'L1', seq: 10, kind: 'SIZE_GRID', closedShort: false, sizes: blk.sizes, inWorkOrders: new Map([['52', 4]]) },
    { id: 'L2', seq: 20, kind: 'SIZE_GRID', closedShort: false, sizes: red.sizes, inWorkOrders: new Map() },
    { id: 'L3', seq: 30, kind: 'SIZE_GRID', closedShort: true, sizes: red.sizes, inWorkOrders: new Map() },
  ]

  it('only while nothing shipped', () => {
    expect(amendStateProblem('IN_PRODUCTION')).toBeNull()
    expect(amendStateProblem('PARTLY_SHIPPED')).toMatch(/its lines no longer change/)
  })

  it('no reason needed (B-OL-004); under what work orders make is allowed (B-SA-042); a line closed short is never left out (B-OP-014: one in work orders is)', () => {
    const problems = amendmentProblems({
      status: 'CONFIRMED',
      reason: ' ',
      current,
      lines: [
        { id: 'L1', sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 3 }] },
        { id: 'L3', sizes: [{ size: '52', quantity: 2 }] },
        { styleId: 'S', sizes: [{ size: '50', quantity: 1 }] },
        { id: 'L9' },
      ],
    })
    // B-SA-042 (P6', R1): line 0 lowers size 52 under what work orders make (4, 3 asked): allowed now, the gap goes to the work order.
    // B-OL-004 (D2): a blank reason is no problem any more (the server stores the automatic words).
    expect(problems.map((issue) => issue.path)).toEqual(['body/lines/1/sizes', 'body/lines/2/colourwayId', 'body/lines/3/id'])
    expect(problems.some((issue) => issue.message.includes('work orders already make'))).toBe(false)
    const removal = amendmentProblems({ status: 'CONFIRMED', reason: 'Customer asked.', current, lines: [{ id: 'L2' }] })
    // B-OP-014: line 10 (in work orders) left out is closed short, not refused; line 30 (closed short already) still is.
    expect(removal.map((issue) => issue.message)).toEqual(['Line 30 is closed short: reopen it before removing it.'])
    expect(amendmentProblems({ status: 'CONFIRMED', reason: 'Customer asked.', current, lines: [{ id: 'L1' }, { id: 'L2', sizes: [{ size: '52', quantity: 4 }] }, { id: 'L3' }] })).toEqual([])
  })

  // ── B-OL-004 (order lines plan D2; 18 F22) ──
  it('B-OL-004: a reason is optional — none or blank is fine, one too long is refused; the automatic words per act', () => {
    const lines = [{ id: 'L1' }, { id: 'L2' }, { id: 'L3' }]
    expect(amendmentProblems({ status: 'CONFIRMED', reason: undefined, current, lines })).toEqual([])
    expect(amendmentProblems({ status: 'CONFIRMED', reason: '   ', current, lines })).toEqual([])
    expect(amendmentProblems({ status: 'CONFIRMED', reason: 'x'.repeat(1001), current, lines }).map((issue) => issue.path)).toEqual(['body/reason'])
    expect(reasonOr('amend', undefined)).toBe('Changed on the order page.')
    expect(reasonOr('close', '  ')).toBe('Closed on the order page.')
    expect(reasonOr('reopen', null)).toBe('Reopened on the order page.')
    expect(reasonOr('promise', '')).toBe('Date changed on the order page.')
    expect(reasonOr('amend', '  The customer asked by phone. ')).toBe('The customer asked by phone.')
    for (const words of Object.values(AUTOMATIC_REASONS)) expect(isAutomaticReason(words)).toBe(true)
    expect(isAutomaticReason('The customer asked by phone.')).toBe(false)
    expect(isAutomaticReason(null)).toBe(false)
  })
  // ── end B-OL-004 ──

  // ── B-OL-005 (order lines plan D3; 18 F10) ──
  it('B-OL-005: the customer is asked when ticked; not said, only when what it pays goes up (a higher net, or a fee)', () => {
    const up = { netBefore: 100_000, netAfter: 120_000 }
    const down = { netBefore: 120_000, netAfter: 100_000 }
    const same = { netBefore: 100_000, netAfter: 100_000 }
    // The default: up asks, down and same do not (before, every change of the net asked — a lower one too).
    expect([customerAsked(undefined, up), customerAsked(undefined, down), customerAsked(null, same)]).toEqual([true, false, false])
    // A fee (a priced change's, CHARGE's) is what the customer pays too: asked by default, even with a lower net.
    expect(customerAsked(undefined, { ...down, feeAmount: 2_500 })).toBe(true)
    expect(customerAsked(undefined, { ...same, feeAmount: null })).toBe(false)
    // The office's tick decides either way.
    expect([customerAsked(true, same), customerAsked(false, up), customerAsked(true, down)]).toEqual([true, false, true])
    // The preview's flags: the amount moves (every writer) and which way (the price grain only).
    expect([amountMoves(up), amountMoves(down), amountMoves(same), amountMoves({ ...same, feeAmount: 100 })]).toEqual([true, true, false, true])
    expect([totalGoesUp(up), totalGoesUp(down), totalGoesUp(same), totalGoesUp({ ...same, feeAmount: 100 })]).toEqual([true, false, false, true])
  })
  // ── end B-OL-005 ──

  it('numbers amendments one after another', () => {
    expect(nextRevision([])).toBe(1)
    expect(nextRevision([1, 3, 2])).toBe(4)
  })

  it('B-SA-042: a made-to-measure unit is cancel only — an amendment never changes it, under work orders or not', () => {
    const unit: AmendableLine = { id: 'U1', seq: 40, kind: 'MADE_TO_MEASURE', closedShort: false, sizes: [{ size: '52', quantity: 1 }], inWorkOrders: new Map([['', 1]]) }
    const problems = amendmentProblems({ status: 'IN_PRODUCTION', reason: 'Fewer', current: [unit], lines: [{ id: 'U1', sizes: [{ size: '52', quantity: 0 }] }] })
    expect(problems.map((issue) => issue.message)).toEqual(['A made-to-measure unit does not change through an amendment.'])
  })
})

// ── B-OP-014 (order page plan N1): a line work orders make may be left out — closed short in the same command ──
describe('B-OP-014: a line left out of an amendment', () => {
  const current: AmendableLine[] = [
    { id: 'L1', seq: 10, kind: 'SIZE_GRID', closedShort: false, sizes: blk.sizes, inWorkOrders: new Map([['52', 4]]) },
    { id: 'L2', seq: 20, kind: 'SIZE_GRID', closedShort: false, sizes: red.sizes, inWorkOrders: new Map() },
    { id: 'L4', seq: 40, kind: 'SIZE_GRID', closedShort: false, sizes: red.sizes, inWorkOrders: new Map() },
  ]

  it('is closed short when work orders make it (pieces in its cells, or any cell pointing at it), else removed', () => {
    expect(leftOutOf({ current, lines: [{ id: 'L2' }] })).toEqual({ remove: ['L4'], close: ['L1'] })
    // A cancelled work order's cell still points at line 40: closed short too, never deleted.
    expect(leftOutOf({ current, lines: [{ id: 'L2' }] }, new Set(['L4']))).toEqual({ remove: [], close: ['L1', 'L4'] })
    expect(leftOutOf({ current, lines: [{ id: 'L1' }, { id: 'L2' }, { id: 'L4' }] })).toEqual({ remove: [], close: [] })
    // Nothing refuses it any more: the amendment's own checks pass.
    expect(amendmentProblems({ status: 'IN_PRODUCTION', reason: 'The customer drops the black.', current, lines: [{ id: 'L2' }, { id: 'L4' }] })).toEqual([])
  })

  it('a made-to-measure unit is never left out (cancel it instead), in work orders or not', () => {
    const unit: AmendableLine = { id: 'U1', seq: 50, kind: 'MADE_TO_MEASURE', closedShort: false, sizes: [{ size: '52', quantity: 1 }], inWorkOrders: new Map([['', 1]]) }
    expect(amendmentProblems({ status: 'IN_PRODUCTION', reason: 'Fewer', current: [...current, unit], lines: [{ id: 'L1' }, { id: 'L2' }, { id: 'L4' }] }).map((issue) => issue.message)).toEqual([
      'Line 50 is a made-to-measure unit: it does not change through an amendment.',
    ])
  })

  it('the diff names a line closed short by the amendment REMOVED, what is left of it to 0, its money kept on the line', () => {
    const before = snapshotOf(header, [blk, red])
    const after = snapshotOf(header, [{ ...blk, closedShortQuantity: 8 }, red])
    const diff = amendmentDiff(before, after)
    expect(diff.lines).toEqual([
      {
        change: 'REMOVED',
        lineId: 'L1',
        seq: 10,
        styleId: 'S',
        colourwayId: 'BLK',
        piecesBefore: 8,
        piecesAfter: 0,
        sizes: [
          { size: '50', before: 2, after: 0 },
          { size: '52', before: 4, after: 0 },
          { size: '54', before: 2, after: 0 },
        ],
        unitPrice: null,
        netBefore: 360_000,
        netAfter: 360_000,
        textChanged: false,
        closedShort: true,
        reopened: false,
      },
    ])
    // Closing short moves no money (a closed line is not billed): the customer is not asked to accept again; it is a change.
    expect([diff.reacceptanceNeeded, diff.empty]).toEqual([false, false])
    // A line closed short before and after (reopened by nobody) is no change.
    expect(amendmentDiff(after, after).empty).toBe(true)
    // An ordinary removal and change say closedShort false.
    expect(amendmentDiff(before, snapshotOf(header, [red])).lines[0]).toMatchObject({ change: 'REMOVED', closedShort: false, netAfter: 0 })
  })

  it('a put-back reopens it: the diff names it CHANGED and reopened, what was left of it back (0 → its sizes)', () => {
    const closed = snapshotOf(header, [{ ...blk, closedShortQuantity: 8 }, red])
    const diff = amendmentDiff(closed, snapshotOf(header, [blk, red]))
    expect(diff.lines).toEqual([
      expect.objectContaining({ change: 'CHANGED', lineId: 'L1', piecesBefore: 0, piecesAfter: 8, closedShort: false, reopened: true, sizes: [{ size: '50', before: 0, after: 2 }, { size: '52', before: 0, after: 4 }, { size: '54', before: 0, after: 2 }], unitPrice: null, netBefore: 360_000, netAfter: 360_000 }),
    ])
    expect(diff.empty).toBe(false)
  })
})
// ── end B-OP-014 ──

// ── B-OC-012 (order changes tab R8): the server's own reason words, read back by one recognizer (no column) ──
describe('B-OC-012: serverReasonOf — the automatic words, an accepted request, a put-back; anything typed is null', () => {
  it('reads the writers’ own templates back', () => {
    const table: readonly (readonly [string | null | undefined, string | null])[] = [
      [AUTOMATIC_REASONS.amend, 'AUTOMATIC'],
      [`  ${AUTOMATIC_REASONS.promise}  `, 'AUTOMATIC'],
      [requestReasonWords({ kind: 'CHANGE', reasonCode: null, askedOn: '2026-11-19', reason: null }), 'REQUEST'],
      [requestReasonWords({ kind: 'CHANGE', reasonCode: null, askedOn: '2026-11-19', reason: 'Made-up: two fewer in 52.' }), 'REQUEST'],
      [requestReasonWords({ kind: 'CANCEL', reasonCode: 'NO_LONGER_NEEDED', askedOn: '2026-11-19', reason: null }), 'REQUEST'],
      [putBackReasonWords(2, 'CUSTOMER_REFUSED'), 'PUT_BACK'],
      [putBackReasonWords(12, 'YES_REFUSED'), 'PUT_BACK'],
      ['Made-up: the customer phoned, one more jacket.', null],
      ["The customer's change request came by phone", null],
      ['', null],
      [null, null],
      [undefined, null],
    ]
    for (const [reason, code] of table) expect(serverReasonOf(reason), String(reason)).toBe(code)
    expect(SERVER_REASON_CODES).toEqual(['AUTOMATIC', 'REQUEST', 'PUT_BACK'])
  })

  it('the templates say what the writers wrote before (one source, the words unchanged)', () => {
    expect(requestReasonWords({ kind: 'CHANGE', reasonCode: null, askedOn: '2026-11-19', reason: 'Made-up: two fewer.' })).toBe("The customer's change request of 2026-11-19 from the portal: Made-up: two fewer.")
    expect(requestReasonWords({ kind: 'CANCEL', reasonCode: 'NO_LONGER_NEEDED', askedOn: '2026-11-19', reason: null })).toBe("The customer's cancel request (NO_LONGER_NEEDED) of 2026-11-19 from the portal")
    expect(putBackReasonWords(2, 'YES_REFUSED')).toBe('Put back as before revision 2: its yes was refused.')
    expect(putBackReasonWords(2, 'CUSTOMER_REFUSED')).toBe('Put back as before revision 2: the customer refused it.')
  })
})
// ── end B-OC-012 ──
