'use client'

/**
 * CBN.2d — shared Ad-console page header (Helium 10 Ads match): eyebrow + title +
 * subtitle on the left; Learn · Share Feedback · Data Sync · Date range · Market
 * selector · Action ▾ on the right. Reused by every /marketing/ads page.
 */
import { useState } from 'react'
import Link from 'next/link'
import { Video, ExternalLink, RefreshCw, Calendar, ChevronDown } from 'lucide-react'

const FLAG: Record<string, string> = {
  IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', GB: '🇬🇧', UK: '🇬🇧', NL: '🇳🇱',
  SE: '🇸🇪', PL: '🇵🇱', BE: '🇧🇪', IE: '🇮🇪', TR: '🇹🇷', US: '🇺🇸',
}
const MARKET_NAME: Record<string, string> = {
  IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', GB: 'United Kingdom', UK: 'United Kingdom',
  NL: 'Netherlands', SE: 'Sweden', PL: 'Poland', BE: 'Belgium', IE: 'Ireland', TR: 'Türkiye', US: 'United States',
}

export const RANGE_PRESETS: Array<{ key: string; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 Days' },
  { key: 'last30', label: 'Last 30 Days' },
  { key: 'thisMonth', label: 'This Month' },
  { key: 'lastMonth', label: 'Last Month' },
]
const fmt = (d: Date) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
export function rangeBounds(preset: string): { start: Date; end: Date } {
  const end = new Date(); const start = new Date()
  switch (preset) {
    case 'today': break
    case 'yesterday': start.setDate(start.getDate() - 1); end.setDate(end.getDate() - 1); break
    case 'last30': start.setDate(start.getDate() - 29); break
    case 'thisMonth': start.setDate(1); break
    case 'lastMonth': start.setMonth(start.getMonth() - 1, 1); end.setDate(0); break
    case 'last7': default: start.setDate(start.getDate() - 6); break
  }
  return { start, end }
}
export function rangeLabel(preset: string): string { const { start, end } = rangeBounds(preset); return `${fmt(start)} - ${fmt(end)}` }

export interface HeaderAction { label: string; href?: string; onClick?: () => void }

export function AdsPageHeader({
  title, subtitle, markets, market, onMarketChange, rangePreset, onRangePreset, onDataSync, syncing, actions,
}: {
  title: string; subtitle: string
  markets: string[]; market: string; onMarketChange: (m: string) => void
  rangePreset: string; onRangePreset: (p: string) => void
  onDataSync: () => void; syncing?: boolean
  actions: HeaderAction[]
}) {
  const [open, setOpen] = useState<'' | 'market' | 'range' | 'action'>('')
  const close = () => setOpen('')
  const marketChip = market === 'all' ? 'All markets' : `${FLAG[market] ?? '🏳️'} ${MARKET_NAME[market] ?? market}`

  return (
    <div className="h10-hdr">
      <div className="h10-hdr-l">
        <div className="eyebrow">Nexus Ads</div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div className="h10-hdr-r">
        <button type="button" className="h10-hbtn"><Video size={15} /> Learn</button>
        <a className="h10-hbtn ghost" href="mailto:feedback@nexus-commerce.app?subject=Ads%20feedback"><ExternalLink size={14} /> Share Feedback</a>
        <button type="button" className="h10-hbtn ghost" onClick={onDataSync} disabled={syncing}><RefreshCw size={14} className={syncing ? 'spin' : ''} /> Data Sync</button>

        {/* date range */}
        <div className="h10-hsel">
          <button type="button" className="h10-hbtn" onClick={() => setOpen(open === 'range' ? '' : 'range')}><Calendar size={14} /> {rangeLabel(rangePreset)} <ChevronDown size={13} /></button>
          {open === 'range' && <>
            <button type="button" className="h10-menu-back" aria-label="Close" onClick={close} />
            <div className="h10-menu">
              {RANGE_PRESETS.map((p) => (
                <button type="button" key={p.key} className={p.key === rangePreset ? 'on' : ''} onClick={() => { onRangePreset(p.key); close() }}>
                  <span>{p.label}</span><span className="sub">{rangeLabel(p.key)}</span>
                </button>
              ))}
            </div>
          </>}
        </div>

        {/* market / account selector */}
        <div className="h10-hsel">
          <button type="button" className="h10-hbtn acct" onClick={() => setOpen(open === 'market' ? '' : 'market')}>
            <span className="amz">amazon</span><span className="chip">{marketChip}</span><ChevronDown size={13} />
          </button>
          {open === 'market' && <>
            <button type="button" className="h10-menu-back" aria-label="Close" onClick={close} />
            <div className="h10-menu">
              <button type="button" className={market === 'all' ? 'on' : ''} onClick={() => { onMarketChange('all'); close() }}>All markets</button>
              {markets.map((m) => (
                <button type="button" key={m} className={m === market ? 'on' : ''} onClick={() => { onMarketChange(m); close() }}>
                  <span>{FLAG[m] ?? '🏳️'} {MARKET_NAME[m] ?? m}</span><span className="sub">{m}</span>
                </button>
              ))}
            </div>
          </>}
        </div>

        {/* Action dropdown */}
        <div className="h10-hsel">
          <button type="button" className="h10-hbtn primary" onClick={() => setOpen(open === 'action' ? '' : 'action')}><ChevronDown size={14} /> Action</button>
          {open === 'action' && <>
            <button type="button" className="h10-menu-back" aria-label="Close" onClick={close} />
            <div className="h10-menu right">
              {actions.map((a) => a.href
                ? <Link key={a.label} href={a.href} className="lk" onClick={close}>{a.label}</Link>
                : <button type="button" key={a.label} onClick={() => { a.onClick?.(); close() }}>{a.label}</button>)}
            </div>
          </>}
        </div>
      </div>
    </div>
  )
}
