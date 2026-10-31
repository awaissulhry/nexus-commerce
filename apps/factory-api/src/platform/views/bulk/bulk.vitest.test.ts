import { afterEach, describe, expect, it } from 'vitest'
import { bulkTargetOf, processBulkTargets, useBulkTargets } from './registry'
import { BulkTargetError, defineBulkTarget, type BulkTarget } from './target'
import { BULK_TARGETS } from './targets'

/** The bulk targets (B-W2b-13; PLT-182, PLT-166): what a target must say, and the registry the routes read. */

type Row = { id: string; n: number }
const base: BulkTarget<Row> = {
  listKey: 'test.rows',
  permission: 'companies.manage',
  fields: { n: { kind: 'integer', min: 0, max: 9, read: (row) => row.n } },
  load: async () => [],
  idOf: (row) => row.id,
  labelOf: (row) => row.id,
  versionOf: () => 1,
  write: async (_caller, row) => row,
}

afterEach(() => useBulkTargets(undefined))

describe('defineBulkTarget', () => {
  it('refuses a bad list key, no field, a field id the frame could not name, a choice without choices, an upside-down range', () => {
    expect(() => defineBulkTarget({ ...base, listKey: 'Test Rows' })).toThrow(BulkTargetError)
    expect(() => defineBulkTarget({ ...base, fields: {} })).toThrow(/needs a field/)
    expect(() => defineBulkTarget({ ...base, fields: { 'a b': base.fields.n! } })).toThrow(/not a column id/)
    expect(() => defineBulkTarget({ ...base, fields: { c: { kind: 'choice', read: () => null } } })).toThrow(/without choices/)
    expect(() => defineBulkTarget({ ...base, fields: { n: { ...base.fields.n!, min: 5, max: 1 } } })).toThrow(/lowest value above/)
    expect(defineBulkTarget(base).listKey).toBe('test.rows')
  })
})

describe('the registry', () => {
  it('holds the real targets by list key (work orders: due date and priority), one per list', () => {
    expect([...processBulkTargets().keys()]).toEqual(BULK_TARGETS.map((target) => target.listKey))
    const workOrders = bulkTargetOf('production.work-orders')!
    expect(workOrders.permission).toBe('workorders.manage')
    expect(Object.keys(workOrders.fields)).toEqual(['due', 'priority'])
    expect(workOrders.fields.due).toMatchObject({ kind: 'date', nullable: true })
    expect(workOrders.fields.priority).toMatchObject({ kind: 'integer', min: -1000, max: 1000 })
    expect(workOrders.fields.due!.held!({ status: 'CLOSED' })).toEqual({ code: 'held', status: 'CLOSED' })
    expect(workOrders.fields.priority!.held!({ status: 'CANCELLED' })).toEqual({ code: 'held', status: 'CANCELLED' })
    expect(workOrders.fields.due!.held!({ status: 'ON_HOLD' })).toBeNull()
    expect(bulkTargetOf('sales.orders')).toBeUndefined()
  })

  it('tests set their own targets; two of one list are refused', () => {
    useBulkTargets([defineBulkTarget(base)])
    expect(bulkTargetOf('test.rows')).toBeDefined()
    expect(bulkTargetOf('production.work-orders')).toBeUndefined()
    expect(() => useBulkTargets([defineBulkTarget(base), defineBulkTarget(base)])).toThrow(/two bulk targets/)
  })
})
