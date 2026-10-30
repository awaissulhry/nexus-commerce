import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { Dec } from '../../tax/decimal'
import { QUALITY_NCR_PERMISSIONS } from './permissions'
import {
  allMet,
  approveProblem,
  canMoveNcr,
  carryOutProblem,
  closeChecklist,
  closeStatement,
  containmentOverdue,
  decidedOf,
  decisionProblems,
  decisionState,
  doneProblems,
  firstUnmet,
  holdDefaults,
  ncrActions,
  ncrDraftProblems,
  nextStage,
  opensRegisterEntry,
  stageChecks,
  stagesToClose,
  valueOf,
  type NcrFacts,
} from './rules'

const NOW = new Date('2026-11-24T10:00:00.000Z')
const facts = (over: Partial<NcrFacts> = {}): NcrFacts => ({ stage: 'OPEN', quantityAffected: '40', uom: 'PCS', actions: [], decisions: [], activeHolds: 0, ...over })
const decision = (quantity: string, over: Partial<NcrFacts['decisions'][number]> = {}) => ({ quantity, approvalRequired: false, approved: false, done: false, ...over })

describe('NCR stages (QHS-089, QHS-090)', () => {
  it('moves OPEN → CONTAINED → DECIDED → CLOSED, cancelled only while open or contained', () => {
    expect(canMoveNcr('OPEN', 'CONTAINED')).toBe(true)
    expect(canMoveNcr('OPEN', 'DECIDED')).toBe(false)
    expect(canMoveNcr('CONTAINED', 'CANCELLED')).toBe(true)
    expect(canMoveNcr('DECIDED', 'CANCELLED')).toBe(false)
    expect(canMoveNcr('CLOSED', 'OPEN')).toBe(false)
    expect(nextStage('DECIDED')).toBe('CLOSED')
    expect(nextStage('CLOSED')).toBeNull()
    expect(stagesToClose('OPEN')).toEqual(['CONTAINED', 'DECIDED', 'CLOSED'])
    expect(stagesToClose('DECIDED')).toEqual(['CLOSED'])
  })

  it('contains once every action is done or cancelled and one is done', () => {
    expect(firstUnmet(stageChecks(facts(), 'CONTAINED'))?.key).toBe('ACTION_DONE')
    const open = stageChecks(facts({ actions: [{ status: 'DONE' }, { status: 'OPEN' }] }), 'CONTAINED')
    expect(firstUnmet(open)?.words).toBe('1 containment action is still open: do or cancel it first.')
    expect(allMet(stageChecks(facts({ actions: [{ status: 'DONE' }, { status: 'CANCELLED' }] }), 'CONTAINED'))).toBe(true)
  })

  it('decides once the whole quantity is decided and approved, in words ("28 of 40 decided · 12 left")', () => {
    const half = facts({ stage: 'CONTAINED', decisions: [decision('28')] })
    expect(decidedOf(half).words).toBe('28 of 40 PCS decided · 12 left')
    expect(firstUnmet(stageChecks(half, 'DECIDED'))?.words).toBe('28 of 40 PCS decided · 12 left: decide the rest first.')
    const waiting = facts({ stage: 'CONTAINED', decisions: [decision('28'), decision('12', { approvalRequired: true })] })
    expect(firstUnmet(stageChecks(waiting, 'DECIDED'))?.key).toBe('APPROVED')
    expect(allMet(stageChecks(facts({ stage: 'CONTAINED', decisions: [decision('40')] }), 'DECIDED'))).toBe(true)
    expect(decidedOf(facts({ quantityAffected: '51.8', uom: 'FT2', decisions: [decision('12')] })).words).toBe('12 of 51.8 FT2 decided · 39.8 left')
  })

  it('closes only when every decision is carried out; the checklist names what is missing from any open stage', () => {
    const decided = facts({ stage: 'DECIDED', actions: [{ status: 'DONE' }], decisions: [decision('30', { done: true }), decision('10')], activeHolds: 1 })
    expect(firstUnmet(stageChecks(decided, 'CLOSED'))?.words).toBe('1 decision waits for its stock move or follow-up record: carry it out first.')
    const contained = facts({ stage: 'CONTAINED', actions: [{ status: 'DONE' }], decisions: [decision('40', { done: true })], activeHolds: 1 })
    const checklist = closeChecklist(contained)
    expect(checklist.map((check) => check.key)).toEqual(['ALL_DECIDED', 'APPROVED', 'CARRIED_OUT', 'HOLDS'])
    expect(allMet(checklist)).toBe(true)
    expect(checklist.at(-1)?.words).toBe('1 hold this NCR decides is closed with it.')
    expect(closeChecklist(facts()).map((check) => check.key)).toEqual(['ACTION_DONE', 'NO_OPEN_ACTION', 'ALL_DECIDED', 'APPROVED', 'CARRIED_OUT', 'HOLDS'])
  })

  it('is cancelled only while nothing is carried out', () => {
    expect(firstUnmet(stageChecks(facts({ decisions: [decision('1', { done: true })] }), 'CANCELLED'))?.words).toBe('1 decision is carried out: close the NCR instead.')
    expect(firstUnmet(stageChecks(facts({ stage: 'CLOSED' }), 'OPEN'))?.words).toBe('The NCR is closed: it never changes.')
  })

  it("answers the record band's actions in words", () => {
    const actions = ncrActions(facts({ stage: 'DECIDED', decisions: [decision('40')] }))
    expect(actions.edit).toBe('The NCR is decided: its problem is read-only now.')
    expect(actions.cancel).toBe('A decided NCR is closed, not cancelled.')
    expect(actions.close).toMatch(/carry it out first/)
  })
})

