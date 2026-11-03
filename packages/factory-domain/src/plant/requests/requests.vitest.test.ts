import { describe, expect, it } from 'vitest'
import { depthEvents as events } from '../events'
import { H1_SETTINGS, lockDescription, lockRefusal, lockSettingsRefusal, loosens } from './lock'
import { duplicateGroups, groupWords, mergeNothing } from './merge'
import { floorAcknowledgeRefusal, onTheWayRefusal, progressOf, worksAgainRefusal, type ProgressFacts } from './progress'
import { DEPTH_REFUSALS } from './refusals'
import { escalatedAtOf, escalationDue, orderRefusal, pickRule, routingOf, routingWords, ruleProblems } from './routing'
import { PLANT_REFUSALS } from '../rules'

/** B-W2b-96: the requests in depth (QHS-179, QHS-180, QHS-181, QHS-183), pure. Every id and name is made up. */

const at = (minute: number) => new Date(Date.UTC(2026, 10, 21, 8, minute))
const rule = (over: Partial<Parameters<typeof pickRule>[0][number]> & { id: string; seq: number }) => ({ machineClassId: null, active: true, ...over })

describe('routing (QHS-179)', () => {
  it('picks the first active rule by seq then id, for the class or every class', () => {
    const rules = [rule({ id: 'b', seq: 1 }), rule({ id: 'a', seq: 0, machineClassId: 'sew' }), rule({ id: 'c', seq: 0, machineClassId: 'press', active: false })]
    expect(pickRule(rules, 'sew')?.id).toBe('a')
    expect(pickRule(rules, 'press')?.id).toBe('b')
    expect(pickRule([rule({ id: 'x', seq: 0, machineClassId: 'sew' })], 'press')).toBeNull()
    expect(pickRule([rule({ id: 'z', seq: 0 }), rule({ id: 'y', seq: 0 })], 'any')?.id).toBe('y')
  })

  it('keeps the team or the technician the rule names; no rule: nothing', () => {
    expect(routingOf({ id: 'r', teamId: 't', technicianId: null })).toEqual({ routingRuleId: 'r', routedTeamId: 't', routedEmployeeId: null })
    expect(routingOf({ id: 'r', teamId: null, technicianId: 'e' })).toEqual({ routingRuleId: 'r', routedTeamId: null, routedEmployeeId: 'e' })
    expect(routingOf(null)).toEqual({ routingRuleId: null, routedTeamId: null, routedEmployeeId: null })
  })

  it('a rule names exactly one target and its escalations whole, the second later than the first', () => {
    expect(ruleProblems({ teamId: 't' })).toEqual([])
    expect(ruleProblems({}).map((problem) => problem.path)).toEqual(['teamId'])
    expect(ruleProblems({ teamId: 't', technicianId: 'e' }).map((problem) => problem.path)).toEqual(['technicianId'])
    expect(ruleProblems({ teamId: 't', escalateAfterMinutes: 10 }).map((problem) => problem.path)).toEqual(['escalateToId'])
    expect(ruleProblems({ teamId: 't', escalateAfterMinutes: 0, escalateToId: 'e' }).map((problem) => problem.path)).toEqual(['escalateAfterMinutes'])
    expect(ruleProblems({ teamId: 't', escalateAgainAfterMinutes: 30, escalateAgainToId: 'f' }).map((problem) => problem.path)).toEqual(['escalateAgainAfterMinutes'])
    expect(ruleProblems({ teamId: 't', escalateAfterMinutes: 30, escalateToId: 'e', escalateAgainAfterMinutes: 30, escalateAgainToId: 'f' }).map((problem) => problem.message)).toEqual(['The second escalation comes later than the first.'])
  })

  it('escalates a NEW, unacknowledged request by its active rule, to the highest level due, never down', () => {
    const r = { active: true, escalateAfterMinutes: 10, escalateToId: 'e2', escalateAgainAfterMinutes: 30, escalateAgainToId: 'e3' }
    const request = { status: 'NEW', acknowledgedAt: null, reportedAt: at(0), escalationLevel: 0, escalatedAt: null }
    expect(escalationDue(request, r, at(9))).toBeNull()
    expect(escalationDue(request, r, at(10))).toEqual({ level: 1, toId: 'e2', dueAt: at(10) })
    expect(escalationDue(request, r, at(31))).toEqual({ level: 2, toId: 'e3', dueAt: at(30) })
    expect(escalationDue({ ...request, escalationLevel: 1, escalatedAt: at(10) }, r, at(20))).toBeNull()
    expect(escalationDue({ ...request, acknowledgedAt: at(5) }, r, at(31))).toBeNull()
    expect(escalationDue({ ...request, status: 'JOB_MADE' }, r, at(31))).toBeNull()
    expect(escalationDue(request, { ...r, active: false }, at(31))).toBeNull()
    expect(escalatedAtOf(at(10), at(10)).getTime()).toBe(at(10).getTime() + 1)
  })

  it('says the worked example in words, and the full order of the rules', () => {
    expect(routingWords({ symptom: 'Thread breaks', machineClass: 'Lockstitch', site: 'A1', target: 'L1-A Line 1 team', escalate: { minutes: 10, to: 'Supervisor' }, again: { minutes: 30, to: 'Lead' } })).toBe(
      'A thread breaks request on a lockstitch at A1 goes to L1-A Line 1 team; not acknowledged in 10 min → Supervisor; in 30 min → Lead.',
    )
    expect(routingWords({ symptom: null, machineClass: 'Press', site: 'A1', target: null, escalate: null, again: null })).toContain('no rule matches')
    expect(orderRefusal(['a', 'b'], ['b', 'a'])).toBeNull()
    expect(orderRefusal(['a', 'b'], ['a'])?.code).toBe('ORDER_INCOMPLETE')
    expect(orderRefusal(['a', 'b'], ['a', 'a'])?.code).toBe('ORDER_INCOMPLETE')
  })
})

