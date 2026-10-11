import { describe, expect, it } from 'vitest'
import { morePages } from './useTermsRead'
import { chunked, DECIDE_MAX, reskipDays, SKIP_MAX, UNDO_MAX } from './useTermsReview'
import { TERM_COLUMN_SPECS, actionCellKeys, goesToKeys, termColumns, rowMenu, rowVerbs, type TermsCellHandlers } from './termsColumns'
import type { HarvestCandidateRow } from '../_shared/types'

const noop = () => {}
const handlers = (over: Partial<TermsCellHandlers> = {}): { current: TermsCellHandlers } => ({
  current: {
    open: noop, harvest: noop, harvestTo: noop, decide: noop, skip: noop, unskip: noop, undo: noop, copy: noop,
    manageHeld: null, writeHeld: () => null, ...over,
  },
})
const row = (over: Partial<HarvestCandidateRow>): HarvestCandidateRow => ({
  id: 'IT|p1|t', term: 't', kind: 'keyword', market: 'IT', currency: 'EUR', product: { id: 'p1', name: 'P' }, source: null, sources: [],
  metrics: { windowDays: 60, impressions: 0, clicks: 0, orders: 0 }, bar: { by: 'brain', label: '', passes: true }, state: 'READY',
  owner: { kind: 'NONE', id: null, name: 'Nobody' }, heldBy: null, destination: null, funnel: [], bidWhy: null, skipped: null, waiting: null, lastHarvest: null,
  ...over,
})

describe('the read', () => {
  it('reads every page after the first, at most ten in all', () => {
    expect(morePages(0)).toEqual([])
    expect(morePages(500)).toEqual([])
    expect(morePages(501)).toEqual([2])
    expect(morePages(1600)).toEqual([2, 3, 4])
    expect(morePages(100_000)).toHaveLength(9)
  })
})

describe('R6: past the routes\' caps every action is sent in the pieces they take', () => {
  it('decide and undo ≤ 200 a call, skip ≤ 5,000', () => {
    expect([DECIDE_MAX, UNDO_MAX, SKIP_MAX]).toEqual([200, 200, 5000])
    const ids = Array.from({ length: 450 }, (_, i) => `id${i}`)
    expect(chunked(ids, 200).map((p) => p.length)).toEqual([200, 200, 50])
    expect(chunked(ids, 200).flat()).toEqual(ids)
    expect(chunked([], 200)).toEqual([])
  })
})

describe('Undo of an unskip skips again', () => {
  const now = Date.parse('2026-10-11T00:00:00Z')
  it('for good stays for good; a timed skip comes back as 7 d or 30 d', () => {
    expect(reskipDays(null, now)).toBeNull()
    expect(reskipDays('2026-10-15T00:00:00Z', now)).toBe(7)
    expect(reskipDays('2026-11-01T00:00:00Z', now)).toBe(30)
  })
})

