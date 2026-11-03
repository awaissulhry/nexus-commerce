import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import { pickList, type PickInput } from '../issue/pick-list'
import { PICKED_REASONS, REFUSALS, returnReasonOf, reversalRefusal } from '../issue/rules'
import { againstNeedWords, areaNumber, findHides, type FindHide } from '../reservations/find'
import { DEFAULT_SHADE_RULE, shadeLotKey, shadeLotWords, shadeReasonProblem, shadeRefusal, type ShadeFacts } from '../reservations/shade'
import { backfillRefusal, goneOnRefusal, mayMoveRemnant, MINIMUM_REMNANT, minimumRemnantIn, minimumWords, remnantSizeRefusal, revivedOnReopen, REMNANT_STATES } from './rules'

/**
 * B-W2b-100 (SCM-254 remnant stock, SCM-257 find hides for a job, SCM-206 one shade lot per order, SCM-214 choose hides at the
 * pick): the pure rules. Made-up lots, hides and tags.
 */

const shade = (hideId: string, lotId: string, label: string | null, extra: Partial<ShadeFacts> = {}): ShadeFacts => ({
  hideId,
  hideCode: `HD-${hideId}`,
  lotId,
  lotCode: `LOT-${lotId}`,
  shadeGroupId: label ? `g-${lotId}-${label}` : null,
  shadeLabel: label,
  outOfShade: false,
  ...extra,
})

