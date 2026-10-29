import { describe, expect, it } from 'vitest'
import { formatScanId, parseScanId, tenantTag } from '../../numbering/scan-id'
import {
  differenceWords,
  dyeBatchNote,
  expectedBaseOf,
  hideAreaUnit,
  hideCountNote,
  hideLineUnit,
  hideTagPrefix,
  lineDifference,
  lineShapeProblems,
  lotStart,
  lotStateWords,
  nextHideTags,
  orderStatusAfter,
  receivingProblem,
  reversalBlockers,
  reversalRefusal,
  thicknessNote,
  unitCostPerBase,
} from './rules'

/** Goods receipts (B-W1-32), pure. Every figure below is worked out by hand in the comment beside it. */

const TENANT = '0199f0a0-0000-7000-8000-000000000001'

describe('the order a receipt is against', () => {
  it('receives against SENT, CONFIRMED and PARTLY_RECEIVED orders only, and says why not otherwise', () => {
    expect(['SENT', 'CONFIRMED', 'PARTLY_RECEIVED'].map((status) => receivingProblem(status as 'SENT'))).toEqual([null, null, null])
    expect(receivingProblem('DRAFT')).toMatch(/never sent/)
    expect(receivingProblem('RECEIVED')).toMatch(/received in full: record extra goods against a new order/)
    expect(receivingProblem('CANCELLED')).toBe('The order is cancelled: no goods are received against it.')
    expect(receivingProblem('DECLINED')).toMatch(/declined/)
  })

  it('expects the confirmed quantity at the line\'s ratio (rounded down), else the ordered one', () => {
    expect(expectedBaseOf({ quantity: '1000.0000', baseQuantity: '1000.0000', confirmedQuantity: null }).toFixed(4)).toBe('1000.0000')
    // 8 hides confirmed of 10 ordered = 525 ft²: 8 × 525 / 10 = 420.
    expect(expectedBaseOf({ quantity: '10', baseQuantity: '525', confirmedQuantity: '8' }).toFixed(4)).toBe('420.0000')
    // 1 of 3 boxes = 100 pieces: 33.3333… rounded down.
    expect(expectedBaseOf({ quantity: '3', baseQuantity: '100', confirmedQuantity: '1' }).toFixed(4)).toBe('33.3333')
    expect(expectedBaseOf({ quantity: '24', baseQuantity: '24', confirmedQuantity: '0' }).toFixed(4)).toBe('0.0000')
  })

  it('compares what came with what is expected, within the line\'s tolerance either way', () => {
    // 1000 ft² ± 5%: received from 950 to 1050 ft² counts as the whole line.
    const line = (receiving: string, before = '0', tolerancePct: string | null = '5') => lineDifference({ expected: '1000', receivedBefore: before, receiving, tolerancePct })
    expect(line('612.4')).toMatchObject({ kind: 'SHORT', after: '612.4000', open: '387.6000', difference: '-387.6000', complete: false, upTo: '1050.0000' })
    expect(line('949.9999')).toMatchObject({ kind: 'SHORT', complete: false })
    expect(line('337.6', '612.4')).toMatchObject({ kind: 'WITHIN_TOLERANCE', after: '950.0000', open: '0.0000', complete: true })
    expect(line('1000')).toMatchObject({ kind: 'EXACT', difference: '0.0000', complete: true })
    expect(line('1050')).toMatchObject({ kind: 'WITHIN_TOLERANCE', complete: true })
    expect(line('1050.0001')).toMatchObject({ kind: 'OVER', difference: '50.0001', complete: true })
    // No tolerance (not leather): anything above the line is over.
    expect(line('1000.0001', '0', null)).toMatchObject({ kind: 'OVER', tolerancePct: '0', upTo: '1000.0000' })
    expect(line('999.9999', '0', null)).toMatchObject({ kind: 'SHORT', open: '0.0001' })
  })

  it('says each difference in words', () => {
    const short = lineDifference({ expected: '1000', receivedBefore: '0', receiving: '612.4', tolerancePct: '5' })
    expect(differenceWords('Line 10 (SEED-LEA-100 BLK)', short, 'FT2')).toBe('Line 10 (SEED-LEA-100 BLK): 612.4 ft² received of 1000 ft² expected; 387.6 ft² still open (the order waits for it).')
    const over = lineDifference({ expected: '100', receivedBefore: '0', receiving: '110', tolerancePct: null })
    expect(differenceWords('Line 20 (SEED-LIN-200 GRY)', over, 'M')).toBe('Line 20 (SEED-LIN-200 GRY): 110 m received of 100 m expected (no tolerance: at most 100 m); 10 m more than expected.')
  })

  it('moves the order: PARTLY_RECEIVED while a line is open, RECEIVED when none is, back when nothing is received', () => {
    const leather = { expected: '1000', tolerancePct: '5' }
    const lining = { expected: '100', tolerancePct: null }
    expect(orderStatusAfter({ status: 'CONFIRMED', confirmed: true }, [{ ...leather, received: '612.4' }, { ...lining, received: '0' }])).toBe('PARTLY_RECEIVED')
    expect(orderStatusAfter({ status: 'PARTLY_RECEIVED', confirmed: true }, [{ ...leather, received: '960' }, { ...lining, received: '100' }])).toBe('RECEIVED')
    expect(orderStatusAfter({ status: 'PARTLY_RECEIVED', confirmed: true }, [{ ...leather, received: '960' }, { ...lining, received: '99' }])).toBe('PARTLY_RECEIVED')
    expect(orderStatusAfter({ status: 'RECEIVED', confirmed: true }, [{ ...leather, received: '0' }, { ...lining, received: '0' }])).toBe('CONFIRMED')
    expect(orderStatusAfter({ status: 'PARTLY_RECEIVED', confirmed: false }, [{ ...leather, received: '0' }])).toBe('SENT')
    expect(orderStatusAfter({ status: 'CANCELLED', confirmed: false }, [{ ...leather, received: '0' }])).toBe('CANCELLED')
  })

  it('values a base unit at the order line\'s price', () => {
    expect(unitCostPerBase({ unitPrice: '5.000000', quantity: '1000', baseQuantity: '1000' })).toBe('5.000000')
    // 262.50 a hide, 10 hides ≈ 525 ft²: 2625 / 525 = 5 a ft².
    expect(unitCostPerBase({ unitPrice: '262.500000', quantity: '10', baseQuantity: '525' })).toBe('5.000000')
    // 2.00 a m of a fabric counted in m² (1.5 m wide): 100 m = 150 m²; 200 / 150 = 1.333333… a m².
    expect(unitCostPerBase({ unitPrice: '2', quantity: '100', baseQuantity: '150' })).toBe('1.333333')
  })
})

