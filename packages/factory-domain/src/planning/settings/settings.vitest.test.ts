import { describe, expect, it } from 'vitest'
import { bucketOf, isoWeekKey, planBuckets, uniformBuckets, weekStart } from './buckets'
import { EMPTY_ITEM_PLANNING, itemPlanningFor, itemPlanningProblems, mergeItemPlanning, orderQuantities, reorderNeed, type ItemPlanningValues } from './items'
import { changedSettings, DEFAULT_PLANNING_SETTINGS, efficiencyPctOf, settingsProblems } from './settings'

const paths = (issues: readonly { path: string }[]) => issues.map((issue) => issue.path)

describe('buckets (PLN-003)', () => {
  it('names ISO weeks by their Thursday and clips uniform buckets to the range', () => {
    expect([weekStart('2026-11-18'), isoWeekKey('2026-11-18'), isoWeekKey('2026-12-31'), isoWeekKey('2027-01-03'), isoWeekKey('2027-01-04')]).toEqual(['2026-11-16', '2026-W47', '2026-W53', '2026-W53', '2027-W01'])
    expect(uniformBuckets('2026-11-18', '2026-12-02', 'WEEK').map((bucket) => [bucket.key, bucket.from, bucket.to])).toEqual([
      ['2026-W47', '2026-11-18', '2026-11-22'],
      ['2026-W48', '2026-11-23', '2026-11-29'],
      ['2026-W49', '2026-11-30', '2026-12-02'],
    ])
    expect(uniformBuckets('2026-12-30', '2027-02-02', 'MONTH').map((bucket) => [bucket.key, bucket.from, bucket.to])).toEqual([
      ['2026-12', '2026-12-30', '2026-12-31'],
      ['2027-01', '2027-01-01', '2027-01-31'],
      ['2027-02', '2027-02-01', '2027-02-02'],
    ])
    expect(uniformBuckets('2026-11-18', '2026-11-18', 'DAY')).toEqual([{ key: '2026-11-18', kind: 'DAY', from: '2026-11-18', to: '2026-11-18' }])
    expect(() => uniformBuckets('2026-11-18', '2026-11-17', 'DAY')).toThrow(RangeError)
  })

  it('makes the plan: days to the end of week 2, weeks to week 13, months to the horizon, with no gap', () => {
    const plan = planBuckets(DEFAULT_PLANNING_SETTINGS, '2026-11-18')
    expect([plan.from, plan.to]).toEqual(['2026-11-18', '2027-05-16'])
    const kinds = plan.buckets.map((bucket) => bucket.kind)
    expect([kinds.filter((kind) => kind === 'DAY').length, kinds.filter((kind) => kind === 'WEEK').length]).toEqual([12, 11])
    expect(plan.buckets.at(11)).toMatchObject({ key: '2026-11-29', kind: 'DAY' })
    expect(plan.buckets.at(12)).toMatchObject({ key: '2026-W49', from: '2026-11-30', to: '2026-12-06' })
    expect(plan.buckets.at(23)).toMatchObject({ kind: 'MONTH', key: '2027-02', from: '2027-02-15', to: '2027-02-28' })
    expect(plan.buckets.at(-1)).toMatchObject({ kind: 'MONTH', key: '2027-05', from: '2027-05-01', to: '2027-05-16' })
    for (let index = 1; index < plan.buckets.length; index++) {
      const before = plan.buckets[index - 1]!
      expect(new Date(`${before.to}T00:00:00Z`).getTime() + 86_400_000).toBe(new Date(`${plan.buckets[index]!.from}T00:00:00Z`).getTime())
    }
    expect(bucketOf(plan.buckets, '2026-12-01')?.key).toBe('2026-W49')
    expect(bucketOf(plan.buckets, '2027-05-17')).toBeNull()
    // Weeks only (no day weeks), and a horizon of weeks only.
    expect(planBuckets({ horizonWeeks: 4, dayBucketWeeks: 0, weekBucketWeeks: 4 }, '2026-11-18').buckets.map((bucket) => bucket.key)).toEqual(['2026-W47', '2026-W48', '2026-W49', '2026-W50'])
    expect(planBuckets({ horizonWeeks: 1, dayBucketWeeks: 1, weekBucketWeeks: 1 }, '2026-11-22').buckets.map((bucket) => bucket.key)).toEqual(['2026-11-22'])
    expect(() => planBuckets({ horizonWeeks: 4, dayBucketWeeks: 5, weekBucketWeeks: 4 }, '2026-11-18')).toThrow(RangeError)
  })
})

describe('planning settings', () => {
  it('holds the ranges in words with the field', () => {
    expect(settingsProblems(DEFAULT_PLANNING_SETTINGS)).toEqual([])
    expect(paths(settingsProblems({ ...DEFAULT_PLANNING_SETTINGS, horizonWeeks: 105 }))).toEqual(['body/horizonWeeks'])
    expect(paths(settingsProblems({ ...DEFAULT_PLANNING_SETTINGS, horizonWeeks: 10, weekBucketWeeks: 13 }))).toEqual(['body/weekBucketWeeks'])
    expect(paths(settingsProblems({ ...DEFAULT_PLANNING_SETTINGS, dayBucketWeeks: 14 }))).toEqual(['body/dayBucketWeeks'])
    expect(paths(settingsProblems({ ...DEFAULT_PLANNING_SETTINGS, defaultEfficiencyPct: '0', scheduledRunTime: '24:00' }))).toEqual(['body/defaultEfficiencyPct', 'body/scheduledRunTime'])
    expect([efficiencyPctOf('85'), efficiencyPctOf('92.5'), efficiencyPctOf('200'), efficiencyPctOf('200.01'), efficiencyPctOf('0.00'), efficiencyPctOf('8,5')]).toEqual(['85.00', '92.50', '200.00', null, null, null])
    expect(changedSettings(DEFAULT_PLANNING_SETTINGS, { ...DEFAULT_PLANNING_SETTINGS, defaultEfficiencyPct: '100', scheduledRunTime: '02:00' })).toEqual(['scheduledRunTime'])
  })
})

