'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ADS_NAV, ADS_BASE } from './nav'

export function AdsSidebar() {
  const pathname = usePathname() || ''
  return (
    <aside className="h10-rail">
      <div className="h10-brand"><span className="mk">Nexus</span> <b>Ads</b></div>
      <nav className="h10-nav">
        {ADS_NAV.map((it) => {
          const href = `${ADS_BASE}/${it.route}`
          const active = pathname === href || pathname.startsWith(`${href}/`)
          return (
            <div key={it.route} className="h10-group">
              <Link href={href} className={`h10-item ${active ? 'on' : ''}`}>
                <it.Icon size={17} />
                <span className="lbl">{it.label}</span>
              </Link>
              {it.children && active && (
                <div className="h10-sub">
                  {it.children.map((c) => {
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
