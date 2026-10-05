/**
 * CM-18 — the row Bid Multiplier modal, the bulk modal and the campaign detail page send only the lanes the operator
 * changed, with `partial: true`. A lane left alone must never be in the request: the screen's copy of it can be
 * minutes old, and re-sending it undid a move rank-defend made after the page loaded.
 */
import { describe, expect, it } from 'vitest'
import { changedPlacementLanes, lanePercent } from './placementLanes'

const TOP = 'PLACEMENT_TOP', PP = 'PLACEMENT_PRODUCT_PAGE', REST = 'PLACEMENT_REST_OF_SEARCH'

describe('changedPlacementLanes', () => {
  it('sends only the lane the operator changed, not the two it showed from its copy', () => {
    expect(changedPlacementLanes({ tos: 50, pdp: 20, ros: 10 }, { tos: 50, pdp: 20, ros: 35 })).toEqual([{ placement: REST, percentage: 35 }])
  })

  it('sends nothing when nothing changed', () => {
    expect(changedPlacementLanes({ tos: 50, pdp: null, ros: null }, { tos: 50, pdp: null, ros: null })).toEqual([])
    // the detail page's text boxes: '' and '0' both mean 0, so moving between them is no change
    expect(changedPlacementLanes({ tos: '', pdp: '0', ros: '15' }, { tos: '0', pdp: '', ros: '15' })).toEqual([])
  })

  it('an emptied or zeroed lane is sent as 0, so it is cleared rather than silently kept', () => {
    expect(changedPlacementLanes({ tos: '60', pdp: '', ros: '' }, { tos: '', pdp: '', ros: '' })).toEqual([{ placement: TOP, percentage: 0 }])
    expect(changedPlacementLanes({ tos: 60, pdp: 30, ros: null }, { tos: 60, pdp: 0, ros: null })).toEqual([{ placement: PP, percentage: 0 }])
  })

  it('several changed lanes are all sent, as Amazon takes them (whole numbers, 0–900)', () => {
    expect(changedPlacementLanes({ tos: '10', pdp: '10', ros: '10' }, { tos: '12.6', pdp: '1000', ros: '10' }))
      .toEqual([{ placement: TOP, percentage: 13 }, { placement: PP, percentage: 900 }])
  })

  it('a box that does not hold a number sends nothing for that lane', () => {
    expect(changedPlacementLanes({ tos: '50', pdp: '', ros: '' }, { tos: 'abc', pdp: '', ros: '20' })).toEqual([{ placement: REST, percentage: 20 }])
  })
})

describe('lanePercent', () => {
  it('reads empty and missing as 0, and refuses what is not a number', () => {
    expect(lanePercent(null)).toBe(0)
    expect(lanePercent(undefined)).toBe(0)
    expect(lanePercent('  ')).toBe(0)
    expect(lanePercent('45')).toBe(45)
    expect(lanePercent(-5)).toBe(0)
    expect(lanePercent('x')).toBeNull()
  })
})
