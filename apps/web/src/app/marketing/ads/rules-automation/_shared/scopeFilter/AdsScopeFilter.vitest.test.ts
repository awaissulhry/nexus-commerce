import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AdsScopeFilter, scopeChips } from './AdsScopeFilter'
import { NO_PICKS, buildIndex, scopeDimensions, type ScopePicks } from './scopeFilterModel'
import type { ScopeFilter } from './useScopeFilter'

/** The bar as the three pages draw it (first render: desktop, open). */
const index = buildIndex({
  campaigns: [{ id: 'c1', name: 'Boots Exact', marketplace: 'IT', portfolioId: 'p1' }],
  portfolios: [{ externalPortfolioId: 'p1', name: 'Boots' }],
  productLines: [{ id: 'L1', sku: 'BOOT', name: 'Boot', campaigns: ['c1'] }],
  adGroups: [{ id: 'g1', name: 'Exact', campaignId: 'c1' }],
}, 'IT')
const filter = (over: Partial<ScopeFilter> = {}, picks: ScopePicks = NO_PICKS): ScopeFilter => ({
  picks, active: false, count: 0, key: '', api: {}, reach: null, pending: false, index, state: 'ready', error: null,
  retry: () => {}, set: () => {}, clear: () => {}, ...over,
})
const render = (f: ScopeFilter, unfiltered?: string) => renderToStaticMarkup(createElement(AdsScopeFilter, { filter: f, ...(unfiltered ? { unfiltered } : {}) }))

describe('AdsScopeFilter', () => {
  it('four labelled lists, each named by its label and value', () => {
    const html = render(filter())
    expect([...html.matchAll(/<span class="flbl" id="[^"]+">([^<]+)<\/span>/g)].map((m) => m[1])).toEqual(['Portfolio', 'Campaign', 'Ad group', 'Product'])
    expect(html.match(/aria-labelledby="/g)).toHaveLength(4)
    expect(html).not.toContain('aria-disabled')
    expect(html).toContain('aria-label="Hide filters"')
  })

  it('lists not read: a banner with Try again, and why the picks it cannot narrow show every row', () => {
    const html = render(filter({ index: null, state: 'failed', error: 'HTTP 503', active: true, count: 1 }, { ...NO_PICKS, campaign: ['c1'] }), 'Rules and sources')
    expect(html).toContain('Filter lists not read')
    expect(html).toContain('HTTP 503 · Rules and sources show unfiltered until they are read.')
    expect(html).toContain('Try again')
    expect(html.match(/aria-description="Not read: HTTP 503"/g)).toHaveLength(4)
  })

  it('while the lists are read: no banner, every list held with why', () => {
    const html = render(filter({ index: null, state: 'reading' }))
    expect(html).not.toContain('Filter lists not read')
    expect(html.match(/aria-description="Reading the list"/g)).toHaveLength(4)
  })

  it('the Negative Targeting redesign: one inline row with the page\'s own fields, one Clear for all (Bid and Harvest keep the panel)', () => {
    const extra = [{ key: 'kind', label: 'Kind', kind: 'listbox' as const, value: '', options: [{ value: '', label: 'All' }, { value: 'term', label: 'Search terms' }], onChange: () => {} }]
    const html = renderToStaticMarkup(createElement(AdsScopeFilter, { filter: filter(), layout: 'inline', extraDimensions: extra, extraActive: 0 }))
    expect([...html.matchAll(/<span class="flbl" id="[^"]+">([^<]+)<\/span>/g)].map((m) => m[1])).toEqual(['Portfolio', 'Campaign', 'Ad group', 'Product', 'Kind'])
    expect(html).not.toContain('aria-label="Hide filters"')
    expect(render(filter())).toContain('aria-label="Hide filters"')
  })

  it('every pick as a chip\'s words; a pick the lists do not name yet shows by its id', () => {
    const lists = scopeDimensions({ ...NO_PICKS, campaign: ['c1'], product: ['zz'] }, index, 'ready')
    expect(scopeChips(lists).map((c) => [c.key, c.text, c.removeLabel])).toEqual([
      ['campaign', 'Campaign: Boots Exact', 'Show every campaign, not only Boots Exact'],
      ['product', 'Product: zz', 'Show every product, not only zz'],
    ])
    expect(scopeChips(scopeDimensions(NO_PICKS, index, 'ready'))).toEqual([])
  })
})
