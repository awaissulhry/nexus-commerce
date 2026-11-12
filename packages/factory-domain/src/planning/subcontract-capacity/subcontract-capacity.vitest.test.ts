import { describe, expect, it } from 'vitest'
import { Dec } from '../../tax/decimal'
import { cellText, heatBand } from '../heatmap/bands'
import { PLANNING_SUBCONTRACT_ADDS, PLANNING_SUBCONTRACT_PERMISSIONS } from './permissions'
import {
  capacityOver,
  capacityProblems,
  conflictProblem,
  daysBetween,
  inHouseProblems,
  jobAmount,
  keysOf,
  kitWords,
  loadPctOf,
  outsideProblems,
  outsideWorkOf,
  rowOn,
  spreadJob,
  verdictOf,
  workDaysOf,
  type CapacityRow,
  type WorkshopFacts,
  type WorkshopJob,
} from './rules'

const P2 = '00000000-0000-7000-8000-000000000002'
const sewing: CapacityRow = { id: 'r1', partyId: P2, workCentreKind: 'SEWING', unit: 'MINUTES', perWeek: 2400, validFrom: '2026-11-01', validTo: null }
const garments: CapacityRow = { id: 'r2', partyId: P2, workCentreKind: null, unit: 'PIECES', perWeek: 60, validFrom: '2026-11-01', validTo: '2026-12-23' }

describe('a workshop’s weekly capacity (PLN-124)', () => {
  it('checks a row and refuses an overlapping period or another unit of the same kind', () => {
    expect(capacityProblems({ perWeek: 0 })).toHaveLength(1)
    expect(capacityProblems({ perWeek: 1_000_001 })).toHaveLength(1)
    expect(capacityProblems({ validFrom: '2026-11-10', validTo: '2026-11-09' })[0]!.path).toBe('body/validTo')
    expect(conflictProblem([sewing, garments], { ...sewing, id: null, validFrom: '2026-12-01' })?.message).toMatch(/overlaps the capacity for sewing from 2026-11-01/)
    expect(conflictProblem([{ ...sewing, validTo: '2026-11-30' }], { ...sewing, id: null, validFrom: '2026-12-01' })).toBeNull()
    expect(conflictProblem([sewing], { ...sewing, id: null, unit: 'PIECES', validFrom: '2027-01-01' })?.path).toBe('body/unit')
    // The same row edited is no conflict with itself.
    expect(conflictProblem([sewing], { ...sewing })).toBeNull()
  })

  it('spreads a week over the weekdays the workshop is open', () => {
    expect(rowOn([sewing, garments], P2, null, '2026-12-24')).toBeNull()
    const week = daysBetween('2026-11-16', '2026-11-22')
    expect(capacityOver([sewing], keysOf([sewing])[0]!, week, new Set()).amount.toFixed(1)).toBe('2400.0')
    const closed = capacityOver([sewing], keysOf([sewing])[0]!, week, new Set(['2026-11-19', '2026-11-20']))
    expect([closed.amount.toFixed(1), closed.openDays, closed.closedDays]).toEqual(['1440.0', 3, 2])
    // Before its first day: unknown, never 0.
    expect(capacityOver([sewing], keysOf([sewing])[0]!, daysBetween('2026-10-19', '2026-10-25'), new Set()).known).toBe(false)
    expect(keysOf([garments, sewing]).map((key) => key.workCentreKind)).toEqual([null, 'SEWING'])
  })

  it('counts a job in minutes of its kind or in garments, spread over the open days', () => {
    const job: WorkshopJob = { kind: 'ORDER', id: 'o1', partyId: P2, workOrderId: 'w1', from: '2026-11-16', to: '2026-11-20', garments: 20, operations: [{ workCentreKind: 'SEWING', minutes: '1000' }, { workCentreKind: 'FINISHING', minutes: '200' }] }
    expect(jobAmount(job, { workCentreKind: 'SEWING', unit: 'MINUTES' }).toFixed(0)).toBe('1000')
    expect(jobAmount(job, { workCentreKind: null, unit: 'MINUTES' }).toFixed(0)).toBe('1200')
    expect(jobAmount(job, { workCentreKind: null, unit: 'PIECES' }).toFixed(0)).toBe('20')
    expect(jobAmount(job, { workCentreKind: 'CUTTING', unit: 'PIECES' }).toFixed(0)).toBe('0')
    const spread = spreadJob(new Dec(1000), job, new Set(['2026-11-20']))
    expect([...spread.keys()]).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'])
    expect(spread.get('2026-11-16')!.toFixed(0)).toBe('250')
    // A weekend job: all on its first day.
    expect([...spreadJob(new Dec(5), { from: '2026-11-21', to: '2026-11-22' }, new Set()).keys()]).toEqual(['2026-11-21'])
    expect(loadPctOf(new Dec(2640), new Dec(2400))).toBe('110.0')
    expect(loadPctOf(new Dec(1), new Dec(0))).toBeNull()
  })
})