describe('remnant stock (SCM-254)', () => {
  it('moves a remnant only as the database does', () => {
    expect(REMNANT_STATES).toEqual(['IN_STOCK', 'ISSUED', 'USED', 'SCRAPPED', 'VOID'])
    expect(mayMoveRemnant('IN_STOCK', 'ISSUED')).toBe(true)
    expect(mayMoveRemnant('ISSUED', 'USED')).toBe(true)
    expect(mayMoveRemnant('USED', 'ISSUED')).toBe(true)
    expect(mayMoveRemnant('SCRAPPED', 'IN_STOCK')).toBe(true)
    expect(mayMoveRemnant('IN_STOCK', 'VOID')).toBe(true)
    expect(mayMoveRemnant('USED', 'IN_STOCK')).toBe(false)
    expect(mayMoveRemnant('VOID', 'IN_STOCK')).toBe(false)
    expect(mayMoveRemnant('ISSUED', 'VOID')).toBe(false)
  })

  it('keeps a piece of at least the minimum (10 dm² by default, no setting yet) in any area unit; refuses a smaller one in words', () => {
    expect(MINIMUM_REMNANT).toEqual({ area: '10', uom: 'DM2' })
    expect(minimumRemnantIn('M2')!.toFixed(4)).toBe('0.1000')
    expect(minimumRemnantIn('FT2')!.toFixed(4)).toBe('1.0764')
    expect(minimumRemnantIn('PCS')).toBeNull()
    expect(minimumWords('FT2')).toBe('1.08 ft² (0.10 m²)')
    expect(remnantSizeRefusal({ hideCode: 'HD-1', baseArea: '1.0764', baseUom: 'FT2' })).toBeNull()
    const small = remnantSizeRefusal({ hideCode: 'HD-1', baseArea: '0.8', baseUom: 'FT2' })
    expect(small).toMatchObject({ code: 'REMNANT_TOO_SMALL' })
    expect(small!.message).toContain('0.80 ft² of hide HD-1 is smaller than the smallest remnant kept, 1.08 ft² (0.10 m²): it is waste.')
    expect(remnantSizeRefusal({ hideCode: 'HD-1', baseArea: '0.01', baseUom: 'PCS' })).toBeNull()
    expect(remnantSizeRefusal({ hideCode: 'HD-1', baseArea: '0.5', baseUom: 'FT2' }, { area: '0.4', uom: 'FT2' })).toBeNull()
  })

  it('posts a part of a hide as a REMNANT and a hide back whole as a RETURN; both are picked moves the office reverses', () => {
    expect(returnReasonOf(true, false)).toBe('REMNANT')
    expect(returnReasonOf(true, true)).toBe('RETURN')
    expect(returnReasonOf(false, false)).toBe('RETURN')
    expect(PICKED_REASONS).toEqual(['ISSUE', 'RETURN', 'REMNANT'])
    const move = { id: 'm', reason: 'REMNANT', workOrderId: 'wo', reversalOfId: null, hideId: 'h', baseQuantity: '5', fromLocationId: null, toLocationId: 'loc' }
    expect(reversalRefusal([move], { reversed: false, workOrderNumber: 'WO-1' })).toBeNull()
    expect(reversalRefusal([{ ...move, reason: 'ADJUSTMENT' }], { reversed: false, workOrderNumber: 'WO-1' })).toMatchObject({ code: 'NOT_IN_WORK_ORDER' })
    for (const code of ['SHADE_LOT', 'OUT_OF_SHADE', 'REMNANT_TOO_SMALL', 'REMNANT_GONE_ON'] as const) expect(REFUSALS).toContain(code)
  })

  it('refuses to reverse a REMNANT move while one of its pieces went on', () => {
    expect(goneOnRefusal([{ code: 'RM-1', state: 'IN_STOCK' }, { code: 'RM-2', state: 'VOID' }])).toBeNull()
    expect(goneOnRefusal([{ code: 'RM-1', state: 'ISSUED' }])).toMatchObject({ code: 'REMNANT_GONE_ON', message: expect.stringContaining('Remnant RM-1 is issued to a work order') })
    expect(goneOnRefusal([{ code: 'RM-1', state: 'USED' }])!.message).toContain('cut already')
  })

  it('brings back, when a close is undone, only the pieces that close used (no later live piece of another move)', () => {
    // A cut in WO-1 left B (move m1); B was issued to WO-2 and cut, leaving C (move m2), now reversed: C VOID, B back; A stays used.
    const pieces = [
      { id: '01-a', moveId: 'm0', state: 'USED' as const },
      { id: '02-b', moveId: 'm1', state: 'USED' as const },
      { id: '03-c', moveId: 'm2', state: 'VOID' as const },
    ]
    expect(revivedOnReopen(pieces).map((piece) => piece.id)).toEqual(['02-b'])
    // Two pieces of one move travel together.
    expect(revivedOnReopen([{ id: '01-a', moveId: 'm1', state: 'USED' as const }, { id: '02-b', moveId: 'm1', state: 'USED' as const }]).map((piece) => piece.id)).toEqual(['01-a', '02-b'])
    expect(revivedOnReopen([{ id: '01-a', moveId: 'm1', state: 'USED' as const }, { id: '02-b', moveId: 'm2', state: 'IN_STOCK' as const }])).toEqual([])
  })

  it('tags a W1 remnant only once, and only one in stock that came back from a work order', () => {
    const base = { hideCode: 'HD-9', hideState: 'REMNANT', onHand: '3', lastReturn: { reversed: false }, liveTags: 0 }
    expect(backfillRefusal(base)).toBeNull()
    expect(backfillRefusal({ ...base, hideState: 'FULL' })).toMatchObject({ code: 'NOT_A_REMNANT' })
    expect(backfillRefusal({ ...base, onHand: '0' })).toMatchObject({ code: 'NOT_A_REMNANT' })
    expect(backfillRefusal({ ...base, lastReturn: null })).toMatchObject({ code: 'NOT_A_REMNANT' })
    expect(backfillRefusal({ ...base, lastReturn: { reversed: true } })).toMatchObject({ code: 'NOT_A_REMNANT' })
    expect(backfillRefusal({ ...base, liveTags: 1 })).toMatchObject({ code: 'TAGGED_ALREADY' })
  })

  it('declares its events (live to the office stock view, and to the floor that issues)', () => {
    const tagged = EVENT_DEFINITIONS.find((event) => event.type === 'inventory.remnant_tagged')
    const changed = EVENT_DEFINITIONS.find((event) => event.type === 'inventory.remnant_changed')
    expect(tagged?.live).toMatchObject({ permission: 'inventory.stock.view', floor: 'inventory.issue' })
    expect(changed?.live).toMatchObject({ permission: 'inventory.stock.view', floor: 'inventory.issue' })
  })
})

