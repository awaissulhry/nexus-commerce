import { describe, expect, it } from 'vitest'
import { Dec, ZERO } from '../../tax/decimal'
import { acrossLaysWarnings, layMixRefusal, pliesFrom, proposalWords, proposeAllocation, rollCheck, type AllocMarker, type AllocRoll } from './allocation'
import { defaultParts, partsProblems, plyRunRefusal, plyRunZpl, stickerLines, stickersOf, stickersPerPly, type PlyLine } from './plies'
import { cellLeft, garmentsPerPly, markerProblems, perPlyLength, planProblems, planWords, ratioText, releaseRefusal, splitPlies, workOrderRefusal } from './rules'
import { fabricOrderCut, finishRefusal, nextScanOf, scanCodeOf, startRefusal, ticketLines, ticketZpl, type TicketLabel } from './tickets'

/** Cut orders, rolls by shade, width and shrinkage, cut tickets and ply numbering (B-W2b-112): the pure rules. Made-up figures. */

describe('the plan (MES-034)', () => {
  const cell = (id: string, ratio?: number, quantity?: number) => ({ workOrderSizeId: id, ...(ratio === undefined ? {} : { ratio }), ...(quantity === undefined ? {} : { quantity }) })
  it('takes a fabric plan: a marker, plies every line shares, lays that add up', () => {
    expect(planProblems({ kind: 'FABRIC', marker: { name: 'MK-1', length: '2.4', uom: 'M', widthCm: '140' }, plies: 10, lays: [6, 4], lines: [cell('a', 2), cell('b', 3, 30)] })).toEqual([])
    expect(planProblems({ kind: 'FABRIC', plies: 10, lines: [cell('a', 2)] })).toEqual([])
    expect(planProblems({ kind: 'FABRIC', plies: 10, lays: [6, 5], lines: [cell('a', 2)] }).map((issue) => issue.path)).toEqual(['lays'])
    expect(planProblems({ kind: 'FABRIC', plies: 10, lines: [cell('a', 2, 21)] }).map((issue) => issue.message)).toEqual(['Ratio 2 × 10 plies is 20 garments.'])
    expect(planProblems({ kind: 'FABRIC', lines: [cell('a', 2)] }).map((issue) => issue.path)).toEqual(['plies'])
    expect(planProblems({ kind: 'FABRIC', plies: 2, lines: [cell('a'), cell('a', 1)] }).map((issue) => issue.path)).toEqual(['lines/1/workOrderSizeId', 'lines/0/ratio'])
  })
  it('takes a leather plan: garments per cell, no marker, plies or lays', () => {
    expect(planProblems({ kind: 'LEATHER', lines: [cell('a', undefined, 5)] })).toEqual([])
    expect(planProblems({ kind: 'LEATHER', marker: { name: 'M', length: '1', uom: 'M' }, plies: 2, lays: [2], lines: [cell('a', 1)] }).map((issue) => issue.path)).toEqual(['marker', 'plies', 'lays', 'lines/0/quantity', 'lines/0/ratio'])
  })
  it('checks the marker', () => {
    expect(markerProblems({ name: ' ', length: '0', uom: 'M', widthCm: '-1' }).map((issue) => issue.path)).toEqual(['marker/name', 'marker/length', 'marker/widthCm'])
    expect(markerProblems({ name: 'Long', length: '5001', uom: 'CM' }).map((issue) => issue.message)).toEqual(['A marker is at most 50 m long.'])
    expect(markerProblems({ name: 'Ok', length: '240', uom: 'CM', widthCm: '150.5' })).toEqual([])
  })
  it('splits plies into lays, says the ratio, the garments per ply and what a cell has left', () => {
    expect(splitPlies(61, 2)).toEqual([31, 30])
    expect(splitPlies(10, 3)).toEqual([4, 3, 3])
    expect(() => splitPlies(2, 3)).toThrow(RangeError)
    expect(ratioText([{ size: '50', ratio: 2 }, { size: '52', ratio: 3 }, { size: '52', ratio: 1 }, { size: '54', ratio: null }])).toBe('50:2 · 52:4')
    expect(garmentsPerPly([{ ratio: 2 }, { ratio: 3 }, { ratio: null }])).toBe(5)
    expect(cellLeft(20, 15)).toBe(5)
    expect(cellLeft(20, 25)).toBe(0)
    expect(perPlyLength({ length: '2.4', uom: 'M' }, 'CM', 2).toString()).toBe('242')
    expect(planWords({ kind: 'FABRIC', lays: 1, plies: 1, garments: 1 }, 'it')).toBe('1 materasso · 1 strato · 1 capo')
    expect(planWords({ kind: 'LEATHER', lays: 0, plies: null, garments: 1200 }, 'en')).toBe('1,200 garments')
  })
  it('refuses a release without lines, marker or matching lays, and work orders not open', () => {
    const order = { number: 'CO-1', kind: 'FABRIC' as const, status: 'PLANNED' as const, lines: 2, marker: true, plies: 10, layPlies: [6, 4] }
    expect(releaseRefusal(order)).toBeNull()
    expect(releaseRefusal({ ...order, status: 'RELEASED' })?.code).toBe('NOT_PLANNED')
    expect(releaseRefusal({ ...order, lines: 0 })?.code).toBe('NO_LINE')
    expect(releaseRefusal({ ...order, marker: false })?.code).toBe('NO_MARKER')
    expect(releaseRefusal({ ...order, layPlies: [6] })?.message).toBe('Cut order CO-1: its lays plan 6 plies, its marker takes 10. Plan the lays again.')
    expect(releaseRefusal({ ...order, kind: 'LEATHER', marker: false, plies: null, layPlies: [] })).toBeNull()
    expect(workOrderRefusal({ number: 'WO-1', status: 'ON_HOLD', holdReason: 'Shade check' })).toEqual({ code: 'WORK_ORDER_ON_HOLD', message: 'Work order WO-1 is on hold (Shade check): nothing is cut for it.' })
    expect(workOrderRefusal({ number: 'WO-1', status: 'DRAFT', holdReason: null })?.code).toBe('WORK_ORDER_NOT_OPEN')
    expect(workOrderRefusal({ number: 'WO-1', status: 'IN_PROGRESS', holdReason: null })).toBeNull()
  })
})