describe('only approved workshops (PLN-162)', () => {
  const base: WorkshopFacts = { name: 'Workshop Beta', isWorkshop: true, active: true, supplierProblem: null, siteName: 'Plant 1', hasLocation: true, needs: [{ label: 'sewing (Op 20 Armour pockets)', qualified: true, standing: 'QUALIFIED', words: 'Qualified.' }], durc: { checked: true, state: 'MET', expiresOn: '2027-01-31' }, capacity: { known: true, over: false, loadPct: '40.0' } }
  it('offers a qualified workshop with a valid DURC', () => {
    expect(verdictOf(base)).toEqual({ offered: true, held: [], warnings: [] })
  })
  it('holds the others with the reason in words', () => {
    const held = verdictOf({ ...base, hasLocation: false, needs: [{ label: 'sewing (Op 20 Armour pockets)', qualified: false, standing: 'PENDING', words: 'Being reviewed: not qualified yet.' }], durc: { checked: true, state: 'EXPIRED', expiresOn: '2026-11-05' } })
    expect(held.offered).toBe(false)
    expect(held.held.map((reason) => reason.code)).toEqual(['NO_LOCATION', 'NOT_QUALIFIED', 'NO_VALID_DURC'])
    expect(held.held[1]!.words).toBe('Not approved for sewing (Op 20 Armour pockets): being reviewed: not qualified yet.')
    expect(held.held[2]!.words).toMatch(/No valid DURC: it expired on 2026-11-05/)
    expect(verdictOf({ ...base, supplierProblem: 'Workshop Beta is on hold as a supplier: no new purchase order goes to it.' }).held[0]!.code).toBe('SUPPLIER_STATUS')
  })
  it('warns without holding: conditions, an expiring DURC, unknown or full capacity, kinds not set', () => {
    const warned = verdictOf({ ...base, needs: [{ label: 'finishing (Op 40 Press)', qualified: true, standing: 'CONDITIONAL', words: 'Qualified with conditions: every piece inspected.' }], durc: { checked: true, state: 'EXPIRING', expiresOn: '2026-11-30' }, capacity: { known: true, over: true, loadPct: '120.0' } })
    expect(warned.offered).toBe(true)
    expect(warned.warnings.map((warning) => warning.code)).toEqual(['CONDITIONAL', 'DURC_EXPIRING', 'OVER_CAPACITY'])
    expect(verdictOf({ ...base, durc: { checked: false, state: 'MISSING', expiresOn: null }, capacity: { known: false, over: false, loadPct: null } }).warnings.map((warning) => warning.code)).toEqual(['DURC_NOT_CHECKED', 'NO_CAPACITY_SET'])
  })
})

