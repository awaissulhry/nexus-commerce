'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { ChevronDown, ExternalLink } from 'lucide-react'
import { ADS_NAV, ADS_BASE } from './nav'

export function AdsSidebar() {
  const pathname = usePathname() || ''
  const isActive = (route: string) => {
    const href = `${ADS_BASE}/${route}`
    return pathname === href || pathname.startsWith(`${href}/`)
  }

  // Collapsible parents (AMC, Reporting) toggle their submenu open/closed on click —
  // independent of navigation, exactly like H10. Seed each group open iff the active
  // route is inside it, so deep-linking to a sub-page lands with the group expanded.
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    for (const it of ADS_NAV)
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
      <nav className="h10-nav">
        {ADS_NAV.map((it) => {
          const href = `${ADS_BASE}/${it.route}`
          const hasChildren = !!it.children?.length
          const active = !it.external && isActive(it.route)
          const isOpen = hasChildren && !!open[it.route]
          const body = (
            <>
              <span className="ico"><it.Icon size={20} /></span>
              <span className="lbl">{it.label}</span>
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
