import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS, FLOOR_SHARED_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { abcClassesOf, itemsOfClass } from './abc'
import { INVENTORY_COUNTS_SCAN } from './permissions'
import { alreadyScanned, binDifferences, finishWrites, passOf, recountByAnotherProblem, recountsToAsk, scanQuantityProblem, type BinLine, type ScanFacts } from './scans'
import { countCovers, dueStateOf, dueThisWeek, nextDueAfter, scheduleProblems } from './schedules'
import { offReasonProblem, ownVarianceProblems, receiverProblem, separationInForce, separationLoosened } from './separation'
import { Dec } from '../../tax/decimal'

const line = (over: Partial<BinLine> & Pick<BinLine, 'id' | 'seq'>): BinLine => ({
  origin: 'SNAPSHOT',
  hideId: null,
  countedById: null,
  expected: '10.0000',
  counted: null,
  recountRequested: false,
  recount: null,
  ...over,
})

describe('count schedules (SCM-227)', () => {
  it('needs a scope, a name and 1 to 366 days', () => {
    expect(scheduleProblems({ name: ' ', locationId: null, abcClass: null, itemKind: null, everyDays: 0, nextDueOn: '2026-13-01' }).map((issue) => issue.path)).toEqual(['body/name', 'body/locationId', 'body/everyDays', 'body/nextDueOn'])
    expect(scheduleProblems({ name: 'Class A weekly', locationId: null, abcClass: 'A', itemKind: null, everyDays: 7, nextDueOn: null })).toEqual([])
  })
  it('moves the next date from the day a count closed', () => {
    expect(nextDueAfter('2026-11-12', 30)).toBe('2026-12-12')
  })
  it('says how due a schedule is, and what the week tile counts', () => {
    expect(dueStateOf({ active: true, nextDueOn: '2026-11-10' }, '2026-11-12')).toEqual({ state: 'OVERDUE', overdueDays: 2, inDays: -2 })
    expect(dueStateOf({ active: true, nextDueOn: '2026-11-12' }, '2026-11-12').state).toBe('DUE_TODAY')
    expect(dueStateOf({ active: true, nextDueOn: '2026-11-18' }, '2026-11-12').state).toBe('DUE_SOON')
    expect(dueStateOf({ active: true, nextDueOn: '2026-11-19' }, '2026-11-12').state).toBe('LATER')
    expect(dueThisWeek({ active: false, nextDueOn: '2026-11-01' }, '2026-11-12')).toBe(false)
  })
  it('a closed count covers a schedule when it counted every stock key the schedule held', () => {
    const key = (locationId: string, itemId: string) => ({ locationId, itemId, itemColourId: null, lotId: null, hideId: null })
    expect(countCovers([key('L1', 'I1'), key('L1', 'I2')], [key('L1', 'I1'), key('L1', 'I2'), key('L2', 'I3')], false)).toBe(true)
    expect(countCovers([key('L1', 'I1'), key('L1', 'I2')], [key('L1', 'I1')], true)).toBe(false)
    expect(countCovers([], [], true)).toBe(true)
    expect(countCovers([], [key('L9', 'I9')], false)).toBe(false)
  })
})

describe('ABC classes', () => {
  it('ranks by the value used: A to 80 %, B to 95 %, C the rest and what used nothing', () => {
    const classes = abcClassesOf([
      { itemId: 'a', code: 'A', value: '700' },
      { itemId: 'b', code: 'B', value: '200' },
      { itemId: 'c', code: 'C', value: '60' },
      { itemId: 'd', code: 'D', value: '40' },
      { itemId: 'e', code: 'E', value: '0' },
    ])
    expect(classes.map((entry) => [entry.itemId, entry.abcClass])).toEqual([['a', 'A'], ['b', 'A'], ['c', 'B'], ['d', 'C'], ['e', 'C']])
    expect(classes[0]!.sharePercent).toBe('70.0')
    expect([...itemsOfClass(classes, 'B')]).toEqual(['c'])
    expect(abcClassesOf([{ itemId: 'x', code: 'X', value: '0' }])[0]).toEqual({ itemId: 'x', abcClass: 'C', rank: 1, sharePercent: null })
  })
})

