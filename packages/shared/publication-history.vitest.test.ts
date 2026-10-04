import { describe, expect, it } from 'vitest'
import {
  HISTORY_KINDS, HISTORY_SEND_ORDER, HISTORY_SOURCES, HISTORY_WHAT, HISTORY_WHAT_KINDS, HISTORY_WHAT_LABEL, LAST_PUBLISH_KIND_LABEL, kindsOfWhat, whatOfKind,
} from './publication-history.js'
import { LISTING_ACTION_LABEL, LISTING_ACTIONS } from './listing-actions.js'

/** Build shape v2 (P7) — the publish history's kinds, its "What" groups and the Last publish kinds. */
describe('publish history vocabulary', () => {
  it('the "What" groups hold every kind exactly once', () => {
    const grouped = HISTORY_WHAT.flatMap(what => HISTORY_WHAT_KINDS[what])
    expect([...grouped].sort()).toEqual([...HISTORY_KINDS].sort())
    expect(new Set(grouped).size).toBe(grouped.length)
    for (const kind of HISTORY_KINDS) expect(HISTORY_WHAT_KINDS[whatOfKind(kind)]).toContain(kind)
    expect(HISTORY_WHAT.map(what => HISTORY_WHAT_LABEL[what])).toEqual(['Updates', 'Selling changes', 'Deletes', 'Photos'])
  })

  it('every selling change is a kind; Delete is its own group, the four Status changes are "Selling changes"', () => {
    for (const action of LISTING_ACTIONS) expect(HISTORY_KINDS).toContain(action)
    expect(kindsOfWhat(['selling'])).toEqual(['pause', 'resume', 'end', 'relist'])
    expect(kindsOfWhat(['deletes'])).toEqual(['delete'])
    expect(kindsOfWhat(['updates', 'photos'])).toEqual(['update', 'create', 'full_update', 'photos'])
    expect(kindsOfWhat([])).toEqual([...HISTORY_KINDS])
  })

  it('the send order names every kind once: Resume/Relist, then content, then Inactive, Ended, Delete', () => {
    expect([...HISTORY_SEND_ORDER].sort()).toEqual([...HISTORY_KINDS].sort())
    const at = (kind: (typeof HISTORY_KINDS)[number]) => HISTORY_SEND_ORDER.indexOf(kind)
    expect(at('resume')).toBeLessThan(at('update'))
    expect(at('update')).toBeLessThan(at('pause'))
    expect(at('pause')).toBeLessThan(at('end'))
    expect(at('end')).toBeLessThan(at('delete'))
  })

  it('selling changes are a history source, ranked right after the product sheet', () => {
    expect(HISTORY_SOURCES.slice(0, 2)).toEqual(['studio', 'listing-action'])
  })

  it('the Last publish kinds use the engine\'s own action words', () => {
    expect(LAST_PUBLISH_KIND_LABEL).toEqual({ publish: 'Publish', full_update: 'Full update', ...LISTING_ACTION_LABEL })
    expect(LAST_PUBLISH_KIND_LABEL.pause).toBe('Pause offer')
  })
})
