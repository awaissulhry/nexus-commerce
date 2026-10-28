/**
 * The phone bottom bar: which entries are tabs, what goes under More, the one current slot — and the markup a screen
 * reader gets. Rendered to markup in Node (no DOM); the sheet's focus and the fixed placement are checked in a browser.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CheckSquare, Factory, FileText, Handshake, Home, Receipt, Settings, Shirt, ShoppingCart, Warehouse } from 'lucide-react'
import type { AreaNav, AreaNavArea } from '../../patterns/shell/area-nav'
import { BottomBar, MoreSheetList, type BottomBarLinkProps } from './BottomBar'
import { badgeText, bottomBarLayout } from './bottomBarModel'

const area = (id: string, label: string, icon: AreaNavArea['icon'], phone?: 'tab' | 'more', extra: Partial<AreaNavArea> = {}): AreaNavArea => ({
  id,
  label,
  href: `/${id}`,
  icon,
  ...(phone ? { phone } : {}),
  ...extra,
})

/** The office view of a planner: seven areas, four marked as tabs; Approvals is a row promoted to More. */
const OFFICE: AreaNav = {
  view: 'office',
  areas: [
    area('home', 'Home', Home, 'tab', {
      badge: 'approvals',
      sections: [
        {
          id: 'top',
          label: 'Home',
          hideLabel: true,
          items: [
            { id: 'my-work', label: 'My work', href: '/home', exact: true },
            { id: 'approvals', label: 'Approvals', href: '/home/approvals', icon: CheckSquare, badge: 'approvals', phone: 'more' },
          ],
        },
      ],
    }),
    area('sales', 'Sales', Handshake, 'tab'),
    area('products', 'Products', Shirt, 'tab'),
    area('planning', 'Planning', FileText),
    area('purchasing', 'Purchasing', ShoppingCart, 'tab'),
    area('warehouse', 'Warehouse', Warehouse),
    area('production', 'Production', Factory),
  ],
}

const ids = (entries: Array<{ id: string }>) => entries.map((e) => e.id)

describe('bottomBarLayout — tabs and More', () => {
  it('the rows marked tab are the tabs, in manifest order; every other area and the rows marked more are under More', () => {
    const layout = bottomBarLayout(OFFICE, '/sales/quotes')
    expect(ids(layout.tabs)).toEqual(['home', 'sales', 'products', 'purchasing'])
    expect(ids(layout.more)).toEqual(['approvals', 'planning', 'warehouse', 'production'])
    expect(layout.current).toBe('sales')
  })
  it('at most four tabs: a fifth marked tab moves under More, first in manifest order', () => {
    const nav: AreaNav = { ...OFFICE, areas: OFFICE.areas.map((a) => (a.id === 'planning' ? { ...a, phone: 'tab' as const } : a)) }
    const layout = bottomBarLayout(nav, '/home')
    expect(ids(layout.tabs)).toEqual(['home', 'sales', 'products', 'planning'])
    expect(ids(layout.more)).toEqual(['approvals', 'purchasing', 'warehouse', 'production'])
  })
  it('a More with one entry becomes a fifth tab', () => {
    const nav: AreaNav = { view: 'portal', areas: [area('home', 'Home', Home, 'tab'), area('orders', 'Orders', ShoppingCart, 'tab'), area('documents', 'Documents', FileText, 'tab'), area('returns', 'Returns', Receipt, 'tab'), area('account', 'Account', Settings)] }
    const layout = bottomBarLayout(nav, '/account/users')
    expect(ids(layout.tabs)).toEqual(['home', 'orders', 'documents', 'returns', 'account'])
    expect(layout.more).toEqual([])
    expect(layout.current).toBe('account')
  })
  it('a portal with three areas has three tabs and no More', () => {
    const nav: AreaNav = { view: 'portal', areas: [area('jobs', 'Jobs', Factory, 'tab'), area('documents', 'Documents', FileText, 'tab'), area('profile', 'Profile', Settings, 'tab')] }
    const layout = bottomBarLayout(nav, '/jobs/12')
    expect(ids(layout.tabs)).toEqual(['jobs', 'documents', 'profile'])
    expect(layout.more).toEqual([])
  })
  it('a manifest that marks no tab: its first areas are the tabs', () => {
    const nav: AreaNav = { view: 'office', areas: OFFICE.areas.map(({ phone: _phone, ...a }) => a) }
    const layout = bottomBarLayout(nav, '/')
    expect(ids(layout.tabs)).toEqual(['home', 'sales', 'products', 'planning'])
    expect(ids(layout.more)).toEqual(['approvals', 'purchasing', 'warehouse', 'production'])
    expect(layout.current).toBeNull()
  })
  it('maxTabs lowers the tab count (and is held to 1–4)', () => {
    expect(ids(bottomBarLayout(OFFICE, '/', { maxTabs: 2 }).tabs)).toEqual(['home', 'sales'])
    expect(bottomBarLayout(OFFICE, '/', { maxTabs: 9 }).tabs).toHaveLength(4)
    expect(bottomBarLayout(OFFICE, '/', { maxTabs: 0 }).tabs).toHaveLength(1)
  })
})

