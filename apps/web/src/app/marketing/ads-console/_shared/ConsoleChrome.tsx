'use client'

/**
 * Automation Console chrome — Phase 1 rebuild.
 * 6 live nav items (zero dead links), wired icon rail, Amazon deep-links per market.
 */

import Link from 'next/link'
import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
  LayoutDashboard, Zap, Crosshair, Activity, FileSpreadsheet,
  Settings, ExternalLink, ChevronLeft, Bell, HelpCircle, User, Megaphone,
  type LucideIcon,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { amazonCampaignsHref, marketLabel } from './amazonLinks'

const BASE = '/marketing/ads-console'

interface NavItem { k: string; label: string; href: string; Icon: LucideIcon }
const NAV: NavItem[] = [
  { k: 'overview',   label: 'Overview',     href: `${BASE}/overview`,   Icon: LayoutDashboard },
  { k: 'automation', label: 'Automation',   href: `${BASE}/automation`, Icon: Zap             },
  { k: 'rank',       label: 'Rank Control', href: `${BASE}/rank`,       Icon: Crosshair       },
  { k: 'activity',   label: 'Activity',     href: `${BASE}/activity`,   Icon: Activity        },
  { k: 'bulk',       label: 'Bulk',         href: `${BASE}/bulk`,       Icon: FileSpreadsheet },
]

interface Conn { profileId: string; marketplace: string; isActive: boolean; mode: string }

function activeKey(pathname: string): string {
  if (pathname.includes('/automation')) return 'automation'
  if (pathname.includes('/rank')) return 'rank'
  if (pathname.includes('/activity')) return 'activity'
  if (pathname.includes('/bulk')) return 'bulk'
  if (pathname.includes('/settings')) return 'settings'
  return 'overview'
}

export function ConsoleChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname() || ''
  const active = activeKey(pathname)
  const [conns, setConns] = useState<Conn[]>([])

  useEffect(() => {
    void fetch(`${getBackendUrl()}/api/advertising/connections`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setConns((d.items ?? []).filter((c: Conn) => c.isActive)))
      .catch(() => {})
  }, [])

  const crumb = NAV.find((n) => n.k === active)?.label ?? (active === 'settings' ? 'Settings' : 'Overview')

  return (
    <>
      {/* ── Top bar ─────────────────────────────────────── */}
      <div className="az-top">
        <Link href={`${BASE}/overview`} className="brand">
          <Megaphone size={18} />
          <span>Nexus<span className="mk"> ads</span></span>
        </Link>
        <span className="crumb">{crumb}</span>
        <span className="sp" />
        <div className="acct">
          <div className="n">XAVIA</div>
          <div className="s">Automation console · {conns.filter(c => c.isActive).length} market{conns.filter(c => c.isActive).length !== 1 ? 's' : ''}</div>
        </div>
        <span className="ti"><Bell size={17} /></span>
        <span className="ti"><HelpCircle size={17} /></span>
        <span className="ti"><User size={18} /></span>
      </div>

      <div className="az-body">
        {/* ── Icon rail — every icon is a live link ────────── */}
        <div className="az-rail">
          {NAV.map(({ k, href, Icon, label }) => (
            <Link key={k} href={href} className={`ri ${active === k ? 'on' : ''}`} title={label}>
              <Icon size={20} />
            </Link>
          ))}
          <span style={{ flex: 1 }} />
          <Link href={`${BASE}/settings`} className={`ri ${active === 'settings' ? 'on' : ''}`} title="Settings">
            <Settings size={20} />
          </Link>
        </div>

        {/* ── Text nav ────────────────────────────────────── */}
        <nav className="az-nav">
          <div className="collapse"><ChevronLeft size={16} /></div>

          {NAV.map(({ k, label, href }) => (
            <Link key={k} href={href} className={active === k ? 'on' : ''}>{label}</Link>
          ))}

          {/* Amazon deep links — one per active marketplace */}
          {conns.length > 0 && (
            <div style={{ marginTop: 16, borderTop: '1px solid var(--divider)', paddingTop: 10 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--ink3)', letterSpacing: 0.6, padding: '0 12px 6px', textTransform: 'uppercase' }}>Open in Amazon</div>
              {conns.map((c) => (
                <a
                  key={c.marketplace}
                  href={amazonCampaignsHref(c.profileId, c.marketplace)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="az-amazon-link"
                >
                  <span className="lbl">{marketLabel(c.marketplace)}</span>
                  {c.mode === 'production' && <span className="live-chip">LIVE</span>}
                  <ExternalLink size={11} style={{ opacity: 0.5, flexShrink: 0 }} />
                </a>
              ))}
            </div>
          )}

          <div style={{ marginTop: 8, borderTop: '1px solid var(--divider)', paddingTop: 8 }}>
            <Link href={`${BASE}/settings`} className={active === 'settings' ? 'on' : ''}>Settings</Link>
          </div>
        </nav>

        <div className="az-content">{children}</div>
      </div>
    </>
  )
}
