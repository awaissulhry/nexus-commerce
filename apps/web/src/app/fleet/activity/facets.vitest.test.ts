import { describe, expect, it } from 'vitest'
import { hiddenByScope, reconcilePoll, type FacetSnapshot, type PageLike } from './poll-view'

/**
 * NAF.SB.ACT.S3R Phase 0 — the regression these tests exist for is study §18.9:
 * a scope line reading 33 events sixty pixels above chips summing to 37, live
 * on production, because the facets were fetched once and the list every ten
 * seconds.
 *
 * Every test here asserts the same one thing from a different angle: the page
 * and the facets the reader is looking at came from the SAME read.
 */

const page = (ids: string[], total = ids.length): PageLike => ({
  events: ids.map((id) => ({ id })),
  total,
})

const facets = (total: number, kinds: Record<string, number> = {}): FacetSnapshot => ({
  actors: [{ key: 'amazon-bid-tuner', name: 'Bid tuner', kind: 'worker' }],
  countsByKind: kinds,
  total,
})

describe('reconcilePoll', () => {
  it('adopts the first read, page and facets together', () => {
    const next = { page: page(['a', 'b']), facets: facets(2) }
    const r = reconcilePoll(null, next, new Set())
    expect(r.action).toBe('adopt')
    expect(r.view).toBe(next)
  })

  it('adopts when nothing new arrived', () => {
    const shown = page(['a', 'b'])
    const next = { page: page(['a', 'b']), facets: facets(2) }
    const r = reconcilePoll(shown, next, new Set(['a', 'b']))
    expect(r.action).toBe('adopt')
    expect(r.fresh).toBe(0)
  })

  it('HOLDS when new events arrive, so rows never shift under the reader', () => {
    const shown = page(['a', 'b'])
    const next = { page: page(['c', 'a', 'b']), facets: facets(3) }
    const r = reconcilePoll(shown, next, new Set(['a', 'b']))
    expect(r.action).toBe('hold')
    expect(r.fresh).toBe(1)
  })

  it('measures "new" on ids, never on totals — a cost ticking up is not news', () => {
    const shown = page(['a', 'b'], 2)
    // same events, a different total (an event elsewhere in the stream changed)
    const next = { page: page(['a', 'b'], 99), facets: facets(99) }
    expect(reconcilePoll(shown, next, new Set(['a', 'b'])).action).toBe('adopt')
  })

  /**
   * THE REGRESSION. Whatever the verdict, the facets returned are the ones read
   * beside that page — there is no path that yields one without the other, so
   * the chips cannot describe rows the list is not showing.
   */
  it('never yields a page without the facets read with it', () => {
    const shown = page(['a'])
    const cases: Array<{ ids: string[]; total: number }> = [
      { ids: ['a'], total: 1 },
      { ids: ['b', 'a'], total: 2 },
      { ids: [], total: 0 },
    ]
    for (const c of cases) {
      const view = { page: page(c.ids, c.total), facets: facets(c.total) }
      const r = reconcilePoll(shown, view, new Set(['a']))
      expect(r.view.page).toBe(view.page)
      expect(r.view.facets).toBe(view.facets)
      expect(r.view.facets!.total).toBe(r.view.page.total)
    }
  })

  it('a failed facet read still travels as a pair, and is never silently reused', () => {
    const shown = page(['a'])
    const r = reconcilePoll(shown, { page: page(['a']), facets: null }, new Set(['a']))
    expect(r.action).toBe('adopt')
    expect(r.view.facets).toBeNull()
  })

  it('holds a pair whose facets failed rather than adopting half of it', () => {
    const shown = page(['a'])
    const r = reconcilePoll(shown, { page: page(['b', 'a']), facets: null }, new Set(['a']))
    expect(r.action).toBe('hold')
    expect(r.view.facets).toBeNull()
  })
})

describe('hiddenByScope', () => {
  it('is the difference between the whole history and the current scope', () => {
    // The live numbers: 119 on record, 33 with the self-test hidden.
    expect(hiddenByScope(119, facets(33))).toBe(86)
  })

  it('is zero when nothing is hidden', () => {
    expect(hiddenByScope(119, facets(119))).toBe(0)
  })

  it('never goes negative when the two reads disagree mid-flight', () => {
    expect(hiddenByScope(33, facets(119))).toBe(0)
  })

  it('says nothing rather than guessing when either read is missing', () => {
    expect(hiddenByScope(null, facets(33))).toBe(0)
    expect(hiddenByScope(119, null)).toBe(0)
  })
})