describe('one shade lot per order (SCM-206)', () => {
  it('defaults to one batch per order (Q18), a lot and its shade group (or W1 text) being one shade lot', () => {
    expect(DEFAULT_SHADE_RULE).toBe('ORDER')
    expect(shadeLotKey(shade('1', 'L1', '2'))).toBe('L1|g:g-L1-2')
    expect(shadeLotKey({ lotId: 'L1', shadeGroupId: null, shadeLabel: ' dark ' })).toBe('L1|t:DARK')
    expect(shadeLotKey({ lotId: 'L1', shadeGroupId: null, shadeLabel: null })).toBe('L1|-')
    expect(shadeLotWords(shade('1', 'L1', '2'))).toBe('lot LOT-L1, shade 2')
    expect(shadeLotWords(shade('1', 'L1', null), 'it')).toBe('lotto LOT-L1 (non diviso per tonalità)')
  })

  it('lets the first hide set the shade lot and refuses another lot or group in words; GARMENT and OFF never refuse here', () => {
    const held = [shade('1', 'L1', '2'), shade('2', 'L1', '2')]
    expect(shadeRefusal('ORDER', 'work order WO-1', [], shade('9', 'L2', '1'))).toBeNull()
    expect(shadeRefusal('ORDER', 'work order WO-1', held, shade('3', 'L1', '2'))).toBeNull()
    const other = shadeRefusal('ORDER', 'work order WO-1', held, shade('4', 'L2', '2'))
    expect(other).toMatchObject({ code: 'SHADE_LOT' })
    expect(other!.message).toBe(
      'Work order WO-1 is cut from lot LOT-L1, shade 2; hide HD-4 is lot LOT-L2, shade 2. One shade lot per order: take a hide of the same shade lot, or a person allowed to override the shade rule lets it through with the reason.',
    )
    expect(shadeRefusal('ORDER', 'work order WO-1', held, shade('5', 'L1', '3'))).toMatchObject({ code: 'SHADE_LOT' })
    expect(shadeRefusal('ORDER', 'work order WO-1', [], shade('6', 'L1', 'X', { outOfShade: true }))).toMatchObject({ code: 'OUT_OF_SHADE' })
    expect(shadeRefusal('GARMENT', 'work order WO-1', held, shade('4', 'L2', '2'))).toBeNull()
    expect(shadeRefusal('OFF', 'work order WO-1', held, shade('6', 'L1', 'X', { outOfShade: true }))).toBeNull()
    // The hide itself among what is held (reserved for the order) never refuses itself.
    expect(shadeRefusal('ORDER', 'work order WO-1', [shade('4', 'L2', '2')], shade('4', 'L2', '2'))).toBeNull()
  })

  it('takes an override only with a reason of 3 to 500 characters, held by the production manager and the quality inspector', () => {
    expect(shadeReasonProblem(undefined)).toBeNull()
    expect(shadeReasonProblem(' ok ')).toMatch(/3 to 500/)
    expect(shadeReasonProblem('Customer accepts two shades')).toBeNull()
    expect(FACTORY_PERMISSIONS.get('inventory.shade.override')).toMatchObject({ area: 'inventory', risk: 'write' })
    expect(templateOf('production_manager')!.permissions).toContain('inventory.shade.override')
    expect(templateOf('quality_inspector')!.permissions).toContain('inventory.shade.override')
    expect(templateOf('warehouse')!.permissions).not.toContain('inventory.shade.override')
    expect(templateOf('owner')!.permissions).toContain('inventory.shade.override')
  })
})

