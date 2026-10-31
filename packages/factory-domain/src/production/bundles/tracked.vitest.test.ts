import { describe, expect, it } from 'vitest'
import { composeLabel } from '../../labels/model'
import { formatScanId, tenantTag } from '../../numbering/scan-id'
import { couponChangeRefusal, couponLabel, couponScan, couponsRefusal, couponsToIssue, type CouponOperation } from './coupons'
import { bunchedAtShiftEnd, findingKey, gapBelowStandard, movedNotScanned, newFindings, PATTERN_RULES, reviewProblems, summarise, whoRefusal, type PatternScan } from './patterns'
import { cellSets, pairRefusal, shadeOf, type SetBundle } from './sets'
import { placeOf, stuckEpisodeKey, stuckLimitOf, stuckLimitProblems, stuckOf, type PlaceOperation } from './where'

/**
 * Bundles tracked (B-W2b-41; MES-067, MES-074, MES-075, MES-078, MES-168): coupons per operation, where a bundle is and
 * when it is stuck, the scan-pattern checks (about bundles, never people) and pair and set matching by shade. Figures
 * worked by hand; every id, code and name is made up.
 */

const op = (id: string, seq: number, scanRequired = true): CouponOperation & PlaceOperation => ({ id, seq, code: `OP${seq}`, name: `Op ${seq}`, scanRequired })
const OPS = [op('o10', 10), op('o20', 20), op('o25', 25, false), op('o30', 30)]
const at = (hhmm: string, day = '2026-11-16') => new Date(`${day}T${hhmm}:00.000Z`)

describe('coupons per operation (MES-067)', () => {
  const workOrder = { number: 'WO-T-1', status: 'RELEASED' as const }

  it('prints no coupons while the site scans one code, nor for a closed work order', () => {
    expect(couponsRefusal({ mode: 'ONE_CODE', workOrder })?.code).toBe('COUPONS_OFF')
    expect(couponsRefusal({ mode: 'COUPON_PER_OPERATION', workOrder: { ...workOrder, status: 'CLOSED' } })?.code).toBe('WORK_ORDER_NOT_OPEN')
    expect(couponsRefusal({ mode: 'COUPON_PER_OPERATION', workOrder })).toBeNull()
  })

  it('issues one coupon per scanned operation still without an ACTIVE coupon or a standing report, in routing order', () => {
    const bundle = { id: 'b1', code: 'BN-1', status: 'ACTIVE' as const }
    const coupons = [
      { id: 'c1', code: 'BN-2', workOrderOperationId: 'o30', status: 'ACTIVE' as const },
      { id: 'c0', code: 'BN-3', workOrderOperationId: 'o20', status: 'VOID' as const },
    ]
    // o25 is not scanned, o30 has its coupon, o10 was reported already: only o20 (its coupon was voided) is left.
    expect(couponsToIssue({ bundle, operations: OPS, coupons, reportedAt: new Set(['o10']) }).map((row) => row.id)).toEqual(['o20'])
    expect(couponsToIssue({ bundle: { ...bundle, status: 'VOID' }, operations: OPS, coupons: [], reportedAt: new Set() })).toEqual([])
  })

  it('refuses to reprint or void a voided coupon, and to reprint one of a voided bundle', () => {
    const coupon = { id: 'c1', code: 'BN-2', workOrderOperationId: 'o20', status: 'ACTIVE' as const }
    const bundle = { id: 'b1', code: 'BN-1', status: 'ACTIVE' as const }
    expect(couponChangeRefusal({ coupon: { ...coupon, status: 'VOID' }, bundle, workOrder, reprint: true })?.code).toBe('COUPON_VOIDED')
    expect(couponChangeRefusal({ coupon, bundle: { ...bundle, status: 'VOID' }, workOrder, reprint: true })?.code).toBe('VOIDED')
    expect(couponChangeRefusal({ coupon, bundle: { ...bundle, status: 'VOID' }, workOrder, reprint: false })).toBeNull()
    expect(couponChangeRefusal({ coupon, bundle, workOrder: { ...workOrder, status: 'COMPLETED' }, reprint: false })?.code).toBe('WORK_ORDER_NOT_OPEN')
  })

  it('a scanned coupon reports its own operation; an old one names its replacement; another operation is refused', () => {
    const coupon = { id: 'c1', code: 'BN-2', workOrderOperationId: 'o20', status: 'ACTIVE' as const }
    const operation = { seq: 20, code: 'OP20', name: 'Sewing' }
    expect(couponScan({ coupon, replacement: null, operation, named: null })).toEqual({ ok: true, operationId: 'o20' })
    expect(couponScan({ coupon, replacement: null, operation, named: { id: 'o20', seq: 20, code: 'OP20', name: 'Sewing' } })).toEqual({ ok: true, operationId: 'o20' })
    const other = couponScan({ coupon, replacement: null, operation, named: { id: 'o30', seq: 30, code: 'OP30', name: 'Pressing' } })
    expect(other).toMatchObject({ ok: false, code: 'NOT_AN_OPERATION', message: 'Coupon BN-2 is for operation 20 · Sewing, not 30 · Pressing.' })
    expect(couponScan({ coupon: { ...coupon, status: 'VOID' }, replacement: { code: 'BN-9' }, operation, named: null })).toMatchObject({ ok: false, code: 'REPLACED', message: 'Coupon BN-2 was replaced by BN-9: use the new coupon.' })
    expect(couponScan({ coupon: { ...coupon, status: 'VOID' }, replacement: null, operation, named: null })).toMatchObject({ ok: false, code: 'VOIDED' })
  })

  it('prints a coupon as a BUNDLE label with its own code, the operation as the title and the bundle it belongs to', () => {
    const tag = tenantTag('00000000-0000-4000-8000-000000000041')
    const code = formatScanId({ type: 'BUNDLE', tenantTag: tag, ref: 77 })
    const label = couponLabel({
      code,
      bundleCode: formatScanId({ type: 'BUNDLE', tenantTag: tag, ref: 76 }),
      operation: { seq: 20, code: 'OP20', name: 'Cucitura' },
      ticket: { language: 'it', maker: 'Made-up Srl', workOrder: { number: 'WO-T-1', batchNumber: null }, style: { code: 'JKT-T', name: 'Jacket' }, colourway: { code: 'BLK', name: 'Nero' }, size: '50', quantity: 5, part: null },
    })
    expect(label).toMatchObject({ kind: 'BUNDLE', scanId: code, title: 'Fase 20 · Cucitura', fields: { workOrder: 'WO-T-1', pieces: '5', operation: `20 · ${formatScanId({ type: 'BUNDLE', tenantTag: tag, ref: 76 })}` } })
    expect(composeLabel(label, { tenantTag: tag }).scanId).toBe(code)
  })
})

