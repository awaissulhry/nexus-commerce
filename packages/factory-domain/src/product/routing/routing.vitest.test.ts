import { describe, expect, it } from 'vitest'
import { diffRoutings } from './diff'
import { MINUTES_ROUND, minutesForQuantity, routingMinutes, sumMinutes } from './minutes'
import { changeOperation, minutesOf, newOperation, operationMachine, operationUseRefusal, sameMinutes, WORK_CENTRE_KINDS, type OperationFields } from './operations'
import {
  copySourceRefusal,
  copySteps,
  editRefusal,
  finalStepOf,
  nextSeq,
  orderProblems,
  planNewStep,
  planStepChange,
  renumbering,
  routingIssues,
  sequenceOf,
  stepChanges,
  type LibraryOperation,
  type StepData,
} from './rules'
import { canTransition } from '../../state/machine'

/**
 * The operation library's and the routing's rules (B-W1-14; features PRD-109, PRD-110, PRD-111). Every code and name is
 * made up; the minutes are the product seed's jacket (cut 14, sew 96.5, inspect 8, pack 3.5) plus a finishing step.
 */

const library = (id: string, code: string, workCentreKind: LibraryOperation['workCentreKind'], standardMinutes: string, status: LibraryOperation['status'] = 'ACTIVE'): LibraryOperation => ({
  id,
  code,
  name: `${code} (made up)`,
  nameI18n: { it: `${code} it`, en: `${code} en` },
  workCentreKind,
  standardMinutes,
  instructions: null,
  status,
})
const CUT = library('op-cut', 'CUT-1', 'CUTTING', '14')
const SEW = library('op-sew', 'SEW-1', 'SEWING', '96.5')
const FIN = library('op-fin', 'FIN-1', 'FINISHING', '6.25')
const QC = library('op-qc', 'QC-1', 'INSPECTION', '8')
const OLD = library('op-old', 'OLD-1', 'SEWING', '3', 'ARCHIVED')
const LIBRARY = new Map([CUT, SEW, FIN, QC, OLD].map((operation) => [operation.id, operation]))

function step(id: string, operation: LibraryOperation, seq: number, change: Parameters<typeof planNewStep>[1] = {}): StepData {
  const plan = planNewStep({ ...operation, status: 'ACTIVE' }, change, seq)
  if (!plan.ok) throw new Error(JSON.stringify(plan.issues))
  return { id, ...plan.step }
}
/** cut, sew, finish, inspect: 14 + 96.5 + 6.25 + 8 = 124.75 minutes per garment. */
const ROUTING = [step('s-10', CUT, 10), step('s-20', SEW, 20), step('s-30', FIN, 30, { scanRequired: false }), step('s-40', QC, 40)]

