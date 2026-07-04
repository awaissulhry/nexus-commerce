'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { ChevronDown, ExternalLink } from 'lucide-react'
import { ADS_NAV, EBAY_ADS_NAV, ADS_BASE } from './nav'
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

  // Collapsible parents (AMC, Reporting) toggle their submenu open/closed on click —
  // independent of navigation, exactly like H10. Seed each group open iff the active
  // route is inside it, so deep-linking to a sub-page lands with the group expanded.
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
      <div className="h10-brand">
        <span className="logo" aria-hidden>N</span>
        <span className="word"><span className="mk">Nexus</span> <b>Ads</b></span>
      </div>
      {/* E4.1/E6.1 — channel switch (brand logos): same console, shift the channel, then pick the market on-page */}
      <div className="h10-channel" role="tablist" aria-label="Ad channel">
        <button type="button" role="tab" aria-selected={!isEbay} aria-label="Amazon ads" title="Amazon ads" className={`h10-channel-btn ${!isEbay ? 'on' : ''}`} onClick={() => switchChannel('amazon')}>
          <svg viewBox="0 0 74 24" className="h10-channel-logo" aria-hidden focusable="false">
            <text x="37" y="13" textAnchor="middle" fontSize="13.5" fontWeight="700" letterSpacing="-0.4" fill="currentColor">amazon</text>
            <path d="M18 17.2c9.5 4.6 27.5 4.7 37.5-.3" fill="none" stroke="#FF9900" strokeWidth="2" strokeLinecap="round" />
            <path d="M55.5 16.9l2.8-.9-1.5 2.6z" fill="#FF9900" />
          </svg>
        </button>
        <button type="button" role="tab" aria-selected={isEbay} aria-label="eBay ads" title="eBay ads" className={`h10-channel-btn ${isEbay ? 'on' : ''}`} onClick={() => switchChannel('ebay')}>
          <svg viewBox="0 0 52 24" className="h10-channel-logo" aria-hidden focusable="false">
            <text x="26" y="16.5" textAnchor="middle" fontSize="15" fontWeight="700" letterSpacing="-0.6">
              <tspan fill="#E53238">e</tspan><tspan fill="#0064D2">b</tspan><tspan fill="#F5AF02">a</tspan><tspan fill="#86B817">y</tspan>
            </text>
          </svg>
        </button>
      </div>
      <nav className="h10-nav">
        {nav.map((it) => {
          const href = `${ADS_BASE}/${it.route}`
          const hasChildren = !!it.children?.length
          const active = !it.external && isActive(it.route)
          const isOpen = hasChildren && !!open[it.route]
          const body = (
            <>
              <span className="ico"><it.Icon size={20} /></span>
              <span className="lbl">{it.label}</span>
              {it.route === 'suggestions' && pendingSuggestions > 0 && <span className="h10-nav-badge" aria-label={`${pendingSuggestions} pending suggestions`}>{pendingSuggestions > 99 ? '99+' : pendingSuggestions}</span>}
              {hasChildren && <ChevronDown className={`chev ${isOpen ? 'open' : ''}`} size={16} aria-hidden />}
              {it.external && <ExternalLink className="ext" size={14} aria-hidden />}
            </>
          )
          return (
            <div key={it.route} className="h10-group">
              {it.external ? (
                <a href={it.external} target="_blank" rel="noopener noreferrer" className="h10-item">{body}</a>
              ) : hasChildren ? (
                <button type="button" className={`h10-item ${active ? 'on' : ''}`} aria-expanded={isOpen} onClick={() => toggle(it.route)}>{body}</button>
              ) : (
                <Link href={href} className={`h10-item ${active ? 'on' : ''}`}>{body}</Link>
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
      <div className="h10-railft">Built to match Helium 10 Ads · WIP</div>
    </aside>
  )
}
