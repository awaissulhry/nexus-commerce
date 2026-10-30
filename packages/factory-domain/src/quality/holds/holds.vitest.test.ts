import { describe, expect, it } from 'vitest'
import {
  ageDays,
  blockedWords,
  holdPreviewWords,
  isOverdue,
  placedByKind,
  placeProblems,
  releasable,
  releaseChecks,
  releaseRefusal,
  releaseStatement,
  unholdableWords,
  workOrderHoldMove,
  workOrderHoldReason,
  workOrderOnHoldWords,
  type ReleaseFacts,
} from './rules'

const paths = (issues: readonly { path: string }[]) => issues.map((issue) => issue.path)
const base: ReleaseFacts = { status: 'ACTIVE', subjectType: 'Lot', placedByReleaser: false, madeBy: null, makersUnnamed: false, notMakerStatement: false, crViOpen: null, reinspectionOpen: null }

describe('placing a hold (QHS-074)', () => {
  it('one or more records, each once; the source both or neither; a release date from today; quarantine only for stock', () => {
    expect(placeProblems({ subjectType: 'Lot', subjectIds: ['a'], reasonCode: 'QUALITY_CHECK' }, '2026-11-21')).toEqual([])
    expect(paths(placeProblems({ subjectType: 'Lot', subjectIds: [], reasonCode: 'X' }, '2026-11-21'))).toEqual(['subjectIds'])
    expect(paths(placeProblems({ subjectType: 'Lot', subjectIds: ['a', 'a'], reasonCode: 'X' }, '2026-11-21'))).toEqual(['subjectIds'])
    expect(paths(placeProblems({ subjectType: 'Lot', subjectIds: ['a'], reasonCode: 'X', sourceType: 'Inspection' }, '2026-11-21'))).toEqual(['sourceType'])
    expect(paths(placeProblems({ subjectType: 'Lot', subjectIds: ['a'], reasonCode: 'X', sourceType: 'Email', sourceId: 'x' }, '2026-11-21'))).toEqual(['sourceType'])
    expect(paths(placeProblems({ subjectType: 'WorkOrder', subjectIds: ['a'], reasonCode: 'X', expectedReleaseOn: '2026-11-20', askQuarantine: true }, '2026-11-21'))).toEqual(['expectedReleaseOn', 'askQuarantine'])
    expect(placeProblems({ subjectType: 'Lot', subjectIds: Array.from({ length: 101 }, (_, index) => String(index)), reasonCode: 'X' }, '2026-11-21')[0]!.message).toMatch(/At most 100/)
  })

  it('refuses what the guard refuses, in words', () => {
    expect(unholdableWords('Lot', { label: 'L-1', state: 'QUARANTINE' })).toBeNull()
    expect(unholdableWords('Lot', { label: 'L-1', state: 'REJECTED' })).toMatch(/rejected/)
    expect(unholdableWords('Hide', { label: 'H-1', state: 'CONSUMED' })).toMatch(/used up/)
    expect(unholdableWords('WorkOrder', { label: 'WO-1', state: 'COMPLETED' })).toBeNull()
    expect(unholdableWords('WorkOrder', { label: 'WO-1', state: 'CLOSED' })).toMatch(/hold its garments/)
    expect(unholdableWords('Bundle', { label: 'B-1', state: 'VOID' })).toMatch(/only an active bundle/)
    expect(unholdableWords('GarmentSerial', { label: 'S-1', state: 'SHIPPED' })).toMatch(/PPE register/)
    expect(unholdableWords('Shipment', { label: 'SH-1', state: 'PACKED' })).toBeNull()
  })

  it('puts a work order ON_HOLD from DRAFT, RELEASED or IN_PROGRESS (MES-008)', () => {
    expect(workOrderHoldMove('DRAFT')).toBe('HOLD')
    expect(workOrderHoldMove('IN_PROGRESS')).toBe('HOLD')
    expect(workOrderHoldMove('ON_HOLD')).toBe('ALREADY')
    expect(workOrderHoldMove('COMPLETED')).toBe('KEEP')
    expect(workOrderHoldMove('CANCELLED')).toBe('REFUSED')
    expect(workOrderHoldReason('Quality check', ' wrong leather lot ')).toBe('Quality check: wrong leather lot')
    expect(workOrderHoldReason('Quality check', 'x'.repeat(400)).length).toBe(200)
  })

  it('previews and refuses in words', () => {
    expect(holdPreviewWords('Lot', 3, '412.0000 DM2')).toBe('Blocks issuing and cutting of 3 lots (412.0000 DM2).')
    expect(holdPreviewWords('WorkOrder', 1, '30 garments')).toBe('Blocks issuing, cutting, scanning, releasing, packing and shipping of 1 work order (30 garments).')
    expect(blockedWords({ holdId: 'h', subjectType: 'Bundle', label: 'B-0001', reason: 'Quality check', placedAt: '2026-11-21T09:10:00.000Z' }, 'it is not scanned')).toBe(
      'Bundle B-0001 is on hold (Quality check, since 21 Nov 2026): it is not scanned until quality releases the hold.',
    )
    expect(workOrderOnHoldWords('WO-0142', 'Quality check: wrong lot', 'its bundles are not scanned')).toBe('Work order WO-0142 is on hold (Quality check: wrong lot): its bundles are not scanned until the hold is lifted.')
  })
})