describe('item parameters (PLN-005, PLN-099)', () => {
  const minMax: ItemPlanningValues = { ...EMPTY_ITEM_PLANNING, method: 'MIN_MAX', source: 'BUY', supplierId: 's', minStock: '50', maxStock: '300', orderMultiple: '50' }

  it('asks for exactly the fields of the method, sizes above 0 and maxima above their minima', () => {
    expect(itemPlanningProblems(minMax)).toEqual([])
    expect(paths(itemPlanningProblems({ ...EMPTY_ITEM_PLANNING, method: 'REORDER_POINT' }))).toEqual(['body/reorderPoint', 'body/lotSize'])
    expect(paths(itemPlanningProblems({ ...minMax, method: 'ORDERS' }))).toEqual(['body/minStock', 'body/maxStock'])
    expect(paths(itemPlanningProblems({ ...minMax, maxStock: '50' }))).toEqual(['body/maxStock'])
    expect(paths(itemPlanningProblems({ ...minMax, orderMultiple: '0', minOrderQty: '10', maxOrderQty: '5' }))).toEqual(['body/orderMultiple', 'body/maxOrderQty'])
    expect(paths(itemPlanningProblems({ ...minMax, source: 'MAKE' }))).toEqual(['body/supplierId'])
    expect(paths(itemPlanningProblems({ ...EMPTY_ITEM_PLANNING, makeSiteId: 'p', buyLeadTimeDays: 367, safetyStock: '1.23456' }))).toEqual(['body/buyLeadTimeDays', 'body/safetyStock', 'body/makeSiteId'])
  })

  it('clears what a change of method or source leaves behind, and says so', () => {
    expect(mergeItemPlanning(minMax, { method: 'ORDERS' })).toEqual({ values: { ...minMax, method: 'ORDERS', minStock: null, maxStock: null }, cleared: ['minStock', 'maxStock'] })
    const toRop = mergeItemPlanning(minMax, { method: 'REORDER_POINT', reorderPoint: '24', lotSize: '48', source: 'MAKE' })
    expect([toRop.values.reorderPoint, toRop.values.minStock, toRop.values.supplierId, toRop.cleared]).toEqual(['24', null, null, ['minStock', 'maxStock', 'supplierId']])
    // A field the change names is kept, so the rule refuses it in words.
    expect(mergeItemPlanning(minMax, { method: 'ORDERS', minStock: '10' }).values.minStock).toBe('10')
    expect(mergeItemPlanning(null, { safetyStock: '12' })).toEqual({ values: { ...EMPTY_ITEM_PLANNING, safetyStock: '12' }, cleared: [] })
  })

  it("picks the colour's row over the one for every colour", () => {
    const rows = [{ id: 'all', itemColourId: null }, { id: 'red', itemColourId: 'RED' }]
    expect([itemPlanningFor(rows, 'RED')?.id, itemPlanningFor(rows, 'BLK')?.id, itemPlanningFor(rows, null)?.id, itemPlanningFor([rows[1]!], 'BLK')]).toEqual(['red', 'all', 'all', null])
  })

  it('shapes orders by the minimum and step, and splits above the maximum', () => {
    expect(orderQuantities('7', { minOrderQty: '24', orderMultiple: '12', maxOrderQty: null })).toEqual(['24.0000'])
    expect(orderQuantities('25', { minOrderQty: '24', orderMultiple: '12', maxOrderQty: null })).toEqual(['36.0000'])
    expect(orderQuantities('250', { minOrderQty: null, orderMultiple: '12', maxOrderQty: '100' })).toEqual(['96.0000', '96.0000', '60.0000'])
    expect(orderQuantities('0', { minOrderQty: '24', orderMultiple: null, maxOrderQty: null })).toEqual([])
  })

  it('triggers a reorder point at or below it and a min/max below the minimum', () => {
    const rop = { ...EMPTY_ITEM_PLANNING, method: 'REORDER_POINT' as const, reorderPoint: '24', lotSize: '48' }
    expect(reorderNeed(rop, { onHand: '30', onOrder: '0', reserved: '6' })).toMatchObject({ triggered: true, position: '24.0000', quantity: '48.0000' })
    expect(reorderNeed(rop, { onHand: '10', onOrder: '0', reserved: '50' })).toMatchObject({ triggered: true, position: '-40.0000', quantity: '96.0000' })
    expect(reorderNeed(rop, { onHand: '30', onOrder: '0', reserved: '5' }).triggered).toBe(false)
    expect(reorderNeed(minMax, { onHand: '20', onOrder: '10', reserved: '0' })).toMatchObject({ triggered: true, quantity: '270.0000' })
    expect(reorderNeed(minMax, { onHand: '50', onOrder: '0', reserved: '0' }).triggered).toBe(false)
    expect(reorderNeed(EMPTY_ITEM_PLANNING, { onHand: '0', onOrder: '0', reserved: '0' }).words).toMatch(/not planned by a reorder rule/)
  })
})
