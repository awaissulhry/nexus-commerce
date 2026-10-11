import { describe, expect, it } from 'vitest'

import { activeGroup, changesIn, groupCounts, groupOf, resultTone, type ReviewGroup } from './reviewChangesPanelModel'

const GROUPS: ReviewGroup[] = [
  { id: 'keywords', label: 'Keywords' },
  { id: 'negatives', label: 'Negatives' },
  { id: 'campaign', label: 'New campaign' },
]

describe('reviewChangesPanelModel — the table in tabs', () => {
  const changes = [
    { id: 'k1', group: 'keywords' }, { id: 'n1', group: 'negatives' }, { id: 'n2', group: 'negatives' },
    { id: 'x', group: 'nowhere' }, { id: 'y' },
  ]

  it('a change goes under its own tab, else the first', () => {
    expect(groupOf({ group: 'negatives' }, GROUPS)).toBe('negatives')
    expect(groupOf({ group: 'nowhere' }, GROUPS)).toBe('keywords')
    expect(groupOf({}, GROUPS)).toBe('keywords')
    expect(groupOf({ group: 'keywords' }, [])).toBe(null)
  })

  it('counts each tab in the host order and leaves an empty tab out', () => {
    expect(groupCounts(changes, GROUPS)).toEqual([
      { id: 'keywords', label: 'Keywords', count: 3 },
      { id: 'negatives', label: 'Negatives', count: 2 },
    ])
    expect(groupCounts([], GROUPS)).toEqual([])
    expect(groupCounts(changes, [])).toEqual([])
  })

  it('shows the tab asked for when it has changes, else the first with any', () => {
    const tabs = groupCounts(changes, GROUPS)
    expect(activeGroup(tabs, 'negatives')).toBe('negatives')
    expect(activeGroup(tabs, 'campaign')).toBe('keywords')
    expect(activeGroup(tabs, null)).toBe('keywords')
    expect(activeGroup([], 'keywords')).toBe(null)
  })

  it('lists the changes of the tab shown, or all of them without tabs', () => {
    expect(changesIn(changes, GROUPS, 'negatives').map((c) => c.id)).toEqual(['n1', 'n2'])
    expect(changesIn(changes, GROUPS, 'keywords').map((c) => c.id)).toEqual(['k1', 'x', 'y'])
    expect(changesIn(changes, [], null).map((c) => c.id)).toEqual(['k1', 'n1', 'n2', 'x', 'y'])
  })
})

describe('reviewChangesPanelModel — a Result in its own tone', () => {
  it('keeps the host tone ("Waiting" is not a success); else success / danger', () => {
    expect(resultTone({ ok: true, words: 'Waiting', tone: 'warning' })).toBe('warning')
    expect(resultTone({ ok: true, words: 'Taken back', tone: 'neutral' })).toBe('neutral')
    expect(resultTone({ ok: true, words: 'Saved' })).toBe('success')
    expect(resultTone({ ok: false, words: 'Refused' })).toBe('danger')
  })
})