describe('where is this bundle and is it stuck (MES-074, MES-168)', () => {
  const base = { status: 'ACTIVE' as const, createdAt: at('07:00'), operations: OPS, standing: new Set<string>(), lastScan: null, held: false, inRework: false, subcontract: null }

  it('reads the place in order: void, workshop, quality, finished, cutting, line', () => {
    expect(placeOf({ ...base, status: 'VOID' }).place).toBe('VOID')
    expect(placeOf({ ...base, subcontract: { orderId: 's1', number: 'SC-1' }, held: true }).place).toBe('SUBCONTRACTOR')
    expect(placeOf({ ...base, held: true })).toMatchObject({ place: 'QUALITY', qualityReason: 'HOLD' })
    expect(placeOf({ ...base, inRework: true })).toMatchObject({ place: 'QUALITY', qualityReason: 'REWORK' })
    expect(placeOf(base)).toMatchObject({ place: 'CUTTING', next: { id: 'o10' }, since: at('07:00') })
    const line = placeOf({ ...base, standing: new Set(['o10']), lastScan: { at: at('09:30'), operationId: 'o10', stationId: 'st1' } })
    expect(line).toMatchObject({ place: 'LINE', operation: { id: 'o10' }, next: { id: 'o20' }, since: at('09:30') })
    // The unscanned o25 never holds a bundle back from FINISHED.
    expect(placeOf({ ...base, standing: new Set(['o10', 'o20', 'o30']), lastScan: { at: at('11:00'), operationId: 'o30', stationId: null } })).toMatchObject({ place: 'FINISHED', operation: { id: 'o30' }, next: null })
  })

  it('is stuck at cutting or on the line after the limit in working hours, never on hold, at a workshop or finished', () => {
    expect(stuckOf('LINE', 240, 4)).toEqual({ stuck: true, hours: 4 })
    expect(stuckOf('LINE', 239, 4)).toEqual({ stuck: false, hours: 4 })
    expect(stuckOf('CUTTING', 301, 4)).toEqual({ stuck: true, hours: 5 })
    for (const place of ['QUALITY', 'SUBCONTRACTOR', 'FINISHED', 'VOID'] as const) expect(stuckOf(place, 10_000, 4).stuck).toBe(false)
    expect(stuckLimitOf(null)).toBe(4)
    expect(stuckLimitOf({ stuckBundleHours: 8 })).toBe(8)
    expect(stuckLimitProblems(0)).toHaveLength(1)
    expect(stuckLimitProblems(721)).toHaveLength(1)
    expect(stuckLimitProblems(2.5)).toHaveLength(1)
    expect(stuckLimitProblems(24)).toEqual([])
    expect(stuckEpisodeKey('b1', null)).toBe('bundle-stuck:b1:made')
    expect(stuckEpisodeKey('b1', 's9')).toBe('bundle-stuck:b1:s9')
  })
})