describe('NCR content, containment and decisions (QHS-081, QHS-082, QHS-083)', () => {
  it('needs a title and a quantity above 0; a zone of the garment map; never found in the future', () => {
    const paths = ncrDraftProblems({ title: ' ', quantityAffected: '0', quantitySuspect: '-1', zone: 'ELBOW', foundOn: new Date('2026-11-25T00:00:00.000Z') }, true, NOW).map((problem) => problem.path)
    expect(paths).toEqual(['title', 'quantityAffected', 'quantitySuspect', 'zone', 'foundOn'])
    expect(ncrDraftProblems({ title: 'Open seam', quantityAffected: '2.5', zone: 'SLEEVE_L' }, true, NOW)).toEqual([])
  })

  it('done needs evidence; holding stock names its hold', () => {
    expect(doneProblems({ kind: 'CHECK_WIP', evidenceNote: null, files: 0, holdId: null }).map((problem) => problem.path)).toEqual(['evidenceNote'])
    expect(doneProblems({ kind: 'CHECK_WIP', evidenceNote: null, files: 1, holdId: null })).toEqual([])
    expect(doneProblems({ kind: 'HOLD_STOCK', evidenceNote: 'held', files: 0, holdId: null }).map((problem) => problem.path)).toEqual(['hold'])
  })

  it('the containment is overdue past its due time while OPEN', () => {
    expect(containmentOverdue({ stage: 'OPEN', containmentDueAt: new Date('2026-11-24T09:00:00.000Z') }, [], NOW)).toBe(true)
    expect(containmentOverdue({ stage: 'OPEN', containmentDueAt: null }, [{ status: 'OPEN', dueAt: new Date('2026-11-23T00:00:00.000Z') }], NOW)).toBe(true)
    expect(containmentOverdue({ stage: 'CONTAINED', containmentDueAt: new Date('2026-11-20T00:00:00.000Z') }, [], NOW)).toBe(false)
  })

  it('a decision never passes what is left, never uses a major NCR as is', () => {
    expect(decisionProblems({ quantity: '13', left: new Dec(12), uom: 'PCS', outcome: 'SCRAP', severity: 'MAJOR' })[0]?.message).toBe('Only 12 PCS are left to decide.')
    expect(decisionProblems({ quantity: '1', left: new Dec(12), uom: 'PCS', outcome: 'USE_AS_IS', severity: 'MAJOR' })[0]?.path).toBe('dispositionCodeId')
    expect(decisionProblems({ quantity: '1', left: new Dec(12), uom: 'PCS', outcome: 'USE_AS_IS', severity: 'MINOR' })).toEqual([])
  })

  it('four eyes: the approver is never the decider; carried out only once approved', () => {
    const base = { stage: 'CONTAINED' as const, approvalRequired: true, approved: false, done: false, decidedById: 'u1' }
    expect(approveProblem({ ...base, approverId: 'u1' })).toBe('You decided this: another person approves it (four eyes).')
    expect(approveProblem({ ...base, approverId: 'u2' })).toBeNull()
    expect(approveProblem({ ...base, approvalRequired: false, approverId: 'u2' })).toBe('This decision needs no approval.')
    expect(carryOutProblem(base)).toBe("This decision waits for another person's approval.")
    expect(carryOutProblem({ ...base, approved: true })).toBeNull()
    expect(decisionState({ approvalRequired: true, approved: false, done: false })).toBe('WAITING_APPROVAL')
    expect(decisionState({ approvalRequired: true, approved: true, done: true })).toBe('DONE')
  })

  it('values the goods for an approval rule in minor units, null when no cost is known', () => {
    expect(valueOf('12', '4.200000')).toBe(5040)
    expect(valueOf('12', null)).toBeNull()
  })
})

