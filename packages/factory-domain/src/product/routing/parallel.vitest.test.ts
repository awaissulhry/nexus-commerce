import { describe, expect, it } from 'vitest'
import { diffRoutings } from './diff'
import { groupProblems, groupsAfter, MAX_PARALLEL_GROUP, nextGroup, parallelGroupProblem, siblingsOf, sideBySide, stepAfter, stepBefore } from './parallel'
import { copySteps, planNewStep, planStepChange, routingIssues, stepChanges, type StepData } from './rules'

/**
 * B-W2b-88 — parallel operations (MES-025): steps with the same parallel group run side by side and count as one step.
 * A made-up routing: 10 cut, 20 sleeves and 30 body side by side (group 1), 40 join, 50 inspect.
 */

const step = (seq: number, parallelGroup: number | null = null, scanRequired = true): StepData => ({
  id: `s-${seq}`,
  seq,
  operationId: `op-${seq}`,
  code: `OP-${seq}`,
  name: `Operation ${seq}`,
  nameI18n: null,
  workCentreKind: 'SEWING',
  standardMinutes: '5',
  scanRequired,
  instructions: null,
  parallelGroup,
})
const ROUTING = [step(10), step(20, 1), step(30, 1), step(40), step(50)]
const seqs = (rows: readonly { readonly seq: number }[]) => rows.map((row) => row.seq)
const library = new Map(ROUTING.map((row) => [row.operationId, { code: row.code, status: 'ACTIVE' as const }]))

describe('the order: a group is one step', () => {
  it('a sibling is never before or after its sibling', () => {
    expect(sideBySide(ROUTING[1]!, ROUTING[2]!)).toBe(true)
    expect(sideBySide(ROUTING[0]!, ROUTING[3]!)).toBe(false)
    expect(seqs(siblingsOf(ROUTING, ROUTING[1]!))).toEqual([30])
    expect(siblingsOf(ROUTING, ROUTING[3]!)).toEqual([])
    expect(seqs(stepBefore(ROUTING, ROUTING[2]!))).toEqual([10])
    expect(seqs(stepBefore(ROUTING, ROUTING[1]!))).toEqual([10])
    expect(seqs(stepAfter(ROUTING, ROUTING[1]!))).toEqual([40])
  })

  it('the step before and after a group is the whole group', () => {
    expect(seqs(stepBefore(ROUTING, ROUTING[3]!))).toEqual([20, 30])
    expect(seqs(stepAfter(ROUTING, ROUTING[0]!))).toEqual([20, 30])
    expect(seqs(stepBefore(ROUTING, ROUTING[4]!))).toEqual([40])
    expect(stepBefore(ROUTING, ROUTING[0]!)).toEqual([])
    expect(stepAfter(ROUTING, ROUTING[4]!)).toEqual([])
    // Rows without the field (older readers) run in sequence.
    expect(seqs(stepBefore([{ seq: 10 }, { seq: 20 }], { seq: 20 }))).toEqual([10])
  })
})

describe('the release check of a routing with groups', () => {
  it('passes a group whose steps follow each other', () => {
    expect(routingIssues(ROUTING, library)).toEqual({ blockers: [], warnings: [] })
  })

  it('refuses a split group and a final operation side by side; warns of a group of one step', () => {
    const split = [step(10, 1), step(20), step(30, 1), step(40)]
    expect(groupProblems(split)).toEqual({ split: [{ group: 1, seqs: [10, 30] }], alone: [] })
    expect(routingIssues(split, library).blockers).toEqual([
      { code: 'PARALLEL_GROUP_SPLIT', stepId: 's-10', message: 'Parallel group 1 (steps 10, 30) is split by other steps: side by side steps follow each other. Move them together.' },
    ])
    const finalTogether = [step(10), step(20, 2), step(30, 2)]
    expect(routingIssues(finalTogether, library).blockers.map((issue) => issue.code)).toEqual(['FINAL_SIDE_BY_SIDE'])
    expect(routingIssues(finalTogether, library).blockers[0]!.stepId).toBe('s-30')
    // A step after them that is scanned makes the last scanned one final: it runs alone.
    expect(routingIssues([...finalTogether, step(40)], library).blockers).toEqual([])
    const alone = [step(10), step(20, 3), step(30)]
    expect(routingIssues(alone, library)).toEqual({ blockers: [], warnings: [{ code: 'PARALLEL_GROUP_ALONE', stepId: 's-20', message: 'Step 20 is alone in parallel group 3: it runs like any step until another step joins it.' }] })
  })
})

describe('typing a group, copying and comparing', () => {
  it('a step takes a group from 1, null takes it back; a new step is in sequence', () => {
    expect(parallelGroupProblem(null)).toBeNull()
    expect(parallelGroupProblem(1)).toBeNull()
    expect(parallelGroupProblem(0)).toBe(`A parallel group is a whole number from 1 to ${MAX_PARALLEL_GROUP}, or none.`)
    expect(parallelGroupProblem(MAX_PARALLEL_GROUP + 1)).not.toBeNull()
    const changed = planStepChange(ROUTING[3]!, { parallelGroup: 2 })
    expect(changed).toMatchObject({ ok: true, step: { parallelGroup: 2 } })
    expect(stepChanges(ROUTING[3]!, changed.ok ? changed.step : ROUTING[3]!)).toEqual(['parallelGroup'])
    expect(planStepChange(ROUTING[1]!, { parallelGroup: null })).toMatchObject({ ok: true, step: { parallelGroup: null } })
    expect(planStepChange(ROUTING[1]!, { parallelGroup: 0 })).toMatchObject({ ok: false, issues: [{ path: 'parallelGroup' }] })
    expect(planStepChange(ROUTING[1]!, { standardMinutes: '6' })).toMatchObject({ ok: true, step: { parallelGroup: 1 } })
    const operation = { id: 'op-x', code: 'OP-X', name: 'X', nameI18n: null, workCentreKind: 'SEWING' as const, standardMinutes: '3', instructions: null, status: 'ACTIVE' as const }
    expect(planNewStep(operation, {}, 60)).toMatchObject({ ok: true, step: { parallelGroup: null } })
    expect(nextGroup(ROUTING)).toBe(2)
    expect(nextGroup([step(10)])).toBe(1)
  })

  it('copied after kept steps, a group is numbered after the kept groups so it never joins one', () => {
    const kept = [step(10, 1), step(20, 1)]
    const groups = groupsAfter(kept, ROUTING)
    expect([...groups]).toEqual([[1, 2]])
    let n = 0
    const copied = copySteps(ROUTING, 30, () => `new-${++n}`, groups)
    expect(copied.map((row) => [row.seq, row.parallelGroup])).toEqual([
      [30, null],
      [40, 2],
      [50, 2],
      [60, null],
      [70, null],
    ])
    expect(groupsAfter([], ROUTING).size).toBe(0)
    expect(copySteps(ROUTING, 10, () => 'x').map((row) => row.parallelGroup)).toEqual([null, 1, 1, null, null])
  })

  it('a compare names a changed group', () => {
    const after = ROUTING.map((row) => (row.seq === 40 ? { ...row, parallelGroup: 1 } : row))
    expect(diffRoutings(ROUTING, after).changed).toEqual([{ from: ROUTING[3], to: after[3], fields: [{ field: 'parallelGroup', from: null, to: 1 }] }])
  })
})