describe('counting by scan (SCM-228, SCM-229)', () => {
  const lines = [line({ id: 'l1', seq: 10 }), line({ id: 'l2', seq: 20, expected: '5.0000' }), line({ id: 'l3', seq: 30, origin: 'ADDED', expected: '0.0000' }), line({ id: 'l4', seq: 40, counted: '3.0000' })]
  const scans: ScanFacts[] = [
    { lineId: 'l1', pass: 'COUNT', quantity: '4.0000', code: 'HIDE-1' },
    { lineId: 'l1', pass: 'COUNT', quantity: '6.0000', code: 'HIDE-2' },
    { lineId: 'l3', pass: 'COUNT', quantity: '2.0000', code: null },
  ]
  it('scans a line in its pass, and a tag once per pass', () => {
    expect(passOf({ counted: null, recountRequested: false, recount: null })).toBe('COUNT')
    expect(passOf({ counted: '1', recountRequested: true, recount: null })).toBe('RECOUNT')
    expect(passOf({ counted: '1', recountRequested: false, recount: null })).toBeNull()
    expect(alreadyScanned(scans, 'hide-1', 'COUNT')).toBe(true)
    expect(alreadyScanned(scans, 'hide-1', 'RECOUNT')).toBe(false)
    expect(alreadyScanned(scans, null, 'COUNT')).toBe(false)
  })
  it('Bin done shows what matches, is missing and is extra; a counted line is not in it', () => {
    expect(binDifferences(lines, scans).map((entry) => [entry.seq, entry.kind, entry.scanned, entry.scans])).toEqual([
      [10, 'MATCH', '10.0000', 2],
      [20, 'MISSING', '0.0000', 0],
      [30, 'EXTRA', '2.0000', 1],
    ])
  })
  it('Finish bin writes each line as the sum of its scans (0 when none)', () => {
    expect(finishWrites(lines, scans)).toEqual([
      { lineId: 'l1', pass: 'COUNT', quantity: '10.0000' },
      { lineId: 'l2', pass: 'COUNT', quantity: '0.0000' },
      { lineId: 'l3', pass: 'COUNT', quantity: '2.0000' },
    ])
  })
  it('asks a recount over the rule: something found where nothing was expected, a hide that differs, over 5 %', () => {
    const finished = [
      { id: 'ok', hideId: null, expected: '100', counted: '96', recountRequested: false, recount: null },
      { id: 'over', hideId: null, expected: '100', counted: '90', recountRequested: false, recount: null },
      { id: 'found', hideId: null, expected: '0', counted: '2', recountRequested: false, recount: null },
      { id: 'hide', hideId: 'h', expected: '4', counted: '0', recountRequested: false, recount: null },
      { id: 'asked', hideId: null, expected: '100', counted: '50', recountRequested: true, recount: null },
    ]
    expect(recountsToAsk(finished)).toEqual(['over', 'found', 'hide'])
  })
  it('a recount is another person’s while the switch is on', () => {
    const counters = [{ userId: null, workerId: 'w1' }]
    expect(recountByAnotherProblem({ switchOn: true, seq: 10, scanner: { userId: null, workerId: 'w1' }, counters })?.code).toBe('OWN_RECOUNT')
    expect(recountByAnotherProblem({ switchOn: true, seq: 10, scanner: { userId: null, workerId: 'w2' }, counters })).toBeNull()
    expect(recountByAnotherProblem({ switchOn: false, seq: 10, scanner: { userId: null, workerId: 'w1' }, counters })).toBeNull()
  })
  it('a unit holds something, a hide at most its measured area', () => {
    expect(scanQuantityProblem(null, null)).toMatch(/number pad/)
    expect(scanQuantityProblem(new Dec('0'), null)).toMatch(/above 0/)
    expect(scanQuantityProblem(new Dec('5.5'), '5.0000')).toMatch(/at most 5.0000/)
    expect(scanQuantityProblem(new Dec('5'), '5.0000')).toBeNull()
  })
})

describe('separation of duties (SCM-293)', () => {
  it('reads the company row, then the tenant row, then on', () => {
    const tenant = { counterNotApprover: false, receiverNotMatcher: null, separationOffReason: 'small site' }
    const inForce = separationInForce({ counterNotApprover: null, receiverNotMatcher: true, separationOffReason: null }, tenant)
    expect(inForce).toEqual({ COUNTER_NOT_APPROVER: { on: false, source: 'TENANT' }, RECEIVER_NOT_MATCHER: { on: true, source: 'COMPANY' } })
    expect(separationInForce(undefined, null).COUNTER_NOT_APPROVER).toEqual({ on: true, source: 'DEFAULT' })
    expect(separationLoosened(separationInForce(null, null), inForce)).toEqual(['COUNTER_NOT_APPROVER'])
    expect(offReasonProblem('  ')).toMatch(/reason/)
  })
  it('the counter never approves their own variance (scans too), unless the switch is off', () => {
    const lines = [{ seq: 10, expected: '10', counted: '8', recountRequested: false, recount: null, countedById: null, recountedById: null, scannedByUserIds: ['u1'] }]
    expect(ownVarianceProblems({ switchOn: true, approvalRequired: true, approverId: 'u1', lines })[0]?.code).toBe('OWN_VARIANCE')
    expect(ownVarianceProblems({ switchOn: false, approvalRequired: true, approverId: 'u1', lines })).toEqual([])
    expect(ownVarianceProblems({ switchOn: true, approvalRequired: true, approverId: 'u2', lines })).toEqual([])
  })
  it('the receiver never approves their invoice while on', () => {
    expect(receiverProblem({ switchOn: true, personId: 'u1', receiverIds: ['u1'], number: 'F-1', acting: 'APPROVE' })?.code).toBe('RECEIVED_THE_GOODS')
    expect(receiverProblem({ switchOn: false, personId: 'u1', receiverIds: ['u1'], number: 'F-1', acting: 'APPROVE' })).toBeNull()
  })
})

describe('the scan permission', () => {
  it('is declared, shared with the floor and held by the warehouse, the operator and the team leader', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(INVENTORY_COUNTS_SCAN)).toBe(true)
    expect(FLOOR_SHARED_PERMISSIONS).toContain(INVENTORY_COUNTS_SCAN)
    for (const key of ['warehouse', 'operator', 'team_leader']) expect(templateOf(key)?.permissions).toContain(INVENTORY_COUNTS_SCAN)
    expect(templateOf('technician')?.permissions).not.toContain(INVENTORY_COUNTS_SCAN)
  })
})
