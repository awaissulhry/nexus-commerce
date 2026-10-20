'use client'

import Link from '@/lib/workspaces/Link'
import { usePathname, useRouter } from '@/lib/workspaces/navigation'
import { useEffect, useState, type ReactElement } from 'react'
import { ChevronDown, ExternalLink } from 'lucide-react'
import { ADS_BASE, adChannelOf, navFor, switchTarget, type AdChannel } from './nav'
import { AmazonBadge, EbayBadge, GoogleBadge, MetaBadge } from './BrandMarks'
import { getBackendUrl } from '@/lib/backend-url'

// E4.1 — one switch, one console per channel; Google joined as the third (Google Ads step 1a, read only), Meta as the
// fourth (Meta ads step 2, read only).
const CHANNELS: Array<{ id: AdChannel; label: string; Badge: (p: { size?: number }) => ReactElement }> = [
  { id: 'amazon', label: 'Amazon', Badge: AmazonBadge },
  { id: 'ebay', label: 'eBay', Badge: EbayBadge },
  { id: 'google', label: 'Google', Badge: GoogleBadge },
  { id: 'meta', label: 'Meta', Badge: MetaBadge },
]

export function AdsSidebar() {
  const pathname = usePathname() || ''
  const router = useRouter()
  const channel = adChannelOf(pathname)
  const nav = navFor(channel)
  const ChipBadge = CHANNELS.find((c) => c.id === channel)!.Badge

  // E4.1 — switching keeps you on the equivalent page (`switchTarget`, nav.ts).
  const switchChannel = (target: AdChannel) => {
    const route = switchTarget(pathname, target)
    if (route) router.push(`${ADS_BASE}/${route}`)
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
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    for (const it of nav)
      if (it.children?.length)
        init[it.route] = isActive(it.route) || it.children.some((c) => isActive(c.route))
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
          <span className="chip"><ChipBadge size={15} /></span>
        </span>
        <span className="word"><span className="mk">Nexus</span> <b>Ads</b></span>
        {/* E4.1/E6.1 — same console, shift the channel, then pick the market on-page */}
        <div className="h10-brand-switch" role="tablist" aria-label="Ad channel">
          {CHANNELS.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={channel === c.id} aria-label={`${c.label} ads`} title={`${c.label} ads`} className={`h10-chan ${channel === c.id ? 'on' : ''}`} onClick={() => switchChannel(c.id)}>
              <c.Badge size={18} />
            </button>
          ))}
        </div>
      </div>
      <nav className="h10-nav">
        {nav.map((it) => {
          // NAF.SB.7 — `href` set means the row leaves this console (the Agent
          // Fleet at /fleet). Such a row is never "active": if you are on it,
          // you are not in the ads console at all.
          const href = it.href ?? `${ADS_BASE}/${it.route}`
          const hasChildren = !!it.children?.length
          // A parent is "section-active" (subtle chip) when you're on one of its children,
          // and "exact-active" (full fill) only on its own page — so the collapsed rail still
          // shows which section you're in without claiming you're on the parent page.
          const childRouteActive = hasChildren && it.children!.some((c) => isActive(c.route))
          const exactActive = !it.external && !it.href && isActive(it.route) && !childRouteActive
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
                  {it.children!.map((c) => {
                    const chref = `${ADS_BASE}/${c.route}`
                    return <Link key={c.route} href={chref} className={`h10-subitem ${pathname === chref ? 'on' : ''}`}>{c.label}</Link>
                  })}
                </div>
              )}
            </div>
          )
        })}
      </nav>
    </aside>
  )
}