describe('the columns', () => {
  it('one registry: every desktop column has a spec, Search term first and locked, ⋯ last', () => {
    const cols = termColumns(false, handlers())
    const ids = cols.map((c) => c.colId)
    expect(ids[0]).toBe('term')
    expect(ids[ids.length - 1]).toBe('actions')
    for (const spec of TERM_COLUMN_SPECS) expect(ids).toContain(spec.key)
    expect(TERM_COLUMN_SPECS[0]).toMatchObject({ key: 'term', locked: true })
    const hidden = cols.filter((c) => c.hide).map((c) => c.colId)
    expect(hidden).toEqual(TERM_COLUMN_SPECS.filter((c) => c.hidden).map((c) => c.key))
  })
  it('the ⋯ cell answers Enter with the first verb and Space with the menu (M10)', () => {
    let clicked = ''
    const button = (name: string) => ({ click: () => { clicked = name } })
    const cell = {
      closest: () => null,
      querySelector: (sel: string) => (sel.includes('aria-haspopup]') && !sel.includes(':not') ? button('menu') : button('verb')),
    }
    const ev = (key: string, shiftKey = false) => ({ event: { key, shiftKey, type: 'keydown', target: cell, preventDefault: () => {} }, editing: false })
    expect(actionCellKeys(ev('Enter'))).toBe(true)
    expect(clicked).toBe('verb')
    expect(actionCellKeys(ev(' '))).toBe(true)
    expect(clicked).toBe('menu')
    expect(actionCellKeys(ev('ArrowDown'))).toBe(false)
  })
  it('Goes to: Enter follows the ad group, Shift+Enter the campaign (M10)', () => {
    let clicked = ''
    const links = [{ click: () => { clicked = 'adGroup' } }, { click: () => { clicked = 'campaign' } }]
    const cell = { closest: () => null, querySelectorAll: () => links }
    const ev = (shiftKey: boolean) => ({ event: { key: 'Enter', shiftKey, type: 'keydown', target: cell, preventDefault: () => {} }, editing: false })
    expect(goesToKeys(ev(false))).toBe(true)
    expect(clicked).toBe('adGroup')
    expect(goesToKeys(ev(true))).toBe(true)
    expect(clicked).toBe('campaign')
  })
  it('a phone gets two columns: the term and its two numbers, no ⋯', () => {
    expect(termColumns(true, handlers()).map((c) => c.colId)).toEqual(['term', 'phoneNumbers'])
  })
})

describe('row verbs', () => {
  it('the verb each state waits for', () => {
    const verbs = rowVerbs(handlers())
    expect(verbs(row({ state: 'READY' })).map((v) => v.id)).toEqual(['harvest'])
    expect(verbs(row({ state: 'WAITING', waiting: { approvalId: 'a', by: { kind: 'BRAIN', id: null }, at: '', expiresAt: null } })).map((v) => v.id)).toEqual(['approve', 'reject'])
    expect(verbs(row({ state: 'SKIPPED' })).map((v) => v.id)).toEqual(['unskip'])
    expect(verbs(row({ state: 'AT_HOME' }))).toEqual([])
  })
  it('a market Nexus only reads holds what reaches Amazon, never Reject', () => {
    const ctx = handlers({ writeHeld: () => 'Nexus only reads IT' })
    const verbs = rowVerbs(ctx)
    const w = row({ state: 'WAITING', waiting: { approvalId: 'a', by: { kind: 'BRAIN', id: null }, at: '', expiresAt: null } })
    const [approve, reject] = verbs(w)
    expect(approve!.disabled?.(w)).toBe('Nexus only reads IT')
    expect(reject!.disabled?.(w)).toBeNull()
    const [harvest] = verbs(row({}))
    expect(harvest!.disabled?.(row({}))).toBe('Nexus only reads IT')
  })
  it('the ⋯ menu lists only what the state can take (S17); a permission hold stays with its reason', () => {
    const harvested = row({ state: 'HARVESTED', lastHarvest: { harvestId: 'h', at: '', by: { kind: 'PERSON', id: null }, status: 'DONE', verdict: null, undo: { available: true, why: null }, keyword: { state: 'ENABLED' }, judge: null } })
    const items = rowMenu(handlers(), harvested)
    expect(items.map((i) => i.id)).toEqual(['open', 'undo', 'sep', 'copy'])
    const waitingRow = row({ state: 'WAITING', waiting: { approvalId: 'a', by: { kind: 'BRAIN', id: null }, at: '', expiresAt: null } })
    expect(rowMenu(handlers(), waitingRow).map((i) => i.id)).toEqual(['open', 'sep', 'copy'])
    const ready = rowMenu(handlers({ manageHeld: 'Needs the permission to manage campaigns' }), row({}))
    expect(ready.find((i) => i.id === 'skip7')).toMatchObject({ disabled: true, description: 'Needs the permission to manage campaigns' })
  })
})
