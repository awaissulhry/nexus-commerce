import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import { VISIT_NEED_READER } from '../rolesheets/rules'
import { SAFETY_HEALTH_MANAGE, SAFETY_HEALTH_PERMISSIONS, SAFETY_HEALTH_PLANS, SAFETY_HEALTH_VIEW, SAFETY_HEALTH_VIEWS } from './permissions'
import {
  absenceRunsOf,
  automaticProposals,
  clinicalWordsIn,
  currentJudgement,
  fitYesNo,
  healthTiles,
  judgementProblems,
  judgementStateOf,
  returnVisitOf,
  roleChangeVisit,
  visitProblems,
  visitProposals,
  visitStateOf,
  type JudgementFacts,
  type PlanFacts,
} from './rules'

const TODAY = '2026-11-04'
const judgement = (over: Partial<JudgementFacts> & Pick<JudgementFacts, 'id'>): JudgementFacts => ({ employeeId: 'e1', outcome: 'FIT', judgedOn: '2026-01-10', expiresOn: null, unfitUntil: null, voided: false, createdAt: '2026-01-10T09:00:00.000Z', ...over })
const plan = (over: Partial<PlanFacts> = {}): PlanFacts => ({ planId: 'p1', roleSheetId: 'r1', needed: true, frequencyMonths: 12, endOfEmploymentVisit: false, doctorSet: true, ...over })

describe('nothing clinical (QHS-254; art. 41 c.6)', () => {
  it('finds the medical words that slip into a task limit, at the start of a word, in Italian and English', () => {
    expect(clinicalWordsIn('No lifting over 15 kg without help; ear defenders at the clicking press.')).toEqual([])
    expect(clinicalWordsIn('Use lifting aids; no operation of the press at night')).toEqual([])
    expect(clinicalWordsIn('Ernia del disco: niente sollevamento')).toEqual(['ernia'])
    expect(clinicalWordsIn('Because of DIABETES, breaks every 2 hours')).toEqual(['diabet'])
    expect(clinicalWordsIn('pregnancy: no solvents')).toEqual(['pregnan'])
    expect(clinicalWordsIn('Allergia al lattice: guanti in nitrile')).toEqual(['allergi'])
    expect(clinicalWordsIn(null)).toEqual([])
  })

  it('checks a judgement’s shape: limits only with fit with limits (and never a reason), an until-day only when temporarily unfit, unfit never expires', () => {
    expect(judgementProblems({ outcome: 'FIT_WITH_LIMITS', taskLimits: 'No lifting over 15 kg', judgedOn: TODAY, expiresOn: '2027-11-04', today: TODAY })).toEqual([])
    expect(judgementProblems({ outcome: 'FIT_WITH_LIMITS', taskLimits: '  ', judgedOn: TODAY, today: TODAY }).map((p) => p.path)).toEqual(['taskLimits'])
    const reason = judgementProblems({ outcome: 'FIT_WITH_LIMITS', taskLimits: 'Depression: no night shifts', judgedOn: TODAY, today: TODAY })
    expect(reason).toEqual([{ path: 'taskLimits', message: expect.stringContaining('Never the medical reason') }])
    expect(judgementProblems({ outcome: 'FIT', taskLimits: 'No lifting', judgedOn: TODAY, today: TODAY }).map((p) => p.path)).toEqual(['taskLimits'])
    expect(judgementProblems({ outcome: 'TEMPORARILY_UNFIT', judgedOn: TODAY, today: TODAY }).map((p) => p.path)).toEqual(['unfitUntil'])
    expect(judgementProblems({ outcome: 'TEMPORARILY_UNFIT', unfitUntil: TODAY, judgedOn: TODAY, today: TODAY }).map((p) => p.path)).toEqual(['unfitUntil'])
    expect(judgementProblems({ outcome: 'UNFIT', expiresOn: '2027-01-01', judgedOn: TODAY, today: TODAY }).map((p) => p.path)).toEqual(['expiresOn'])
    expect(judgementProblems({ outcome: 'FIT', judgedOn: '2026-11-05', today: TODAY }).map((p) => p.path)).toEqual(['judgedOn'])
    expect(judgementProblems({ outcome: 'FIT', judgedOn: TODAY, expiresOn: TODAY, today: TODAY }).map((p) => p.path)).toEqual(['expiresOn'])
  })

  it('a return visit carries the absence’s length only, above 60 days; no other visit carries one', () => {
    expect(visitProblems({ type: 'RETURN_AFTER_ABSENCE', absenceDays: 61 })).toEqual([])
    expect(visitProblems({ type: 'RETURN_AFTER_ABSENCE', absenceDays: 60 }).map((p) => p.path)).toEqual(['absenceDays'])
    expect(visitProblems({ type: 'RETURN_AFTER_ABSENCE' }, 'items/2').map((p) => p.path)).toEqual(['items/2/absenceDays'])
    expect(visitProblems({ type: 'PERIODIC', absenceDays: 70 }).map((p) => p.path)).toEqual(['absenceDays'])
  })
})

