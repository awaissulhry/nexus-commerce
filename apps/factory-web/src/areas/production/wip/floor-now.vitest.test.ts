import { describe, expect, it } from 'vitest'
import { carryParty } from '../_shared/customer/model'
import { floorBoardsCan, heldPhrase, mixedSectionsCan, shownOf, withNextPage } from './model'

/**
 * F-PR-17 — Floor now (production plan §5 "held work shown; Customer column; no silent cap"; 09-design R11 "Nothing hidden
 * silently: every capped list says '5 of 11 · See all'"; the brand wall: line totals only for a person who reaches every
 * customer, B-PR-07). Made-up ids only.
 */

const A = '11111111-1111-4111-8111-111111111111'
const row = (id: string, status = 'IN_PROGRESS', holdReason: string | null = null) => ({ workOrder: { id, status }, holdReason })

describe('the sections that add up every customer', () => {
  const can = floorBoardsCan(['production.boards.view', 'production.boards.targets', 'production.bundles.view', 'production.calls.view'])

  it('open for a person who reaches every customer; never read for one limited to some, nor before it is known', () => {
    expect(mixedSectionsCan(can, true)).toEqual(can)
    expect(mixedSectionsCan(can, false)).toEqual({ boards: false, targets: false, bundles: true, calls: true })
    expect(mixedSectionsCan(can, null)).toEqual({ boards: false, targets: false, bundles: true, calls: true })
  })
})

describe('no silent cap', () => {
  it('says "100 of 143" while rows are left, nothing once every row is shown or the total is not known', () => {
    expect(shownOf(100, 143)).toEqual({ shown: 100, total: 143 })
    expect(shownOf(20, 26)).toEqual({ shown: 20, total: 26 })
    expect(shownOf(143, 143)).toBeNull()
    expect(shownOf(12, undefined)).toBeNull()
    expect(shownOf(0, null)).toBeNull()
  })

  it('Show more adds the next page after the rows shown, a row read twice once', () => {
    expect(withNextPage([row('a'), row('b')], [row('b'), row('c')]).map((entry) => entry.workOrder.id)).toEqual(['a', 'b', 'c'])
    expect(withNextPage([], [row('a')]).map((entry) => entry.workOrder.id)).toEqual(['a'])
  })
})

describe('held work is on the floor', () => {
  it('a held work order says so, with its reason when one is kept', () => {
    expect(heldPhrase(row('a', 'ON_HOLD', 'Shade difference on the first panels'))).toEqual({ key: 'floor.heldWhy', params: { reason: 'Shade difference on the first panels' } })
    expect(heldPhrase(row('a', 'ON_HOLD', '  '))).toEqual({ key: 'floor.held' })
    expect(heldPhrase(row('a', 'ON_HOLD'))).toEqual({ key: 'floor.held' })
    expect(heldPhrase(row('a', 'RELEASED'))).toBeNull()
  })
})

describe('the customer filter on Floor now', () => {
  it('is carried to and from the other Production pages', () => {
    expect(carryParty('/w/F1/production/floor', '/production/cutting', new URLSearchParams(`party=${A}`))).toBe(`/w/F1/production/floor?party=${A}`)
    expect(carryParty('/w/F1/production/bundles?stuck=true', '/production/floor', new URLSearchParams(`line=L1&party=${A}`))).toBe(`/w/F1/production/bundles?stuck=true&party=${A}`)
  })
})