describe('scan-pattern checks: about bundles, never people (MES-075)', () => {
  const scan = (id: string, bundleId: string, operationId: string, time: string, placeKey = 'ST-1', pieces = 10): PatternScan => ({ id, bundleId, workOrderId: 'w1', operationId, placeKey, lineId: 'L1', at: at(time), pieces })

  it('finds reports bunched around a shift end at one place, one finding per bundle and operation', () => {
    const end = at('16:00')
    const burst = ['15:48', '15:50', '15:52', '15:55', '16:05'].map((time, index) => scan(`s${index}`, `b${index}`, 'o20', time))
    const elsewhere = ['15:49', '15:51', '15:53', '15:56'].map((time, index) => scan(`x${index}`, `c${index}`, 'o20', time, 'ST-2'))
    const early = scan('e1', 'b9', 'o20', '15:30')
    const found = bunchedAtShiftEnd([...burst, ...elsewhere, early], [end])
    expect(found.map((row) => row.bundleId).sort()).toEqual(['b0', 'b1', 'b2', 'b3', 'b4'])
    expect(found[0]).toMatchObject({ kind: 'BUNCHED_AT_SHIFT_END', operationId: 'o20', windowStart: at('15:45'), windowEnd: at('16:15'), detail: { scansInTheBurst: 5, windowMinutes: 30, lineId: 'L1' } })
    // Four at the other place is below the limit of five.
    expect(found.some((row) => row.bundleId.startsWith('c'))).toBe(false)
    // Never a person or a station in what was seen.
    for (const row of found) expect(Object.keys(row.detail).some((key) => /worker|station|employee|user|place/i.test(key))).toBe(false)
  })

  it('finds a bundle that reached a later operation with an earlier scanned one not reported', () => {
    const found = movedNotScanned(
      [
        { bundleId: 'b1', workOrderId: 'w1', createdAt: at('07:00'), standing: [{ operationId: 'o10', at: at('08:00'), lineId: 'L1' }, { operationId: 'o30', at: at('10:00'), lineId: 'L1' }] },
        { bundleId: 'b2', workOrderId: 'w1', createdAt: at('07:00'), standing: [{ operationId: 'o10', at: at('08:00'), lineId: 'L1' }] },
      ],
      () => OPS.map((row) => ({ ...row, standardMinutes: 1 })),
    )
    // o25 is not scanned: only o20 of b1 is missing; b2 has not moved past anything.
    expect(found).toEqual([{ kind: 'MOVED_NOT_SCANNED', workOrderId: 'w1', bundleId: 'b1', operationId: 'o20', windowStart: at('08:00'), windowEnd: at('10:00'), detail: { missingSeq: 20, reachedSeq: 30, lineId: 'L1' } }])
  })

  it('finds a report at one place sooner than half the standard minutes of its garments allow', () => {
    const operations = new Map([['o20', { id: 'o20', seq: 20, scanRequired: true, standardMinutes: 2 }]])
    // 10 garments × 2 min = 20 min of work: 8 min after the place's previous report is below 10 (half); 12 min is not.
    const scans = [scan('s1', 'b1', 'o20', '08:00'), scan('s2', 'b2', 'o20', '08:08'), scan('s3', 'b3', 'o20', '08:20'), scan('s4', 'b4', 'o20', '13:00')]
    const found = gapBelowStandard(scans, (id) => operations.get(id), () => 10)
    expect(found).toEqual([{ kind: 'GAP_BELOW_STANDARD', workOrderId: 'w1', bundleId: 'b2', operationId: 'o20', windowStart: at('08:00'), windowEnd: at('08:08'), detail: { gapMinutes: 8, standardMinutes: 20, pieces: 10, ratio: 0.4, lineId: 'L1' } }])
    // A short job (under 5 expected minutes) is never judged.
    expect(gapBelowStandard([scan('t1', 'b1', 'o20', '08:00', 'P', 1), scan('t2', 'b2', 'o20', '08:01', 'P', 1)], (id) => operations.get(id), () => 1)).toEqual([])
  })

  it('writes a finding once: the key keeps the job from repeating itself', () => {
    const one = { kind: 'GAP_BELOW_STANDARD' as const, workOrderId: 'w1', bundleId: 'b1', operationId: 'o20', windowStart: at('08:00'), windowEnd: at('08:08'), detail: {} }
    const moved = { ...one, kind: 'MOVED_NOT_SCANNED' as const, windowStart: at('09:00') }
    expect(findingKey(moved)).toBe('MOVED_NOT_SCANNED|b1|o20')
    expect(newFindings([one, one, moved], new Set([findingKey({ ...moved, windowStart: at('07:00') })]))).toEqual([one])
  })

  it('counts per line, operation and kind; holds names unless the site names workers with its basis and the purpose on', () => {
    const rows = summarise([
      { kind: 'GAP_BELOW_STANDARD', status: 'OPEN', lineId: 'L1', operationCode: 'SEW' },
      { kind: 'GAP_BELOW_STANDARD', status: 'DISMISSED', lineId: 'L1', operationCode: 'SEW' },
      { kind: 'BUNCHED_AT_SHIFT_END', status: 'REVIEWED', lineId: 'L1', operationCode: 'SEW' },
    ])
    expect(rows).toEqual([
      { lineId: 'L1', operationCode: 'SEW', kind: 'GAP_BELOW_STANDARD', open: 1, reviewed: 0, dismissed: 1 },
      { lineId: 'L1', operationCode: 'SEW', kind: 'BUNCHED_AT_SHIFT_END', open: 0, reviewed: 1, dismissed: 0 },
    ])
    expect(whoRefusal({ scanSubject: 'STATION', basisRecorded: true, performanceOpen: true })?.message).toBe('Not available: this site records stations, not people.')
    expect(whoRefusal({ scanSubject: 'WORKER', basisRecorded: false, performanceOpen: true })?.code).toBe('NO_BASIS')
    expect(whoRefusal({ scanSubject: 'WORKER', basisRecorded: true, performanceOpen: false })?.code).toBe('GATE_CLOSED')
    expect(whoRefusal({ scanSubject: 'WORKER', basisRecorded: true, performanceOpen: true })).toBeNull()
    expect(reviewProblems('DISMISSED', ' ')).toHaveLength(1)
    expect(reviewProblems('REVIEWED', null)).toEqual([])
    expect(PATTERN_RULES.summaryDays).toBe(7)
  })
})