describe('rolls by shade, width and shrinkage (MES-037)', () => {
  const marker: AllocMarker = { length: '2', uom: 'M', widthCm: new Dec('140') }
  const roll = (code: string, over: Partial<AllocRoll> = {}): AllocRoll => ({
    id: code,
    code,
    state: 'FULL',
    uom: 'M',
    lengthLeft: new Dec('60'),
    widthCm: new Dec('150'),
    shadeGroupId: null,
    shade: 'A',
    shrinkageGroup: 'S1',
    lotCode: 'LOT-1',
    lotQuality: 'RELEASED',
    lotHeld: false,
    rejected: false,
    plannedElsewhere: ZERO,
    ...over,
  })
  it('says what a roll gives and why not', () => {
    expect(pliesFrom(roll('a'), marker)).toBe(30)
    expect(pliesFrom(roll('a', { uom: 'CM', lengthLeft: new Dec('6000'), plannedElsewhere: new Dec('1000') }), marker, 10)).toBe(23)
    expect(rollCheck(roll('a'), marker)).toEqual({ refusal: null, warnings: [] })
    expect(rollCheck(roll('a', { widthCm: new Dec('130') }), marker).refusal?.code).toBe('ROLL_TOO_NARROW')
    expect(rollCheck(roll('a', { state: 'CONSUMED' }), marker).refusal?.code).toBe('ROLL_NOT_IN_STOCK')
    expect(rollCheck(roll('a', { rejected: true }), marker).refusal?.code).toBe('ROLL_REJECTED')
    expect(rollCheck(roll('a', { lotHeld: true }), marker).refusal?.code).toBe('LOT_HELD')
    expect(rollCheck(roll('a', { lotQuality: 'BLOCKED' }), marker).refusal?.code).toBe('LOT_NOT_USABLE')
    expect(rollCheck(roll('a', { lengthLeft: new Dec('1.5') }), marker).refusal?.message).toBe('Roll a has 1.5 m free: not one ply of 2 m.')
    expect(rollCheck(roll('a', { widthCm: null, shrinkageGroup: null, shade: null, lotQuality: 'QUARANTINE' }), marker).warnings.map((warning) => warning.code)).toEqual(['WIDTH_UNKNOWN', 'SHRINKAGE_UNKNOWN', 'SHADE_UNKNOWN', 'LOT_NOT_RELEASED'])
  })
  it('refuses a lay of two shades or two shrinkage groups; across lays it warns', () => {
    expect(layMixRefusal([roll('a'), roll('b')])).toBeNull()
    expect(layMixRefusal([roll('a'), roll('b', { shade: 'B' })])?.code).toBe('MIXED_SHADE')
    expect(layMixRefusal([roll('a'), roll('b', { shadeGroupId: 'g1' })])?.code).toBe('MIXED_SHADE')
    expect(layMixRefusal([roll('a'), roll('b', { shrinkageGroup: null }), roll('c', { shrinkageGroup: 'S2' })])?.code).toBe('MIXED_SHRINKAGE')
    expect(layMixRefusal([roll('a'), roll('b', { shrinkageGroup: null })])).toBeNull()
    expect(acrossLaysWarnings([[roll('a')], [roll('b', { shade: 'B', shrinkageGroup: 'S2' })]]).map((warning) => warning.code)).toEqual(['SHADES_ACROSS_LAYS', 'SHRINKAGE_ACROSS_LAYS'])
  })
  it('proposes each lay from one shade and shrinkage group: the group in use first, ends before full rolls', () => {
    const rolls = [roll('full-a'), roll('end-a', { state: 'END', lengthLeft: new Dec('9') }), roll('full-b', { shade: 'B', lengthLeft: new Dec('200') }), roll('narrow', { widthCm: new Dec('120'), lengthLeft: new Dec('400') })]
    const proposal = proposeAllocation(
      rolls,
      [
        { id: 'l1', seq: 1, plies: 30, rolls: [], proposable: true },
        { id: 'l2', seq: 2, plies: 20, rolls: [], proposable: true },
        { id: 'l3', seq: 3, plies: 5, rolls: [{ rollId: 'x', code: 'X', plies: 5, shadeGroupId: null, shade: 'A', shrinkageGroup: 'S1' }], proposable: false },
      ],
      marker,
    )
    // Lay 1: shade A (in use on lay 3) and B both cover 30 plies: A, its end first. Lay 2: A has 4 plies left, B covers it.
    expect(proposal.map((lay) => [lay.seq, lay.rolls.map((entry) => `${entry.code}:${entry.plies}`), lay.short])).toEqual([
      [1, ['end-a:4', 'full-a:26'], 0],
      [2, ['full-b:20'], 0],
    ])
    // With shade A in use on another lay, a lay takes A first: the end (4 plies), then the full roll.
    const preferA = proposeAllocation(rolls, [{ id: 'l0', seq: 1, plies: 10, rolls: [], proposable: true }, { id: 'l9', seq: 9, plies: 2, rolls: [{ rollId: 'x', code: 'X', plies: 2, shadeGroupId: null, shade: 'A', shrinkageGroup: 'S1' }], proposable: false }], marker)
    expect(preferA[0]!.rolls.map((entry) => `${entry.code}:${entry.plies}`)).toEqual(['end-a:4', 'full-a:6'])
    // A lay with rolls keeps its shade; what nothing covers is short.
    const own = proposeAllocation(rolls, [{ id: 'l1', seq: 1, plies: 50, rolls: [{ rollId: 'full-a', code: 'full-a', plies: 10, shadeGroupId: null, shade: 'A', shrinkageGroup: 'S1' }], proposable: true }], marker)
    expect(own[0]).toMatchObject({ need: 40, short: 36, rolls: [{ code: 'end-a', plies: 4 }] })
    expect(proposalWords(own, 'en')).toBe('Lay 1: end-a 4 plies, 36 plies short')
    expect(proposalWords(own, 'it')).toBe('Materasso 1: end-a 4 strati, mancano 36 strati')
  })
})

