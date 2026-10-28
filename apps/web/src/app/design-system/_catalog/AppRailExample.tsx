'use client'
import { useMemo, useState } from 'react'
import { Boxes, ExternalLink, Home, Package, ShoppingCart, Store } from 'lucide-react'
import { AppRail, type RailLinkProps, type RailNavItem } from '@/design-system/patterns/shell'
import { Checkbox } from '@/design-system/primitives/Checkbox'

const NAV: RailNavItem[] = [
  { label: 'Home', href: '/home', Icon: Home },
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
      { label: 'Amazon', href: '/listings/amazon', children: [{ code: 'IT', label: 'Italy', href: '/listings/amazon/it' }, { code: 'DE', label: 'Germany', href: '/listings/amazon/de' }] },
      { label: 'Shopify', href: '/listings/shopify', indicator: 'disconnected' },
    ],
  },
  { label: 'Stock', href: '/stock', Icon: Boxes, indicator: 'action' },
  { label: 'Orders', href: '/orders', Icon: ShoppingCart, badge: 120 },
  { label: 'Help', href: '/help', Icon: ExternalLink, external: 'https://example.com' },
]

/**
 * The app's main sidebar. The specimen's `LinkComponent` moves the example's current page instead of leaving the
 * catalog, so a click or Enter on a row shows the one current row moving.
 */
export function AppRailExample() {
  const [path, setPath] = useState('/products/drafts')
  const [pinned, setPinned] = useState(false)
  const SpecimenLink = useMemo(
    () =>
      function SpecimenLink({ href, children, ...rest }: RailLinkProps) {
        return <a {...rest} href={`#${href}`} onClick={(event) => { event.preventDefault(); setPath(href) }}>{children}</a>
      },
    [],
  )
  return <section id="app-rail-example">
    <h3>AppRail · the main sidebar</h3>
    <p>
      A 66 px icon rail that opens to 344 px on hover, on keyboard focus inside it, or pinned. The app passes its own link
      (<code>LinkComponent</code>) and the current address (<code>pathname</code>): exactly one row is the current page,
      the longest match. Its stylesheet is <code>patterns/shell/app-rail.css</code>, loaded by the app.
    </p>
    <Checkbox label="Pinned" checked={pinned} onChange={(event) => setPinned(event.target.checked)} />
    <div style={{ position: 'relative', height: 440, marginTop: 10, paddingLeft: pinned ? 344 : 66, border: '1px solid var(--nds-border)', borderRadius: 12, overflow: 'hidden' }}>
      <AppRail navItems={NAV} pathname={path} LinkComponent={SpecimenLink} pinned={pinned} brand={{ mark: 'N', name: 'Nexus' }} />
      <p role="status" style={{ margin: 16 }}>Current page: <code>{path}</code></p>
    </div>
  </section>
}
