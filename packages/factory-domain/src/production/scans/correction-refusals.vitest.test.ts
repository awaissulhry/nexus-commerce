import { describe, expect, it } from 'vitest'
import { CORRECTION_REFUSAL_REASONS, CORRECTION_REFUSAL_TILES, correctionRefusalNeedsWords, correctionRefusalNote } from './correction-refusals'
import { selfApprovalRefusal } from './rules'

// B-W2b-83: why a team leader refuses a correction on the tablet (design floor.supervisor: Reject needs a reason tile).
describe('a correction refused on the tablet', () => {
  it('has a tile for every reason, in both languages; only Other asks for words', () => {
    expect(CORRECTION_REFUSAL_TILES.map((tile) => tile.code)).toEqual([...CORRECTION_REFUSAL_REASONS])
    for (const tile of CORRECTION_REFUSAL_TILES) expect(tile.labelIt && tile.labelEn).toBeTruthy()
    expect(CORRECTION_REFUSAL_TILES.filter((tile) => tile.needsDetail).map((tile) => tile.code)).toEqual(['OTHER'])
    expect(correctionRefusalNeedsWords('OTHER', '  ')).toBe(true)
    expect(correctionRefusalNeedsWords('OTHER', 'It cleans off.')).toBe(false)
    expect(correctionRefusalNeedsWords('RECORDED_RIGHT', null)).toBe(false)
  })

  it('keeps the tile in words, then the lead’s own: never an empty note (the trigger asks why)', () => {
    expect(correctionRefusalNote('RECORDED_RIGHT', null)).toBe('The recorded count is right')
    expect(correctionRefusalNote('COUNTS_WRONG', '  ')).toBe('The new counts are wrong')
    expect(correctionRefusalNote('OTHER', ' It cleans off. ')).toBe('Other: It cleans off.')
  })

  it('names four eyes as a refusal of either decision', () => {
    expect(selfApprovalRefusal()).toMatchObject({ code: 'SELF_APPROVAL', final: true })
  })
})
