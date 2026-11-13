import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { describe, expect, it } from 'vitest'
import { isCutTicketNumber, isTrolleyLabel, planScan, readScan, resultCode, resultType } from './scan-model'

const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
const OTHER = tenantTag('0190f0e2-0000-7000-8000-000000000001')
const OPERATOR = ['floor.work', 'inventory.locations.view', 'production.cut']

describe('scan anything reads every label of the factory (PLT-126, PLT-155)', () => {
  it('knows the type from the prefix, and this factory from the tag', () => {
    const hide = formatScanId({ type: 'HIDE', tenantTag: TAG, ref: 42 })
    expect(readScan(hide, TAG)).toEqual({ kind: 'label', type: 'hide', code: hide })
    expect(readScan(hide.toLowerCase().replace(/-/g, ''), TAG)).toEqual({ kind: 'label', type: 'hide', code: hide })
    expect(readScan(formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 7 }), TAG)).toMatchObject({ kind: 'label', type: 'bundle' })
    expect(readScan(formatScanId({ type: 'COUPON', tenantTag: TAG, ref: 7 }), TAG)).toMatchObject({ kind: 'label', type: 'bundle' })
    expect(readScan(formatScanId({ type: 'WORK_ORDER', tenantTag: TAG, ref: 7 }), TAG)).toMatchObject({ kind: 'label', type: 'workOrder' })
    expect(readScan(formatScanId({ type: 'HIDE', tenantTag: OTHER, ref: 42 }), TAG)).toMatchObject({ kind: 'otherFactory' })
  })

  it('catches a misread code, a badge, and anything else as a free code', () => {
    const hide = formatScanId({ type: 'HIDE', tenantTag: TAG, ref: 42 })
    const typo = hide.slice(0, -1) + (hide.endsWith('A') ? 'B' : 'A')
    expect(readScan(typo, TAG)).toMatchObject({ kind: 'typo' })
    expect(readScan('0123456789ABCDEFGHJKMNPQRS', TAG)).toEqual({ kind: 'badge', code: '0123456789ABCDEFGHJKMNPQRS' })
    expect(readScan(' SEED-HIDE-0001 ', TAG)).toEqual({ kind: 'free', code: 'SEED-HIDE-0001' })
  })
})

describe("a cut ticket's number beside a carton's label (B-W2b-F16: both start with CT)", () => {
  it('reads a cut ticket as the office number it is, before the carton rule, in any case', () => {
    for (let n = 1; n <= 40; n++) {
      const number = `CTA-2026-${String(n).padStart(5, '0')}`
      expect(readScan(number, TAG), number).toEqual({ kind: 'free', code: number, cutTicket: true })
    }
    expect(readScan(' ct-2027-00042 ', TAG)).toEqual({ kind: 'free', code: 'CT-2027-00042', cutTicket: true })
    expect(isCutTicketNumber('CTB-2026-00001')).toBe(true)
    // Not a ticket's shape: a work order's number, a carton code typed without its hyphens, a year out of range.
    for (const other of ['WO-2026-00001', 'CT-26-00001', 'CTABCDEF-2026-00001', 'CT-1999-00001', 'CT-2026-'] as const) expect(isCutTicketNumber(other), other).toBe(false)
  })

  it("keeps a carton's label a carton's (and another factory's, and a misread one, as before)", () => {
    const carton = formatScanId({ type: 'CARTON', tenantTag: TAG, ref: 77 })
    expect(isCutTicketNumber(carton)).toBe(false)
    expect(readScan(carton, TAG)).toEqual({ kind: 'label', type: 'carton', code: carton })
    expect(readScan(carton.replace(/-/g, '').toLowerCase(), TAG)).toEqual({ kind: 'label', type: 'carton', code: carton })
    expect(readScan(formatScanId({ type: 'CARTON', tenantTag: OTHER, ref: 77 }), TAG)).toMatchObject({ kind: 'otherFactory' })
    const typo = carton.slice(0, -1) + (carton.endsWith('A') ? 'B' : 'A')
    expect(readScan(typo, TAG)).toMatchObject({ kind: 'typo' })
  })

  it('asks no lookup for a cut ticket: Scan anything names it and where it is used', () => {
    expect(planScan(readScan('CTA-2026-00001', TAG), OPERATOR)).toEqual({ kind: 'cutTicket' })
    expect(planScan(readScan(formatScanId({ type: 'CARTON', tenantTag: TAG, ref: 77 }), TAG), OPERATOR)).toEqual({ kind: 'notOnFloor', type: 'carton' })
    expect(resultType({ kind: 'cutTicket', code: 'CTA-2026-00001' })).toBe('cutTicket')
    expect(resultCode({ kind: 'cutTicket', code: 'CTA-2026-00001' })).toBe('CTA-2026-00001')
  })
})

