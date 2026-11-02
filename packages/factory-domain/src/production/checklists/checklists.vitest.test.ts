import { describe, expect, it } from 'vitest'
import { checklistHold, openSteps, standingTicks, stepsOfInstructions } from './rules'

const INSTRUCTIONS = ['Sew the collar to the neck line.', '', '[ ] TRIM_THREADS Trim the threads', '  [o] POCKET_ZIP Close the pocket zip  ', '[ ] TRIM_THREADS Named twice', '[x] DONE_ALREADY Not a step', '[ ] lower Not a code', '[ ] NO_WORDS'].join('\n')

describe('the steps written in the instructions (MES-102)', () => {
  it('reads required and optional steps in their order; every other line is plain instructions', () => {
    expect(stepsOfInstructions(INSTRUCTIONS)).toEqual([
      { code: 'TRIM_THREADS', words: 'Trim the threads', required: true },
      { code: 'POCKET_ZIP', words: 'Close the pocket zip', required: false },
    ])
  })

  it('an operation with no such line has no checklist', () => {
    expect(stepsOfInstructions(null)).toEqual([])
    expect(stepsOfInstructions('Measure over a thin base layer, arms relaxed.')).toEqual([])
  })
})

describe('what stands and what holds Finish', () => {
  const steps = [
    { code: 'A', words: 'First', required: true },
    { code: 'B', words: 'Second', required: true },
    { code: 'C', words: 'Third', required: false },
    { code: 'D', words: 'Fourth', required: true },
    { code: 'E', words: 'Fifth', required: true },
  ]

  it('the latest tick of a step stands', () => {
    expect(standingTicks([{ stepCode: 'A', outcome: 'DONE' }, { stepCode: 'A', outcome: 'NOT_APPLICABLE' }]).get('A')?.outcome).toBe('NOT_APPLICABLE')
  })

  it('counts only the required steps with no tick; either outcome satisfies one', () => {
    expect(openSteps(steps, [{ stepCode: 'A' }, { stepCode: 'C' }]).map((step) => step.code)).toEqual(['B', 'D', 'E'])
    expect(openSteps(steps, ['A', 'B', 'D', 'E'].map((stepCode) => ({ stepCode })))).toEqual([])
  })

  it('holds Finish in words, not final (it passes once they are ticked)', () => {
    expect(checklistHold([], { bundleCode: 'B-1' })).toBeNull()
    expect(checklistHold(steps.slice(0, 1), { bundleCode: 'B-1' })).toMatchObject({ code: 'CHECKLIST_OPEN', final: false, message: 'Bundle B-1: one step is not ticked yet (First).' })
    expect(checklistHold(steps, { bundleCode: 'B-1' })?.message).toBe('Bundle B-1: 5 steps are not ticked yet (First, Second, Third and 2 more).')
  })
})
