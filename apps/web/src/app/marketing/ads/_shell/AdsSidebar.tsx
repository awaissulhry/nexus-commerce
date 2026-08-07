'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { ChevronDown, ExternalLink } from 'lucide-react'
import { ADS_NAV, EBAY_ADS_NAV, ADS_BASE } from './nav'
import { AmazonBadge, EbayBadge } from './BrandMarks'
import { getBackendUrl } from '@/lib/backend-url'

// E4.1 — channel counterparts: switching keeps you on the equivalent page.
const TO_EBAY: Record<string, string> = {
  campaigns: 'ebay/campaigns',
  dashboard: 'ebay',
  changelog: 'ebay/change-log',
}
const TO_AMAZON: Record<string, string> = {
  'ebay/campaigns': 'campaigns',
  'ebay/products': 'campaigns',
  'ebay/change-log': 'changelog',
  ebay: 'dashboard',
}

export function AdsSidebar() {
  const pathname = usePathname() || ''
  const router = useRouter()
  const isEbay = pathname.startsWith(`${ADS_BASE}/ebay`)
  const nav = isEbay ? EBAY_ADS_NAV : ADS_NAV

  const switchChannel = (target: 'amazon' | 'ebay') => {
    if ((target === 'ebay') === isEbay) return
    const current = pathname.slice(ADS_BASE.length + 1) // strip "/marketing/ads/"
    const map = target === 'ebay' ? TO_EBAY : TO_AMAZON
    const hit = Object.entries(map).find(([from]) => current === from || current.startsWith(`${from}/`))
    router.push(`${ADS_BASE}/${hit ? hit[1] : target === 'ebay' ? 'ebay' : 'dashboard'}`)
  }
  // F1 — pending-suggestions count badge on the Suggestions nav item.
  const [pendingSuggestions, setPendingSuggestions] = useState(0)
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try { const j = await fetch(`${getBackendUrl()}/api/advertising/suggestions/count`).then((r) => r.json()); if (alive) setPendingSuggestions(Number(j?.pending) || 0) } catch { /* ignore */ }
    }
    void poll()
    const t = setInterval(poll, 60_000) // refresh hourly-ish; cheap count query
    return () => { alive = false; clearInterval(t) }
  }, [])
  const isActive = (route: string) => {
    const href = `${ADS_BASE}/${route}`
    return pathname === href || pathname.startsWith(`${href}/`)
  }

  // Collapsible parents (AMC, Reporting) are TWO-TARGET rows, ported verbatim from the
  // commerce rail (_shared/AppRail.tsx): the label is a Link that navigates to the parent's
  // own page, and the chevron is a separate button that expands the submenu without
  // navigating. Before RPT.1 the whole row was a toggle-only <button>, so `Reporting` and
  // `AMC` were the only rail items you could not click through to — their pages were
  // reachable only by typing the URL. Every class used here (.h10-parent-link,
  // .h10-parent-chev, .h10-item.section) already exists in ads.css, which both rails share,
  // so this is JSX-only: no new CSS, and the two rails cannot drift.
  //
  // Seed each group open iff the active route is inside it, so deep-linking to a sub-page
  // lands with the group expanded.
  // NAF.SB — grouped children (the Agent Fleet's ten pages) add a third level,
  // rendered with the .h10-subgroup / .h10-subsub classes the commerce rail
  // (_shared/AppRail.tsx) already uses for channel → markets. Same markup, so
  // the two rails cannot drift and no new rail CSS is needed. One deviation:
  // a group row TOGGLES and does not navigate, because Operate/Build/Govern
  // are not pages — so its label is a toggle, not a link.
  //
  // Groups seed OPEN. Collapse exists for the group you do not use; it is not
  // the resting state, or the Approvals badge would sit behind two closed
  // levels.
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    for (const it of nav) {
      if (it.children?.length)
        init[it.route] = isActive(it.route) || it.children.some((c) => isActive(c.route))
      if (it.groups?.length) {
        init[it.route] =
          isActive(it.route) ||
          it.groups.some((g) => g.items.some((c) => isActive(c.route)))
        for (const g of it.groups) init[`${it.route}:${g.group}`] = true
      }
    }
    return init
  })
  const toggle = (route: string) => setOpen((o) => ({ ...o, [route]: !o[route] }))

  return (
    <aside className="h10-rail">
      {/* CH1 — the brand row carries the channel state. Collapsed, a corner chip on
          the "N" says which account you're spending in; hovered, the full switch
          fades in at the right edge alongside the wordmark. Replaces the E4.1 pill
          row, which could not fit inside the 66px collapsed rail. */}
      <div className="h10-brand">
        <span className="h10-brandmark">
          <span className="logo" aria-hidden>N</span>
          <span className="chip">{isEbay ? <EbayBadge size={15} /> : <AmazonBadge size={15} />}</span>
        </span>
        <span className="word"><span className="mk">Nexus</span> <b>Ads</b></span>
        {/* E4.1/E6.1 — same console, shift the channel, then pick the market on-page */}
        <div className="h10-brand-switch" role="tablist" aria-label="Ad channel">
          <button type="button" role="tab" aria-selected={!isEbay} aria-label="Amazon ads" title="Amazon ads" className={`h10-chan ${!isEbay ? 'on' : ''}`} onClick={() => switchChannel('amazon')}>
            <AmazonBadge size={18} />
          </button>
          <button type="button" role="tab" aria-selected={isEbay} aria-label="eBay ads" title="eBay ads" className={`h10-chan ${isEbay ? 'on' : ''}`} onClick={() => switchChannel('ebay')}>
            <EbayBadge size={18} />
          </button>
        </div>
      </div>
      <nav className="h10-nav">
        {nav.map((it) => {
          const href = `${ADS_BASE}/${it.route}`
          const hasGroups = !!it.groups?.length
          const hasChildren = !!it.children?.length || hasGroups
          // A parent is "section-active" (subtle chip) when you're on one of its children,
          // and "exact-active" (full fill) only on its own page — so the collapsed rail still
          // shows which section you're in without claiming you're on the parent page.
          const groupItems = it.groups?.flatMap((g) => g.items) ?? []
          const childRouteActive = hasChildren
            && (it.children ?? groupItems).some((c) => isActive(c.route) && c.route !== it.route)
          const exactActive = !it.external && isActive(it.route) && !childRouteActive
          const isOpen = hasChildren && !!open[it.route]
          const bodyInner = (
            <>
              <span className="ico"><it.Icon size={20} /></span>
              <span className="lbl">{it.label}</span>
              {it.route === 'suggestions' && pendingSuggestions > 0 && <span className="h10-nav-badge" aria-label={`${pendingSuggestions} pending suggestions`}>{pendingSuggestions > 99 ? '99+' : pendingSuggestions}</span>}
            </>
          )
          return (
            <div key={it.route} className="h10-group">
              {it.external ? (
                <a href={it.external} target="_blank" rel="noopener noreferrer" className="h10-item">
                  {bodyInner}
                  <ExternalLink className="ext" size={14} aria-hidden />
                </a>
              ) : hasChildren ? (
                <div className={`h10-item h10-parent ${exactActive ? 'on' : childRouteActive ? 'section' : ''}`}>
                  <Link href={href} className="h10-parent-link" aria-current={exactActive ? 'page' : undefined}>{bodyInner}</Link>
                  <button
                    type="button"
                    className="h10-parent-chev"
                    aria-label={isOpen ? `Collapse ${it.label}` : `Expand ${it.label}`}
                    aria-expanded={isOpen}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(it.route) }}
                  >
                    <ChevronDown className={`chev ${isOpen ? 'open' : ''}`} size={16} aria-hidden />
                  </button>
                </div>
              ) : (
                <Link href={href} className={`h10-item ${exactActive ? 'on' : ''}`} aria-current={exactActive ? 'page' : undefined}>{bodyInner}</Link>
              )}
              {hasChildren && isOpen && (
                <div className="h10-sub">
                  {it.children?.map((c) => {
                    const chref = `${ADS_BASE}/${c.route}`
                    return <Link key={c.route} href={chref} className={`h10-subitem ${pathname === chref ? 'on' : ''}`}>{c.label}</Link>
                  })}
                  {it.groups?.map((g) => {
                    const gkey = `${it.route}:${g.group}`
                    const gOpen = !!open[gkey]
                    const gActive = g.items.some((c) => pathname === `${ADS_BASE}/${c.route}`)
                    return (
                      <div key={gkey} className="h10-subgroup">
                        <div className={`h10-subitem h10-subparent ${gActive ? 'on' : ''}`}>
                          <button
                            type="button"
                            className="subname subname-toggle"
                            aria-expanded={gOpen}
                            title={`${g.group} — ${g.hint}`}
                            onClick={() => toggle(gkey)}
                          >
                            {g.group}
                          </button>
                          <button
                            type="button"
                            className="subchev-btn"
                            aria-expanded={gOpen}
                            aria-label={gOpen ? `Collapse ${g.group}` : `Expand ${g.group}`}
                            onClick={() => toggle(gkey)}
                          >
                            <ChevronDown className={`subchev ${gOpen ? 'open' : ''}`} size={14} aria-hidden />
                          </button>
                        </div>
                        {gOpen && (
                          <div className="h10-subsub">
                            {g.items.map((c) => {
                              const chref = `${ADS_BASE}/${c.route}`
                              return (
                                <Link
                                  key={c.route}
                                  href={chref}
                                  className={`h10-subsubitem ${pathname === chref ? 'on' : ''}`}
                                >
                                  <span className="mname">{c.label}</span>
                                </Link>
                              )
                            })}
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
      <div className="h10-railft">Built to match Helium 10 Ads · WIP</div>
    </aside>
  )
}
