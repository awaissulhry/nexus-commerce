import { describe, expect, it } from 'vitest'
import { businessDayStart } from '../../core/time'
import { eightDFingerprintText, eightDReport, type EightDInput } from './report'
import {
  actionDraftProblems,
  addDays,
  capaDraftProblems,
  closeChecks,
  complaintReasons,
  escalationDue,
  escalationTask,
  firstStage,
  lastStage,
  moveProblem,
  ncrReasons,
  nextStage,
  overdueFrom,
  reminderDue,
  reminderMoments,
  reminderTask,
  teamProblems,
} from './rules'

/** B-W2b-108: the CAPA and 8D rules (stages, close, shape, reminders, escalation, why escalate) and the 8D report's words. */

const U1 = '00000000-0000-4000-8000-000000000001'
const U2 = '00000000-0000-4000-8000-000000000002'
const at7 = (day: string) => new Date(businessDayStart(day).getTime() + 7 * 3_600_000)

describe('stages and the close (QHS-093)', () => {
  it('each type runs its own stages, either way, and closes or cancels with its own step', () => {
    expect([firstStage('CAPA'), lastStage('CAPA'), firstStage('EIGHT_D'), lastStage('EIGHT_D')]).toEqual(['PLAN', 'CHECK', 'D1', 'D8'])
    expect(nextStage('EIGHT_D', 'D3')).toBe('D4')
    expect(nextStage('CAPA', 'CHECK')).toBeNull()
    expect(moveProblem('EIGHT_D', 'D5', 'D4')).toBeNull()
    expect(moveProblem('EIGHT_D', 'D1', 'D7')).toBeNull()
    expect(moveProblem('CAPA', 'PLAN', 'D2')).toMatch(/PLAN, ACT, CHECK only/)
    expect(moveProblem('CAPA', 'ACT', 'ACT')).toMatch(/already/)
    expect(moveProblem('CAPA', 'CHECK', 'CLOSED')).toMatch(/own step/)
    expect(moveProblem('EIGHT_D', 'CLOSED', 'D1')).toMatch(/never changes/)
  })

  it('a close needs the last stage, an action done and none open, each said in words', () => {
    const checks = closeChecks({ type: 'EIGHT_D', status: 'D6', actions: [{ status: 'OPEN' }, { status: 'CANCELLED' }] })
    expect(checks.filter((check) => !check.ok).map((check) => check.key)).toEqual(['LAST_STAGE', 'ACTION_DONE', 'NO_OPEN_ACTION'])
    expect(checks[0]!.words).toBe('An 8D closes from D8 closure: move it there first.')
    expect(checks[2]!.words).toBe('One action is still open: finish or cancel it first.')
    expect(closeChecks({ type: 'CAPA', status: 'CHECK', actions: [{ status: 'DONE' }, { status: 'CANCELLED' }] }).every((check) => check.ok)).toBe(true)
  })
})

describe('what a CAPA and an action say', () => {
  it('the team: each person once, a role each', () => {
    expect(teamProblems([{ userId: U1, role: 'Lead' }, { userId: U2, role: 'Quality' }])).toEqual([])
    expect(teamProblems([{ userId: U1, role: 'Lead' }, { userId: U1, role: ' ' }]).map((problem) => problem.path)).toEqual(['team/1/userId', 'team/1/role'])
  })

  it('a title, a due day not before today when opened; the problem not blank when given', () => {
    expect(capaDraftProblems({ title: ' ', dueOn: '2026-11-02', problemWhat: '  ' }, true, '2026-11-03').map((problem) => problem.path)).toEqual(['title', 'dueOn', 'problemWhat'])
    expect(capaDraftProblems({ dueOn: '2026-01-01' }, false, '2026-11-03')).toEqual([])
    expect(actionDraftProblems({ description: 'Check every hide', dueOn: '2026-11-03' }, true, '2026-11-03')).toEqual([])
    expect(actionDraftProblems({ description: '', dueOn: '2026-11-01' }, true, '2026-11-03').map((problem) => problem.path)).toEqual(['description', 'dueOn'])
  })
})