describe('cut tickets (MES-041)', () => {
  const ticket = { number: 'CT-1', kind: 'CUT' as const, status: 'OPEN' as const, voidReason: null }
  const order = { number: 'CO-1', status: 'RELEASED' as const }
  it('starts and finishes in order; refuses what is gone, a recut, a cut order not released, a lay not counted', () => {
    expect(scanCodeOf(' cta-2026-00001 ')).toBe('CTA-2026-00001')
    expect(startRefusal(ticket, order)).toBeNull()
    expect(startRefusal({ ...ticket, status: 'STARTED' }, order)?.code).toBe('TICKET_STARTED')
    expect(startRefusal({ ...ticket, status: 'VOID', voidReason: 'Lost' }, order)?.message).toBe('Ticket CT-1 was voided (Lost): take the new ticket from the office.')
    expect(startRefusal({ ...ticket, kind: 'RECUT' }, order)?.code).toBe('TICKET_IS_RECUT')
    expect(startRefusal(ticket, { ...order, status: 'PLANNED' })?.message).toBe('Cut order CO-1 is back in planning: its tickets are not cut now.')
    expect(finishRefusal(ticket, null, null)?.code).toBe('TICKET_NOT_STARTED')
    expect(finishRefusal({ ...ticket, status: 'STARTED' }, 'SPREADING', 2)?.message).toBe('Lay 2 is spreading: count its plies at both ends before the cut is done.')
    expect(finishRefusal({ ...ticket, status: 'STARTED' }, 'CHECKED', 2)).toBeNull()
    expect(finishRefusal({ ...ticket, status: 'STARTED' }, null, null)).toBeNull()
    expect(nextScanOf(ticket, order, 'PLANNED', 1)).toEqual({ next: 'START', refusal: null })
    expect(nextScanOf({ ...ticket, status: 'STARTED' }, order, 'SPREADING', 1)).toMatchObject({ next: 'FINISH', refusal: { code: 'PLIES_NOT_COUNTED' } })
    expect(fabricOrderCut(['CUT', 'CANCELLED'])).toBe(true)
    expect(fabricOrderCut(['CUT', 'CHECKED'])).toBe(false)
    expect(fabricOrderCut(['CANCELLED'])).toBe(false)
  })
  it('lays the ticket out: words in its language, its code as Code 128', () => {
    const label: TicketLabel = { code: 'CTA-2026-00007', language: 'it', maker: 'Pelletteria Esempio', cutOrderNumber: 'CO-2026-0003', kind: 'FABRIC', lay: { seq: 2, of: 3, plies: 30 }, material: 'LIN-200 GRY Fodera', marker: 'MK-1 · 2,4 m', ratio: '46:1 · 48:2', styles: 'JKT-02', workOrders: 'WO-1, WO-2', garments: 90, due: '2026-12-01' }
    expect(ticketLines(label)).toEqual({
      heading: 'Pelletteria Esempio · Buono di taglio',
      title: 'Materasso 2/3 · 30 strati · JKT-02',
      fields: [
        { label: 'Ordine di taglio', value: 'CO-2026-0003' },
        { label: 'Materiale', value: 'LIN-200 GRY Fodera' },
        { label: 'Piazzamento', value: 'MK-1 · 2,4 m' },
        { label: 'Taglie', value: '46:1 · 48:2' },
        { label: 'Ordini di lavoro', value: 'WO-1, WO-2' },
        { label: 'Consegna', value: '2026-12-01' },
      ],
    })
    const zpl = ticketZpl(label, { widthMm: 100, heightMm: 60, dpi: 203 }, 2)
    expect(zpl).toContain('^BCN,')
    expect(zpl).toContain('^FH^FDCTA-2026-00007^FS')
    expect(zpl).toContain('^PQ2')
    expect(() => ticketZpl(label, { widthMm: 40, heightMm: 60, dpi: 203 })).toThrow(RangeError)
    expect(ticketLines({ ...label, language: 'en', kind: 'LEATHER', lay: null, marker: null, ratio: null }).title).toBe('Leather · 90 garments · JKT-02')
  })
})