describe('releasing a hold', () => {
  it('never by who placed it (the design\'s four-eyes line)', () => {
    const checks = releaseChecks({ ...base, placedByReleaser: true })
    expect(releasable(checks)).toBe(false)
    expect(releaseRefusal(checks)?.words).toBe('You placed this hold - another person must release it.')
    expect(releasable(releaseChecks(base))).toBe(true)
  })

  it('held garments: never by a maker; the signed statement where the floor names stations only', () => {
    expect(releaseRefusal(releaseChecks({ ...base, subjectType: 'WorkOrder', madeBy: ['WO-0001'] }))?.key).toBe('NOT_MAKER')
    expect(releaseRefusal(releaseChecks({ ...base, subjectType: 'WorkOrder', madeBy: [], makersUnnamed: true }))?.key).toBe('STATEMENT')
    expect(releasable(releaseChecks({ ...base, subjectType: 'WorkOrder', madeBy: [], makersUnnamed: true, notMakerStatement: true }))).toBe(true)
  })

  it('the source\'s conditions: Cr VI PASS, a passed re-inspection; an ended hold', () => {
    expect(releaseRefusal(releaseChecks({ ...base, crViOpen: ['LEA-01 PENDING'] }))?.words).toBe('Cr VI result PASS (now: LEA-01 PENDING).')
    expect(releaseRefusal(releaseChecks({ ...base, subjectType: 'WorkOrder', madeBy: [], reinspectionOpen: ['WO-0001'] }))?.words).toBe('Re-inspection signed (now: missing for WO-0001).')
    expect(releaseRefusal(releaseChecks({ ...base, status: 'RELEASED' }))?.key).toBe('ACTIVE')
  })

  it('signs a statement of the hold, the goods, who, when and the checks', () => {
    const text = releaseStatement({ holdId: 'h1', subjectType: 'Lot', subjectIds: ['b', 'a'], releasedBy: 'user u1', releasedAt: '2026-11-22T10:00:00.000Z', checks: releaseChecks(base), note: null })
    expect(text.split('\n').slice(0, 3)).toEqual(['Release of quality hold h1', 'Lot: a, b', 'By user u1 at 2026-11-22T10:00:00.000Z'])
    expect(text).toContain('OK NOT_PLACER')
  })
})

describe('the list', () => {
  it('age, overdue and who placed it', () => {
    expect(ageDays('2026-11-21T09:00:00.000Z', null, '2026-11-24T08:00:00.000Z')).toBe(2)
    expect(ageDays('2026-11-21T09:00:00.000Z', '2026-11-22T09:00:00.000Z', '2026-12-24T08:00:00.000Z')).toBe(1)
    expect(isOverdue({ status: 'ACTIVE', expectedReleaseOn: '2026-11-20' }, '2026-11-21')).toBe(true)
    expect(isOverdue({ status: 'RELEASED', expectedReleaseOn: '2026-11-20' }, '2026-11-21')).toBe(false)
    expect(placedByKind({ placedById: null, placedByWorkerId: null })).toBe('SYSTEM')
    expect(placedByKind({ placedById: null, placedByWorkerId: 'w' })).toBe('WORKER')
  })
})
