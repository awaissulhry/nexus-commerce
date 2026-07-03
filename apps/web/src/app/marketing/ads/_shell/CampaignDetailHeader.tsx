'use client'

/**
 * CBN.3.1 — Campaign Details page header (Helium 10 match). Distinct from the list
 * header (AdsPageHeader): a "Back to Ad Manager" link, the targeting-type badge + the
 * campaign name as the title, and a right-side action cluster — Learn · Share Feedback ·
 * date-range (grid tabs only) · account selector · Action ▾. Reuses DateRangePicker and
 * the shared .h10-hbtn / .h10-hsel / .h10-menu styling so the two headers stay in sync.
 */
import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowLeft, Video, ExternalLink, ChevronDown } from 'lucide-react'
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

export interface DetailHeaderAction { label: string; href?: string; onClick?: () => void; danger?: boolean }

export function CampaignDetailHeader({
  badge, title, markets, market, onMarketChange,
  showDateRange, dateRange, onDateRange, actions,
  backLabel = 'Back to Ad Manager', backHref = '/marketing/ads/campaigns', label = 'Campaign Details',
  channel = 'amazon', titleBadges,
}: {
  badge?: string
  title: string
  markets: string[]
  market: string
  onMarketChange: (m: string) => void
  showDateRange: boolean
  dateRange: { start: Date; end: Date }
  onDateRange: (start: Date, end: Date) => void
  actions: DetailHeaderAction[]
  backLabel?: string
  backHref?: string
  label?: string
  // ER1 (additive; Amazon default) — brand mark + optional pills after the title
  channel?: 'amazon' | 'ebay'
  titleBadges?: ReactNode
}) {
  const [open, setOpen] = useState<'' | 'market' | 'action'>('')
  const close = () => setOpen('')
  const marketChip = market === 'all' ? 'All markets' : `${FLAG[market] ?? '🏳️'} ${MARKET_NAME[market] ?? market}`

  return (
    <div className="h10-cd-hdr">
      <Link href={backHref} className="h10-cd-back"><ArrowLeft size={15} /> {backLabel}</Link>
      <div className="h10-cd-titlerow">
        <div className="h10-cd-titlecol">
          <div className="lbl">{label}</div>
          <h1 title={title}>{badge ? <span className="h10-cd-badge" data-t={badge}>{badge}</span> : null}<span className="nm">{title || '—'}</span>{titleBadges}</h1>
        </div>
        <div className="h10-cd-actions">
          <button type="button" className="h10-hbtn"><Video size={15} /> Learn</button>
          <a className="h10-hbtn ghost" href="mailto:feedback@nexus-commerce.app?subject=Ads%20feedback"><ExternalLink size={14} /> Share Feedback</a>

          {showDateRange && <DateRangePicker value={dateRange} onChange={onDateRange} />}

          {/* account / market selector — same pattern as the list header */}
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

          {/* Action dropdown */}
          <div className="h10-hsel">
            <button type="button" className="h10-hbtn primary" onClick={() => setOpen(open === 'action' ? '' : 'action')}><ChevronDown size={14} /> Action</button>
            {open === 'action' && <>
              <button type="button" className="h10-menu-back" aria-label="Close" onClick={close} />
              <div className="h10-menu right">
                {actions.map((a) => a.href
                  ? <Link key={a.label} href={a.href} className="lk" onClick={close}>{a.label}</Link>
                  : <button type="button" key={a.label} className={a.danger ? 'danger' : ''} onClick={() => { a.onClick?.(); close() }}>{a.label}</button>)}
              </div>
            </>}
          </div>
        </div>
      </div>
    </div>
  )
}
