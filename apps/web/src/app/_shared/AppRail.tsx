'use client'

/**
 * AppRail — shared collapsible hover-rail sidebar for standalone shell routes.
 *
 * Pure-CSS hover-expand (66px → 344px) matching the ads-console .h10-rail behavior.
 * Uses the same .h10-rail / .h10-brand / .h10-nav / .h10-group / .h10-item / .ico /
 * .lbl / .chev / .h10-sub / .h10-subitem / .h10-nav-badge / .h10-railft classes as
 * AdsSidebar — so importing ads.css (or any stylesheet that defines those rules)
 * gives the correct look. TODO: extract the relevant rules into a neutral
 * shared-shell.css; ads.css is the source of truth for now.
 *
 * Key differences from AdsSidebar:
 *  - Accepts an arbitrary RailNavItem[] with ABSOLUTE hrefs (not ads-relative routes).
 *  - Active detection compares pathname to href directly (=== or startsWith(href+'/'))
 *    so it works for any route in the app.
 *  - Optional per-item badge count (surfaced in .h10-nav-badge style).
 *  - Brand mark and wordmark are driven by the `brand` prop so this component is
 *    reusable across different sub-sections of the app.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { ChevronDown, ExternalLink } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface RailNavItem {
  label: string
  /** Absolute href (e.g. '/products', '/fulfillment/stock'). */
  href: string
  Icon: LucideIcon
  /** Optional count shown as a badge over the icon corner. */
  badge?: number
  /** Sub-items revealed when this item is expanded. One level only. */
  children?: { label: string; href: string }[]
  /** When set, the item is an external link (opens in new tab). */
  external?: string
}

export interface AppRailProps {
  navItems: RailNavItem[]
  brand: {
    /** Single character shown as the compact mark when collapsed. */
    mark: string
    /** Full product name shown when expanded. */
    name: string
    /** Optional accent word appended in bold after name (e.g. 'Ads'). */
    accent?: string
  }
  /** Short footer caption visible only when the rail is expanded. */
  footer?: string
}

export function AppRail({ navItems, brand, footer }: AppRailProps) {
  const pathname = usePathname() || ''

  const isActiveHref = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`)

  // Seed collapsible groups: open iff the current pathname is the parent or any child.
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    for (const it of navItems) {
      if (it.children?.length) {
        init[it.href] =
          isActiveHref(it.href) || it.children.some((c) => isActiveHref(c.href))
      }
    }
    return init
  })

  const toggle = (href: string) =>
    setOpen((o) => ({ ...o, [href]: !o[href] }))

  return (
    <aside className="h10-rail">
      {/* Brand mark: compact "N" (or custom mark) collapsed; full wordmark on hover */}
      <div className="h10-brand">
        <span className="logo" aria-hidden="true">{brand.mark}</span>
        <span className="word">
          <span className="mk">{brand.name}</span>
          {brand.accent && <> <b>{brand.accent}</b></>}
        </span>
      </div>

      <nav className="h10-nav" aria-label="Application navigation">
        {navItems.map((it) => {
          const hasChildren = !!it.children?.length
          const active = !it.external && isActiveHref(it.href)
          const isOpen = hasChildren && !!open[it.href]

          const body = (
            <>
              <span className="ico"><it.Icon size={20} /></span>
              <span className="lbl">{it.label}</span>
              {it.badge !== undefined && it.badge > 0 && (
                <span
                  className="h10-nav-badge"
                  aria-label={`${it.badge} pending`}
                >
                  {it.badge > 99 ? '99+' : it.badge}
                </span>
              )}
              {hasChildren && (
                <ChevronDown
                  className={`chev ${isOpen ? 'open' : ''}`}
                  size={16}
                  aria-hidden="true"
                />
              )}
              {it.external && (
                <ExternalLink className="ext" size={14} aria-hidden="true" />
              )}
            </>
          )

          return (
            <div key={it.href} className="h10-group">
              {it.external ? (
                <a
                  href={it.external}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="h10-item"
                >
                  {body}
                </a>
              ) : hasChildren ? (
                <button
                  type="button"
                  className={`h10-item ${active ? 'on' : ''}`}
                  aria-expanded={isOpen}
                  onClick={() => toggle(it.href)}
                >
                  {body}
                </button>
              ) : (
                <Link
                  href={it.href}
                  className={`h10-item ${active ? 'on' : ''}`}
                >
                  {body}
                </Link>
              )}

              {hasChildren && isOpen && (
                <div className="h10-sub">
                  {it.children!.map((c) => (
                    <Link
                      key={c.href}
                      href={c.href}
                      className={`h10-subitem ${pathname === c.href || pathname.startsWith(`${c.href}/`) ? 'on' : ''}`}
                    >
                      {c.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      {footer && (
        <div className="h10-railft">{footer}</div>
      )}
    </aside>
  )
}