describe('ply numbering (MES-043)', () => {
  const lines: PlyLine[] = [
    { size: '50', ratio: 2, pieces: [{ name: 'Body lining', quantity: 1 }, { name: 'Sleeve lining', quantity: 2 }] },
    { size: '52', ratio: 1, pieces: [{ name: 'Body lining', quantity: 1 }] },
    { size: '54', ratio: 1, pieces: [] },
  ]
  it('counts the stickers per ply from the ratio and the pattern pieces', () => {
    expect(defaultParts(lines)).toEqual(['Body lining', 'Sleeve lining'])
    // 50: 2 × (1 + 2); 52: 1 × 1 (no sleeve lining there); 54: 1 × 2 (no pattern: each part once).
    expect(stickersPerPly(lines, ['Body lining', 'Sleeve lining'])).toBe(9)
    expect(stickersPerPly(lines, ['Sleeve lining'])).toBe(5)
    expect(partsProblems(['Body', ' body ', ''])).toEqual([
      { path: 'parts/1', message: 'body is named twice.' },
      { path: 'parts/2', message: "A part's name, 1 to 60 characters." },
    ])
  })
  it('numbers only a counted lay, within its count, at most 2000 stickers a run', () => {
    expect(plyRunRefusal({ firstPly: 1, lastPly: 6, perPly: 9 }, { seq: 1, status: 'CHECKED', counted: 6 })).toBeNull()
    expect(plyRunRefusal({ firstPly: 1, lastPly: 6, perPly: 9 }, { seq: 1, status: 'SPREADING', counted: null })?.code).toBe('PLIES_NOT_COUNTED')
    expect(plyRunRefusal({ firstPly: 1, lastPly: 7, perPly: 9 }, { seq: 1, status: 'CUT', counted: 6 })?.code).toBe('PLIES_BEYOND_COUNT')
    expect(plyRunRefusal({ firstPly: 1, lastPly: 6, perPly: 0 }, { seq: 1, status: 'CUT', counted: 6 })?.code).toBe('NO_PARTS')
    expect(plyRunRefusal({ firstPly: 1, lastPly: 300, perPly: 9 }, { seq: 1, status: 'CUT', counted: 300 })?.message).toBe('2700 stickers: a run prints at most 2000. Number 222 plies at a time.')
  })
  it('lists the stickers ply by ply and prints one label each', () => {
    const stickers = stickersOf({ firstPly: 3, lastPly: 4 }, lines, ['Body lining', 'Sleeve lining'])
    expect(stickers).toHaveLength(18)
    expect(stickers.slice(0, 4).map((sticker) => stickerLines(sticker, { cutOrderNumber: 'CO-9', laySeq: 2 }, 'en'))).toEqual([
      ['Ply 3 · 50', 'Body lining', 'CO-9 · Lay 2 · 1/2'],
      ['Ply 3 · 50', 'Sleeve lining 1/2', 'CO-9 · Lay 2 · 1/2'],
      ['Ply 3 · 50', 'Sleeve lining 2/2', 'CO-9 · Lay 2 · 1/2'],
      ['Ply 3 · 50', 'Body lining', 'CO-9 · Lay 2 · 2/2'],
    ])
    expect(stickerLines(stickers.at(-1)!, { cutOrderNumber: 'CO-9', laySeq: 2 }, 'it')).toEqual(['Strato 4 · 54', 'Sleeve lining', 'CO-9 · Mat. 2'])
    const zpl = plyRunZpl(stickers, { cutOrderNumber: 'CO-9', laySeq: 2 }, { widthMm: 80, heightMm: 50, dpi: 300 }, 'it')
    expect(zpl.match(/\^XA/g)).toHaveLength(18)
    expect(() => plyRunZpl([], { cutOrderNumber: 'CO-9', laySeq: 2 }, { widthMm: 80, heightMm: 50, dpi: 300 }, 'it')).toThrow(RangeError)
  })
})
