import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { SAMPLE_STAGES } from '../samples/rules'
import { REPAIR_STAGES } from '../repairs/rules'
import { SALES_ORDER_STATUSES } from '../orders/orders'
import { creditStateOf, daysLate, GLANCE_PARTS, latestProfiles, PART_PERMISSIONS, PROMISE_STATUSES, promisesOf, REPAIR_OPEN_STAGES, SAMPLE_OPEN_STAGES, withheldParts } from './glance'

// Made-up rows only.
const TODAY = '2026-11-12'

describe('Customer 360 (B-W2b-324)', () => {
  it('counts late promises and finds the next one', () => {
    expect(promisesOf([{ promiseDate: '2026-11-01' }, { promiseDate: '2026-11-12' }, { promiseDate: '2026-12-03' }, { promiseDate: null }], TODAY)).toEqual({ open: 4, late: 1, noPromise: 1, next: '2026-11-12' })
    expect(promisesOf([], TODAY)).toEqual({ open: 0, late: 0, noPromise: 0, next: null })
    expect(promisesOf([{ promiseDate: '2026-10-30' }], TODAY)).toEqual({ open: 1, late: 1, noPromise: 0, next: null })
  })

  it('says days late from a due day (none without one)', () => {
    expect(daysLate('2026-11-10', TODAY)).toBe(2)
    expect(daysLate('2026-11-12', TODAY)).toBe(0)
    expect(daysLate('2026-11-20', TODAY)).toBe(-8)
    expect(daysLate(null, TODAY)).toBeNull()
  })

  it('keeps the newest revision per party, rider and garment type, the newest measured first', () => {
    const rows = [
      { id: 'a', partyId: 'p', riderName: 'Rider Uno', garmentType: 'JACKET', revision: 1, takenAt: '2026-01-10T09:00:00.000Z' },
      { id: 'b', partyId: 'p', riderName: 'rider  uno', garmentType: 'JACKET', revision: 2, takenAt: '2026-05-10T09:00:00.000Z' },
      { id: 'c', partyId: 'p', riderName: 'Rider Uno', garmentType: 'PANTS', revision: 1, takenAt: '2026-03-01T09:00:00.000Z' },
      { id: 'd', partyId: 'q', riderName: 'Rider Uno', garmentType: 'JACKET', revision: 1, takenAt: '2026-02-01T09:00:00.000Z' },
    ]
    expect(latestProfiles(rows).map((row) => row.id)).toEqual(['b', 'c', 'd'])
  })

  it('says where credit stands: no limit, within, over', () => {
    expect(creditStateOf(null)).toBe('NONE')
    expect(creditStateOf({ limit: null, available: null })).toBe('NONE')
    expect(creditStateOf({ limit: 100_00, available: 0 })).toBe('WITHIN')
    expect(creditStateOf({ limit: 100_00, available: -1 })).toBe('OVER')
  })

  it('withholds a part without its permission, every permission named in the catalogue', () => {
    for (const part of GLANCE_PARTS) for (const permission of PART_PERMISSIONS[part]) expect(FACTORY_PERMISSIONS.isDeclared(permission), permission).toBe(true)
    expect(withheldParts(() => true)).toEqual([])
    expect(withheldParts((permission) => permission !== 'sales.samples.view' && permission !== 'sales.credit.view')).toEqual(['credit', 'samples'])
    expect(withheldParts(() => false)).toEqual(['promises', 'credit', 'samples', 'profiles', 'repairs'])
  })

  it('reads stages and statuses the schema has', () => {
    for (const stage of SAMPLE_OPEN_STAGES) expect(SAMPLE_STAGES).toContain(stage)
    expect(SAMPLE_OPEN_STAGES).not.toContain('DECIDED')
    for (const stage of REPAIR_OPEN_STAGES) expect(REPAIR_STAGES).toContain(stage)
    expect(REPAIR_OPEN_STAGES).not.toContain('SHIPPED')
    for (const status of PROMISE_STATUSES) expect(SALES_ORDER_STATUSES).toContain(status)
  })
})
