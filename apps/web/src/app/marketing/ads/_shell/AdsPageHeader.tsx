'use client'

/**
 * CBN.2d — shared Ad-console page header (Helium 10 Ads match): eyebrow + title +
 * subtitle on the left; Learn · Change Log · Data Sync · Date range · Market
 * selector · Action ▾ on the right. Reused by every /marketing/ads page.
 *
 * The Change Log sits here rather than in the sidebar, and is OPT-IN per page rather than shown
 * everywhere: a control repeated on 49 pages stops being navigation and becomes furniture. Pages
 * that own or receive recorded changes ask for it. It took the slot of a mailto "Share Feedback"
 * link — the least-used control in the header and the only one that left the product.
 * CBN.2f — the date control is the full DateRangePicker (its range is local to the
 * header for now; lift it when the campaigns list endpoint becomes date-aware).
 */
import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { RefreshCw, ChevronDown, History } from 'lucide-react'
import { Button, Spinner } from '@/design-system/primitives'
import { DateRangePicker } from './DateRangePicker'
import { EbayMark } from './EbayMark'
import { MarketSelect } from './MarketSelect'
import type { AdsMarket } from './MarketplaceContext'

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
  title, subtitle, markets, market, onMarketChange, onDataSync, syncing, actions, onDateRange, dateRange,
  showDataSync = true, showDateRange = true, showMarket = true, showChangeLog = false, primaryAction, channel = 'amazon',
  allowAllMarkets = true, marketValues, onMarketValuesChange,
}: {
  title: string; subtitle: string
  markets: string[]; market: string; onMarketChange: (m: string) => void
  onDataSync?: () => void; syncing?: boolean
  actions?: HeaderAction[]
  // optional: parent can observe the picked range; the header owns the state for now
  rangePreset?: string; onRangePreset?: (p: string) => void
  onDateRange?: (start: Date, end: Date) => void
  /**
   * PLC.0 (additive; default off) — make this control CONTROLLED.
   *
   * `onDateRange` could already read a change out; nothing could put one back in, because the
   * range lives in this component's own `useState` seeded to the last 7 days. So a page whose
   * window is in its URL — Placement arrives on `?preset=last30` or `?start=…&end=…` — rendered a
   * header label that disagreed with its own grid. Two controls for one fact, which is the defect
   * that sank the reverted scope bar.
   *
   * Passed: the header renders this range and still calls `onDateRange` on every change. Omitted:
   * the header keeps its own state and every other page is byte-identical.
   *
   * ⚠ `DateRangePicker` seeds its calendar HIGHLIGHT from `value` at mount only, so a change that
   * does not originate from the picker (the back button) moves the label — which is what you read
   * — but not the highlighted days until the popover is reopened. Left alone deliberately: that is
   * a second behaviour change to a control 49 pages render.
   *
   * ⚠ `rangePreset` / `onRangePreset` above are DEAD — declared here and never destructured. They
   * are left in place rather than deleted because deleting a prop from a 49-page header is not
   * this session's change to make; do not wire anything to them expecting a callback.
   */
  dateRange?: { start: Date; end: Date }
  // CBN — per-page header tailoring (Rules & Automation hides Learn/Data-Sync/Date
  // and swaps the Action ▾ dropdown for a single "+ Rule" primary button).
  showDataSync?: boolean; showDateRange?: boolean
  /**
   * RA.SPINE S5 (additive; defaults `true`, so every existing page is byte-identical).
   *
   * The market picker was the one control here with no off switch, and that is a defect at eleven
   * pages rather than at one. Each of the ten Rules & Automation pages currently passes a
   * `markets: string[]` derived from **whichever campaigns happened to load** — which is the exact
   * defect `AdsMarketplaceProvider` was written about: *"each analytics page kept its own local
   * market filter … so nothing agreed with anything else."* A page's picker can therefore be
   * missing DE simply because DE had no rows in that page's current window.
   *
   * Those ten wire to the provider in their OWN sessions; this prop is what makes that possible,
   * because a page moving its market control into a scope bar of its own must be able to stop
   * rendering the header's — otherwise it ships two controls for one fact, which is precisely what
   * sank the reverted RA scope bar (`7db1a4ed6`).
   *
   * ⚠ Off means the page owns the market elsewhere and says so. It does not mean the page has no
   * market: a header with no picker and no scope bar leaves the operator unable to see which market
   * they are reading, which is worse than a picker built from the wrong list.
   */
  showMarket?: boolean
  /**
   * 🔴 HV.10 — whether "All markets" is offered. Defaults TRUE, which is what this header
   * hardcoded, so every existing consumer is unchanged.
   *
   * It is a prop because it was a lie on at least one page: the Keyword Tracker's route returns
   * **400** for `market=all` (`KT_MARKETS` is IT/DE/ES/FR), so the option was offered on a page
   * that cannot serve it — the request only failed quietly because that page's `push` happened to
   * drop the param and fall back to IT. A page that cannot serve `all` should not show it.
   */
  allowAllMarkets?: boolean
  /**
   * HV.10 — pass BOTH to turn the picker into a multi-select. Absent ⇒ unchanged single-select.
   * `[]` means "all markets".
   */
  marketValues?: string[]
  onMarketValuesChange?: (codes: string[]) => void
  /** Opt in on pages that own or receive recorded changes. Off everywhere else by default. */
  showChangeLog?: boolean
  primaryAction?: HeaderPrimary
  // ER1 (additive; Amazon default) — the account-cluster brand mark. eBay
  // pages pass 'ebay' so the header stops showing the amazon wordmark.
  channel?: 'amazon' | 'ebay'
}) {
  const pathname = usePathname()
  const changeLogHref = channel === 'ebay' ? '/marketing/ads/ebay/change-log' : '/marketing/ads/changelog'
  const [open, setOpen] = useState<'' | 'action'>('')
  const close = () => setOpen('')
  const [ownRange, setOwnRange] = useState(() => { const e = new Date(); e.setHours(0, 0, 0, 0); const s = new Date(e); s.setDate(s.getDate() - 6); return { start: s, end: e } })
  // Controlled when the parent passes one, uncontrolled otherwise — see the `dateRange` prop doc.
  const shownRange = dateRange ?? ownRange

  // APS.2a — these pages pass a plain string[] of markets they saw in their own
  // data, and every one of those is selectable-as-a-filter. Widen to the shared
  // AdsMarket shape with launchable:true so the extracted control behaves
  // exactly as this header did before.
  const marketOptions: AdsMarket[] = markets.map((m) => ({
    code: m, label: '', mode: 'production', writesEnabled: true, launchable: true,
  }))

  return (
    <div className="h10-hdr">
      <div className="h10-hdr-l">
        <div className="eyebrow">Nexus Ads</div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div className="h10-hdr-r">
        {/* Channel-aware: the eBay console has its own complete change log, and sending an eBay
            operator to the Amazon one would be worse than showing nothing. Hidden when you are
            already there. Navigates in place rather than a new tab — this is top-level console
            navigation, unlike the drawer's link, where a new tab exists to preserve the drawer. */}
        {showChangeLog && pathname !== changeLogHref && (
          <Button asChild variant="ghost">
            <Link href={changeLogHref} title="Every change Nexus made to this account — what changed, what caused it, and whether it reached the channel">
              <History size={14} /> Change Log
            </Link>
          </Button>
        )}
        {/* The spinning state is the DS Spinner, not `<RefreshCw className="spin">`: the only rule
            that animated that icon was `.h10-hbtn .spin`, so dropping `.h10-hbtn` would have left
            a silently motionless "spinner". */}
        {showDataSync && <Button variant="ghost" onClick={onDataSync} disabled={syncing}>{syncing ? <Spinner size={14} /> : <RefreshCw size={14} />} Data Sync</Button>}

        {showDateRange && <DateRangePicker value={shownRange} onChange={(s, e) => { setOwnRange({ start: s, end: e }); onDateRange?.(s, e) }} />}

        {/* market / account selector — shared with the campaign builders (APS.2a).
            `showMarket` is off only for a page that owns the control elsewhere — see the prop. */}
        {showMarket && (
          <MarketSelect
            markets={marketOptions}
            value={market}
            onChange={onMarketChange}
            values={marketValues}
            onValuesChange={onMarketValuesChange}
            allowAll={allowAllMarkets}
            brand={channel === 'ebay' ? <EbayMark /> : <span className="amz">amazon</span>}
          />
        )}

        {/* Primary: a single button (e.g. "+ Rule") when primaryAction is set,
            otherwise the Action ▾ dropdown. */}
        {primaryAction ? (
          primaryAction.href
            ? <Button asChild variant="primary"><Link href={primaryAction.href}>{primaryAction.icon}{primaryAction.label}</Link></Button>
            : <Button variant="primary" onClick={primaryAction.onClick}>{primaryAction.icon}{primaryAction.label}</Button>
        ) : actions?.length ? (
          // RPT.1 — only render Action ▾ when there is at least one action. Pages with
          // neither `primaryAction` nor `actions` (Change Log, Reporting) were showing a
          // primary button that opened an empty popover.
          <div className="h10-hsel">
            <Button variant="primary" aria-haspopup="menu" aria-expanded={open === 'action'} onClick={() => setOpen(open === 'action' ? '' : 'action')}><ChevronDown size={14} /> Action</Button>
            {open === 'action' && <>
              <button type="button" className="h10-menu-back" aria-label="Close" onClick={close} />
              <div className="h10-menu right">
                {(actions ?? []).map((a) => a.href
                  ? <Link key={a.label} href={a.href} className="lk" onClick={close}>{a.label}</Link>
                  : <button type="button" key={a.label} onClick={() => { a.onClick?.(); close() }}>{a.label}</button>)}
              </div>
            </>}
          </div>
        ) : null}
      </div>
    </div>
  )
}