describe('pair and set matching by shade (MES-078)', () => {
  const bundle = (id: string, part: string | null, quantity: number, shades: string[], cell = 'c1'): SetBundle => ({ id, code: `BN-${id}`, workOrderSizeId: cell, part, quantity, shades })

  it('reads a shade from the hide, else its lot, else the dye batch', () => {
    expect(shadeOf({ hideShade: ' b2 ', lotShade: 'A', dyeBatch: '77' })).toBe('B2')
    expect(shadeOf({ hideShade: null, lotShade: 'a', dyeBatch: '77' })).toBe('A')
    expect(shadeOf({ hideShade: '', lotShade: null, dyeBatch: '7731' })).toBe('7731')
    expect(shadeOf({ hideShade: null, lotShade: null, dyeBatch: null })).toBeNull()
  })

  it('makes complete garments per shade from part bundles and names the parts left over', () => {
    const result = cellSets(['Body', 'Sleeves'], [bundle('1', 'Body', 10, ['A']), bundle('2', 'Sleeves', 6, ['A']), bundle('3', 'Sleeves', 4, ['B']), bundle('4', null, 5, ['A']), bundle('5', 'Body', 3, ['A', 'B'])])
    expect(result.mixed).toEqual([{ id: '5', code: 'BN-5', shades: ['A', 'B'] }])
    const a = result.sets.find((set) => set.shade === 'A')!
    // 5 whole + min(Body 10, Sleeves 6) = 11 complete; 4 bodies wait for sleeves of shade A.
    expect(a.complete).toBe(11)
    expect(a.unmatched).toEqual([{ part: 'Body', pieces: 4, waitsFor: ['Sleeves'] }])
    expect(result.sets.find((set) => set.shade === 'B')).toMatchObject({ complete: 0, unmatched: [{ part: 'Sleeves', pieces: 4, waitsFor: ['Body'] }] })
  })

  it('refuses to pair bundles of two shades, a bundle of two shades, or bundles of two cells; unknown shades pass', () => {
    expect(pairRefusal([bundle('1', 'Body', 10, ['A']), bundle('2', 'Sleeves', 10, ['A'])])).toBeNull()
    expect(pairRefusal([bundle('1', 'Body', 10, ['A']), bundle('2', 'Sleeves', 10, [])])).toBeNull()
    expect(pairRefusal([bundle('1', 'Body', 10, ['A']), bundle('2', 'Sleeves', 10, ['B'])])).toEqual({ code: 'SHADE_MISMATCH', message: 'These bundles come from different shades (BN-1 shade A; BN-2 shade B): pair bundles of one shade only.' })
    expect(pairRefusal([bundle('1', 'Body', 10, ['A', 'B'])])?.code).toBe('MIXED_SHADES')
    expect(pairRefusal([bundle('1', 'Body', 10, ['A']), bundle('2', 'Sleeves', 10, ['A'], 'c2')])?.code).toBe('NOT_ONE_SET')
  })
})