describe('find hides for a job (SCM-257)', () => {
  const hide = (hideId: string, lotId: string, label: string | null, left: string, extra: Partial<FindHide> = {}): FindHide => ({
    ...shade(hideId, lotId, label),
    receivedAt: lotId === 'L1' ? '2026-09-01T08:00:00.000Z' : '2026-10-01T08:00:00.000Z',
    gradeId: null,
    gradeCode: 'A',
    state: 'FULL',
    left,
    locationCodes: ['A1'],
    remnant: null,
    ...extra,
  })
  const hides = [hide('a', 'L1', '1', '20'), hide('b', 'L1', '1', '15'), hide('c', 'L2', '1', '30'), hide('d', 'L2', '1', '25'), hide('e', 'L1', '2', '50'), hide('r', 'L2', '1', '4', { state: 'REMNANT', remnant: { id: 'rm', code: 'RM-1' } })]

  it('proposes ONE shade lot first: the one that covers the need with the least to spare, the area running against the need', () => {
    const result = findHides({ need: '44', baseUom: 'M2', rule: 'ORDER', held: [], hides })
    expect(result.lots.map((lot) => lot.key)).toEqual(['L1|g:g-L1-2', 'L2|g:g-L2-1', 'L1|g:g-L1-1'])
    // L1 shade 2: one hide of 50 (6 spare); L2 shade 1: 30 + 25 = 55 (11 spare); L1 shade 1: 35, short.
    expect(result.proposal).toMatchObject({ lotKey: 'L1|g:g-L1-2', hideIds: ['e'], count: 1, area: '50.0000', covers: true })
    expect(result.proposal!.words.en).toBe('1 hide · 50.00 of 44.00 m² ✓')
    expect(result.proposal!.words.it).toBe('1 pelle · 50,00 di 44,00 m² ✓')
    expect(result.lots[1]).toMatchObject({ covers: true, shadeWarning: true, total: '59.0000' })
    expect(result.lots[1]!.hides.map((row) => [row.hideId, row.running, row.proposed])).toEqual([
      ['c', '30.0000', false],
      ['d', '55.0000', false],
      ['r', '59.0000', false],
    ])
    expect(result.lots[2]).toMatchObject({ covers: false, shadeWarning: true })
  })

  it("puts the order's own shade lot first when it holds one, and lists out-of-shade hides apart", () => {
    const own = findHides({ need: '44', baseUom: 'M2', rule: 'ORDER', held: [shade('z', 'L2', '1')], hides: [...hides, hide('o', 'L1', 'X', '60', { outOfShade: true })] })
    expect(own.lots[0]).toMatchObject({ key: 'L2|g:g-L2-1', ordersOwn: true, shadeWarning: false })
    expect(own.proposal).toMatchObject({ hideIds: ['c', 'd'], count: 2, area: '55.0000', covers: true })
    expect(own.outOfShade.map((row) => row.hideId)).toEqual(['o'])
    expect(own.lots.every((lot) => lot.key !== 'L1|g:g-L1-X')).toBe(true)
  })

  it('says what is short when no lot covers, and lists by area without a need', () => {
    const short = findHides({ need: '100', baseUom: 'FT2', rule: 'ORDER', held: [], hides })
    expect(short.proposal).toMatchObject({ covers: false, count: 3, area: '59.0000' })
    expect(short.proposal!.words.en).toBe('3 hides · 59.00 of 100.00 ft²: 41.00 ft² short')
    expect(short.proposal!.words.it).toBe('3 pelli · 59,00 di 100,00 ft²: mancano 41,00 ft²')
    const none = findHides({ need: null, baseUom: 'M2', rule: 'OFF', held: [], hides })
    expect(none.proposal).toBeNull()
    expect(none.lots[0]!.key).toBe('L2|g:g-L2-1')
    expect(findHides({ need: '10', baseUom: 'M2', rule: 'ORDER', held: [], hides: [] })).toMatchObject({ lots: [], proposal: null })
  })

  it('writes areas for people, exactly', () => {
    expect(areaNumber('1234.5', 'en')).toBe('1,234.50')
    expect(areaNumber('1234.5', 'it')).toBe('1.234,50')
    expect(againstNeedWords({ count: 4, area: '96.2', need: '110', uom: 'FT2' }, 'en')).toBe('4 hides · 96.20 of 110.00 ft²: 13.80 ft² short')
    expect(againstNeedWords({ count: 4, area: '96.2', need: null, uom: 'FT2' }, 'en')).toBe('4 hides · 96.20 ft²')
  })
})