describe('bottomBarLayout — the one current slot', () => {
  it('a page of a tab area marks that tab', () => {
    expect(bottomBarLayout(OFFICE, '/home').current).toBe('home')
    expect(bottomBarLayout(OFFICE, '/purchasing/po/12').current).toBe('purchasing')
  })
  it('a row in the bar wins over its area: Approvals is under More, so More is current, not Home', () => {
    const layout = bottomBarLayout(OFFICE, '/home/approvals/77')
    expect(layout.current).toBe('more')
    expect(layout.currentInMore).toBe('approvals')
  })
  it('an area under More makes More current and names the entry', () => {
    const layout = bottomBarLayout(OFFICE, '/warehouse/receipts?status=open')
    expect(layout).toMatchObject({ current: 'more', currentInMore: 'warehouse' })
  })
  it('an address nobody owns: no current slot', () => {
    expect(bottomBarLayout(OFFICE, '/settings')).toMatchObject({ current: null, currentInMore: null })
  })
})

/** The app's link stand-in: marks its anchors and adds a prefix, as a workspace link does. */
function TestLink({ href, children, onClick: _onClick, ...rest }: BottomBarLinkProps) {
  return createElement('a', { ...rest, href, 'data-app-link': '' }, children)
}

const counts: Record<string, number> = { approvals: 3 }
const render = (pathname: string) =>
  renderToStaticMarkup(
    createElement(BottomBar, { nav: OFFICE, pathname, LinkComponent: TestLink, href: (a: string) => `https://app.example.com/w/acme${a}`, count: (k: string) => counts[k] }),
  )

describe('BottomBar markup', () => {
  it('a named nav landmark with one link per tab, through the app link, prefixed', () => {
    const html = render('/sales')
    expect(html).toContain('<nav class="nds-bottombar" aria-label="Main">')
    expect(html.match(/data-app-link=""/g)).toHaveLength(4)
    expect(html).toContain('href="https://app.example.com/w/acme/purchasing"')
  })
  it('the current tab has aria-current="page" and the .on class; no other does', () => {
    const html = render('/sales/quotes')
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toMatch(/<a class="nds-bottombar-tab on" aria-current="page" aria-label="Sales" href="https:\/\/app\.example\.com\/w\/acme\/sales"/)
  })
  it('a count is said in the name and drawn as a hidden badge; icons are hidden', () => {
    const html = render('/sales')
    expect(html).toContain('aria-label="Home, 3 waiting"')
    expect(html).toContain('<span class="nds-bottombar-badge" aria-hidden="true">3</span>')
    expect(html).not.toMatch(/<svg(?![^>]*aria-hidden="true")/)
  })
  it('More is a button that opens a dialog, carries the counts inside it, and says when the current page is inside', () => {
    const html = render('/warehouse')
    expect(html).toMatch(/<button type="button" class="nds-bottombar-tab on" aria-haspopup="dialog" aria-expanded="false" aria-label="More, current page is here, 3 waiting">/)
    expect(html).not.toContain('aria-current="page"')
  })
  it('draws nothing for an empty manifest', () => {
    expect(renderToStaticMarkup(createElement(BottomBar, { nav: { view: 'portal', areas: [] }, pathname: '/', LinkComponent: TestLink }))).toBe('')
  })
  it('the More sheet is closed until More is pressed (nothing in the page but the bar)', () => {
    expect(render('/sales')).not.toContain('role="dialog"')
  })
})

describe('MoreSheet', () => {
  it('lists its entries as links in order; a row names its area; the one current entry is marked', () => {
    const layout = bottomBarLayout(OFFICE, '/home/approvals')
    const html = renderToStaticMarkup(
      createElement(MoreSheetList, { entries: layout.more, current: layout.currentInMore, LinkComponent: TestLink, count: (k: string) => counts[k] }),
    )
    expect([...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1])).toEqual(['/home/approvals', '/planning', '/warehouse', '/production'])
    expect(html).toContain('<a class="nds-moresheet-row on" aria-current="page" aria-label="Approvals, Home, 3 waiting"')
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toContain('<span class="nds-moresheet-area">Home</span>')
  })
})

describe('badgeText', () => {
  it('caps at 99+', () => {
    expect(badgeText(7)).toBe('7')
    expect(badgeText(99)).toBe('99')
    expect(badgeText(100)).toBe('99+')
  })
})