const facts = (over: Partial<ProgressFacts> = {}): ProgressFacts => ({
  status: 'NEW',
  acknowledgedAt: null,
  onTheWayAt: null,
  confirmedWorksAt: null,
  closedAt: null,
  job: null,
  unsafe: false,
  signedSafeAt: null,
  target: null,
  ...over,
})

describe('the requester sees progress (QHS-180)', () => {
  it('moves reported → acknowledged → on the way → fixed (the job handed back) → works', () => {
    expect(progressOf(facts()).step).toBe('REPORTED')
    expect(progressOf(facts({ status: 'ACKNOWLEDGED', acknowledgedAt: at(1) })).step).toBe('ACKNOWLEDGED')
    expect(progressOf(facts({ status: 'JOB_MADE', acknowledgedAt: at(1), onTheWayAt: at(2), job: { status: 'IN_PROGRESS', handedBackAt: null } })).step).toBe('ON_THE_WAY')
    const fixed = progressOf(facts({ status: 'JOB_MADE', acknowledgedAt: at(1), job: { status: 'HANDED_BACK', handedBackAt: at(20) } }))
    expect(fixed).toMatchObject({ step: 'FIXED', fixedAt: at(20), canConfirm: true })
    expect(progressOf(facts({ status: 'JOB_MADE', job: { status: 'CLOSED', handedBackAt: at(20) }, confirmedWorksAt: at(25) }))).toMatchObject({ step: 'WORKS', canConfirm: false })
  })

  it('a merged request follows the one it joined; a closed one has nothing to confirm; a lock waits for its sign-safe', () => {
    const target = { status: 'JOB_MADE', acknowledgedAt: at(1), onTheWayAt: at(2), confirmedWorksAt: null, closedAt: null, job: { status: 'HANDED_BACK', handedBackAt: at(20) } }
    expect(progressOf(facts({ status: 'MERGED', closedAt: at(3), target }))).toMatchObject({ step: 'FIXED', acknowledgedAt: at(1), onTheWayAt: at(2), canConfirm: true })
    expect(progressOf(facts({ status: 'MERGED', target: { ...target, job: { status: 'IN_PROGRESS', handedBackAt: null } } })).canConfirm).toBe(false)
    const closed = progressOf(facts({ status: 'CLOSED', closedAt: at(4) }))
    expect(closed).toMatchObject({ closedWithoutJob: true, canConfirm: false })
    expect(worksAgainRefusal(closed, 'SEW-1')?.code).toBe('CLOSED_WITHOUT_JOB')
    const locked = progressOf(facts({ status: 'JOB_MADE', unsafe: true, job: { status: 'HANDED_BACK', handedBackAt: at(20) } }))
    expect(locked.canConfirm).toBe(false)
    expect(worksAgainRefusal(locked, 'SEW-1')?.message).toContain('signed it safe')
    expect(worksAgainRefusal(progressOf(facts({ status: 'JOB_MADE', job: { status: 'IN_PROGRESS', handedBackAt: null } })), 'SEW-1')?.code).toBe('NOT_FIXED_YET')
    expect(worksAgainRefusal(progressOf(facts({ status: 'JOB_MADE', confirmedWorksAt: at(30), job: { status: 'CLOSED', handedBackAt: at(20) } })), 'SEW-1')?.code).toBe('WORKS_CONFIRMED')
  })

  it('acknowledges a NEW request once; on the way once, from NEW, ACKNOWLEDGED or JOB_MADE', () => {
    expect(floorAcknowledgeRefusal({ status: 'NEW', acknowledgedAt: null })).toBeNull()
    expect(floorAcknowledgeRefusal({ status: 'ACKNOWLEDGED', acknowledgedAt: at(1) })?.code).toBe('ALREADY_ACKNOWLEDGED')
    expect(onTheWayRefusal({ status: 'NEW', onTheWayAt: null })).toBeNull()
    expect(onTheWayRefusal({ status: 'JOB_MADE', onTheWayAt: null })).toBeNull()
    expect(onTheWayRefusal({ status: 'JOB_MADE', onTheWayAt: at(2) })?.code).toBe('ON_THE_WAY_ALREADY')
    expect(onTheWayRefusal({ status: 'MERGED', onTheWayAt: null })?.code).toBe('NOT_ON_THE_WAY_NOW')
  })
})