describe('standard minutes (PRD-111)', () => {
  it('are rounded half up to 3 decimals, once, and stay above 0', () => {
    expect(minutesOf('4.2')).toEqual({ ok: true, minutes: '4.2' })
    expect(minutesOf('4.200')).toEqual({ ok: true, minutes: '4.2' })
    expect(minutesOf('0.16667')).toEqual({ ok: true, minutes: '0.167' })
    expect(minutesOf('1.0005')).toEqual({ ok: true, minutes: '1.001' })
    expect(minutesOf('1.0005', 'DOWN')).toEqual({ ok: true, minutes: '1' })
    expect(minutesOf('0.0004')).toMatchObject({ ok: false, message: expect.stringMatching(/above 0/) })
    expect(minutesOf('0')).toMatchObject({ ok: false })
    expect(minutesOf('-1')).toMatchObject({ ok: false })
    expect(minutesOf('1e3')).toMatchObject({ ok: false })
    expect(minutesOf('12345678')).toMatchObject({ ok: false })
    expect(minutesOf('9999999.9994')).toEqual({ ok: true, minutes: '9999999.999' })
    expect(minutesOf('9999999.9996')).toMatchObject({ ok: false, message: expect.stringMatching(/7 digits/) })
    expect(sameMinutes('96.500', '96.5')).toBe(true)
  })

  it('add up exactly per garment, per kind of work centre in floor order, and per size', () => {
    const minutes = routingMinutes(ROUTING, ['50', '52', '54'], MINUTES_ROUND)
    expect(minutes).toEqual({
      perGarment: '124.75',
      byKind: [
        { workCentreKind: 'CUTTING', minutes: '14', steps: 1 },
        { workCentreKind: 'SEWING', minutes: '96.5', steps: 1 },
        { workCentreKind: 'FINISHING', minutes: '6.25', steps: 1 },
        { workCentreKind: 'INSPECTION', minutes: '8', steps: 1 },
      ],
      // No per-size minutes in W1 (PRD-114 is W2b): every size takes the garment's.
      bySize: [
        { size: '50', minutes: '124.75' },
        { size: '52', minutes: '124.75' },
        { size: '54', minutes: '124.75' },
      ],
      steps: 4,
      scanPoints: 3,
    })
    expect(routingMinutes([], ['50'], MINUTES_ROUND)).toMatchObject({ perGarment: '0', byKind: [], bySize: [{ size: '50', minutes: '0' }], steps: 0, scanPoints: 0 })
    // 0.1 + 0.2 is 0.3 exactly (no binary float).
    expect(sumMinutes([{ standardMinutes: '0.1' }, { standardMinutes: '0.2' }]).toFixed()).toBe('0.3')
  })

  it('for a quantity are multiplied exactly and rounded once, as the caller says', () => {
    expect(minutesForQuantity('124.75', '30', MINUTES_ROUND)).toBe('3742.5')
    expect(minutesForQuantity('0.167', '3', { scale: 1, rounding: 'HALF_UP' })).toBe('0.5')
    expect(minutesForQuantity('0.167', '3', { scale: 1, rounding: 'DOWN' })).toBe('0.5')
    expect(minutesForQuantity('0.167', '3', { scale: 0, rounding: 'UP' })).toBe('1')
  })
})

