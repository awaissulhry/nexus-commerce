import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { REGISTER_SOURCE_TYPES } from '../../compliance/register/rules'
import { QUALITY_COMPLAINTS_PERMISSIONS } from './permissions'
import {
  acknowledgeHeld,
  answerDueState,
  canMove,
  closeHeld,
  closeReasonProblems,
  COMPLAINT_ACTIONS,
  complaintActions,
  dueSoonUntil,
  evidenceOf,
  factProblems,
  monthStart,
  moveHeld,
  registerHeld,
  safetyStateOf,
  showsOnBanner,
  triageProblems,
  type ComplaintAction,
} from './rules'

const everything = Object.fromEntries(COMPLAINT_ACTIONS.map((action) => [action, true])) as Record<ComplaintAction, boolean>
const RAISED = new Date('2026-10-30T09:00:00.000Z')

describe('the status moves (NEW → TRIAGED → INVESTIGATING → ANSWERED → CLOSED)', () => {
  it('takes only the moves the plan names; triage and close have their own steps', () => {
    expect(canMove('TRIAGED', 'INVESTIGATING')).toBe(true)
    expect(canMove('TRIAGED', 'ANSWERED')).toBe(true)
    expect(canMove('INVESTIGATING', 'ANSWERED')).toBe(true)
    expect(canMove('ANSWERED', 'INVESTIGATING')).toBe(true)
    expect(canMove('NEW', 'INVESTIGATING')).toBe(false)
    expect(canMove('INVESTIGATING', 'INVESTIGATING')).toBe(false)
    expect(canMove('CLOSED', 'ANSWERED')).toBe(false)
  })

  it('says why a move is held, with a code the screens put in words', () => {
    expect(moveHeld('NEW', 'INVESTIGATING')).toBe('NOT_TRIAGED')
    expect(moveHeld('INVESTIGATING', 'INVESTIGATING')).toBe('ALREADY_INVESTIGATING')
    expect(moveHeld('ANSWERED', 'ANSWERED')).toBe('ALREADY_ANSWERED')
    expect(moveHeld('CLOSED', 'ANSWERED')).toBe('CLOSED')
    expect(moveHeld('TRIAGED', 'ANSWERED')).toBeNull()
  })
})

describe('the safety escalation (QHS-115)', () => {
  it('raised → acknowledged, shown on the banner until then (never timed out)', () => {
    expect(safetyStateOf({ safetyRaisedAt: null, safetyAcknowledgedAt: null })).toBe('NONE')
    expect(safetyStateOf({ safetyRaisedAt: RAISED, safetyAcknowledgedAt: null })).toBe('RAISED')
    expect(safetyStateOf({ safetyRaisedAt: RAISED, safetyAcknowledgedAt: RAISED })).toBe('ACKNOWLEDGED')
    expect(showsOnBanner({ status: 'TRIAGED', safetyRaisedAt: RAISED, safetyAcknowledgedAt: null })).toBe(true)
    expect(showsOnBanner({ status: 'TRIAGED', safetyRaisedAt: RAISED, safetyAcknowledgedAt: RAISED })).toBe(false)
  })

  it('acknowledges a raised alert once; closes a safety complaint only acknowledged and in the register', () => {
    expect(acknowledgeHeld({ status: 'TRIAGED', safetyRaisedAt: null, safetyAcknowledgedAt: null })).toBe('NO_SAFETY_ALERT')
    expect(acknowledgeHeld({ status: 'TRIAGED', safetyRaisedAt: RAISED, safetyAcknowledgedAt: RAISED })).toBe('ACKNOWLEDGED')
    expect(acknowledgeHeld({ status: 'TRIAGED', safetyRaisedAt: RAISED, safetyAcknowledgedAt: null })).toBeNull()
    expect(closeHeld({ status: 'TRIAGED', safetyRaisedAt: RAISED, safetyAcknowledgedAt: null, inRegister: true })).toBe('SAFETY_NOT_ACKNOWLEDGED')
    expect(closeHeld({ status: 'TRIAGED', safetyRaisedAt: RAISED, safetyAcknowledgedAt: RAISED, inRegister: false })).toBe('NOT_IN_REGISTER')
    expect(closeHeld({ status: 'TRIAGED', safetyRaisedAt: RAISED, safetyAcknowledgedAt: RAISED, inRegister: true })).toBeNull()
    expect(closeHeld({ status: 'NEW', safetyRaisedAt: null, safetyAcknowledgedAt: null, inRegister: false })).toBeNull()
    expect(closeHeld({ status: 'CLOSED', safetyRaisedAt: null, safetyAcknowledgedAt: null, inRegister: false })).toBe('CLOSED')
  })

  it('a safety triage needs the style (the register keeps an entry per style) and an answer due on or after the day it came in', () => {
    expect(triageProblems({ category: 'SAFETY', severity: 'CRITICAL', answerDueOn: '2026-11-02', styleId: null }, '2026-10-30').map((problem) => problem.path)).toEqual(['body/styleId'])
    expect(triageProblems({ category: 'FIT', severity: 'MINOR', answerDueOn: '2026-10-29', styleId: null }, '2026-10-30').map((problem) => problem.path)).toEqual(['body/answerDueOn'])
    expect(triageProblems({ category: 'FIT', severity: 'MINOR', answerDueOn: '2026-10-30', styleId: null }, '2026-10-30')).toEqual([])
  })

  it('the PPE register takes a complaint as an entry\'s source', () => {
    expect(REGISTER_SOURCE_TYPES).toContain('Complaint')
  })
})

