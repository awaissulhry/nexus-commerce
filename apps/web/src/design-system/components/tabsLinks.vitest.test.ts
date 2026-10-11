import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Tabs, type TabItem } from './Tabs'
import { activeTabFromPath } from './tabsRoute'

const TABS: TabItem[] = [
  { id: 'apply', label: 'Apply Rules', href: '/marketing/ads/rules-automation/apply-rules' },
  { id: 'bid', label: 'Bid', href: '/marketing/ads/rules-automation/bid', count: 3 },
  { id: 'hours', label: 'Hourly Bids', href: '/marketing/ads/rules-automation/dayparting', count: null },
  { id: 'soon', label: 'Soon (not built yet)', disabled: true },
]

describe('activeTabFromPath — the tab of the page you are on', () => {
  it('matches the route exactly or the deepest tab it sits under', () => {
    expect(activeTabFromPath(TABS, '/marketing/ads/rules-automation/bid')).toBe('bid')
    expect(activeTabFromPath(TABS, '/marketing/ads/rules-automation/bid/rule-7')).toBe('bid')
    expect(activeTabFromPath(TABS, '/marketing/ads/rules-automation/keyword-harvest')).toBe(null)
    const nested = [{ id: 'ads', href: '/marketing/ads' }, { id: 'bid', href: '/marketing/ads/rules-automation/bid' }]
    expect(activeTabFromPath(nested, '/marketing/ads/rules-automation/bid/rule-7')).toBe('bid')
    expect(activeTabFromPath(nested, '/marketing/ads/campaigns')).toBe('ads')
  })
  it('ignores the query, the hash and a trailing slash; matches whole segments only', () => {
    expect(activeTabFromPath(TABS, '/marketing/ads/rules-automation/bid/?market=IT#x')).toBe('bid')
    expect(activeTabFromPath(TABS, '/marketing/ads/rules-automation/bidding')).toBe(null)
    expect(activeTabFromPath(TABS, '/settings')).toBe(null)
    expect(activeTabFromPath(TABS, null)).toBe(null)
  })
})

const A = ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement('a', { href, ...rest }, children)
const render = (active: string) => renderToStaticMarkup(createElement(Tabs, { ariaLabel: 'Rules and automation', tabs: TABS, active, linkAs: A }))

describe('Tabs with hrefs — a nav of real links', () => {
  it('draws a nav of anchors, the active one aria-current, counts as before (null draws none)', () => {
    const html = render('bid')
    expect(html.startsWith('<nav class="nds-tabs" aria-label="Rules and automation">')).toBe(true)
    expect(html).not.toContain('role="tablist"')
    expect(html).toContain('<a href="/marketing/ads/rules-automation/bid" data-tab-id="bid" class="nds-tab on" aria-current="page">Bid<span class="nds-tab-count">3</span></a>')
    expect(html).toContain('<a href="/marketing/ads/rules-automation/apply-rules" data-tab-id="apply" class="nds-tab">Apply Rules</a>')
    expect(html).toContain('<a href="/marketing/ads/rules-automation/dayparting" data-tab-id="hours" class="nds-tab">Hourly Bids</a>')
  })
  it('a tab with no href stays focusable, held, and goes nowhere', () => {
    expect(render('bid')).toContain('<span data-tab-id="soon" class="nds-tab" role="link" aria-disabled="true" tabindex="0">Soon (not built yet)</span>')
  })
  it('without hrefs the bar is the tablist it always was', () => {
    const html = renderToStaticMarkup(createElement(Tabs, { tabs: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], active: 'a', onChange: () => {} }))
    expect(html).toContain('role="tablist"')
    expect(html).toContain('<button type="button" role="tab" data-tab-id="a" aria-selected="true" tabindex="0" class="nds-tab on">A</button>')
  })
})