describe('the operation library (PRD-109)', () => {
  const sewing: OperationFields = {
    code: 'SEW-1',
    name: 'Sew the body',
    nameI18n: { it: 'Cucire il corpo', en: 'Sew the body' },
    workCentreKind: 'SEWING',
    machineType: 'post-bed',
    skill: 'machinist',
    standardMinutes: '96.5',
    instructions: null,
  }

  it('takes a new operation with its code in capitals and minutes rounded to 3 decimals', () => {
    const outcome = newOperation({ code: ' sew-2 ', name: ' Topstitch ', workCentreKind: 'SEWING', standardMinutes: '2.34567' })
    expect(outcome).toEqual({ ok: true, operation: { code: 'SEW-2', name: 'Topstitch', nameI18n: null, workCentreKind: 'SEWING', machineType: null, skill: null, standardMinutes: '2.346', instructions: null } })
  })

  it('refuses a bad code, an empty name, a foreign language, zero minutes and a kind outside the list, all at once', () => {
    const outcome = newOperation({ code: '-X', name: ' ', nameI18n: { de: 'Nähen' } as never, workCentreKind: 'WELDING' as never, standardMinutes: '0' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.issues.map((issue) => issue.path).sort()).toEqual(['code', 'name', 'nameI18n/de', 'standardMinutes', 'workCentreKind'])
  })

  it('changes only what was sent, says what changed, and keeps the code of a used operation', () => {
    const change = changeOperation(sewing, { standardMinutes: '96.500', skill: null, machineType: 'twin-needle' }, true)
    expect(change).toMatchObject({ ok: true, changed: ['machineType', 'skill'] })
    expect(changeOperation(sewing, { code: 'sew-9' }, false)).toMatchObject({ ok: true, changed: ['code'], operation: { code: 'SEW-9' } })
    expect(changeOperation(sewing, { code: 'SEW-9' }, true)).toMatchObject({ ok: false, issues: [{ path: 'code' }] })
    expect(changeOperation(sewing, { code: 'SEW-1', standardMinutes: '90' }, true)).toMatchObject({ ok: true, changed: ['standardMinutes'] })
  })

  it('archives and reactivates; an archived operation is in no new step', () => {
    expect(canTransition(operationMachine, 'ACTIVE', 'ARCHIVED').ok).toBe(true)
    expect(canTransition(operationMachine, 'ARCHIVED', 'ACTIVE').ok).toBe(true)
    expect(operationUseRefusal(OLD)).toMatch(/OLD-1 is archived/)
    expect(operationUseRefusal(CUT)).toBeNull()
    expect(WORK_CENTRE_KINDS).toContain('SUBCONTRACT')
  })
})

describe('routing steps (PRD-110)', () => {
  it('copies the library operation, then what was typed for this style', () => {
    const plan = planNewStep(SEW, { standardMinutes: '90.1234', instructions: 'Twin seam at the yoke.' }, 20)
    expect(plan).toEqual({
      ok: true,
      step: { seq: 20, operationId: 'op-sew', code: 'SEW-1', name: 'SEW-1 (made up)', nameI18n: { it: 'SEW-1 it', en: 'SEW-1 en' }, workCentreKind: 'SEWING', standardMinutes: '90.123', scanRequired: true, instructions: 'Twin seam at the yoke.' },
    })
  })

  it('refuses an archived operation, minutes of 0 and a place out of range', () => {
    expect(planNewStep(OLD, {}, 10)).toMatchObject({ ok: false, issues: [{ path: 'operationId' }] })
    expect(planNewStep(CUT, { standardMinutes: '0' }, 10)).toMatchObject({ ok: false, issues: [{ path: 'standardMinutes' }] })
    expect(planNewStep(CUT, {}, 100_000)).toMatchObject({ ok: false, issues: [{ path: 'seq' }] })
  })

  it("changes a step's minutes, scan point and instructions only, and says which fields changed", () => {
    const current = ROUTING[1]!
    const plan = planStepChange(current, { standardMinutes: '96.50', scanRequired: false, instructions: null })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.step).toMatchObject({ seq: 20, code: 'SEW-1', standardMinutes: '96.5', scanRequired: false, instructions: null })
    expect(stepChanges(current, plan.step)).toEqual(['scanRequired'])
    expect(planStepChange(current, { instructions: ' padded ' })).toMatchObject({ ok: false, issues: [{ path: 'instructions' }] })
  })

  it('numbers new steps after the last one, by tens', () => {
    expect(nextSeq([])).toBe(10)
    expect(nextSeq(ROUTING)).toBe(50)
    expect(nextSeq([{ seq: 15 }])).toBe(20)
  })

  it('reorders only with every step named once, and moves only the steps whose place changes', () => {
    const ids = ROUTING.map((entry) => entry.id)
    expect(orderProblems(ids, ['s-20', 's-10', 's-30', 's-40'])).toEqual([])
    expect(orderProblems(ids, ['s-20', 's-20', 's-30', 's-40']).map((issue) => issue.path)).toEqual(['stepIds/1', 'stepIds'])
    expect(orderProblems(ids, ['s-10', 's-20', 's-30', 's-40', 'other']).map((issue) => issue.path)).toEqual(['stepIds/4'])
    const places = sequenceOf(['s-20', 's-10', 's-30', 's-40'])
    expect([...places]).toEqual([['s-20', 10], ['s-10', 20], ['s-30', 30], ['s-40', 40]])
    expect(renumbering(ROUTING, places)).toEqual([
      { id: 's-10', from: 10, to: 20 },
      { id: 's-20', from: 20, to: 10 },
    ])
    expect(renumbering(ROUTING, sequenceOf(ids))).toEqual([])
  })

  it('copies steps under new ids, numbered on from the place given', () => {
    let next = 0
    const copied = copySteps([ROUTING[3]!, ROUTING[0]!], 50, () => `new-${++next}`)
    expect(copied.map((entry) => [entry.id, entry.seq, entry.code])).toEqual([['new-1', 50, 'CUT-1'], ['new-2', 60, 'QC-1']])
    expect(copied[0]!.nameI18n).not.toBe(ROUTING[0]!.nameI18n)
  })
})