describe('choose hides at the pick (SCM-214)', () => {
  const input = (extra: Partial<PickInput> = {}): PickInput => ({
    materials: [{ id: 'm1', bomLineId: 'b1', bomSeq: 1, placement: null, itemId: 'leather', itemColourId: 'blk', workOrderSizeId: 'c1', cellOrder: 0, colourwayCode: 'BLK', size: '50', baseQuantity: '110' }],
    items: new Map([['leather', { id: 'leather', code: 'LEA', name: 'Leather', baseUom: 'FT2', tracking: 'HIDE' as const }]]),
    colours: new Map([['blk', { id: 'blk', code: 'BLK', name: 'Black' }]]),
    stock: [
      { locationId: 'loc', locationCode: 'A1', itemId: 'leather', itemColourId: 'blk', lotId: 'L1', hideId: 'old', onHand: '40' },
      { locationId: 'loc', locationCode: 'A1', itemId: 'leather', itemColourId: 'blk', lotId: 'L2', hideId: 'mine', onHand: '45' },
    ],
    lots: new Map([
      ['L1', { id: 'L1', code: 'LOT-1', qualityStatus: 'RELEASED', requiresCrViTest: false, crViStatus: 'NOT_REQUIRED', receivedAt: '2026-01-01T00:00:00.000Z', dyeBatch: null }],
      ['L2', { id: 'L2', code: 'LOT-2', qualityStatus: 'RELEASED', requiresCrViTest: false, crViStatus: 'NOT_REQUIRED', receivedAt: '2026-06-01T00:00:00.000Z', dyeBatch: null }],
    ]),
    hides: new Map([
      ['old', { id: 'old', code: 'HD-OLD', state: 'FULL' as const, grade: 'A', lotId: 'L1', shadeGroupId: 'g1', shadeLabel: '1', outOfShade: false, remnant: null }],
      ['mine', { id: 'mine', code: 'HD-MINE', state: 'REMNANT' as const, grade: 'A', lotId: 'L2', shadeGroupId: 'g2', shadeLabel: '2', outOfShade: false, remnant: { id: 'rm', code: 'RM-7' } }],
      ['held', { id: 'held', code: 'HD-HELD', state: 'FULL' as const, grade: 'A', lotId: 'L2', shadeGroupId: 'g2', shadeLabel: '2', outOfShade: false, remnant: null }],
    ]),
    atWorkOrder: [{ itemId: 'leather', itemColourId: 'blk', lotId: 'L2', hideId: 'held', quantity: '50' }],
    cuts: new Map(),
    ...extra,
  })

  it("counts a leather line's hides, names its shade lots, and puts the order's own shade lot first", () => {
    const [line] = pickList(input())
    expect(line!.hides).toEqual({ count: 1 })
    expect(line!.shadeLots).toEqual([{ key: 'L2|g:g2', lotCode: 'LOT-2', shadeLabel: '2' }])
    expect(line!.usable.candidates.map((row) => [row.hideCode, row.sameShade, row.remnant?.code ?? null])).toEqual([
      ['HD-MINE', true, 'RM-7'],
      ['HD-OLD', false, null],
    ])
    expect(line!.usable.candidates[0]).toMatchObject({ shadeLabel: '2', shadeLot: 'L2|g:g2', outOfShade: false })
  })

  it('keeps oldest first with nothing held yet (no shade lot), and says nothing of shades for other lines', () => {
    const [line] = pickList(input({ atWorkOrder: [] }))
    expect(line!.hides).toEqual({ count: 0 })
    expect(line!.shadeLots).toEqual([])
    expect(line!.usable.candidates.map((row) => [row.hideCode, row.sameShade])).toEqual([
      ['HD-OLD', null],
      ['HD-MINE', null],
    ])
    const lining = pickList(input({ items: new Map([['leather', { id: 'leather', code: 'LIN', name: 'Lining', baseUom: 'M', tracking: 'LOT' as const }]]), stock: [], atWorkOrder: [] }))
    expect(lining[0]!.hides).toBeNull()
  })
})