describe('the lot', () => {
  const plain = { itemRequiresCrViTest: false, itemCrViLimitMgKg: null, lineRequiresCrViTest: false, isPpeComponent: false }
  it('starts in quarantine with Cr VI PENDING when its leather needs the test (REACH Annex XVII entry 47)', () => {
    expect(lotStart({ ...plain, itemRequiresCrViTest: true, itemCrViLimitMgKg: '3.000' })).toEqual({ qualityStatus: 'QUARANTINE', requiresCrViTest: true, crViLimitMgKg: '3.000', crViStatus: 'PENDING', holds: ['CR_VI_TEST'] })
    // A brand's lower limit stays the lot's; an order line that asks the test without its item: the legal 3 mg/kg.
    expect(lotStart({ ...plain, itemRequiresCrViTest: true, itemCrViLimitMgKg: '1.5' }).crViLimitMgKg).toBe('1.500')
    expect(lotStart({ ...plain, lineRequiresCrViTest: true })).toMatchObject({ qualityStatus: 'QUARANTINE', crViLimitMgKg: '3.000', crViStatus: 'PENDING' })
  })

  it('holds a certified PPE component and a lot the receiver holds; releases the rest at receipt', () => {
    expect(lotStart({ ...plain, isPpeComponent: true })).toEqual({ qualityStatus: 'QUARANTINE', requiresCrViTest: false, crViLimitMgKg: null, crViStatus: 'NOT_REQUIRED', holds: ['PPE_CERTIFICATE'] })
    expect(lotStart({ ...plain, holdReason: 'Wet cartons' })).toMatchObject({ qualityStatus: 'QUARANTINE', holds: ['QUALITY_HOLD'] })
    expect(lotStart({ ...plain, holdReason: '  ' })).toMatchObject({ qualityStatus: 'RELEASED', holds: [] })
    expect(lotStart(plain)).toEqual({ qualityStatus: 'RELEASED', requiresCrViTest: false, crViLimitMgKg: null, crViStatus: 'NOT_REQUIRED', holds: [] })
  })

  it('says why a lot is held', () => {
    expect(lotStateWords({ qualityStatus: 'QUARANTINE', requiresCrViTest: true, crViStatus: 'PENDING', crViLimitMgKg: '3.000' })).toBe(
      'In quarantine: waits for its chromium VI result (REACH Annex XVII entry 47): released only with a PASS (limit 3.000 mg/kg). Not usable until released.',
    )
    expect(lotStateWords({ qualityStatus: 'QUARANTINE', requiresCrViTest: false, crViStatus: 'NOT_REQUIRED', crViLimitMgKg: null, holdNote: 'Wet cartons' })).toBe('In quarantine: held at receipt: Wet cartons. Not usable until released.')
    expect(lotStateWords({ qualityStatus: 'RELEASED', requiresCrViTest: false, crViStatus: 'NOT_REQUIRED', crViLimitMgKg: null })).toBe('Released: usable stock.')
  })
})