describe('the final operation and the release check', () => {
  it('is the last scanned step', () => {
    expect(finalStepOf(ROUTING)?.id).toBe('s-40')
    expect(finalStepOf([ROUTING[0]!, { ...ROUTING[3]!, scanRequired: false }])?.id).toBe('s-10')
    expect(finalStepOf([])).toBeNull()
  })

  it('blocks an empty routing and one without a scan point; warns of an archived operation and an unscanned last step', () => {
    expect(routingIssues([], LIBRARY).blockers.map((issue) => issue.code)).toEqual(['NO_STEPS'])
    expect(routingIssues(ROUTING, LIBRARY)).toEqual({ blockers: [], warnings: [] })
    const unscanned = ROUTING.map((entry) => ({ ...entry, scanRequired: false }))
    expect(routingIssues(unscanned, LIBRARY).blockers.map((issue) => issue.code)).toEqual(['NO_SCAN_POINT'])
    const packLast = [...ROUTING, { ...step('s-50', OLD, 50), scanRequired: false }]
    const check = routingIssues(packLast, LIBRARY)
    expect(check.blockers).toEqual([])
    expect(check.warnings.map((issue) => [issue.code, issue.stepId])).toEqual([['OPERATION_ARCHIVED', 's-50'], ['LAST_STEP_NOT_SCANNED', 's-50']])
    expect(check.warnings[1]!.message).toMatch(/QC-1/)
    expect(routingIssues([{ ...ROUTING[0]!, standardMinutes: '0' }], LIBRARY).blockers.map((issue) => issue.code)).toEqual(['MINUTES_NOT_POSITIVE'])
  })

  it('refuses a change to a frozen routing or an archived style, and a copy from anything but a released routing', () => {
    expect(editRefusal({ revision: 1, status: 'DRAFT' }, 'DRAFT')).toBeNull()
    expect(editRefusal({ revision: 1, status: 'RELEASED' }, 'ACTIVE')).toMatch(/released: its routing is frozen/)
    expect(editRefusal({ revision: 2, status: 'OBSOLETE' }, 'ACTIVE')).toMatch(/obsolete/)
    expect(editRefusal({ revision: 3, status: 'DRAFT' }, 'ARCHIVED')).toMatch(/archived/)
    expect(copySourceRefusal({ revision: 1, status: 'RELEASED' }, false)).toBeNull()
    expect(copySourceRefusal({ revision: 2, status: 'DRAFT' }, false)).toMatch(/only from a released routing/)
    expect(copySourceRefusal({ revision: 1, status: 'RELEASED' }, true)).toMatch(/not copied into itself/)
  })
})

describe('the difference between two routings', () => {
  it('matches steps by operation and reports added, removed, changed and the minutes per garment', () => {
    const next = [
      { ...ROUTING[1]!, id: 'n-10', seq: 10, standardMinutes: '90' },
      { ...ROUTING[0]!, id: 'n-20', seq: 20 },
      { ...ROUTING[3]!, id: 'n-30', seq: 40 },
      step('n-40', CUT, 50),
    ]
    const diff = diffRoutings(ROUTING, next)
    expect(diff.added.map((entry) => entry.id)).toEqual(['n-40'])
    expect(diff.removed.map((entry) => entry.id)).toEqual(['s-30'])
    expect(diff.changed.map((change) => [change.from.id, change.to.id, change.fields])).toEqual([
      ['s-20', 'n-10', [{ field: 'seq', from: 20, to: 10 }, { field: 'standardMinutes', from: '96.5', to: '90' }]],
      ['s-10', 'n-20', [{ field: 'seq', from: 10, to: 20 }]],
    ])
    expect(diff.unchanged).toBe(1)
    expect(diff.minutes).toEqual({ from: '124.75', to: '126' })
    expect(diffRoutings(ROUTING, ROUTING)).toMatchObject({ added: [], removed: [], changed: [], unchanged: 4 })
  })
})