describe("a trolley's label (B-W2b-F17; B-W2b-117's trolley to sewing)", () => {
  it('reads T-3, its number with or without the hyphen, and one word before it, in any case, as the trolley it is', () => {
    for (const label of ['T-3', 'T3', 'T-12', 'T-9999', 'SEED-T-1', 'A1-T-12']) expect(readScan(label, TAG), label).toEqual({ kind: 'free', code: label, trolley: true })
    expect(readScan(' t-3 ', TAG)).toEqual({ kind: 'free', code: 'T-3', trolley: true })
    expect(readScan('seed-t-2', TAG)).toEqual({ kind: 'free', code: 'SEED-T-2', trolley: true })
    // Not a trolley's shape: an office number, a location code, a hide tag, a cut ticket, a carton, two words before it.
    for (const other of ['WO-2026-00001', 'A1-STORE-01', 'SEED-HIDE-0001', 'LOT-1', 'PT-3', 'T-', 'T-12345', 'A-B-T-1', 'CTA-2026-00001']) expect(isTrolleyLabel(other), other).toBe(false)
    expect(readScan('CTA-2026-00001', TAG)).toEqual({ kind: 'free', code: 'CTA-2026-00001', cutTicket: true })
    const carton = formatScanId({ type: 'CARTON', tenantTag: TAG, ref: 77 })
    expect(isTrolleyLabel(carton)).toBe(false)
    expect(readScan(carton, TAG)).toEqual({ kind: 'label', type: 'carton', code: carton })
    // Every label code of the factory keeps its type (four parts never read as a trolley).
    for (const type of ['HIDE', 'BUNDLE', 'LOT', 'BATCH', 'SERIAL', 'LOCATION', 'WORK_ORDER', 'ROLL', 'REMNANT', 'COUPON'] as const) {
      for (const ref of [1, 3, 12, 4211]) expect(readScan(formatScanId({ type, tenantTag: TAG, ref }), TAG).kind, `${type} ${ref}`).toBe('label')
    }
    expect(readScan('0123456789ABCDEFGHJKMNPQRS', TAG).kind).toBe('badge')
  })

  it('asks no lookup for a trolley: Scan anything names it and where it is used', () => {
    expect(planScan(readScan('T-3', TAG), OPERATOR)).toEqual({ kind: 'trolley' })
    expect(resultType({ kind: 'trolley', code: 'T-3' })).toBe('trolley')
    expect(resultCode({ kind: 'trolley', code: 'T-3' })).toBe('T-3')
  })
})