describe('the work sent out, kit timing, in-house or outside (PLN-164, PLN-165)', () => {
  const op = (seq: number, kind: string, extra: Partial<{ outsourced: boolean; outsideStep: boolean; remaining: number }> = {}) => ({ id: `op${seq}`, seq, name: `Op ${seq}`, workCentreKind: kind, outsourced: false, outsideStep: false, remaining: 10, ...extra })
  it('sends the outside steps, else the making', () => {
    expect(outsideWorkOf([op(10, 'CUTTING'), op(20, 'SEWING'), op(30, 'FINISHING'), op(40, 'PACKING')]).map((row) => row.seq)).toEqual([20, 30])
    expect(outsideWorkOf([op(10, 'CUTTING'), op(20, 'SEWING', { outsideStep: true }), op(30, 'FINISHING')]).map((row) => row.seq)).toEqual([20])
    expect(outsideWorkOf([op(20, 'SEWING', { remaining: 0 }), op(30, 'FINISHING')]).map((row) => row.seq)).toEqual([30])
  })
  it('says when the kit leaves and how long the work takes', () => {
    expect(kitWords({ workshop: 'Beta', shipOn: '2026-11-18', start: '2026-11-20', transportDays: 2, today: '2026-11-16' })).toEqual({ late: false, words: 'Send the kit on 2026-11-18: 2 transport days before the work starts at Beta on 2026-11-20.' })
    expect(kitWords({ workshop: 'Beta', shipOn: '2026-11-10', start: '2026-11-12', transportDays: 2, today: '2026-11-16' }).late).toBe(true)
    expect(workDaysOf({ amount: new Dec(1000), perWeek: 2400, routingDays: null, transportDays: 2 })).toEqual({ days: 3, source: 'CAPACITY' })
    expect(workDaysOf({ amount: null, perWeek: null, routingDays: 7, transportDays: 2 })).toEqual({ days: 3, source: 'ROUTING' })
    expect(workDaysOf({ amount: null, perWeek: null, routingDays: null, transportDays: 2 })).toEqual({ days: 1, source: 'DEFAULT' })
  })
  it('refuses a switch the work order or the order does not allow', () => {
    expect(outsideProblems({ number: 'WO-1', status: 'COMPLETED' }, { seq: 20, name: 'Sew', outsourced: false, remaining: 5 })[0]).toMatch(/completed/)
    expect(outsideProblems({ number: 'WO-1', status: 'RELEASED' }, { seq: 20, name: 'Sew', outsourced: true, remaining: 5 })[0]).toMatch(/outside already/)
    expect(outsideProblems({ number: 'WO-1', status: 'RELEASED' }, { seq: 20, name: 'Sew', outsourced: false, remaining: 5 })).toEqual([])
    expect(inHouseProblems({ number: 'WO-1', status: 'RELEASED' }, { seq: 20, name: 'Sew', outsourced: true }, { number: 'SC-1', status: 'AT_WORKSHOP', somethingOut: true })[0]).toMatch(/SC-1 are at the workshop/)
    expect(inHouseProblems({ number: 'WO-1', status: 'RELEASED' }, { seq: 20, name: 'Sew', outsourced: true }, { number: 'SC-1', status: 'DRAFT', somethingOut: false })).toEqual([])
    expect(inHouseProblems({ number: 'WO-1', status: 'RELEASED' }, { seq: 20, name: 'Sew', outsourced: false }, null)[0]).toMatch(/in-house already/)
  })
})

describe('the load heatmap (PLN-117)', () => {
  it('bands a cell and writes its number', () => {
    expect(['10.0', '70.0', '89.9', '90.0', '100.0', '100.1', null].map(heatBand)).toEqual(['LOW', 'MEDIUM', 'MEDIUM', 'HIGH', 'HIGH', 'OVER', 'UNKNOWN'])
    expect([cellText('112.4'), cellText(null)]).toEqual(['112%', '—'])
  })
  it('gives the permissions to the planner, the production manager and the buyer', () => {
    expect(PLANNING_SUBCONTRACT_PERMISSIONS).toEqual(['planning.subcontract.capacity', 'planning.subcontract.outsource'])
    expect(Object.keys(PLANNING_SUBCONTRACT_ADDS).sort()).toEqual(['buyer', 'planner', 'production_manager'])
  })
})
