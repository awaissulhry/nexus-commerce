import { describe, expect, it } from 'vitest'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { FACTORY_PERMISSIONS, FLOOR_SHARED_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { QUEUED_ACTIONS } from '../../floor-sync/kinds'
import { summaryOf } from '../../floor-sync/rules'
import {
  compareRepairRows,
  DOWNGRADE_REASONS,
  downgradedFrom,
  downgradeLeft,
  downgradeMoveKey,
  downgradeRefusal,
  repairCountHere,
  repairMinutes,
  repairStateOf,
  repairTimeOf,
  scanRefusal,
  withdrawMoveKey,
  withdrawRefusal,
  type DowngradeFacts,
  type QueueRowFacts,
  type ScanFacts,
} from './rules'

const IN = new Date('2026-11-17T08:00:00.000Z')
const OUT = new Date('2026-11-17T08:37:30.000Z')

describe('the repair queue', () => {
  it('reads WAITING until scanned in, IN_REPAIR until scanned out, nothing once done', () => {
    expect(repairStateOf({ status: 'OPEN', repairInAt: null, repairOutAt: null })).toBe('WAITING')
    expect(repairStateOf({ status: 'IN_PROGRESS', repairInAt: null, repairOutAt: null })).toBe('WAITING')
    expect(repairStateOf({ status: 'IN_PROGRESS', repairInAt: IN, repairOutAt: null })).toBe('IN_REPAIR')
    expect(repairStateOf({ status: 'DONE', repairInAt: IN, repairOutAt: OUT })).toBeNull()
    expect(repairStateOf({ status: 'CANCELLED', repairInAt: null, repairOutAt: null })).toBeNull()
  })

  it('counts whole minutes per rework, so far while in repair', () => {
    expect(repairMinutes(IN, OUT)).toBe(38)
    expect(repairMinutes(IN, null, new Date('2026-11-17T08:10:00.000Z'))).toBe(10)
    expect(repairMinutes(null, null, OUT)).toBeNull()
  })

  it("puts this station's repairs first, then its waiting bundles, then the site's; held last; due date; oldest", () => {
    const row = (id: string, extra: Partial<QueueRowFacts>): QueueRowFacts => ({ id, state: 'WAITING', here: false, held: false, dueDate: '2026-11-20', since: '2026-11-17T07:00:00.000Z', ...extra })
    const rows = [
      row('site-waiting', {}),
      row('here-waiting-late', { here: true, dueDate: '2026-11-30' }),
      row('here-in', { here: true, state: 'IN_REPAIR' }),
      row('here-waiting-held', { here: true, held: true, dueDate: '2026-11-18' }),
      row('here-waiting-soon', { here: true, dueDate: '2026-11-19' }),
      row('site-in', { state: 'IN_REPAIR' }),
    ]
    expect([...rows].sort(compareRepairRows).map((entry) => entry.id)).toEqual(['here-in', 'here-waiting-soon', 'here-waiting-late', 'here-waiting-held', 'site-waiting', 'site-in'])
    expect(repairCountHere(rows)).toBe(4)
  })
})

describe('scans in and out', () => {
  const facts = (extra: Partial<ScanFacts> = {}): ScanFacts => ({
    step: 'IN',
    workOrder: { number: 'WO-1', status: 'IN_PROGRESS' },
    rework: { status: 'OPEN', repairInAt: null, repairOutAt: null, quantity: 2, bundleCode: 'BN-0001' },
    station: { code: 'REP-01' },
    ...extra,
  })

  it('takes a waiting bundle in at a station with its own ticket', () => {
    expect(scanRefusal(facts({ code: ' bn-0001 ' }))).toBeNull()
    expect(scanRefusal(facts())).toBeNull()
  })

  it('refuses each wrong scan in words, with what to do', () => {
    expect(scanRefusal(facts({ code: 'BN-0002' }))).toMatchObject({ code: 'NOT_THIS_BUNDLE', fix: expect.stringContaining('BN-0001') })
    expect(scanRefusal(facts({ station: null }))?.code).toBe('NO_STATION')
    expect(scanRefusal(facts({ rework: { status: 'IN_PROGRESS', repairInAt: IN, repairOutAt: null, quantity: 2, bundleCode: 'BN-0001', stationCode: 'REP-01' } }))).toMatchObject({ code: 'ALREADY_IN', message: expect.stringContaining('REP-01') })
    expect(scanRefusal(facts({ rework: { status: 'DONE', repairInAt: IN, repairOutAt: OUT, quantity: 2, bundleCode: null } }))?.code).toBe('WRONG_STATE')
    expect(scanRefusal(facts({ workOrder: { number: 'WO-1', status: 'ON_HOLD', holdReason: 'Shade check' } }))).toMatchObject({ code: 'WORK_ORDER_ON_HOLD', message: expect.stringContaining('Shade check') })
    expect(scanRefusal(facts({ workOrder: { number: 'WO-1', status: 'COMPLETED' } }))?.code).toBe('WORK_ORDER_NOT_OPEN')
  })

  it('scans out only after the scan in, with good and scrapped adding up to the garments', () => {
    const inRepair = { status: 'IN_PROGRESS' as const, repairInAt: IN, repairOutAt: null, quantity: 2, bundleCode: 'BN-0001' }
    expect(scanRefusal(facts({ step: 'OUT', rework: { ...inRepair, repairInAt: null }, good: 2, scrap: 0 }))?.code).toBe('NOT_IN')
    expect(scanRefusal(facts({ step: 'OUT', rework: inRepair, good: 1, scrap: 0 }))?.code).toBe('COUNTS_DO_NOT_ADD_UP')
    expect(scanRefusal(facts({ step: 'OUT', rework: inRepair, good: 1, scrap: 1, station: null }))).toBeNull()
  })

  it("believes a queued scan's tablet time within bounds, and never puts a scan out before its scan in", () => {
    const now = new Date('2026-11-17T09:00:00.000Z')
    expect(repairTimeOf(new Date('2026-11-17T08:20:00.000Z'), now)).toEqual(new Date('2026-11-17T08:20:00.000Z'))
    expect(repairTimeOf(new Date('2026-11-17T09:01:00.000Z'), now)).toEqual(now)
    expect(repairTimeOf(new Date('2026-11-17T09:30:00.000Z'), now)).toEqual(now)
    expect(repairTimeOf(new Date('2026-11-15T09:00:00.000Z'), now)).toEqual(now)
    expect(repairTimeOf(new Date('2026-11-17T07:00:00.000Z'), now, IN)).toEqual(IN)
    expect(repairTimeOf(null, now)).toEqual(now)
  })
})

describe('second quality instead of scrap', () => {
  const facts = (extra: Partial<DowngradeFacts> = {}): DowngradeFacts => ({
    workOrder: { number: 'WO-1', status: 'IN_PROGRESS' },
    scrapped: 3,
    downgraded: 1,
    quantity: 2,
    part: null,
    reasonCode: 'STAIN',
    approval: null,
    ppe: false,
    ppeConfirmed: false,
    target: 'SKU',
    skuKnown: true,
    placeInFinishedGoods: false,
    ...extra,
  })

  it('sends up to what the row scrapped less what went already, with a reason', () => {
    expect(downgradeLeft({ scrapped: 3, downgraded: 1 })).toBe(2)
    expect(downgradeRefusal(facts())).toBeNull()
    expect(downgradeRefusal(facts({ quantity: 3 }))).toMatchObject({ code: 'MORE_THAN_SCRAPPED', message: expect.stringContaining('2 can still') })
    expect(downgradeRefusal(facts({ downgraded: 3, quantity: 1 }))).toMatchObject({ code: 'MORE_THAN_SCRAPPED', message: expect.stringContaining('already') })
    expect(downgradeRefusal(facts({ reasonCode: 'NICE' }))?.code).toBe('NOT_A_REASON')
    expect(downgradeRefusal(facts({ reasonCode: 'OTHER' }))?.code).toBe('REASON_WORDS')
    expect(downgradeRefusal(facts({ reasonCode: 'OTHER', note: 'Zip pull scratched' }))).toBeNull()
    expect(DOWNGRADE_REASONS.every((code) => !/\s/.test(code))).toBe(true)
  })

  it('refuses a cut piece, a held or refused scrap, a closed work order and nothing scrapped', () => {
    expect(downgradeRefusal(facts({ part: 'sleeve' }))).toMatchObject({ code: 'NOT_A_GARMENT', message: expect.stringContaining('sleeve') })
    expect(downgradeRefusal(facts({ approval: 'WAITING' }))?.code).toBe('SCRAP_WAITS_APPROVAL')
    expect(downgradeRefusal(facts({ approval: 'REFUSED' }))?.code).toBe('SCRAP_REFUSED')
    expect(downgradeRefusal(facts({ workOrder: { number: 'WO-1', status: 'CANCELLED' } }))?.code).toBe('WORK_ORDER_NOT_OPEN')
    expect(downgradeRefusal(facts({ workOrder: { number: 'WO-1', status: 'COMPLETED' } }))).toBeNull()
    expect(downgradeRefusal(facts({ scrapped: 0, downgraded: 0 }))?.code).toBe('NOT_SCRAP')
  })

  it('asks a protective garment to be confirmed, keeps a SKU out of finished goods, and checks the item', () => {
    expect(downgradeRefusal(facts({ ppe: true }))).toMatchObject({ code: 'PPE_CONFIRM', fix: expect.any(String) })
    expect(downgradeRefusal(facts({ ppe: true, ppeConfirmed: true }))).toBeNull()
    expect(downgradeRefusal(facts({ placeInFinishedGoods: true }))?.code).toBe('SKU_IN_FINISHED_GOODS')
    expect(downgradeRefusal(facts({ skuKnown: false }))?.code).toBe('NO_SKU')
    expect(downgradeRefusal(facts({ target: 'ITEM', placeInFinishedGoods: true, itemFits: true }))).toBeNull()
    expect(downgradeRefusal(facts({ target: 'ITEM', itemFits: false }))?.code).toBe('NOT_A_SECOND_QUALITY_ITEM')
  })

  it('counts what a source sent already, withdrawn rows left out; a rework source is its own scrap only', () => {
    const rows = [
      { sourceScanId: 's1', reworkOrderId: null, quantity: 2, voidedAt: null },
      { sourceScanId: 's1', reworkOrderId: null, quantity: 1, voidedAt: new Date() },
      { sourceScanId: null, reworkOrderId: 'r1', quantity: 1, voidedAt: null },
      { sourceScanId: 's2', reworkOrderId: 'r1', quantity: 5, voidedAt: null },
    ]
    expect(downgradedFrom(rows, { sourceScanId: 's1' })).toBe(2)
    expect(downgradedFrom(rows, { reworkOrderId: 'r1' })).toBe(1)
    expect(downgradedFrom(rows, {})).toBe(0)
  })

  it('withdraws once; the moves are found by their keys', () => {
    expect(withdrawRefusal({ voidedAt: null })).toBeNull()
    expect(withdrawRefusal({ voidedAt: new Date() })?.code).toBe('ALREADY_WITHDRAWN')
    expect(downgradeMoveKey('d1')).toBe('production.downgrade:d1:1')
    expect(withdrawMoveKey('d1')).toBe('production.downgrade:d1:withdraw')
  })
})

describe('the catalogues', () => {
  it('declares the two permissions; the repair one is shared with the floor, the downgrade one is not', () => {
    expect(FACTORY_PERMISSIONS.get('production.repair')?.risk).toBe('write')
    expect(FACTORY_PERMISSIONS.get('production.downgrade')?.risk).toBe('write')
    expect(FLOOR_SHARED_PERMISSIONS).toContain('production.repair')
    expect(FLOOR_SHARED_PERMISSIONS).not.toContain('production.downgrade')
  })

  it('gives the repair station to operators and team leaders, second quality to the production manager and quality inspector', () => {
    for (const key of ['operator', 'team_leader']) expect(templateOf(key)?.permissions).toContain('production.repair')
    for (const key of ['production_manager', 'quality_inspector']) expect(templateOf(key)?.permissions).toContain('production.downgrade')
    for (const key of ['floor_inspector', 'cutting_operator', 'sales', 'finance']) {
      expect(templateOf(key)?.permissions).not.toContain('production.repair')
      expect(templateOf(key)?.permissions).not.toContain('production.downgrade')
    }
  })

  it('declares the three events with no person and no money in a live field', () => {
    for (const type of ['production.repair_scanned', 'production.garments_downgraded', 'production.downgrade_withdrawn']) {
      const definition = EVENT_CATALOGUE.get(type, 1)
      expect(definition, type).toBeDefined()
      expect(definition!.live?.permission).toBe('production.scrap.view')
    }
    expect(EVENT_CATALOGUE.get('production.repair_scanned', 1).live?.floor).toBe('production.repair')
  })

  it('queues a repair scan offline under the repair right, summarised without a person', () => {
    expect(QUEUED_ACTIONS['production.repair.scan'].permission).toBe('production.repair')
    expect(summaryOf('production.repair.scan', { reworkId: 'r1', step: 'OUT', code: 'BN-1', good: 1, scrap: 1, workerId: 'w' })).toEqual({ code: 'BN-1', target: 'r1', good: 1, scrap: 1 })
    expect(summaryOf('production.repair.scan', { reworkId: 'r1', step: 'IN' })).toEqual({ code: 'IN', target: 'r1' })
  })
})