describe('NCR from anywhere, the register and the close signature (QHS-080, QHS-090)', () => {
  it('an NCR from a hold comes from what it holds', () => {
    expect(holdDefaults('Hide', null)).toEqual({ source: 'SUPPLIER', foundAt: 'STOCK' })
    expect(holdDefaults('WorkOrder', 'Inspection')).toEqual({ source: 'INSPECTION', foundAt: 'IN_LINE' })
    expect(holdDefaults('Shipment', 'Complaint')).toEqual({ source: 'COMPLAINT', foundAt: 'CUSTOMER' })
  })

  it('a PPE nonconformity that may present a risk opens its register entry', () => {
    expect(opensRegisterEntry({ ppe: true, severity: 'CRITICAL', foundAt: 'FINAL', source: 'INSPECTION' })).toBe(true)
    expect(opensRegisterEntry({ ppe: true, severity: 'MINOR', foundAt: 'CUSTOMER', source: 'RETURN' })).toBe(true)
    expect(opensRegisterEntry({ ppe: true, severity: 'MAJOR', foundAt: 'IN_LINE', source: 'BUNDLE' })).toBe(false)
    expect(opensRegisterEntry({ ppe: false, severity: 'CRITICAL', foundAt: 'CUSTOMER', source: 'COMPLAINT' })).toBe(false)
  })

  it('signs the NCR, its decisions and the note', () => {
    const statement = closeStatement({ ncrId: 'n1', number: 'NCR-2026-0001', closedBy: 'user u1', closedAt: '2026-11-24T10:00:00.000Z', quantityAffected: '2', uom: 'PCS', decisions: [{ seq: 1, code: 'REWORK', quantity: '2', followUp: 'ReworkOrder r1', stockMoveId: null }], note: 'Reworked.' })
    expect(statement).toContain('I close nonconformance NCR-2026-0001 (n1).')
    expect(statement).toContain('1. REWORK 2 PCS, ReworkOrder r1')
  })
})

describe('NCR permissions and templates', () => {
  it('declares them and gives them to the roles the design names', () => {
    for (const name of QUALITY_NCR_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    expect(templateOf('quality_inspector')!.permissions).toEqual(expect.arrayContaining([...QUALITY_NCR_PERMISSIONS]))
    expect(templateOf('production_manager')!.permissions).toEqual(expect.arrayContaining(['quality.ncr.manage', 'quality.ncr.approve']))
    expect(templateOf('production_manager')!.permissions).not.toContain('quality.ncr.close')
    expect(templateOf('warehouse')!.permissions).toEqual(expect.arrayContaining(['quality.ncr.view', 'quality.ncr.raise']))
    expect(templateOf('planner')!.permissions).not.toContain('quality.ncr.raise')
    expect(templateOf('operator')?.permissions ?? []).not.toContain('quality.ncr.view')
  })
})