describe('what is asked, with the person\'s permissions (fail closed)', () => {
  const label = (type: 'HIDE' | 'LOCATION' | 'LOT' | 'WORK_ORDER') => readScan(formatScanId({ type, tenantTag: TAG, ref: 3 }), TAG)

  it('asks the one lookup of a typed label, or refuses it without its permission', () => {
    expect(planScan(label('HIDE'), OPERATOR)).toEqual({ kind: 'ask', lookups: ['hide'], denied: [] })
    expect(planScan(label('WORK_ORDER'), OPERATOR)).toEqual({ kind: 'ask', lookups: ['workOrder'], denied: [] })
    expect(planScan(label('HIDE'), ['floor.work'])).toEqual({ kind: 'noPermission', type: 'hide' })
    expect(planScan(label('LOCATION'), ['floor.work', 'production.cut'])).toEqual({ kind: 'noPermission', type: 'location' })
  })

  it('names the types the floor cannot open yet', () => {
    expect(planScan(label('LOT'), OPERATOR)).toEqual({ kind: 'notOnFloor', type: 'lot' })
    expect(planScan(readScan(formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 1 }), TAG), OPERATOR)).toEqual({ kind: 'notOnFloor', type: 'bundle' })
  })

  it('tries a free code as a hide tag, a work order number, a location code and a machine tag, only those allowed', () => {
    const free = readScan('SEED-WO-0001', TAG)
    expect(planScan(free, [...OPERATOR, 'plant.report'])).toEqual({ kind: 'ask', lookups: ['hide', 'workOrder', 'location', 'machine'], denied: [] })
    expect(planScan(free, OPERATOR)).toEqual({ kind: 'ask', lookups: ['hide', 'workOrder', 'location'], denied: ['machine'] })
    expect(planScan(free, ['floor.work', 'inventory.locations.view'])).toEqual({ kind: 'ask', lookups: ['location'], denied: ['hide', 'workOrder', 'machine'] })
    // B-W2a-73: a sewing operator (plant.report only) finds a machine's tag at once.
    // (Its shape is a carton's marks' too: B-W2b-387's carton lookup, which this operator may not run.)
    expect(planScan(readScan('DEMO-SEW-21', TAG), ['floor.work', 'production.scan', 'plant.report'])).toEqual({ kind: 'ask', lookups: ['machine'], denied: ['hide', 'workOrder', 'location', 'carton'] })
  })

  it("B-W2b-387: a code shaped like a carton's marks (`<shipment>-<n>`) is also asked as a carton, last, by a packer", () => {
    expect(planScan(readScan('SH-00012-2', TAG), ['floor.work', 'shipping.pack'])).toEqual({ kind: 'ask', lookups: ['carton'], denied: ['hide', 'workOrder', 'location', 'machine'] })
    expect(planScan(readScan('SH-00012-2', TAG), [...OPERATOR, 'plant.report', 'shipping.pack'])).toEqual({ kind: 'ask', lookups: ['hide', 'workOrder', 'location', 'machine', 'carton'], denied: [] })
    expect(planScan(readScan('SH-00012', TAG), ['floor.work', 'shipping.pack'])).toEqual({ kind: 'ask', lookups: [], denied: ['hide', 'workOrder', 'location', 'machine'] })
  })

  it('refuses another factory\'s label and a misread one without asking; a badge switches person', () => {
    expect(planScan({ kind: 'otherFactory', code: 'X' }, OPERATOR)).toEqual({ kind: 'unknown', reason: 'otherFactory' })
    expect(planScan({ kind: 'typo', code: 'X' }, OPERATOR)).toEqual({ kind: 'unknown', reason: 'typo' })
    expect(planScan({ kind: 'badge', code: 'X' }, OPERATOR)).toEqual({ kind: 'badge' })
  })

  it('names a result\'s code and type for the recent list', () => {
    expect(resultCode({ kind: 'workOrder', number: 'WO-1', batchNumber: null, status: 'RELEASED', style: 's', dueDate: null, pieces: 1, toCut: 1, sizesLeft: [], colourways: [] })).toBe('WO-1')
    expect(resultType({ kind: 'unknown', code: 'x', reason: 'notFound' })).toBeNull()
    expect(resultType({ kind: 'notOnFloor', type: 'lot', code: 'x' })).toBe('lot')
    expect(resultType({ kind: 'machine', id: 'm', code: 'DEMO-SEW-21', type: { labelIt: 'Lineare', labelEn: 'Lockstitch', icon: 'needle' }, makeModel: null, station: null, line: null, status: 'DOWN', statusSince: '2026-10-31T08:00:00.000Z', locked: false, openJob: null, openRequests: 1 })).toBe('machine')
  })
})