describe('judgements and fit yes or no (QHS-254; people.skills "fitness valid (yes / no only)")', () => {
  it('the person’s judgement is the newest not voided; the others are superseded, voided, expiring or expired', () => {
    const old = judgement({ id: 'j1', judgedOn: '2025-01-10' })
    const voided = judgement({ id: 'j2', judgedOn: '2026-10-01', voided: true })
    const sameDayLater = judgement({ id: 'j4', judgedOn: '2026-01-10', createdAt: '2026-01-10T15:00:00.000Z', expiresOn: '2026-11-20' })
    const sameDay = judgement({ id: 'j3', judgedOn: '2026-01-10' })
    const current = currentJudgement([old, voided, sameDay, sameDayLater])
    expect(current?.id).toBe('j4')
    expect(judgementStateOf(sameDayLater, 'j4', TODAY)).toBe('EXPIRING')
    expect(judgementStateOf(sameDay, 'j4', TODAY)).toBe('SUPERSEDED')
    expect(judgementStateOf(voided, 'j4', TODAY)).toBe('VOIDED')
    expect(judgementStateOf(judgement({ id: 'j5', expiresOn: '2026-11-03' }), 'j5', TODAY)).toBe('EXPIRED')
    expect(judgementStateOf(judgement({ id: 'j6', expiresOn: '2027-06-01' }), 'j6', TODAY)).toBe('IN_FORCE')
  })

  it('fit yes: fit or fit with limits, not expired; no: temporarily unfit, unfit, expired or none', () => {
    expect(fitYesNo({ outcome: 'FIT', expiresOn: null }, TODAY)).toBe(true)
    expect(fitYesNo({ outcome: 'FIT_WITH_LIMITS', expiresOn: TODAY }, TODAY)).toBe(true)
    expect(fitYesNo({ outcome: 'FIT', expiresOn: '2026-11-03' }, TODAY)).toBe(false)
    expect(fitYesNo({ outcome: 'TEMPORARILY_UNFIT', expiresOn: '2027-01-01' }, TODAY)).toBe(false)
    expect(fitYesNo({ outcome: 'UNFIT', expiresOn: null }, TODAY)).toBe(false)
    expect(fitYesNo(null, TODAY)).toBe(false)
  })
})

