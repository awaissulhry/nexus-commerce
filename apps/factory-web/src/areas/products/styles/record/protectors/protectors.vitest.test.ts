import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../../lib/api/errors'
import { REVISIONS } from '../../demo/fixtures'
import { demoProtectors, PLACEMENTS, PROTECTOR } from './fixtures'
import { cellPatch, draftOf, draftPatch, draftProblems, findingWords, markKey, movedOrder, overlapWith, protectorsHeld, shownValue, sizesText, withProtector } from './protectors-model'
import { placementProblem } from './use-protectors'

/** B-W2b-233 (SCR-287): the Protector placement section's rules and words, with made-up data. */

const view = demoProtectors()
const RANGE = view.style.sizes
const [shoulder, elbow, back] = PLACEMENTS as [(typeof PLACEMENTS)[0], (typeof PLACEMENTS)[0], (typeof PLACEMENTS)[0]]

describe('who may change the placement (PRD-074)', () => {
  it('holds without the right, on a frozen revision, on an archived style, under the style’s rule', () => {
    expect(protectorsHeld(view, true)).toBeNull()
    expect(protectorsHeld(view, false)).toBe('protectors.held.noManage')
    expect(protectorsHeld(demoProtectors({ revision: REVISIONS[1] }), true)).toBe('protectors.held.frozen')
    expect(protectorsHeld({ ...view, style: { ...view.style, status: 'ARCHIVED' } }, true)).toBe('protectors.held.archived')
    expect(protectorsHeld(demoProtectors({ rule: true }), true)).toBe('protectors.held.rule')
  })
})

describe('words', () => {
  it('reads sizes as people do', () => {
    expect(sizesText([], RANGE)).toEqual({ key: 'protectors.sizes.all' })
    expect(sizesText(['46', '48', '50', '52', '54'], RANGE)).toEqual({ key: 'protectors.sizes.run', params: { from: '46', to: '54' } })
    expect(sizesText(['50', '54'], RANGE)).toEqual({ key: 'protectors.sizes.some', params: { sizes: '50, 54' } })
  })

  it('says a finding from its code and figures; the pocket as a key of its own', () => {
    const bom = view.findings.find((finding) => finding.code === 'BOM_NOT_PLACED')!
    expect(findingWords(bom)).toMatchObject({ key: 'protectors.finding.BOM_NOT_PLACED', params: { item: 'DEMO-PRO-S2', sizes: '56, 58' }, pocket: null })
    expect(findingWords({ ...bom, params: { ...bom.params, all: 'yes' } }).key).toBe('protectors.finding.BOM_NOT_PLACED_ALL')
    expect(findingWords(view.findings[0]!)).toMatchObject({ key: 'protectors.finding.NOT_IN_BOM', pocket: 'ELBOW' })
  })

  it('says a refused write in its own words', () => {
    expect(placementProblem(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/sizes', message: 'x' }]))).toBe('protectors.problem.overlap')
    expect(placementProblem(new ApiError('conflict', 409, 'version_conflict', 'x'))).toBe('protectors.problem.moved')
    expect(placementProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/EDIT_BLOCKED', message: 'x' }]))).toBe('protectors.held.rule')
  })
})

describe('a cell checked before it goes', () => {
  it('a second protector in one pocket and size is refused before the write', () => {
    expect(cellPatch(back, 'pocket', 'ELBOW', view)).toEqual({ problem: 'protectors.problem.overlap' })
    expect(cellPatch(back, 'pocket', 'HIP', view)).toEqual({ patch: { pocket: 'HIP' } })
    expect(cellPatch(shoulder, 'sizes', ['58', '56'], view)).toEqual({ patch: { sizes: ['56', '58'] } })
    expect(cellPatch(shoulder, 'sizes', ['62'], view)).toEqual({ problem: 'protectors.problem.size' })
    expect(overlapWith(view.placements, { id: null, pocket: 'SHOULDER', sizes: ['56'] }, RANGE)).toBeNull()
    expect(overlapWith(view.placements, { id: null, pocket: 'SHOULDER', sizes: [] }, RANGE)?.seq).toBe(1)
  })

  it('a standard with its edition, level 1 or 2, an offered protector, a note of 500 at most', () => {
    expect(cellPatch(elbow, 'standard', ' EN 1621-1:2012 ', view)).toEqual({ patch: { standard: 'EN 1621-1:2012' } })
    expect(cellPatch(elbow, 'standard', '  ', view)).toEqual({ problem: 'protectors.problem.standard' })
    expect(cellPatch(elbow, 'level', '3', view)).toEqual({ problem: 'protectors.problem.level' })
    expect(cellPatch(elbow, 'protectorItemId', 'nope', view)).toEqual({ problem: 'protectors.problem.protector' })
    expect(cellPatch(elbow, 'positionNote', '   ', view)).toEqual({ patch: { positionNote: null } })
    expect(cellPatch(elbow, 'positionNote', 'x'.repeat(501), view)).toEqual({ problem: 'protectors.problem.note' })
  })

  it('shows the value typed while it saves, the stored one after a refusal', () => {
    expect(shownValue(elbow, 'level', { [markKey(elbow.id, 'level')]: { state: 'saving', value: '2' } })).toBe('2')
    expect(shownValue(elbow, 'level', { [markKey(elbow.id, 'level')]: { state: 'refused', value: '2', problem: 'x' } })).toBe('1')
    expect(shownValue(elbow, 'protectorItemId', {})).toBe(PROTECTOR.limb)
  })
})

describe('the placement dialog and the order', () => {
  it('a new placement takes the protector in the BOM and its own standard and level', () => {
    const draft = draftOf(null, view)
    expect(draft).toMatchObject({ protectorItemId: PROTECTOR.shoulder, standard: 'EN 1621-1:2012', level: '2' })
    const hip = withProtector({ ...draft, pocket: 'HIP' }, view.choices.find((choice) => choice.id === PROTECTOR.hip)!)
    expect(hip).toMatchObject({ protectorItemId: PROTECTOR.hip, level: '1' })
    expect(draftProblems({ ...hip, sizes: [] }, view, null, false)).toEqual({})
    expect(draftProblems({ ...draft, sizes: ['50'] }, view, null, true)).toEqual({ sizes: 'protectors.problem.overlap' })
    expect(draftProblems({ ...draft, sizes: [] }, view, null, true)).toEqual({ sizes: 'protectors.sizes.pickOne' })
    expect(draftPatch({ ...hip, positionNote: ' Fianco ' }, null, false)).toEqual({ pocket: 'HIP', protectorItemId: PROTECTOR.hip, standard: 'EN 1621-1:2012', level: '1', sizes: [], positionNote: 'Fianco' })
  })

  it('an open placement sends only what changed', () => {
    const draft = draftOf(elbow, view)
    expect(draftPatch(draft, elbow, false)).toEqual({})
    expect(draftPatch({ ...draft, level: '2' }, elbow, false)).toEqual({ level: '2' })
  })

  it('moves one up or down, never past an end', () => {
    expect(movedOrder(view.placements, elbow.id, -1)).toEqual([elbow.id, shoulder.id, back.id])
    expect(movedOrder(view.placements, shoulder.id, -1)).toBeNull()
  })
})