describe('hides', () => {
  it('get the tenant\'s HIDE scan ids, after its highest one', () => {
    const tag = tenantTag(TENANT)
    expect(hideTagPrefix(TENANT)).toBe(`HD-${tag}-`)
    const first = nextHideTags(TENANT, null, 2)
    expect(first.map((code) => parseScanId(code, { types: ['HIDE'], tenantTag: tag }))).toMatchObject([{ ok: true, ref: 1 }, { ok: true, ref: 2 }])
    const next = nextHideTags(TENANT, formatScanId({ type: 'HIDE', tenantTag: tag, ref: 41 }), 2)
    expect(next.map((code) => (parseScanId(code) as { ref: number }).ref)).toEqual([42, 43])
    // Another factory's tag or a code that is no scan id counts as none.
    expect((parseScanId(nextHideTags(TENANT, 'SEED-HIDE-0002', 1)[0]) as { ref: number }).ref).toBe(1)
  })

  it('are measured in the unit given, else the order line\'s area unit, else the base unit; a line is in the unit its hides share', () => {
    expect(hideAreaUnit({ areaUom: 'M2' }, 'FT2', 'FT2')).toBe('M2')
    expect(hideAreaUnit({}, 'FT2', 'M2')).toBe('FT2')
    expect(hideAreaUnit({}, 'HIDE', 'FT2')).toBe('FT2')
    expect(hideLineUnit(['FT2', 'FT2'], 'FT2')).toBe('FT2')
    expect(hideLineUnit(['FT2', 'M2'], 'FT2')).toBe('FT2')
    expect(hideLineUnit(['M2', 'M2'], 'FT2')).toBe('M2')
  })
})

describe('what a receipt line sends', () => {
  it('leather: lots of hides one by one, each with its area; no quantity of its own', () => {
    expect(lineShapeProblems({ lots: [{ hides: [{ area: '52.3' }, { area: '4.8', areaUom: 'M2', thicknessMm: '1.2' }] }] }, 'HIDE', 'LEA')).toEqual([])
    expect(lineShapeProblems({ quantity: '100', lots: [{ hides: [] }] }, 'HIDE', 'LEA').map((issue) => issue.path)).toEqual(['quantity', 'lots/0/hides'])
    expect(lineShapeProblems({ lots: [{ quantity: '3', hides: [{ area: '0' }, { area: '5', areaUom: 'M' }, { area: '5.12345' }] }] }, 'HIDE', 'LEA').map((issue) => issue.path)).toEqual([
      'lots/0/quantity',
      'lots/0/hides/0/area',
      'lots/0/hides/1/areaUom',
      'lots/0/hides/2/area',
    ])
    expect(lineShapeProblems({}, 'HIDE', 'LEA')).toEqual([{ path: 'lots', message: 'LEA is tracked by HIDE: name at least one lot (a dye batch, a roll batch).' }])
    expect(lineShapeProblems({ lots: [{ hides: [{ area: '50', thicknessMm: '120' }, { area: '50', thicknessMm: '1.234' }] }] }, 'HIDE', 'LEA')).toEqual([
      { path: 'lots/0/hides/0/thicknessMm', message: 'At most 99.99 mm.' },
      { path: 'lots/0/hides/1/thicknessMm', message: 'At most 2 decimals.' },
    ])
  })

  it('a lot-tracked material: lots with their quantities; an untracked one: its quantity and no lot', () => {
    expect(lineShapeProblems({ uom: 'ROLL', lots: [{ quantity: '2', baseQuantity: '101.5' }] }, 'LOT', 'LIN')).toEqual([])
    expect(lineShapeProblems({ lots: [{ hides: [{ area: '1' }] }] }, 'LOT', 'LIN').map((issue) => issue.path)).toEqual(['lots/0/hides', 'lots/0/quantity'])
    expect(lineShapeProblems({ quantity: '24' }, 'NONE', 'THR')).toEqual([])
    expect(lineShapeProblems({ lots: [{ quantity: '1' }] }, 'NONE', 'THR').map((issue) => issue.path)).toEqual(['lots', 'quantity'])
  })
})