describe('the due list builds itself (QHS-253; art. 41 c.2)', () => {
  const plans = new Map([['r1', plan()], ['r2', plan({ planId: 'p2', roleSheetId: 'r2', needed: false, frequencyMonths: null })], ['r3', plan({ planId: 'p3', roleSheetId: 'r3', doctorSet: false })]])
  const person = (employeeId: string, roleSheetId = 'r1', startDate = '2020-01-01', roleSince = startDate) => ({ employeeId, roleSheetId, startDate, roleSince })

  it('proposes a visit before the task for a starter, one today for someone with nothing on file, a change of task after a role change, the periodic one, sooner at an expiry or the end of a temporary unfitness', () => {
    const proposals = visitProposals({
      today: TODAY,
      horizonDays: 60,
      people: [
        person('starter', 'r1', '2026-11-10'),
        person('nothing'),
        person('moved', 'r1', '2020-01-01', '2026-10-20'),
        person('periodic'),
        person('expires'),
        person('unfit'),
        person('open'),
        person('unfitForGood'),
        person('notNeeded', 'r2'),
        person('farAway'),
        person('noDoctor', 'r3'),
        // Visited before hiring (art. 41 c.2 e-bis): the role is the one they were hired for, not a change of task.
        person('preHire', 'r1', '2026-09-01'),
      ],
      plans,
      visits: [
        { employeeId: 'moved', type: 'PERIODIC', status: 'DONE', dueOn: '2026-03-01', doneOn: '2026-03-01' },
        { employeeId: 'periodic', type: 'PERIODIC', status: 'DONE', dueOn: '2025-12-01', doneOn: '2025-12-01' },
        { employeeId: 'open', type: 'PERIODIC', status: 'BOOKED', dueOn: '2026-11-20', bookedOn: '2026-11-20' },
        { employeeId: 'farAway', type: 'PERIODIC', status: 'DONE', dueOn: '2026-10-01', doneOn: '2026-10-01' },
        { employeeId: 'preHire', type: 'PREVENTIVE', status: 'DONE', dueOn: '2026-08-20', doneOn: '2026-08-20' },
      ],
      judgements: [
        judgement({ id: 'x', employeeId: 'expires', judgedOn: '2026-06-01', expiresOn: '2026-11-15' }),
        judgement({ id: 'y', employeeId: 'unfit', outcome: 'TEMPORARILY_UNFIT', judgedOn: '2026-10-01', unfitUntil: '2026-11-12', expiresOn: '2026-12-31' }),
        judgement({ id: 'z', employeeId: 'unfitForGood', outcome: 'UNFIT', judgedOn: '2026-01-01' }),
        judgement({ id: 'w', employeeId: 'noDoctor', judgedOn: '2025-10-01' }),
      ],
    })
    expect(proposals.map((p) => [p.employeeId, p.type, p.dueOn, p.why, p.doctorSet])).toEqual([
      ['moved', 'CHANGE_OF_TASK', '2026-10-20', 'ROLE_CHANGED', true],
      ['noDoctor', 'PERIODIC', '2026-10-01', 'PERIODIC', false],
      ['periodic', 'PERIODIC', '2026-12-01', 'PERIODIC', true],
      ['nothing', 'PREVENTIVE', TODAY, 'NOTHING_ON_FILE', true],
      ['starter', 'PREVENTIVE', '2026-11-10', 'STARTER', true],
      ['unfit', 'PERIODIC', '2026-11-12', 'UNFIT_ENDS', true],
      ['expires', 'PERIODIC', '2026-11-15', 'JUDGEMENT_EXPIRES', true],
    ].sort((a, b) => (a[2] === b[2] ? String(a[0]).localeCompare(String(b[0])) : String(a[2]) < String(b[2]) ? -1 : 1)))
    // Only the periodic ones of a plan the doctor set plan themselves.
    expect(automaticProposals(proposals).map((p) => p.employeeId).sort()).toEqual(['expires', 'periodic', 'unfit'])
  })

  it('a role change asks a visit only from a plan the doctor set: a starter before the task, a move a change of task, an old hand nothing by itself', () => {
    expect(roleChangeVisit({ fromRoleSheetId: 'r0', plan: plan(), startDate: '2010-01-01', today: TODAY })).toEqual({ type: 'CHANGE_OF_TASK', dueOn: TODAY })
    expect(roleChangeVisit({ fromRoleSheetId: null, plan: plan(), startDate: '2026-11-20', today: TODAY })).toEqual({ type: 'PREVENTIVE', dueOn: '2026-11-20' })
    expect(roleChangeVisit({ fromRoleSheetId: null, plan: plan(), startDate: '2026-10-25', today: TODAY })).toEqual({ type: 'PREVENTIVE', dueOn: TODAY })
    expect(roleChangeVisit({ fromRoleSheetId: null, plan: plan(), startDate: '2010-01-01', today: TODAY })).toBeNull()
    expect(roleChangeVisit({ fromRoleSheetId: 'r0', plan: plan({ doctorSet: false }), startDate: '2010-01-01', today: TODAY })).toBeNull()
    expect(roleChangeVisit({ fromRoleSheetId: 'r0', plan: plan({ needed: false, frequencyMonths: null }), startDate: '2010-01-01', today: TODAY })).toBeNull()
    expect(roleChangeVisit({ fromRoleSheetId: 'r0', plan: null, startDate: '2010-01-01', today: TODAY })).toBeNull()
  })

  it('an absence for health reasons over 60 continuous days asks a return visit the day after it ends; only its length travels', () => {
    const days: string[] = []
    for (let d = 0; d < 75; d++) {
      const day = new Date(Date.UTC(2026, 7, 20 + d))
      if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) days.push(day.toISOString().slice(0, 10))
    }
    const runs = absenceRunsOf([...days, '2026-01-05', '2026-01-06'])
    expect(runs.map((run) => [run.from, run.to, run.days])).toEqual([
      ['2026-01-05', '2026-01-06', 2],
      ['2026-08-20', '2026-11-02', 75],
    ])
    expect(returnVisitOf(runs[1]!, TODAY)).toEqual({ absenceDays: 75, dueOn: '2026-11-03' })
    expect(returnVisitOf(runs[0]!, TODAY)).toBeNull()
    expect(returnVisitOf({ from: '2026-01-01', to: '2026-03-31', days: 90 }, TODAY)).toBeNull()
    expect(Object.keys(returnVisitOf(runs[1]!, TODAY)!)).toEqual(['absenceDays', 'dueOn'])
  })

  it('states a visit for the due list and counts the tiles', () => {
    expect(visitStateOf({ status: 'DUE', dueOn: '2026-11-03' }, TODAY)).toBe('OVERDUE')
    expect(visitStateOf({ status: 'DUE', dueOn: '2026-12-01' }, TODAY)).toBe('DUE_SOON')
    expect(visitStateOf({ status: 'DUE', dueOn: '2027-02-01' }, TODAY)).toBe('PLANNED')
    expect(visitStateOf({ status: 'BOOKED', dueOn: '2026-11-01', bookedOn: '2026-11-14' }, TODAY)).toBe('BOOKED')
    expect(visitStateOf({ status: 'BOOKED', dueOn: '2026-11-30', bookedOn: '2026-11-02' }, TODAY)).toBe('OVERDUE')
    const tiles = healthTiles({
      today: TODAY,
      visits: [
        { employeeId: 'a', type: 'PERIODIC', status: 'DUE', dueOn: '2026-11-01' },
        { employeeId: 'b', type: 'RETURN_AFTER_ABSENCE', status: 'DUE', dueOn: '2026-11-10' },
        { employeeId: 'c', type: 'CHANGE_OF_TASK', status: 'BOOKED', dueOn: '2026-11-01', bookedOn: '2026-11-20' },
        { employeeId: 'd', type: 'PERIODIC', status: 'DONE', dueOn: '2026-11-01', doneOn: '2026-11-01' },
        { employeeId: 'e', type: 'PERIODIC', status: 'DUE', dueOn: '2027-03-01' },
      ],
      proposals: [{ type: 'PREVENTIVE' }, { type: 'PERIODIC' }],
      current: [
        { outcome: 'TEMPORARILY_UNFIT', unfitUntil: '2026-11-10' },
        { outcome: 'TEMPORARILY_UNFIT', unfitUntil: '2026-12-31' },
        { outcome: 'FIT', unfitUntil: null },
      ],
    })
    expect(tiles).toEqual({ overdue: 1, dueIn30: 2, beforeTask: 2, returnVisits: 1, unfitEnding: 1 })
  })
})

