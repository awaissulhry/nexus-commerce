import { describe, expect, it } from 'vitest'
import { isoWeekday, plusDays } from '../../calendars/dates'
import type { DemandPart, PartCoverage } from '../mrp/net'
import { calculatedDelays, delayWords } from './delays'
import { itemProfile, type ProfileDemandRef } from './profile'

/** The item's requirement profile (PLN-084) and the calculated delays (PLN-082), B-W2b-318. Every code and number is made up. */

const ref = (orderNumber: string): ProfileDemandRef => ({ orderId: `id-${orderNumber}`, orderNumber, orderLineId: `ol-${orderNumber}`, lineSeq: 10, size: '52', workOrderId: null, workOrderNumber: null, rank: null })

describe('the item’s requirement profile, week by week (PLN-084)', () => {
  const profile = itemProfile({
    today: '2026-11-12',
    weeks: 3,
    onHand: '100',
    safetyStock: '20',
    demand: [
      { day: '2026-11-18', quantity: '60', ref: ref('SO-1') },
      { day: '2026-11-25', quantity: '80', ref: ref('SO-2') },
    ],
    receipts: [{ kind: 'PURCHASE_ORDER', day: '2026-11-20', quantity: '50', purchaseOrderLineId: 'pol-1', purchaseOrderId: 'po-1', purchaseOrderNumber: 'PO-1', lineSeq: 10 }],
    planned: [{ seq: 1, day: '2026-11-25', quantity: '40' }],
  })

  it('projects the stock from on hand with receipts less demand; with the plan, its orders too', () => {
    expect(profile).toMatchObject({ from: '2026-11-09', to: '2026-11-29', weeks: 3, onHand: '100.0000', safetyStock: '20.0000', firstShort: null, firstBelowSafety: '2026-W48' })
    expect(profile.rows.map((row) => [row.key, row.demand, row.receipts, row.planned, row.projected, row.projectedWithPlan, row.belowSafety])).toEqual([
      ['2026-W46', '0.0000', '0.0000', '0.0000', '100.0000', '100.0000', false],
      ['2026-W47', '60.0000', '50.0000', '0.0000', '90.0000', '90.0000', false],
      ['2026-W48', '80.0000', '0.0000', '40.0000', '10.0000', '50.0000', true],
    ])
    expect(profile.totals).toEqual({ demand: '140.0000', receipts: '50.0000', planned: '40.0000' })
  })

  it('available to promise: a week’s shortfall is taken from the weeks before it', () => {
    expect(profile.rows.map((row) => row.atp)).toEqual(['10.0000', '0.0000', '0.0000'])
  })

  it('names what is in each cell; late demand is one row before the weeks', () => {
    expect(profile.rows[1]!.demandRefs).toEqual([{ ...ref('SO-1'), day: '2026-11-18', quantity: '60.0000' }])
    expect(profile.rows[1]!.receiptRefs).toMatchObject([{ kind: 'PURCHASE_ORDER', purchaseOrderNumber: 'PO-1' }])
    const late = itemProfile({ today: '2026-11-12', weeks: 1, onHand: '0', safetyStock: null, demand: [{ day: '2026-11-02', quantity: '5', ref: ref('SO-0') }], receipts: [], planned: [] })
    expect(late.rows.map((row) => [row.key, row.projected, row.short])).toEqual([
      ['PAST', '-5.0000', true],
      ['2026-W46', '-5.0000', true],
    ])
    expect(late.firstShort).toBe('PAST')
  })
})

describe('calculated delays (PLN-082)', () => {
  const part = (key: string, dueDate: string): DemandPart => ({ key, orderId: `so-${key}`, orderNumber: `SO-${key}`, orderLineId: `ol-${key}`, lineSeq: 10, partyId: 'p', size: '52', workOrderId: null, workOrderNumber: null, pieces: 1, dueDate, quantity: '30', issued: '0' })
  const coverage: PartCoverage[] = [
    { part: part('1', '2026-11-20'), day: '2026-11-20', supplies: [{ kind: 'PLANNED', quantity: '30.0000' }], short: '30.0000', uncovered: '30.0000' },
    { part: part('2', '2026-12-20'), day: '2026-12-20', supplies: [{ kind: 'PLANNED', quantity: '30.0000' }], short: '30.0000', uncovered: '30.0000' },
    { part: part('3', '2026-11-25'), day: '2026-11-25', supplies: [{ kind: 'FIRM', quantity: '30.0000', date: '2026-12-01', late: true }], short: '30.0000', uncovered: '0.0000' },
    { part: part('4', '2026-11-13'), day: '2026-11-13', supplies: [{ kind: 'PURCHASE_ORDER', quantity: '30.0000', date: '2026-11-10', purchaseOrderLineId: 'pol-9' }], short: '0.0000', uncovered: '0.0000' },
    { part: part('5', '2026-11-30'), day: '2026-11-30', supplies: [{ kind: 'STOCK', quantity: '30.0000' }], short: '0.0000', uncovered: '0.0000' },
  ]
  // The site works Monday to Friday: a Saturday or Sunday moves to the Monday.
  const onWorkingDay = (day: string) => (isoWeekday(day) === 6 ? plusDays(day, 2) : isoWeekday(day) === 7 ? plusDays(day, 1) : day)
  const delayed = calculatedDelays(coverage, { today: '2026-11-12', arrival: '2026-11-26', leadTimeDays: 14, delayDays: 2, onWorkingDay })

  it('says each demand its supply cannot meet: the earliest usable day after the delay days, past the closures', () => {
    expect(delayed.map((entry) => [entry.part.orderNumber, entry.source, entry.arrival, entry.usable, entry.daysLate])).toEqual([
      ['SO-1', 'PLANNED', '2026-11-26', '2026-11-30', 10],
      ['SO-3', 'FIRM', '2026-12-01', '2026-12-03', 8],
      ['SO-4', 'PURCHASE_ORDER', '2026-11-12', '2026-11-16', 3],
    ])
    expect(delayed[2]!.purchaseOrderLineId).toBe('pol-9')
  })

  it('in words', () => {
    expect(delayWords(delayed[0]!, 'LEA-100 BLK', 14)).toBe('SO-1 line 10, size 52 needs LEA-100 BLK on 2026-11-20; it is not ordered yet: ordered today, it arrives on 2026-11-26 (14 days), usable on 2026-11-30 at the earliest: 10 days late.')
    expect(delayWords(delayed[1]!, 'LEA-100 BLK', 14)).toMatch(/its firm planned order is dated 2026-12-01/)
  })
})