describe('notes on a receipt', () => {
  it('compare the hides with the estimate, the dye batches with "one dye batch", the thickness with the range', () => {
    expect(hideCountNote('Line 10', 12, 14)).toBe('Line 10: 12 hides came; about 14 were expected.')
    expect(hideCountNote('Line 10', 12, 12)).toBeNull()
    expect(hideCountNote('Line 10', 12, null)).toBeNull()
    expect(dyeBatchNote('Line 10', true, ['DB-1', 'DB-2', 'DB-1', null])).toBe('Line 10: the order asked one dye batch; 2 came (DB-1, DB-2). Keep the shades apart when cutting.')
    expect(dyeBatchNote('Line 10', false, ['DB-1', 'DB-2'])).toBeNull()
    expect(thicknessNote('Line 10', { min: '1.10', max: '1.30' }, [{ code: 'H1', thicknessMm: '1.2' }, { code: 'H2', thicknessMm: '1.35' }, { code: 'H3', thicknessMm: null }])).toBe('Line 10: 1 hide outside the 1.10–1.30 mm asked (H2).')
  })
})

describe('reversing a receipt', () => {
  const names = { location: (id: string) => ({ rcv: 'A1-RCV', store: 'A1-STORE' })[id] ?? id, workOrder: (id: string) => ({ wo1: 'WO-00001', wo2: 'WO-00002' })[id] ?? id }
  const receipt = [
    { key: 'h1', label: 'hide HD-1', toLocationId: 'rcv' },
    { key: 'h2', label: 'hide HD-2', toLocationId: 'rcv' },
  ]
  const move = (key: string, reason: string, from: string | null, to: string | null, quantity: string, workOrderId: string | null = null) => ({ key, reason, fromLocationId: from, toLocationId: to, baseQuantity: quantity, workOrderId })

  it('is free while nothing touched the stock, or what touched it was undone', () => {
    expect(reversalBlockers(receipt, [], names)).toEqual([])
    const undone = [move('h1', 'ISSUE', 'rcv', null, '52.3', 'wo1'), move('h1', 'ISSUE', null, 'rcv', '52.3', 'wo1'), move('h2', 'TRANSFER', 'rcv', 'store', '51'), move('h2', 'TRANSFER', 'store', 'rcv', '51')]
    expect(reversalBlockers(receipt, undone, names)).toEqual([])
  })

  it('names what used it: issued to a work order (net of returns), moved, scrapped, added', () => {
    const touched = [
      move('h1', 'ISSUE', 'rcv', null, '52.3', 'wo1'),
      move('h1', 'RETURN', null, 'rcv', '20.1', 'wo1'),
      move('h2', 'TRANSFER', 'rcv', 'store', '51'),
      move('h2', 'SCRAP', 'store', null, '51'),
    ]
    expect(reversalBlockers(receipt, touched, names)).toEqual([
      // 52.3 issued − 20.1 returned = 32.2 still at the work order.
      { code: 'ISSUED', key: 'h1', label: 'hide HD-1', where: 'WO-00001', quantity: '32.2000' },
      { code: 'LEFT_STOCK', key: 'h2', label: 'hide HD-2', where: 'SCRAP', quantity: '51.0000' },
    ])
    expect(reversalBlockers(receipt, [move('h2', 'TRANSFER', 'rcv', 'store', '51')], names)).toEqual([{ code: 'MOVED', key: 'h2', label: 'hide HD-2', where: 'A1-STORE', quantity: '51.0000' }])
    expect(reversalBlockers(receipt, [move('h1', 'ADJUSTMENT', null, 'rcv', '2')], names)).toEqual([{ code: 'ADDED', key: 'h1', label: 'hide HD-1', where: 'ADJUSTMENT', quantity: '2.0000' }])
  })

  it('says what to do first, grouped by work order and place', () => {
    const blockers = reversalBlockers(receipt, [move('h1', 'ISSUE', 'rcv', null, '52.3', 'wo1'), move('h2', 'ISSUE', 'rcv', null, '51', 'wo1')], names)
    expect(reversalRefusal(blockers, 'A1-RCV')).toEqual({
      message: 'The receipt\'s stock was used since it was posted. 2 of its lots and hides (hide HD-1, hide HD-2) are issued to work order WO-00001: return them to A1-RCV or reverse the issue first, then reverse the receipt.',
      issues: [{ path: 'blockers/ISSUED', message: '2 of its lots and hides (hide HD-1, hide HD-2) are issued to work order WO-00001: return them to A1-RCV or reverse the issue first, then reverse the receipt.' }],
    })
    const two = reversalRefusal(reversalBlockers(receipt, [move('h1', 'ISSUE', 'rcv', null, '52.3', 'wo1'), move('h2', 'TRANSFER', 'rcv', 'store', '51')], names), 'A1-RCV')
    expect(two.message).toBe('The receipt\'s stock was used since it was posted in 2 ways; see each.')
    expect(two.issues.map((issue) => issue.path)).toEqual(['blockers/ISSUED', 'blockers/MOVED'])
    expect(two.issues[1]!.message).toBe('hide HD-2 lies at A1-STORE: move it back to A1-RCV first, then reverse the receipt.')
  })
})
