'use client'

/**
 * AppRail — the app's main sidebar: a collapsible hover rail.
 *
 * Moved into the design system from the web (`apps/web/src/app/_shared/AppRail.tsx`) on 2026-10-28, so a second app
 * can draw the same rail. It knows no router: the app passes the link it navigates with (`LinkComponent`) and the
 * address its rows are matched against (`pathname`). The web's `_shared/AppRail.tsx` is that wrapper: its workspace
 * `Link` (keeps the `/w/<id>` prefix) and the workspace-free pathname.
 *
 * Pure-CSS hover-expand (66px → 344px; keyboard focus and `pinned` open it too). The classes (.h10-rail / .h10-brand /
 * .h10-nav / .h10-group / .h10-item / .ico / .lbl / .chev / .h10-sub / .h10-subitem / .h10-nav-badge / .h10-railft …)
 * are styled by `app-rail.css` beside this file, which reads the `--nds-rail-*` tokens. The app loads that stylesheet
 * itself (the web: `@import` at the top of `_shared/shared-shell.css`). The ads cockpit's own `AdsSidebar` draws the
 * same classes.
 *
 *  - Accepts an arbitrary RailNavItem[] with ABSOLUTE hrefs.
 *  - Exactly one row is the current page: the longest matching href wins (`app-rail-active.ts`). Group expansion and
 *    the `.section` tint stay prefix-based.
 *  - Optional per-item badge count (surfaced in .h10-nav-badge style).
 *  - Brand mark and wordmark are driven by the `brand` prop.
 */

import { useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { ChevronDown, ExternalLink } from 'lucide-react'
import { resolveActiveNav } from './app-rail-active'
import type { LucideIcon } from 'lucide-react'

/** What the rail passes to the app's link: the row's address, class, current-page state, name and content. */
export interface RailLinkProps {
  href: string
  className?: string
  'aria-current'?: 'page'
  'aria-label'?: string
  children?: ReactNode
}

/**
 * The app's own link for in-app rows: Next's `Link`, or one that keeps a workspace prefix. It must render an `<a>`
 * with the props it is given. External rows (`external`) are always a plain `<a target="_blank">`.
 */
export type RailLinkComponent = ComponentType<RailLinkProps>

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
  /** Total markets this channel supports. When greater than the inline
   *  children, a "See all N markets" row opens the full markets modal. */
  moreMarketsCount?: number
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
  /**
   * The current address, in the same form as the rows' hrefs (the web passes it without the `/w/<id>` prefix). It
   * picks the one current row and, on first render, which groups start open.
   */
  pathname: string
  /** The link drawn for every in-app row (see `RailLinkComponent`). */
  LinkComponent: RailLinkComponent
  /**
   * Brand mark + wordmark for the rail's own `.h10-brand` block.
   *
   * OPTIONAL since TB.1: when the app-wide top bar renders, IT owns the brand, and a rail that
   * repeated it would show the mark twice. `AppNavRail` therefore omits this; a rail used
   * outside the bar's reach still passes it.
   */
  brand?: {
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
  /** When true the rail stays expanded (docked) instead of hover-collapsing. */
  pinned?: boolean
  /** Opens the "all markets" modal for a channel sub-item (Amazon/eBay). */
  onSeeAllMarkets?: (sub: RailSubItem) => void
}

export function AppRail({ navItems, pathname, LinkComponent, brand, header, footer, pinned, onSeeAllMarkets }: AppRailProps) {
  const isActiveHref = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`)

  // Exactly ONE row carries `.on` — see app-rail-active.ts for the defect this
  // replaced and why longest-match is the rule. Expansion and the `.section`
  // tint below deliberately stay prefix-based.
  const best = useMemo(() => resolveActiveNav(navItems, pathname), [navItems, pathname])
  const isOn = (href: string, depth: number) =>
    best != null && best.href === href && best.depth === depth

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
    <aside className={`h10-rail${pinned ? ' pinned' : ''}`} data-print-hide>
      {/* Brand mark: compact "N" (or custom mark) collapsed; full wordmark on hover.
          Omitted when the top bar is providing the brand — see the `brand` prop.
          NOTE this is AppRail's own block only. The ads cockpit renders its own
          <aside class="h10-rail"> in AdsSidebar.tsx whose `.h10-brand` CONTAINS the
          channel switcher (`.h10-brand-switch`), so it is deliberately untouched. */}
      {brand && (
        <div className="h10-brand">
          <span className="logo" aria-hidden="true">{brand.mark}</span>
          <span className="word">
            <span className="mk">{brand.name}</span>
            {brand.accent && <> <b>{brand.accent}</b></>}
          </span>
        </div>
      )}

      {header != null && <div className="h10-railhdr-wrap">{header}</div>}

      <nav className="h10-nav" aria-label="Application navigation">
        {navItems.map((it) => {
          const hasChildren = !!it.children?.length
          // A parent is "section-active" (subtle highlight) when you're on one
          // of its children (so the collapsed icon still shows which section
          // you're in); "exact-active" (full fill) only on its own page.
          const childRouteActive =
            hasChildren &&
            it.children!.some(
              (c) =>
                isActiveHref(c.href) ||
                (c.children?.some((m) => isActiveHref(m.href)) ?? false),
            )
          const exactActive = !it.external && isOn(it.href, 1)
          const sectionActive = childRouteActive
          const active = exactActive
          const isOpen = hasChildren && !!open[it.href]
          /* Step 4 (2026-10-01) — the resting rail shows only icons; its labels fade in on hover. The link carries its
             name itself, so it is named however the label is drawn ("Products, 4 pending"). */
          const itemName = it.badge !== undefined && it.badge > 0 ? `${it.label}, ${it.badge} pending` : it.label

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
                  aria-label={`${itemName} (opens in a new tab)`}
                >
                  {bodyInner}
                  <ExternalLink className="ext" size={14} aria-hidden="true" />
                </a>
              ) : hasChildren ? (
                // Two-target parent (mirrors the live sidebar + the channel
                // sub-rows): the wrapper carries the active fill; the Link
                // navigates to the page; the chevron button toggles the
                // sub-items without navigating.
                <div className={`h10-item h10-parent ${exactActive ? 'on' : sectionActive ? 'section' : ''}`}>
                  <LinkComponent
                    href={it.href}
                    className="h10-parent-link"
                    aria-current={active ? 'page' : undefined}
                    aria-label={itemName}
                  >
                    {bodyInner}
                  </LinkComponent>
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
                <LinkComponent
                  href={it.href}
                  className={`h10-item ${active ? 'on' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  aria-label={itemName}
                >
                  {bodyInner}
                </LinkComponent>
              )}

              {hasChildren && isOpen && (
                <div className="h10-sub">
                  {it.children!.map((c) => {
                    const childActive = isOn(c.href, 2)
                    const hasMarkets = !!c.children?.length

                    // Plain leaf sub-item (e.g. Shopify, Organize) — may carry
                    // a trailing indicator dot.
                    if (!hasMarkets) {
                      return (
                        <LinkComponent
                          key={c.href}
                          href={c.href}
                          className={`h10-subitem ${childActive ? 'on' : ''}`}
                        >
                          <span className="sublbl">{c.label}</span>
                          <RailIndicator indicator={c.indicator} />
                        </LinkComponent>
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
                          <LinkComponent href={c.href} className="subname">
                            {c.label}
                          </LinkComponent>
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
                              <LinkComponent
                                key={m.href}
                                href={m.href}
                                className={`h10-subsubitem ${isOn(m.href, 3) ? 'on' : ''}`}
                              >
                                {m.code && <span className="mcode">{m.code}</span>}
                                <span className="mname">{m.label}</span>
                              </LinkComponent>
                            ))}
                            {onSeeAllMarkets &&
                              c.moreMarketsCount != null &&
                              c.moreMarketsCount > (c.children?.length ?? 0) && (
                                <button
                                  type="button"
                                  className="h10-subsubitem h10-seeall"
                                  onClick={() => onSeeAllMarkets(c)}
                                >
                                  <span className="mname">
                                    See all {c.moreMarketsCount} markets
                                  </span>
                                </button>
                              )}
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