describe('the catalogues (QHS-256: HR and the doctor read; every view recorded)', () => {
  it('declares four write-risk permissions and gives them to HR, the doctor and the safety officer only, never read-only or the floor', () => {
    for (const name of SAFETY_HEALTH_PERMISSIONS) {
      expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
      expect(FACTORY_PERMISSIONS.get(name)?.risk).toBe('write')
    }
    const holders = (name: string) => ROLE_TEMPLATES.filter((template) => template.permissions.includes(name as never)).map((template) => template.key).sort()
    expect(holders(SAFETY_HEALTH_VIEW)).toEqual(['company_doctor', 'hr', 'owner'])
    expect(holders(SAFETY_HEALTH_MANAGE)).toEqual(['company_doctor', 'hr', 'owner'])
    expect(holders(SAFETY_HEALTH_PLANS)).toEqual(['company_doctor', 'owner', 'safety_officer'])
    expect(holders(SAFETY_HEALTH_VIEWS)).toEqual(['hr', 'owner'])
    // The role sheets' person-level visit (B-W2b-128) now follows the health readers.
    expect(VISIT_NEED_READER).toBe(SAFETY_HEALTH_VIEW)
  })

  it('declares the events with ids and states only', () => {
    const own = EVENT_DEFINITIONS.filter((event) => event.context === 'safety-health')
    expect(own.map((event) => event.type)).toEqual(['health_plan.changed', 'health_visit.changed', 'fitness_judgement.changed'])
    expect(own.find((event) => event.type === 'health_visit.changed')!.payload.safeParse({ visitId: '0190d6a2-6f3e-7c4b-9a2e-1b2c3d4e5f60', change: 'BOOKED', status: 'BOOKED', by: 'OFFICE', employeeId: '0190d6a2-6f3e-7c4b-9a2e-1b2c3d4e5f60' }).success).toBe(false)
  })
})
