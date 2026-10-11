import { describe, expect, it } from 'vitest'
import { mergeOrder, placeColumns, seedChoices, strayColumns } from './columnChoices'

describe('the person\'s column picks survive a column leaving and coming back (use audit A3)', () => {
  it('seeds shown / hidden from the store, then the saved grid state', () => {
    const map = seedChoices({ auto: true, goal: false }, { columnOrder: { orderedColIds: ['keyword', 'goal'] }, columnVisibility: { hiddenColIds: ['spark'] } })
    expect(Object.fromEntries(map)).toEqual({ auto: true, goal: false, keyword: false, spark: true })
  })

  it('names the columns whose state is not the one the person left them in', () => {
    const known = new Map([['auto', true], ['spark', false]])
    expect(strayColumns([{ colId: 'auto', hide: false }, { colId: 'spark', hide: false }, { colId: 'match', hide: true }], known)).toEqual([{ colId: 'auto', hide: true }])
  })

  it('keeps an absent column in its place, and puts it back there when it returns', () => {
    // The person's order with Auto after Who; a market without Auto; back again.
    const mine = ['keyword', 'owner', 'auto', 'bidNow', 'spark', 'match']
    const withoutAuto = ['keyword', 'owner', 'bidNow', 'spark', 'match']
    const remembered = mergeOrder(mine, withoutAuto)
    expect(remembered).toEqual(mine)
    // AG put the returning column at the end: it goes back after Who.
    expect(placeColumns(remembered, [...withoutAuto, 'auto'])).toEqual(mine)
    // A column never seen before stays where its definitions put it.
    expect(placeColumns(remembered, ['keyword', 'owner', 'goal', 'bidNow', 'spark', 'match'])).toEqual(['keyword', 'owner', 'goal', 'bidNow', 'spark', 'match'])
  })
})