describe('triage and merge (QHS-181)', () => {
  it('groups two or more open requests of a machine and suggests the open job, else the lock, else the oldest', () => {
    const open = [
      { id: 'r1', machineId: 'm1', reportedAt: at(0), locking: false },
      { id: 'r2', machineId: 'm1', reportedAt: at(20), locking: true },
      { id: 'r3', machineId: 'm2', reportedAt: at(5), locking: false },
      { id: 'r4', machineId: 'm3', reportedAt: at(6), locking: false },
      { id: 'r5', machineId: 'm3', reportedAt: at(7), locking: false },
    ]
    const groups = duplicateGroups(open, new Map([['m3', 'job-3']]))
    expect(groups.map((group) => group.machineId)).toEqual(['m1', 'm3'])
    expect(groups[0]).toMatchObject({ requestIds: ['r1', 'r2'], withinMinutes: 20, suggested: { kind: 'REQUEST', requestId: 'r2' } })
    expect(groups[1]!.suggested).toEqual({ kind: 'JOB', jobId: 'job-3' })
    expect(groupWords(3, 'Lockstitch L2-07', 20)).toBe('3 requests on Lockstitch L2-07 in 20 min')
    expect(mergeNothing(0)?.code).toBe('MERGE_NOTHING')
    expect(mergeNothing(2)).toBeNull()
  })
})

describe('the unsafe lock (QHS-183; Owner answer H1)', () => {
  it('holds H1: other choices are refused in words; switching the hazard report off loosens', () => {
    expect(lockSettingsRefusal(H1_SETTINGS)).toBeNull()
    expect(lockSettingsRefusal({ ...H1_SETTINGS, hazardReportOnLock: false })).toBeNull()
    expect(lockSettingsRefusal({ ...H1_SETTINGS, lockBy: 'LEADS_AND_TECHNICIANS' })?.code).toBe('H1_HELD')
    expect(lockSettingsRefusal({ ...H1_SETTINGS, signSafeBy: 'TECHNICIANS_AND_SAFETY_OFFICER' })?.message).toContain('only a technician')
    expect(loosens(H1_SETTINGS, { ...H1_SETTINGS, hazardReportOnLock: false })).toBe(true)
    expect(loosens({ ...H1_SETTINGS, hazardReportOnLock: false }, H1_SETTINGS)).toBe(false)
  })

  it('anyone locks under H1; leads and technicians only under the other choice', () => {
    expect(lockRefusal({ lockBy: 'ANYONE_AT_STATION' }, { lead: false, technician: false })).toBeNull()
    expect(lockRefusal({ lockBy: 'LEADS_AND_TECHNICIANS' }, { lead: false, technician: false })?.code).toBe('LOCK_NOT_ALLOWED')
    expect(lockRefusal({ lockBy: 'LEADS_AND_TECHNICIANS' }, { lead: true, technician: false })).toBeNull()
    expect(lockDescription('Guard missing', 'front guard off')).toBe('Locked as unsafe from the office after the report "Guard missing": front guard off')
    expect(lockDescription(null, null)).toBe('Locked as unsafe from the office')
  })
})

describe('the catalogues', () => {
  it('declares the five events of the plant, ids and states only', () => {
    expect(events.map((event) => event.type)).toEqual(['maintenance_request.escalated', 'maintenance_request.progressed', 'maintenance_request.locked', 'maintenance_job.confirmed', 'plant_settings.changed'])
    expect(events.every((event) => event.context === 'plant')).toBe(true)
  })

  it('keeps its refusal codes apart from W2a’s (the Office screens mirror W2a’s list word for word)', () => {
    expect(DEPTH_REFUSALS.filter((code) => (PLANT_REFUSALS as readonly string[]).includes(code))).toEqual([])
    expect(new Set(DEPTH_REFUSALS).size).toBe(DEPTH_REFUSALS.length)
  })
})
