import { describe, expect, it } from 'vitest'
import { confirmNameProblem, eraseReasonProblem, KEPT_WHY, KEPT_WHY_WORDS } from './erasure'
import { clockOf, dueAtOf, extendedDueOf, personRecordFits, requestActions, requestProblems, type RequestFacts } from './requests'
import { cutoffOf, isShortening, periodWords, ruleKey, ruleProblems, sweepModeOf } from './retention'

/** Data protection in depth (B-W2b-405; PLT-202, PLT-203, PLT-204): the pure rules the API and the database share. */

const HOUR = 3_600_000

describe('retention rules', () => {
  it('cut off a business day (Europe/Rome) less the months, a month end clamped as the database does', () => {
    expect(cutoffOf(new Date('2026-03-31T10:00:00Z'), 1)).toBe('2026-02-28')
    expect(cutoffOf(new Date('2028-03-31T10:00:00Z'), 1)).toBe('2028-02-29')
    expect(cutoffOf(new Date('2026-11-14T23:30:00Z'), 12)).toBe('2025-11-15') // already the 15th in Rome
    expect(cutoffOf(new Date('2026-01-15T12:00:00Z'), 120)).toBe('2016-01-15')
  })

  it('say the period in words, key the rule by type and company, and report until switched on', () => {
    expect([periodWords(1), periodWords(12), periodWords(30), periodWords(120)]).toEqual(['1 month', '1 year', '2 years and 6 months', '10 years'])
    expect(ruleKey('CronRun', null)).toBe('retention:CronRun:all')
    expect(ruleKey('Invoice', 'c-1')).toBe('retention:Invoice:c-1')
    expect(sweepModeOf({ applyOn: false })).toBe('REPORT')
    expect(sweepModeOf({ applyOn: true })).toBe('APPLY')
    expect(isShortening(24, 12)).toBe(true)
    expect(isShortening(12, 24)).toBe(false)
  })

  it('refuse a period out of range, an action the type does not take and a missing legal reason, in words', () => {
    expect(ruleProblems({ keepMonths: 12, thenAction: 'DELETE', legalReason: 'GDPR art. 5(1)(e)' }, ['DELETE'])).toEqual([])
    const problems = ruleProblems({ keepMonths: 0, thenAction: 'ANONYMISE', legalReason: ' ' }, ['DELETE'])
    expect(problems.map((problem) => problem.path)).toEqual(['keepMonths', 'thenAction', 'legalReason'])
    expect(ruleProblems({ keepMonths: 1201, thenAction: 'DELETE', legalReason: 'x'.repeat(1001) }, ['DELETE']).map((problem) => problem.path)).toEqual(['keepMonths', 'legalReason'])
    expect(ruleProblems({ keepMonths: 12, thenAction: 'DELETE', legalReason: 'kept' }, [])[0]!.message).toMatch(/kept: no sweep/)
  })
})

describe('data requests', () => {
  const received = new Date('2026-11-01T09:00:00Z')
  const base: RequestFacts = { kind: 'ACCESS', status: 'RECEIVED', dueAt: dueAtOf(received), extendedDueAt: null, identityCheckedAt: null, packageFileId: null, erasures: 0 }

  it('are due 720 hours after they came in; extended by one or two months of 720 hours; overdue only while open', () => {
    expect(dueAtOf(received).getTime() - received.getTime()).toBe(720 * HOUR)
    expect(extendedDueOf(dueAtOf(received), 2).getTime() - received.getTime()).toBe(2160 * HOUR)
    const late = new Date(received.getTime() + 721 * HOUR)
    expect(clockOf({ receivedAt: received, ...base }, late)).toMatchObject({ overdue: true, hoursLeft: -1, extended: false })
    expect(clockOf({ receivedAt: received, ...base, status: 'DONE' }, late).overdue).toBe(false)
  })

  it('name a person by the record of their kind; refuse one received in the future', () => {
    expect(personRecordFits('WORKER', 'Employee')).toBe(true)
    expect(personRecordFits('CONTACT', 'User')).toBe(false)
    expect(requestProblems({ receivedAt: new Date(received.getTime() + HOUR) }, received)[0]!.path).toBe('receivedAt')
  })

  it('move on in order: identity first, an access request done with its package, an erasure done once it ran', () => {
    const now = new Date(received.getTime() + HOUR)
    expect(requestActions(base, now).collect.held).toBe('NOT_STARTED')
    expect(requestActions(base, now).checkIdentity.allowed).toBe(true)
    const started: RequestFacts = { ...base, status: 'IN_PROGRESS', identityCheckedAt: now }
    expect(requestActions(started, now).checkIdentity.held).toBe('IDENTITY_CHECKED')
    expect(requestActions(started, now).collect.allowed).toBe(true)
    expect(requestActions(started, now).close.held).toBe('NO_PACKAGE')
    expect(requestActions({ ...started, packageFileId: 'f' }, now).close.allowed).toBe(true)
    const erasure: RequestFacts = { ...started, kind: 'ERASURE' }
    expect(requestActions(erasure, now).erase.allowed).toBe(true)
    expect(requestActions(erasure, now).close.held).toBe('NOT_ERASED')
    expect(requestActions({ ...erasure, erasures: 3 }, now).erase.held).toBe('ERASED')
    expect(requestActions({ ...started, status: 'DONE' }, now).refuse.held).toBe('CLOSED')
    expect(requestActions({ ...started, extendedDueAt: extendedDueOf(started.dueAt, 1) }, now).extend.held).toBe('EXTENDED')
    expect(requestActions(started, new Date(started.dueAt.getTime() + 1)).extend.held).toBe('TOO_LATE_TO_EXTEND')
  })
})

describe('erasure', () => {
  it('asks the name as shown (spaces and case aside) and a reason without the person', () => {
    expect(confirmNameProblem('  anna   BIANCHI ', 'Anna Bianchi')).toBeNull()
    expect(confirmNameProblem('Anna', 'Anna Bianchi')?.path).toBe('confirmName')
    expect(confirmNameProblem('', 'Anna Bianchi')?.path).toBe('confirmName')
    expect(eraseReasonProblem('no')?.path).toBe('reason')
    expect(eraseReasonProblem('Asked by mail on 3 November.')).toBeNull()
  })

  it('keeps with a reason in words the database takes (3-1000 characters), one sentence per code', () => {
    for (const code of KEPT_WHY) {
      expect(KEPT_WHY_WORDS[code].length).toBeGreaterThanOrEqual(3)
      expect(KEPT_WHY_WORDS[code].length).toBeLessThanOrEqual(1000)
    }
    expect(new Set(Object.values(KEPT_WHY_WORDS)).size).toBe(KEPT_WHY.length)
  })
})
