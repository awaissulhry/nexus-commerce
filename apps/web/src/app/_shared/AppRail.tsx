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
import { useState, type ReactNode } from 'react'
import { ChevronDown, ExternalLink } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/** Third-level item — a market under a channel (e.g. Amazon → IT). */
export interface RailMarketItem {
  /** Optional short code rendered as a monospace chip (e.g. 'IT'). */
  code?: string
  label: string
  href: string
}

/** Second-level item under a top-level nav entry. May itself expand into
 *  a third level of markets (the channel → markets case). A bare
 *  `{ label, href }` (no children) renders as a plain leaf link. */
export interface RailSubItem {
  label: string
  href: string
  /** Markets revealed when this sub-item is expanded (the 3rd level). */
  children?: RailMarketItem[]
  /** Trailing status: red dot (action), amber dot (warning), or a
   *  "Connect" affordance (disconnected). */
  indicator?: 'action' | 'warning' | 'disconnected'
}

export interface RailNavItem {
  label: string
  /** Absolute href (e.g. '/products', '/fulfillment/stock'). */
  href: string
  Icon: LucideIcon
  /** Optional count shown as a badge over the icon corner. */
  badge?: number
  /** Sub-items revealed when this item is expanded. */
  children?: RailSubItem[]
  /** Trailing status: red dot (action), amber dot (warning), or a
   *  "Connect" affordance (disconnected). */
  indicator?: 'action' | 'warning' | 'disconnected'
  /** When set, the item is an external link (opens in new tab). */
  external?: string
}

/** Shared trailing indicator (dot or Connect) for a nav row. */
function RailIndicator({ indicator }: { indicator?: 'action' | 'warning' | 'disconnected' }) {
  if (indicator === 'disconnected') return <span className="h10-connect">Connect</span>
  if (indicator === 'action') return <span className="h10-dot action" aria-hidden="true" />
  if (indicator === 'warning') return <span className="h10-dot warning" aria-hidden="true" />
  return null
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
  /** Chrome rendered directly under the brand (workspace switcher, ⌘K/search,
   *  theme toggle). Visible only when the rail is expanded. */
  header?: ReactNode
  /** Footer chrome (recently-viewed, user profile). Visible only when expanded. */
  footer?: ReactNode
}

export function AppRail({ navItems, brand, header, footer }: AppRailProps) {
  const pathname = usePathname() || ''

  const isActiveHref = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`)

  // Seed collapsible groups: open iff the current pathname is the parent, a
  // child, or (for channel → markets) a grandchild. Both the top-level group
  // and the channel sub-group are keyed by their own href so a deep-link to a
  // market auto-reveals the full Listings → Amazon → IT chain.
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    for (const it of navItems) {
      if (!it.children?.length) continue
      init[it.href] =
        isActiveHref(it.href) ||
        it.children.some(
          (c) =>
            isActiveHref(c.href) ||
            (c.children?.some((m) => isActiveHref(m.href)) ?? false),
        )
      for (const c of it.children) {
        if (c.children?.length) {
          init[c.href] =
            isActiveHref(c.href) || c.children.some((m) => isActiveHref(m.href))
        }
      }
    }
    return init
  })

  const toggle = (href: string) =>
    setOpen((o) => ({ ...o, [href]: !o[href] }))

  return (
    <aside className="h10-rail" data-print-hide>
      {/* Brand mark: compact "N" (or custom mark) collapsed; full wordmark on hover */}
      <div className="h10-brand">
        <span className="logo" aria-hidden="true">{brand.mark}</span>
        <span className="word">
          <span className="mk">{brand.name}</span>
          {brand.accent && <> <b>{brand.accent}</b></>}
        </span>
      </div>

      {header != null && <div className="h10-railhdr-wrap">{header}</div>}

      <nav className="h10-nav" aria-label="Application navigation">
        {navItems.map((it) => {
          const hasChildren = !!it.children?.length
          const active = !it.external && isActiveHref(it.href)
          const isOpen = hasChildren && !!open[it.href]

          const bodyInner = (
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
              <RailIndicator indicator={it.indicator} />
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
                  {bodyInner}
                  <ExternalLink className="ext" size={14} aria-hidden="true" />
                </a>
              ) : hasChildren ? (
                // Two-target parent (mirrors the live sidebar + the channel
                // sub-rows): the wrapper carries the active fill; the Link
                // navigates to the page; the chevron button toggles the
                // sub-items without navigating.
                <div className={`h10-item h10-parent ${active ? 'on' : ''}`}>
                  <Link
                    href={it.href}
                    className="h10-parent-link"
                    aria-current={active ? 'page' : undefined}
                  >
                    {bodyInner}
                  </Link>
                  <button
                    type="button"
                    className="h10-parent-chev"
                    aria-label={isOpen ? `Collapse ${it.label}` : `Expand ${it.label}`}
                    aria-expanded={isOpen}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      toggle(it.href)
                    }}
                  >
                    <ChevronDown
                      className={`chev ${isOpen ? 'open' : ''}`}
                      size={16}
                      aria-hidden="true"
                    />
                  </button>
                </div>
              ) : (
                <Link
                  href={it.href}
                  className={`h10-item ${active ? 'on' : ''}`}
                  aria-current={active ? 'page' : undefined}
                >
                  {bodyInner}
                </Link>
              )}

              {hasChildren && isOpen && (
                <div className="h10-sub">
                  {it.children!.map((c) => {
                    const childActive = isActiveHref(c.href)
                    const hasMarkets = !!c.children?.length

                    // Plain leaf sub-item (e.g. Shopify, Organize) — may carry
                    // a trailing indicator dot.
                    if (!hasMarkets) {
                      return (
                        <Link
                          key={c.href}
                          href={c.href}
                          className={`h10-subitem ${childActive ? 'on' : ''}`}
                        >
                          <span className="sublbl">{c.label}</span>
                          <RailIndicator indicator={c.indicator} />
                        </Link>
                      )
                    }

                    // Channel sub-item with markets (Amazon / eBay): a
                    // two-target row mirroring the live ChannelNav — the
                    // label LINKS to the channel page, the chevron BUTTON
                    // toggles the markets without navigating.
                    const subOpen = !!open[c.href]
                    return (
                      <div key={c.href} className="h10-subgroup">
                        <div className={`h10-subitem h10-subparent ${childActive ? 'on' : ''}`}>
                          <Link href={c.href} className="subname">
                            {c.label}
                          </Link>
                          <RailIndicator indicator={c.indicator} />
                          <button
                            type="button"
                            className="subchev-btn"
                            aria-expanded={subOpen}
                            aria-label={subOpen ? `Collapse ${c.label} markets` : `Expand ${c.label} markets`}
                            onClick={() => toggle(c.href)}
                          >
                            <ChevronDown
                              className={`subchev ${subOpen ? 'open' : ''}`}
                              size={14}
                              aria-hidden="true"
                            />
                          </button>
                        </div>
                        {subOpen && (
                          <div className="h10-subsub">
                            {c.children!.map((m) => (
                              <Link
                                key={m.href}
                                href={m.href}
                                className={`h10-subsubitem ${pathname === m.href || pathname.startsWith(`${m.href}/`) ? 'on' : ''}`}
                              >
                                {m.code && <span className="mcode">{m.code}</span>}
                                <span className="mname">{m.label}</span>
                              </Link>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      {footer != null && <div className="h10-railft-wrap">{footer}</div>}
    </aside>
  )
}
