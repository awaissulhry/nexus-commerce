/**
 * The rail knows no router: every in-app row is drawn by the app's `LinkComponent`, and `pathname` alone decides the
 * one current row and which groups start open. Rendered to markup in Node (no DOM): hover, pin and keyboard are CSS
 * (`app-rail.css`) and are checked in a browser.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Home, Package, Store, BookOpen } from 'lucide-react'
import { AppRail, type AppRailProps, type RailLinkProps, type RailNavItem } from './AppRail'

/** The app's link stand-in: marks its anchors and adds a prefix, as a workspace link does. */
function TestLink({ href, children, ...rest }: RailLinkProps) {
  return createElement('a', { ...rest, href: `/w/acme${href}`, 'data-app-link': '' }, children)
}

const NAV: RailNavItem[] = [
  { label: 'Home', href: '/', Icon: Home },
  {
    label: 'Products',
    href: '/products',
    Icon: Package,
    badge: 4,
    children: [
      { label: 'Drafts', href: '/products/drafts' },
      { label: 'Organize', href: '/products/organize', indicator: 'warning' },
    ],
  },
  {
    label: 'Listings',
    href: '/listings',
    Icon: Store,
    children: [
      {
        label: 'Amazon',
        href: '/listings/amazon',
        children: [{ code: 'IT', label: 'Italy', href: '/listings/amazon/it' }],
        moreMarketsCount: 9,
      },
    ],
  },
  { label: 'Help', href: '/help', Icon: BookOpen, external: 'https://example.com/help', badge: 120 },
]

const render = (pathname: string, extra: Partial<AppRailProps> = {}) =>
  renderToStaticMarkup(createElement(AppRail, { navItems: NAV, pathname, LinkComponent: TestLink, ...extra }))

/** Every class attribute that carries the full `.on` fill. */
const onRows = (html: string) => [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).filter((c) => /(^| )on( |$)/.test(c))

describe('AppRail — the app passes its link and its pathname', () => {
  it('draws every in-app row with LinkComponent and the external row as a plain new-tab link', () => {
    const html = render('/listings/amazon/it')
    // Home, Products, Listings, Amazon (channel name), Italy — the open rows; each through the app's link.
    expect(html.match(/data-app-link=""/g)?.length).toBe(5)
    expect(html).toContain('href="/w/acme/listings/amazon/it"')
    expect(html).toMatch(/<a href="https:\/\/example\.com\/help" target="_blank" rel="noopener noreferrer" class="h10-item" aria-label="Help, 120 pending \(opens in a new tab\)">/)
    expect(html).not.toContain('/w/acme/help')
  })

  it('lights exactly one row, the longest match, and marks it as the current page', () => {
    const html = render('/listings/amazon/it')
    expect(onRows(html)).toEqual(['h10-subsubitem on'])
    // The sections that hold it are tinted, not lit.
    expect(html).toContain('class="h10-item h10-parent section"')
    expect(render('/products')).toContain('class="h10-item h10-parent on"><a class="h10-parent-link" aria-current="page" aria-label="Products, 4 pending" href="/w/acme/products"')
    expect(onRows(render('/products/drafts/123'))).toEqual(['h10-subitem on'])
  })

  it('opens the groups that hold the current page, and only those', () => {
    const onMarket = render('/listings/amazon/it', { onSeeAllMarkets: () => {} })
    expect(onMarket).toContain('Italy')
    expect(onMarket).toContain('See all 9 markets')
    expect(onMarket).not.toContain('Drafts')
    const onProducts = render('/products/organize')
    expect(onProducts).toContain('Drafts')
    expect(onProducts).not.toContain('Amazon')
  })

  it('a page with no row lights nothing and opens nothing', () => {
    const html = render('/settings/profile')
    expect(onRows(html)).toEqual([])
    expect(html).not.toContain('aria-current')
    expect(html).not.toContain('h10-sub"')
  })

  it('the external row is never current, even on its own path', () => {
    expect(onRows(render('/help'))).toEqual([])
  })

  it('keeps the rest of its props: pinned, brand, badge words, header and footer', () => {
    const html = render('/', {
      pinned: true,
      brand: { mark: 'N', name: 'Nexus', accent: 'Ads' },
      header: createElement('span', null, 'HEADER'),
      footer: createElement('span', null, 'FOOTER'),
    })
    expect(html).toMatch(/^<aside class="h10-rail pinned" data-print-hide="true">/)
    expect(html).toContain('<span class="logo" aria-hidden="true">N</span>')
    expect(html).toContain('<div class="h10-railhdr-wrap"><span>HEADER</span></div>')
    expect(html).toContain('<div class="h10-railft-wrap"><span>FOOTER</span></div>')
    expect(html).toContain('>99+<')
    expect(render('/')).toMatch(/^<aside class="h10-rail" data-print-hide="true">/)
  })
})

describe('patterns/shell imports no router', () => {
  it('no file here imports next/* — the app brings its own link and pathname', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url))
    for (const file of readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f))) {
      expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(/from ['"]next\//)
    }
  })
})
