'use client'

// The branding stylesheet is the app's to load (tokens/branding.ts); the catalog loads it where it shows a brand.
import '@/design-system/styles/branding.css'
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { CheckSquare, Factory, FileText, Handshake, Home, Receipt, Settings, Shirt, ShoppingCart, Undo2, Warehouse } from 'lucide-react'
import { BottomBar, type BottomBarLinkProps } from '@/design-system/components/BottomBar'
import type { AreaNav } from '@/design-system/patterns/shell'
import { brandingAttrs, checkBranding } from '@/design-system/tokens'

/*
 * 2026-10-28 — G14, the phone bottom bar and its More sheet. Two phone frames (the bar `inline`, so it shows at every
 * width; on a real phone it is fixed to the bottom edge under 720 px). The specimen link moves the frame's current page
 * instead of leaving the catalog. Verify, light and dark, 390 and 1440 px: one current tab (colour, weight, top bar);
 * Tab reaches every tab and More; Enter on More opens the sheet with the focus inside; Esc closes it and the focus is
 * back on More; a row in the sheet closes it and marks More current; the counts are said in each name.
 */

const OFFICE: AreaNav = {
  view: 'office',
  areas: [
    {
      id: 'home',
      label: 'Home',
      href: '/home',
      icon: Home,
      badge: 'approvals',
      phone: 'tab',
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
    },
    { id: 'sales', label: 'Sales', href: '/sales', icon: Handshake, badge: 'quotes', phone: 'tab' },
    { id: 'products', label: 'Products', href: '/products', icon: Shirt, phone: 'tab' },
    { id: 'planning', label: 'Planning', href: '/planning', icon: FileText },
    { id: 'purchasing', label: 'Purchasing', href: '/purchasing', icon: ShoppingCart, phone: 'tab' },
    { id: 'warehouse', label: 'Warehouse', href: '/warehouse', icon: Warehouse, badge: 'shipsToday' },
    { id: 'production', label: 'Production', href: '/production', icon: Factory },
  ],
}

const PORTAL: AreaNav = {
  view: 'portal',
  areas: [
    { id: 'home', label: 'Home', href: '/home', icon: Home, phone: 'tab' },
    { id: 'orders', label: 'Orders', href: '/orders', icon: ShoppingCart, phone: 'tab' },
    { id: 'documents', label: 'Documents', href: '/documents', icon: FileText, badge: 'newDocuments', phone: 'tab' },
    { id: 'returns', label: 'Returns & claims', href: '/returns', icon: Undo2, phone: 'tab' },
    { id: 'account', label: 'Account', href: '/account', icon: Settings },
    { id: 'invoices', label: 'Invoices', href: '/invoices', icon: Receipt },
  ],
}

const COUNTS: Record<string, number> = { approvals: 3, quotes: 2, shipsToday: 14, newDocuments: 1 }
const count = (key: string) => COUNTS[key]

/** A fictional partner brand: a navy that passes every pair in light, and a light blue for dark. */
const PARTNER = checkBranding({ name: 'Atelier Example', accent: '#1d3557', accentDark: '#a8c5ff' })

const FRAME: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: 390,
  maxWidth: '100%',
  height: 300,
  border: '1px solid var(--nds-border)',
  borderRadius: 'var(--nds-radius-3xl)',
  overflow: 'hidden',
  background: 'var(--nds-bg)',
}

function PhoneFrame({ title, path, children }: { title: string; path: string; children: ReactNode }) {
  return (
    <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '100%' }}>
      <figcaption style={{ fontSize: 'var(--nds-font-size-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--nds-text-3)' }}>
        {title}
      </figcaption>
      <div style={FRAME}>
        <p role="status" style={{ flex: 1, margin: 0, padding: 16, color: 'var(--nds-text-2)', fontSize: 'var(--nds-font-size-sm)' }}>
          Current page: <code>{path}</code>
        </p>
        {children}
      </div>
    </figure>
  )
}

/** The specimen's link: moves the frame's current page instead of navigating. */
function useSpecimenLink(setPath: (path: string) => void) {
  return useMemo(
    () =>
      function SpecimenLink({ href, children, onClick, ...rest }: BottomBarLinkProps) {
        return (
          <a
            {...rest}
            href={`#${href}`}
            onClick={(event) => {
              event.preventDefault()
              setPath(href)
              onClick?.()
            }}
          >
            {children}
          </a>
        )
      },
    [setPath],
  )
}

export function BottomBarExample() {
  const [officePath, setOfficePath] = useState('/sales/quotes')
  const [portalPath, setPortalPath] = useState('/documents')
  const OfficeLink = useSpecimenLink(setOfficePath)
  const PortalLink = useSpecimenLink(setPortalPath)
  return (
    <section id="bottom-bar-example">
      <h3>BottomBar + MoreSheet · the phone&apos;s main navigation</h3>
      <p>
        Built from the view&apos;s area-navigation manifest (<code>AreaNav</code>): the areas and rows marked{' '}
        <code>phone: &apos;tab&apos;</code> are the tabs (four at most), everything else is in the More sheet; a More with one
        entry becomes a fifth tab. The current slot comes from <code>findAreaNavPlace</code>. Fixed to the bottom under
        720 px with the safe-area inset; shown <code>inline</code> here. Inside a <code>[data-brand]</code> subtree the
        current tab&apos;s bar takes the tenant&apos;s accent (right).
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        <PhoneFrame title="Office · planner" path={officePath}>
          <BottomBar inline nav={OFFICE} pathname={officePath} LinkComponent={OfficeLink} count={count} />
        </PhoneFrame>
        <PhoneFrame title="Portal · customer, branded" path={portalPath}>
          <div {...brandingAttrs(PARTNER)}>
            <BottomBar inline nav={PORTAL} pathname={portalPath} LinkComponent={PortalLink} count={count} labels={{ navigation: 'Portal' }} />
          </div>
        </PhoneFrame>
      </div>
    </section>
  )
}
