/**
 * The Negative Targeting builder's "Stop waste — may run alone" section (wave 4) — the pure half: the form a starter or a
 * saved rule opens on, the field checks, what the first action carries, and why Automate stays held. Values made up.
 */
import { describe, expect, it } from 'vitest'
import { autoHeldBy, EXACT_ONLY_ASKS, exactOnlyBlocks, formOfSaved, formOfStarter, rememberTypes, restoreTypes, sectionProblems, stopWastePayload, windowWords, type MappedGroup, type Starter } from './stopWasteSectionModel'

const TERM: Starter = { kind: 'NEGATE_TERM', windowDays: 60, minClicks: 20, cpaMultiple: 1.5, spendFloorCents: 1500 }
const exactOnly: MappedGroup = { look: true, types: { P: false, E: true, product: false } }

describe('the form', () => {
  it('a starter opens off, its money only when the API gave it', () => {
    expect(formOfStarter(TERM)).toEqual({ on: false, kind: 'NEGATE_TERM', windowDays: '60', minClicks: '20', cpaMultiple: '1.5', spendFloor: '15' })
    expect(formOfStarter({ ...TERM, spendFloorCents: undefined }, true)).toMatchObject({ on: true, spendFloor: null })
  })

  it('a saved rule\'s section reads back on; none, or a kind it does not know, stays off', () => {
    expect(formOfSaved({ kind: 'PAUSE_KEYWORD', windowDays: 30, minClicks: 25, cpaMultiple: 2, spendFloorCents: 2500 }, true))
      .toEqual({ on: true, kind: 'PAUSE_KEYWORD', windowDays: '30', minClicks: '25', cpaMultiple: '2', spendFloor: '25' })
    expect(formOfSaved({ kind: 'PAUSE_KEYWORD', spendFloorCents: 2500 }, false)?.spendFloor).toBeNull()
    expect(formOfSaved(undefined, true)).toBeNull()
    expect(formOfSaved({ kind: 'OTHER' }, true)).toBeNull()
  })
})

describe('the checks and what is saved', () => {
  it('off: nothing to check, nothing carried — an old rule saves exactly as before', () => {
    const off = { ...formOfStarter(TERM), windowDays: 'nonsense' }
    expect(sectionProblems(off)).toEqual({})
    expect(stopWastePayload(off)).toBeNull()
  })

  it('on: the API\'s bounds, a decimal comma read', () => {
    const on = formOfStarter(TERM, true)
    expect(sectionProblems(on)).toEqual({})
    expect(stopWastePayload({ ...on, cpaMultiple: '2,5', spendFloor: '12,5' })).toEqual({ kind: 'NEGATE_TERM', windowDays: 60, minClicks: 20, cpaMultiple: 2.5, spendFloorCents: 1250 })
    expect(Object.keys(sectionProblems({ ...on, windowDays: '88', minClicks: '0', cpaMultiple: '11', spendFloor: '0' }))).toEqual(['windowDays', 'minClicks', 'cpaMultiple', 'spendFloor'])
    expect(sectionProblems({ ...on, windowDays: '30.5' }).windowDays).toMatch(/whole number of days, 14 to 87/)
    expect(stopWastePayload({ ...on, minClicks: '' })).toBeNull()
    // Money hidden: no bar is sent, the API keeps its default.
    expect(stopWastePayload({ ...on, spendFloor: null })).not.toHaveProperty('spendFloorCents')
  })
})

describe('Automate: may run alone, or why it stays held (the API\'s own shape and words)', () => {
  const on = formOfStarter(TERM, true)
  it('a negative exact only — E where it looks, no P or product target anywhere — at ad-group level: may run alone', () => {
    expect(autoHeldBy(on, { negationLevel: 'adgroup', groups: [exactOnly, { look: false, types: { P: false, E: true, product: false } }] })).toBeNull()
  })
  it('a phrase or a product target ticked (where it looks or not), E missing, a campaign-level negative, or no ad group: held, with why', () => {
    expect(autoHeldBy(on, { negationLevel: 'adgroup', groups: [{ look: true, types: { P: true, E: true, product: false } }] })).toBe(EXACT_ONLY_ASKS)
    expect(autoHeldBy(on, { negationLevel: 'adgroup', groups: [exactOnly, { look: false, types: { P: false, E: false, product: true } }] })).toBe(EXACT_ONLY_ASKS)
    expect(autoHeldBy(on, { negationLevel: 'adgroup', groups: [{ look: true, types: { P: false, E: false, product: false } }] })).toBe(EXACT_ONLY_ASKS)
    expect(autoHeldBy(on, { negationLevel: 'both', groups: [exactOnly] })).toMatch(/Negation Level to Ad Group/)
    expect(autoHeldBy(on, { negationLevel: 'adgroup', groups: [] })).toMatch(/Add an ad group/)
  })
  it('"Pause keyword, keep it paused" and the section off are never held here', () => {
    expect(autoHeldBy({ ...on, kind: 'PAUSE_KEYWORD' }, { negationLevel: 'campaign', groups: [] })).toBeNull()
    expect(autoHeldBy({ ...on, on: false }, { negationLevel: 'campaign', groups: [] })).toBeNull()
  })
})

describe('audit M2 / S1 — "Negative exact" makes exact negatives only; one window', () => {
  const g = (P: boolean, E: boolean, product: boolean) => ({ id: 'x', look: true, types: { P, E, product } })
  it('switches the mapping\'s P and product targets off, E kept; the same blocks back when nothing changes', () => {
    const blocks = [{ id: 1, groups: [g(true, true, false), g(false, true, true)] }]
    expect(exactOnlyBlocks(blocks)).toEqual([{ id: 1, groups: [g(false, true, false), g(false, true, false)] }])
    const clean = [{ id: 1, groups: [g(false, true, false)] }]
    expect(exactOnlyBlocks(clean)).toBe(clean)
  })
  it('the criteria are read over the safe test\'s window, said once', () => {
    expect(windowWords(formOfStarter(TERM, true))).toMatch(/^With Stop waste on, the criteria are read over the safe test's window: 60 click-days, clicks and spend up to 3 days ago, orders up to today/)
    expect(windowWords({ ...formOfStarter(TERM, true), windowDays: 'x' })).toMatch(/window: its window,/)
  })
})

describe('audit R-S1 — "Negative exact" remembers the ticks it holds and gives them back exactly', () => {
  const blocks = [{ id: 1, groups: [{ id: 'a', types: { P: true, E: true, product: false } }, { id: 'b', types: { P: false, E: true, product: true } }, { id: 'c', types: { P: false, E: true, product: false } }] }]
  it('remembers each row\'s P and product before they go off; a row it holds keeps its first memory', () => {
    const before = rememberTypes(blocks, new Map())
    expect([...before]).toEqual([['1:a', { P: true, product: false }], ['1:b', { P: false, product: true }]])
    expect(rememberTypes(exactOnlyBlocks(blocks), before)).toEqual(before)
  })
  it('off again: every held row back exactly, the others untouched; nothing remembered, nothing changed', () => {
    const before = rememberTypes(blocks, new Map())
    expect(restoreTypes(exactOnlyBlocks(blocks), before)).toEqual(blocks)
    expect(restoreTypes(blocks, new Map())).toBe(blocks)
  })
})