describe('reminders and escalation (QHS-096)', () => {
  const action = { status: 'OPEN' as const, dueOn: '2026-11-20', remindersSent: 0, lastRemindedAt: null as Date | null }

  it('3 days before and on the day, from 07:00 Rome', () => {
    expect(reminderMoments('2026-11-20')).toEqual([at7('2026-11-17'), at7('2026-11-20')])
    expect(reminderDue(action, new Date(at7('2026-11-17').getTime() - 1))).toBeNull()
    expect(reminderDue(action, at7('2026-11-17'))).toEqual(at7('2026-11-17'))
    // The first one sent: nothing until the day.
    const once = { ...action, remindersSent: 1, lastRemindedAt: at7('2026-11-17') }
    expect(reminderDue(once, at7('2026-11-19'))).toBeNull()
    expect(reminderDue(once, at7('2026-11-20'))).toEqual(at7('2026-11-20'))
  })

  it('a reminder after a moment covers it: an action added late gets one, not two', () => {
    const late = new Date(at7('2026-11-20').getTime() + 3 * 3_600_000)
    expect(reminderDue(action, late)).toEqual(at7('2026-11-20'))
    expect(reminderDue({ ...action, remindersSent: 1, lastRemindedAt: late }, new Date(late.getTime() + 60_000))).toBeNull()
    // A due day moved later brings the new day's moments.
    expect(reminderDue({ ...action, dueOn: '2026-11-30', remindersSent: 1, lastRemindedAt: late }, at7('2026-11-27'))).toEqual(at7('2026-11-27'))
    expect(reminderDue({ ...action, status: 'DONE' }, late)).toBeNull()
  })

  it('escalates once, when overdue plus the rule’s wait', () => {
    expect(overdueFrom('2026-11-20')).toEqual(businessDayStart('2026-11-21'))
    const due = { status: 'OPEN' as const, dueOn: '2026-11-20', escalatedAt: null as Date | null }
    expect(escalationDue(due, 1440, new Date(businessDayStart('2026-11-22').getTime() - 1))).toBeNull()
    expect(escalationDue(due, 1440, businessDayStart('2026-11-22'))).toEqual(businessDayStart('2026-11-22'))
    expect(escalationDue(due, 0, businessDayStart('2026-11-21'))).toEqual(businessDayStart('2026-11-21'))
    expect(escalationDue({ ...due, escalatedAt: new Date() }, 0, businessDayStart('2026-11-25'))).toBeNull()
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('the tasks speak the reader’s language', () => {
    const facts = { number: 'CAPA-2026-0001', seq: 2, description: 'Add a grain check', dueOn: '2026-11-20', ownerName: 'Ada Rossi' }
    expect(reminderTask('it', facts).title).toBe('Promemoria: azione 2 di CAPA-2026-0001 entro il 20/11/2026')
    expect(reminderTask('en', facts).title).toMatch(/^Reminder: action 2 of CAPA-2026-0001 due /)
    expect(escalationTask('en', facts).description).toContain('Owner: Ada Rossi')
  })
})

describe('why escalate (ncr-capa: the rule that suggested it)', () => {
  it('critical, a repeat, a customer; a safety complaint', () => {
    expect(ncrReasons({ severity: 'CRITICAL', source: 'COMPLAINT', repeats: 2 })).toEqual(['CRITICAL', 'REPEAT_DEFECT', 'CUSTOMER'])
    expect(ncrReasons({ severity: 'MINOR', source: 'INSPECTION', repeats: 0 })).toEqual([])
    expect(complaintReasons({ category: 'SAFETY' })).toEqual(['CUSTOMER', 'SAFETY'])
    expect(complaintReasons({ category: null })).toEqual(['CUSTOMER'])
  })
})

describe('the 8D report (QHS-094)', () => {
  const input: EightDInput = {
    language: 'en',
    date: '2026-11-25',
    company: { name: 'Seed Leather Works S.r.l.', lines: ['Registered office: Via Finta 1'], legal: 'Seed Leather Works S.r.l. · VAT IT00000000000' },
    type: 'EIGHT_D',
    number: 'CAPA-2026-0003',
    title: 'Protector pocket seam opened',
    status: 'D6',
    openedOn: '2026-11-03',
    dueOn: '2026-12-01',
    owner: 'Ada Rossi',
    customer: { name: 'Seed Brand One', reference: 'P1-RMA-77' },
    team: [{ name: 'Ada Rossi', role: 'Champion' }],
    problem: { what: 'The seam opened\nat the elbow', where: null, when: 'In use', howMany: '2 jackets' },
    sources: [{ type: 'Nonconformance', number: 'NCR-2026-0004' }, { type: 'Complaint', number: 'CMP-2026-0002' }],
    containment: [{ ncr: 'NCR-2026-0004', actions: [{ kind: 'HOLD_STOCK', description: 'Hold the batch', status: 'DONE', doneOn: '2026-11-04' }] }],
    causes: [{ code: 'SEW-ERROR', label: 'Sewing error' }],
    actions: [
      { seq: 1, kind: 'CORRECTIVE', description: 'Re-sew the batch', owner: 'Bo Verdi', dueOn: '2026-11-20', status: 'DONE', doneOn: '2026-11-18', evidence: 'All 40 re-sewn' },
      { seq: 2, kind: 'PREVENTIVE', description: 'Thread check at the station', owner: null, dueOn: '2026-12-01', status: 'OPEN', doneOn: null, evidence: null },
    ],
    closedOn: null,
    closeNote: null,
    sample: true,
  }

  it('the eight disciplines in order, with the record’s facts, in English and Italian', () => {
    const report = eightDReport(input)
    expect(report.title).toBe('8D report')
    expect(report.sample).toBe('PREVIEW - version not kept')
    expect(report.sections.map((section) => section.heading.slice(0, 2))).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'])
    expect(report.sections[1]!.lines).toEqual(['What: The seam opened', 'at the elbow', 'When: In use', 'How many: 2 jackets'])
    expect(report.sections[2]!.lines[0]).toBe('NCR-2026-0004 · Goods put on hold: Hold the batch (done on 4 Nov 2026)')
    expect(report.facts.find((fact) => fact.label === 'Came from')?.value).toBe('NCR-2026-0004, CMP-2026-0002')
    expect(report.sections[3]!.lines).toEqual(['Sewing error (SEW-ERROR)'])
    expect(report.sections[5]!.table!.rows).toEqual([['1', 'Re-sew the batch', '18 Nov 2026', 'All 40 re-sewn']])
    expect(report.sections[6]!.table!.rows[0]).toEqual(['2', 'Thread check at the station', '-', '1 Dec 2026', 'Open'])
    expect(report.sections[7]!.lines).toEqual(['Open: due 1 Dec 2026.'])
    expect(report.facts.find((fact) => fact.label === 'Your reference')?.value).toBe('P1-RMA-77')
    expect(report.fileName).toBe('8D-report-CAPA-2026-0003-en.pdf')
    const italian = eightDReport({ ...input, language: 'it', type: 'CAPA', status: 'CLOSED', closedOn: '2026-11-30', closeNote: 'Nessuna ripetizione.', sample: false })
    expect(italian.title).toBe('Rapporto di azione correttiva')
    expect(italian.sample).toBeNull()
    expect(italian.sections[7]!.lines).toEqual(['Chiuso il 30/11/2026.', 'Nessuna ripetizione.'])
  })

  it('the fingerprint leaves out the day and the banner', () => {
    const one = eightDFingerprintText(eightDReport({ ...input, sample: false }))
    expect(eightDFingerprintText(eightDReport({ ...input, sample: true, date: '2027-01-02' }))).toBe(one)
    expect(eightDFingerprintText(eightDReport({ ...input, sample: false, title: 'Another title' }))).not.toBe(one)
  })
})
