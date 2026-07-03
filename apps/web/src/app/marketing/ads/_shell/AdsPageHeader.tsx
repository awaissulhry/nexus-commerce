'use client'

/**
 * CBN.2d — shared Ad-console page header (Helium 10 Ads match): eyebrow + title +
 * subtitle on the left; Learn · Share Feedback · Data Sync · Date range · Market
 * selector · Action ▾ on the right. Reused by every /marketing/ads page.
 * CBN.2f — the date control is the full DateRangePicker (its range is local to the
 * header for now; lift it when the campaigns list endpoint becomes date-aware).
 */
import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Video, ExternalLink, RefreshCw, ChevronDown } from 'lucide-react'
import { DateRangePicker } from './DateRangePicker'
import { EbayMark } from './EbayMark'

const FLAG: Record<string, string> = {
  IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', GB: '🇬🇧', UK: '🇬🇧', NL: '🇳🇱',
  SE: '🇸🇪', PL: '🇵🇱', BE: '🇧🇪', IE: '🇮🇪', TR: '🇹🇷', US: '🇺🇸',
}
const MARKET_NAME: Record<string, string> = {
  IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', GB: 'United Kingdom', UK: 'United Kingdom',
  NL: 'Netherlands', SE: 'Sweden', PL: 'Poland', BE: 'Belgium', IE: 'Ireland', TR: 'Türkiye', US: 'United States',
}

// Kept for AdManagerGraph (preset → {start,end}); the header itself now uses the
// full DateRangePicker. Safe to retire once the graph moves to an explicit range.
export const RANGE_PRESETS: Array<{ key: string; label: string }> = [
  { key: 'today', label: 'Today' }, { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 Days' }, { key: 'last30', label: 'Last 30 Days' },
  { key: 'thisMonth', label: 'This Month' }, { key: 'lastMonth', label: 'Last Month' },
]
const fmtMD = (d: Date) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
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
export function rangeLabel(preset: string): string { const { start, end } = rangeBounds(preset); return `${fmtMD(start)} - ${fmtMD(end)}` }

export interface HeaderAction { label: string; href?: string; onClick?: () => void }
/** A single primary button rendered in place of the Action ▾ dropdown (e.g. the
 *  Rules & Automation page's "+ Rule"). When set, `actions` is ignored. */
export interface HeaderPrimary { label: string; icon?: ReactNode; href?: string; onClick?: () => void }

export function AdsPageHeader({
  title, subtitle, markets, market, onMarketChange, onDataSync, syncing, actions, onDateRange,
  showLearn = true, showDataSync = true, showDateRange = true, primaryAction, channel = 'amazon',
}: {
  title: string; subtitle: string
  markets: string[]; market: string; onMarketChange: (m: string) => void
  onDataSync?: () => void; syncing?: boolean
  actions?: HeaderAction[]
  // optional: parent can observe the picked range; the header owns the state for now
  rangePreset?: string; onRangePreset?: (p: string) => void
  onDateRange?: (start: Date, end: Date) => void
  // CBN — per-page header tailoring (Rules & Automation hides Learn/Data-Sync/Date
  // and swaps the Action ▾ dropdown for a single "+ Rule" primary button).
  showLearn?: boolean; showDataSync?: boolean; showDateRange?: boolean
  primaryAction?: HeaderPrimary
  // ER1 (additive; Amazon default) — the account-cluster brand mark. eBay
  // pages pass 'ebay' so the header stops showing the amazon wordmark.
  channel?: 'amazon' | 'ebay'
}) {
  const [open, setOpen] = useState<'' | 'market' | 'action'>('')
  const close = () => setOpen('')
  const marketChip = market === 'all' ? 'All markets' : `${FLAG[market] ?? '🏳️'} ${MARKET_NAME[market] ?? market}`
  const [dateRange, setDateRange] = useState(() => { const e = new Date(); e.setHours(0, 0, 0, 0); const s = new Date(e); s.setDate(s.getDate() - 6); return { start: s, end: e } })

  return (
    <div className="h10-hdr">
      <div className="h10-hdr-l">
        <div className="eyebrow">Nexus Ads</div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div className="h10-hdr-r">
        {showLearn && <button type="button" className="h10-hbtn"><Video size={15} /> Learn</button>}
        <a className="h10-hbtn ghost" href="mailto:feedback@nexus-commerce.app?subject=Ads%20feedback"><ExternalLink size={14} /> Share Feedback</a>
        {showDataSync && <button type="button" className="h10-hbtn ghost" onClick={onDataSync} disabled={syncing}><RefreshCw size={14} className={syncing ? 'spin' : ''} /> Data Sync</button>}

        {showDateRange && <DateRangePicker value={dateRange} onChange={(s, e) => { setDateRange({ start: s, end: e }); onDateRange?.(s, e) }} />}

        {/* market / account selector */}
        <div className="h10-hsel">
          <button type="button" className="h10-hbtn acct" onClick={() => setOpen(open === 'market' ? '' : 'market')}>
            {channel === 'ebay' ? <EbayMark /> : <span className="amz">amazon</span>}<span className="chip">{marketChip}</span><ChevronDown size={13} />
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

        {/* Primary: a single button (e.g. "+ Rule") when primaryAction is set,
            otherwise the Action ▾ dropdown. */}
        {primaryAction ? (
          primaryAction.href
            ? <Link href={primaryAction.href} className="h10-hbtn primary">{primaryAction.icon}{primaryAction.label}</Link>
            : <button type="button" className="h10-hbtn primary" onClick={primaryAction.onClick}>{primaryAction.icon}{primaryAction.label}</button>
        ) : (
          <div className="h10-hsel">
            <button type="button" className="h10-hbtn primary" onClick={() => setOpen(open === 'action' ? '' : 'action')}><ChevronDown size={14} /> Action</button>
            {open === 'action' && <>
              <button type="button" className="h10-menu-back" aria-label="Close" onClick={close} />
              <div className="h10-menu right">
                {(actions ?? []).map((a) => a.href
                  ? <Link key={a.label} href={a.href} className="lk" onClick={close}>{a.label}</Link>
                  : <button type="button" key={a.label} onClick={() => { a.onClick?.(); close() }}>{a.label}</button>)}
              </div>
            </>}
          </div>
        )}
      </div>
    </div>
  )
}
