import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateImpact } from '@/design-system/grid'
import type { AssortmentPlace, FollowedLink, ProductSharing, ShareCopy, SharedField } from './sharingApi'
import {
  copyWords, detachedWords, fieldListWords, fieldName, fieldSource, followingFacts, holdsWords, placeActionLabel, shareStateWords, stockWords, takeOutImpact,
} from './sharingWords'

const product: ProductSharing['product'] = { id: 'p1', sku: 'JKT', rootId: 'p1', rootSku: 'JKT', isVariation: false }
const variation: ProductSharing['product'] = { id: 'p2', sku: 'JKT-M', rootId: 'p1', rootSku: 'JKT', isVariation: true }
const place = (over: Partial<AssortmentPlace> = {}): AssortmentPlace => ({ id: 'a1', name: 'Winter', selection: 'list', version: 3, holds: true, openShares: 1, ...over })
const copy = (over: Partial<ShareCopy> = {}): ShareCopy => ({
  shareId: 's1', assortmentId: 'a1', assortmentName: 'Winter', businessId: 'b', businessName: 'Business B', shareStatus: 'active', copy: 'following',
  heldSku: null, heldReason: null, lastSyncedAt: '2026-09-28T10:00:00Z', lastSyncError: null, detachedReason: null, ...over,
})
const link = (over: Partial<FollowedLink> = {}): FollowedLink => ({
  id: 'l1', shareId: 's1', sourceBusiness: 'Business A', linkedBy: 'created', status: 'active', detachedReason: null, heldSku: null, heldReason: null,
  heldAt: null, lastSyncedAt: null, lastSyncError: null, ...over,
})
const field = (over: Partial<SharedField> = {}): SharedField => ({ key: 'name', label: 'Title', group: 'Content', locale: null, state: 'follow', ...over })

describe('the Other businesses page words', () => {
  it('a followed field and a kept field use the design system’s linked and override marks, naming the other business', () => {
    expect(fieldSource(field(), 'Business A')).toEqual({ kind: 'linked', label: 'Follows Business A', description: 'A change made in Business A arrives here by itself.' })
    expect(fieldSource(field({ state: 'override' }), null)).toMatchObject({ kind: 'override', label: 'Own value', description: expect.stringContaining('the other business') })
    expect(fieldName(field({ locale: 'de' }))).toBe('Title · DE')
  })

  it('the link summary counts the kept fields and never says “0 fields keep”', () => {
    const facts = followingFacts(link({ linkedBy: 'matched' }), [field(), field({ key: 'x', state: 'override' })])
    expect(facts.map((f) => [f.label, f.value, f.hint])).toEqual([
      ['Follows', 'Business A', undefined],
      ['How it was linked', 'A product of this business, linked by its SKU', undefined],
      ['Last updated from there', 'Not yet', undefined],
      ['Fields', '1 field follows', '1 field keeps this business’s own value'],
    ])
    expect(followingFacts(link(), [field()]).at(-1)?.hint).toBeUndefined()
  })

  it('the field list shows the kept fields and puts the followed ones behind one button', () => {
    expect(fieldListWords(2, 218, 'Business A', false)).toEqual({ keptTitle: 'Kept here: 2 fields with this business’s own value', none: null, toggle: 'Show 218 followed fields' })
    expect(fieldListWords(0, 1, 'Business A', true)).toEqual({ keptTitle: null, none: 'Every field follows Business A.', toggle: 'Hide 1 followed field' })
    expect(fieldListWords(0, 0, null, false)).toEqual({ keptTitle: null, none: 'No field is recorded yet. The first update from the other business records them.', toggle: null })
  })

  it('a stopped link says why, and that nothing was deleted', () => {
    const words = detachedWords(link({ status: 'detached', detachedReason: 'deleted in the business that shares it' }))
    expect(words.title).toBe('This product stopped following Business A')
    expect(words.body).toMatch(/^Why: deleted in the business that shares it\. .*Nothing was deleted and no listing ended\.$/)
  })

  it('what another business does with this product: following, a waiting SKU, not copied, not answered, stopped', () => {
    expect(copyWords(copy())).toMatchObject({ label: 'Follows this product', tone: 'success' })
    expect(copyWords(copy({ heldSku: 'JKT-2' }))).toEqual({ label: 'Follows this product', tone: 'warning', hint: 'SKU change to JKT-2 waits there.' })
    expect(copyWords(copy({ copy: 'not-copied' }))).toMatchObject({ label: 'Not copied yet', hint: 'Business B gets it with its next copy of shared products.' })
    expect(copyWords(copy({ copy: 'not-copied', shareStatus: 'pending' }))).toMatchObject({ label: 'Offer not answered yet' })
    expect(copyWords(copy({ copy: 'detached', detachedReason: 'no longer shared' }))).toEqual({ label: 'Stopped following', tone: 'neutral', hint: 'Why: no longer shared' })
    expect(shareStateWords('paused')).toEqual({ label: 'Paused', tone: 'warning' })
  })

  it('an assortment of every product says “leave out”, a list says “take out”, and a variation is held through its main product', () => {
    expect(placeActionLabel(place())).toBe('Take out')
    expect(placeActionLabel(place({ holds: false }))).toBe('Add')
    expect(placeActionLabel(place({ selection: 'all' }))).toBe('Leave out')
    expect(placeActionLabel(place({ selection: 'all', holds: false }))).toBe('Put back')
    expect(holdsWords(place(), variation)).toBe('Yes (with its main product JKT)')
    expect(holdsWords(place({ selection: 'all', holds: false }), product)).toBe('No: left out of “every product”')
  })

  it('taking the product out of an offered assortment asks first, naming each business and what it keeps — and passes the DS confirm rules', () => {
    expect(takeOutImpact(place(), product, [copy({ assortmentId: 'other' })])).toBeNull()
    const impact = takeOutImpact(place(), variation, [copy(), copy({ shareId: 's2', businessName: 'Business C', copy: 'not-copied' })])!
    expect(impact.title).toBe('Take JKT out of Winter?')
    expect(impact.subject).toEqual({ kind: 'sku', value: 'JKT' })
    expect(impact.consequences).toEqual([
      'Business B stops following it. Its copy stays there as its own product, with every value it has now.',
      'Business C will not get it with its next copy.',
      'Nothing is deleted, and no listing ends, in any business.',
      'JKT is the main product: its variations go with it.',
    ])
    expect(validateImpact(impact)).toEqual([])
  })

  it('the stock line names the lender and the number, or says own stock', () => {
    expect(stockWords({ kind: 'own' })).toBe('Sells from this business’s own stock.')
    expect(stockWords({ kind: 'pool', lenderName: 'Business A', available: 12, products: 3 })).toBe('3 variations sell from Business A’s shared stock: 12 available there.')
  })
})

/* apps/web/CLAUDE.md: a studio tab surface owns its scroll, draws tooltips in a portal and sets the DS body size. */
describe('the Other businesses page is a proper studio tab surface', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  it('owns its scroll, up and down only, at the DS body size', () => {
    const page = read('./sharing.module.css').match(/(?:^|\n)\.page\s*\{([^}]*)\}/)?.[1].replace(/\s+/g, ' ') ?? ''
    for (const rule of ['flex: 1;', 'min-height: 0;', 'overflow-y: auto;', 'overflow-x: hidden;', 'font-size: var(--nds-font-size-base);']) expect(page).toContain(rule)
  })
  it('its content sits in a TooltipPortalProvider', () => {
    expect(read('./SharingTab.tsx')).toMatch(/<TooltipPortalProvider>\s*<div className=\{styles\.page\}>/)
  })
})
