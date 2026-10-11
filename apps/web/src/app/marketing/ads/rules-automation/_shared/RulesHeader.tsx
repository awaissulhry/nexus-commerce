'use client'

/**
 * Bid page programme, lane SHELL (2026-10-10) — the Rules & Automation header in the design system.
 *
 * One compact row: the page title on the left; Change log, the market and the page's own button on the right. No
 * eyebrow (the rail already says Ads) and no subtitle sentence. The section's layout puts this in place of
 * `AdsPageHeader` (`AdsHeaderFrame`), so the eleven tab pages keep passing the props they pass today and every one
 * of them still works: the market a page writes, the Hourly Bids date range and its "Hourly Bid Plan" button, the
 * Automations "Rule" button.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, History, RefreshCw } from 'lucide-react'
import Link from '@/lib/workspaces/Link'
import { usePathname, useRouter } from '@/lib/workspaces/navigation'
import { Button, Spinner } from '@/design-system/primitives'
import { Banner, Listbox, Menu, useNarrow } from '@/design-system/components'
import { PageHeader } from '@/design-system/patterns'
import { AdsHeaderFrame, type AdsHeaderProps } from '../../_shell/AdsPageHeader'
import { DateRangePicker, lastCompleteDays } from '../../_shell/DateRangePicker'
import { MarketSelect } from '../../_shell/MarketSelect'
import { useAdsMarketplaceOptional, type AdsMarket } from '../../_shell/MarketplaceContext'
import { ALL_MARKETS, READING_ONLY, readingOnlyDetail } from '../../_shell/adsMarkets'
import { NO_MARKET, rulesMarketOptions } from './rulesFrame'
import styles from './rulesFrame.module.css'

export function RulesHeader({
  title, markets, market, onMarketChange, onDataSync, syncing, actions, onDateRange, dateRange,
  showDataSync = true, showDateRange = true, showMarket = true, showChangeLog = false, primaryAction, channel = 'amazon',
  allowAllMarkets = true, marketValues, onMarketValuesChange, dataSyncLabel = 'Refresh view', dataSyncTip, marketNotYet, dateRangeNotYet,
}: AdsHeaderProps) {
  const pathname = usePathname()
  const router = useRouter()
  // A phone keeps Change log and the market on one row: Change log becomes its 28px icon (Bid page design audit S8,
  // 2026-10-11 — the two stacked on two rows at 390, 114 and 168px wide).
  const narrow = useNarrow()
  const ads = useAdsMarketplaceOptional()
  const changeLogHref = channel === 'ebay' ? '/marketing/ads/ebay/change-log' : '/marketing/ads/changelog'
  // The same window rule as the ads header: 7 complete days ending yesterday, unless the page holds the range.
  const [ownRange, setOwnRange] = useState(() => lastCompleteDays(7))
  const shownRange = dateRange ?? ownRange

  // What the connections list knows about each market the page offers: a market Nexus only reads says so.
  const known = useMemo(() => markets.map((code) => {
    const k: AdsMarket | undefined = channel === 'amazon' ? ads?.markets.find((x) => x.code === code) : undefined
    const readingOnly = !!k && !k.launchable
    return { code, label: k?.label ?? '', mode: k?.mode ?? 'production', writesEnabled: k?.writesEnabled ?? true, launchable: true,
      note: readingOnly ? 'reading only' : null, whyNot: readingOnly ? k?.whyNot ?? null : null } satisfies AdsMarket
  }), [markets, channel, ads?.markets])
  const options = useMemo(
    () => rulesMarketOptions({ markets: known, value: marketNotYet ? ALL_MARKETS : market, allowAll: allowAllMarkets, notYet: marketNotYet }),
    [known, market, allowAllMarkets, marketNotYet],
  )
  // The operator's own move also moves the shared market the next ads page starts from (AM-28), as the ads header does.
  const changeMarket = (m: string) => {
    if (m === NO_MARKET) return
    if (channel === 'amazon' && ads && (m === ALL_MARKETS || ads.readMarkets.includes(m))) ads.setScopeMarket(m)
    onMarketChange(m)
  }
  const multi = Array.isArray(marketValues) && typeof onMarketValuesChange === 'function'

  // A market Nexus only reads shows its data, and says once, under the header, that its ads are not changed from here.
  const readOnly = channel === 'amazon' && showMarket && ads && market && market !== ALL_MARKETS && ads.readMarkets.includes(market)
    ? ads.writeAccess(market)
    : null

  return (
    <>
      <PageHeader
        title={title}
        actions={(
          <>
            {showChangeLog && pathname !== changeLogHref && (
              <Button asChild size="sm" variant="secondary" className={narrow ? 'icon' : undefined}>
                <Link href={changeLogHref} title="Every change made to this account" aria-label={narrow ? 'Change log' : undefined}>
                  <History size={14} aria-hidden />{narrow ? null : ' Change log'}
                </Link>
              </Button>
            )}
            {showDataSync && (
              // While it reads, a click does nothing and the spinner says why (no silent `disabled`).
              <Button size="sm" variant="secondary" onClick={() => { if (!syncing) onDataSync?.() }} aria-busy={syncing || undefined}
                title={syncing ? 'Reading…' : dataSyncTip}>
                {syncing ? <Spinner size={14} /> : <RefreshCw size={14} aria-hidden />} {dataSyncLabel}
              </Button>
            )}
            {showDateRange && (
              <DateRangePicker value={shownRange} disabledReason={dateRangeNotYet}
                onChange={(s, e) => { setOwnRange({ start: s, end: e }); onDateRange?.(s, e) }} />
            )}
            {showMarket && (multi
              // A page that picks several markets at once keeps the console's multi-market control (Apply commits once).
              ? <MarketSelect markets={known} value={market} onChange={changeMarket} values={marketValues} onValuesChange={onMarketValuesChange}
                  allowAll={allowAllMarkets} notYet={marketNotYet} />
              : <Listbox size="sm" width={168} ariaLabel={channel === 'ebay' ? 'eBay market' : 'Amazon market'} options={options}
                  value={marketNotYet ? ALL_MARKETS : market} onChange={changeMarket} />
            )}
            {primaryAction ? (
              primaryAction.href
                ? <Button asChild size="sm" variant="primary"><Link href={primaryAction.href}>{primaryAction.icon}{primaryAction.label}</Link></Button>
                : <Button size="sm" variant="primary" onClick={primaryAction.onClick}>{primaryAction.icon}{primaryAction.label}</Button>
            ) : actions?.length ? (
              <Menu label={<><ChevronDown size={14} aria-hidden /> Action</>} align="right"
                items={actions.map((a) => ({ id: a.label, label: a.label, onSelect: () => (a.href ? router.push(a.href) : a.onClick?.()) }))} />
            ) : null}
          </>
        )}
      />
      {readOnly && !readOnly.canWrite && (
        <div className={styles.readOnly}>
          <Banner tone="info" title={READING_ONLY}>{readingOnlyDetail(readOnly.reason)}</Banner>
        </div>
      )}
    </>
  )
}

/** Mounted once by the section's layout: every `AdsPageHeader` under it draws `RulesHeader`. */
export function RulesHeaderFrame({ children }: { children: ReactNode }) {
  return <AdsHeaderFrame.Provider value={RulesHeader}>{children}</AdsHeaderFrame.Provider>
}