describe('the steps a person takes, held with a reason', () => {
  it('holds every step the person may not take, then by the complaint’s state', () => {
    const none = Object.fromEntries(COMPLAINT_ACTIONS.map((action) => [action, false])) as Record<ComplaintAction, boolean>
    const held = complaintActions({ status: 'NEW', styleId: null, inRegister: false, safetyRaisedAt: null, safetyAcknowledgedAt: null, may: none })
    expect(held.every((state) => state.held === 'NO_PERMISSION' && !state.allowed)).toBe(true)
    const fresh = Object.fromEntries(complaintActions({ status: 'NEW', styleId: null, inRegister: false, safetyRaisedAt: null, safetyAcknowledgedAt: null, may: everything }).map((state) => [state.action, state.held]))
    expect(fresh).toMatchObject({ edit: null, triage: null, startInvestigation: 'NOT_TRIAGED', markAnswered: 'NOT_TRIAGED', reopenInvestigation: 'NOT_ANSWERED', close: null, acknowledge: 'NO_SAFETY_ALERT', register: 'NO_STYLE', createNcr: null, makeRepair: null })
    const answered = Object.fromEntries(complaintActions({ status: 'ANSWERED', styleId: 's', inRegister: true, safetyRaisedAt: RAISED, safetyAcknowledgedAt: RAISED, may: everything }).map((state) => [state.action, state.held]))
    expect(answered).toMatchObject({ startInvestigation: 'ALREADY_ANSWERED', markAnswered: 'ALREADY_ANSWERED', reopenInvestigation: null, close: null, acknowledge: 'ACKNOWLEDGED', register: 'IN_REGISTER' })
    const closed = complaintActions({ status: 'CLOSED', styleId: 's', inRegister: true, safetyRaisedAt: null, safetyAcknowledgedAt: null, may: everything })
    expect(closed.filter((state) => state.allowed)).toEqual([])
    expect(registerHeld({ status: 'TRIAGED', styleId: 's', inRegister: false })).toBeNull()
  })
})

describe('what a person types, and the list', () => {
  it('checks the customer’s words, the lengths and the time it came in', () => {
    const now = new Date('2026-10-30T10:00:00.000Z')
    expect(factProblems({ description: ' ' }, now, true).map((problem) => problem.path)).toEqual(['body/description'])
    expect(factProblems({ description: 'x', serial: 'S'.repeat(121), receivedAt: new Date('2026-10-30T11:00:00.000Z') }, now, true).map((problem) => problem.path)).toEqual(['body/serial', 'body/receivedAt'])
    expect(factProblems({ description: '' }, now, false).map((problem) => problem.path)).toEqual(['body/description'])
    expect(factProblems({}, now, false)).toEqual([])
    expect(closeReasonProblems('  ').map((problem) => problem.path)).toEqual(['body/reason'])
    expect(closeReasonProblems('A duplicate.')).toEqual([])
  })

  it('answer due in 3 days counts overdue ones too; the month starts on its first day; the evidence trail by serial, else batch', () => {
    expect(dueSoonUntil('2026-10-30')).toBe('2026-11-02')
    expect(monthStart('2026-10-30')).toBe('2026-10-01')
    expect(answerDueState('TRIAGED', '2026-10-29', '2026-10-30')).toBe('OVERDUE')
    expect(answerDueState('INVESTIGATING', '2026-11-02', '2026-10-30')).toBe('SOON')
    expect(answerDueState('TRIAGED', '2026-11-20', '2026-10-30')).toBe('LATER')
    expect(answerDueState('ANSWERED', '2026-10-29', '2026-10-30')).toBe('NONE')
    expect(evidenceOf({ serial: ' SN-1 ', batchNumber: 'B-1' })).toEqual({ kind: 'serial', subject: 'SN-1' })
    expect(evidenceOf({ serial: null, batchNumber: 'B-1' })).toEqual({ kind: 'batch', subject: 'B-1' })
    expect(evidenceOf({ serial: '', batchNumber: null })).toBeNull()
  })
})

describe('the catalogues', () => {
  it('declares the four permissions; quality triages, sales logs, only the owner acknowledges', () => {
    for (const name of QUALITY_COMPLAINTS_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name), name).toBe(true)
    const template = (key: string) => ROLE_TEMPLATES.find((role) => role.key === key)!.permissions
    expect(template('sales')).toEqual(expect.arrayContaining(['quality.complaints.view', 'quality.complaints.log']))
    expect(template('sales')).not.toContain('quality.complaints.manage')
    expect(template('quality_inspector')).toEqual(expect.arrayContaining(['quality.complaints.view', 'quality.complaints.log', 'quality.complaints.manage']))
    const acknowledging = ROLE_TEMPLATES.filter((role) => role.permissions.includes('quality.complaints.acknowledge')).map((role) => role.key)
    expect(acknowledging).toEqual(['owner'])
    expect(template('read_only')).toContain('quality.complaints.view')
  })

  it('declares the complaint events, live to the complaint screens, with no money or name', () => {
    for (const type of ['complaint.received', 'complaint.changed', 'complaint.triaged', 'complaint.safety_raised', 'complaint.safety_acknowledged', 'complaint.status_changed']) {
      const definition = EVENT_CATALOGUE.get(type, 1)
      expect(definition.context).toBe('quality')
      expect(definition.live?.permission).toBe('quality.complaints.view')
    }
  })
})
