import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { describe, expect, it } from 'vitest'
import { planScan, readScan, resultCode, resultType } from './scan-model'

const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
const OTHER = tenantTag('0190f0e2-0000-7000-8000-000000000001')
const OPERATOR = ['floor.work', 'inventory.locations.view', 'production.cut']

describe('scan anything reads every label of the factory (PLT-126, PLT-155)', () => {
  it('knows the type from the prefix, and this factory from the tag', () => {
    const hide = formatScanId({ type: 'HIDE', tenantTag: TAG, ref: 42 })
    expect(readScan(hide, TAG)).toEqual({ kind: 'label', type: 'hide', code: hide })
    expect(readScan(hide.toLowerCase().replace(/-/g, ''), TAG)).toEqual({ kind: 'label', type: 'hide', code: hide })
    expect(readScan(formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 7 }), TAG)).toMatchObject({ kind: 'label', type: 'bundle' })
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
    expect(planScan(readScan('DEMO-SEW-21', TAG), ['floor.work', 'production.scan', 'plant.report'])).toEqual({ kind: 'ask', lookups: ['machine'], denied: ['hide', 'workOrder', 'location'] })
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
