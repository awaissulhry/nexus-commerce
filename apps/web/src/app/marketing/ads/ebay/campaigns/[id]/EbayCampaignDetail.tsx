'use client'

/**
 * E3 — campaign detail. General: ads with RATE-AT-AD-LEVEL truth +
 * break-even column + per-listing window performance. Priority: ad groups →
 * keywords (+ bids, locked note under DYNAMIC) + exact/phrase negatives.
 * Offsite: campaign-level only (eBay exposes no children).
 */
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { AdsPageHeader } from '../../../_shell/AdsPageHeader'
import { DataGrid, type Column } from '@/design-system/components/DataGrid'
import { Banner } from '@/design-system/components/Banner'
import { EmptyState } from '@/design-system/components/EmptyState'
import { Skeleton } from '@/design-system/primitives/Skeleton'
import { Select } from '@/design-system/primitives/Select'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '../../ebay.css'
import {
  useEbayAdsFetch, PRESETS, eurC, pctP, intlN, FreshnessLine,
  StrategyChip, StatusChip, BreakEvenCell,
  type CampaignDetailPayload, type AdRow, type KeywordRow,
} from '../../_shared'

export function EbayCampaignDetail({ campaignId }: { campaignId: string }) {
  const [preset, setPreset] = useState('last30')
  const { data, error, loading, reload } = useEbayAdsFetch<CampaignDetailPayload>(`/campaigns/${campaignId}`, 'all', preset)

  const c = data?.campaign
  const isOffsite = (c?.channels ?? []).includes('OFF_SITE')
  const isCps = c?.fundingModel === 'COST_PER_SALE'
  const isSmart = c?.targetingType === 'SMART'
  const dynamicBidding = c?.adRateStrategy === 'DYNAMIC'

  const totals = useMemo(() => {
    const ads = data?.ads ?? []
    const t = ads.reduce(
      (acc, a) => ({
        impressions: acc.impressions + a.metrics.impressions,
        clicks: acc.clicks + a.metrics.clicks,
        adFeesCents: acc.adFeesCents + a.metrics.adFeesCents,
        salesCents: acc.salesCents + a.metrics.salesCents,
        soldQty: acc.soldQty + a.metrics.soldQty,
      }),
      { impressions: 0, clicks: 0, adFeesCents: 0, salesCents: 0, soldQty: 0 },
    )
    return { ...t, acosPct: t.salesCents > 0 ? (t.adFeesCents / t.salesCents) * 100 : null }
  }, [data])

  const adColumns: Column<AdRow>[] = useMemo(() => [
    {
      key: 'listing', label: 'Listing', sticky: true, width: 320, sortable: true, sortValue: (a) => a.title ?? a.listingId ?? '',
      render: (a) => (
        <div className="eb-cell-name">
          <span className="nm">{a.title ?? a.inventoryReference ?? a.listingId ?? '—'}</span>
          <span className="sub">
            {a.listingId && (
              <a href={`https://www.ebay.it/itm/${a.listingId}`} target="_blank" rel="noopener noreferrer" className="eb-extlink">
                {a.listingId} <ExternalLink size={11} aria-hidden />
              </a>
            )}
            {a.priceCents != null && <> · {eurC(a.priceCents)}</>}
            {a.quantity != null && <> · qty {a.quantity}</>}
            {a.createdVia === 'DISCOVERED' && <span className="eb-chip eb-chip--dim">Seller Hub</span>}
          </span>
        </div>
      ),
    },
    {
      key: 'status', label: 'State', width: 110,
      render: (a) => (
        <span>
          <StatusChip status={a.status} />
          {a.listingEnded && <span className="eb-chip eb-chip--stale" title="The listing behind this ad is no longer live on eBay">listing ended</span>}
        </span>
      ),
    },
    {
      key: 'rate', label: 'Ad rate', align: 'right', width: 90, sortable: true, sortValue: (a) => a.bidPercentage ?? -1,
      render: (a) => (
        <span title={a.bidPercentage == null && c?.bidPercentage != null ? `Inherits campaign default ${c.bidPercentage}%` : 'Ad-level rate (authoritative)'}>
          {a.bidPercentage != null ? `${a.bidPercentage}%` : c?.bidPercentage != null ? `(${c.bidPercentage}%)` : '—'}
        </span>
      ),
    },
    { key: 'breakEven', label: 'Break-even', align: 'right', width: 100, render: (a) => <BreakEvenCell pct={a.breakEvenAdRatePct} status={a.economicsStatus} /> },
    { key: 'impr', label: 'Impr.', align: 'right', width: 90, sortable: true, sortValue: (a) => a.metrics.impressions, render: (a) => intlN(a.metrics.impressions) },
    { key: 'clicks', label: 'Clicks', align: 'right', width: 75, sortable: true, sortValue: (a) => a.metrics.clicks, render: (a) => intlN(a.metrics.clicks) },
    { key: 'ctr', label: 'CTR', align: 'right', width: 75, render: (a) => pctP(a.metrics.ctrPct, 2) },
    { key: 'fees', label: 'Ad fees', align: 'right', width: 95, sortable: true, sortValue: (a) => a.metrics.adFeesCents, render: (a) => eurC(a.metrics.adFeesCents) },
    { key: 'sales', label: 'Ad sales', align: 'right', width: 100, sortable: true, sortValue: (a) => a.metrics.salesCents, render: (a) => eurC(a.metrics.salesCents) },
    { key: 'acos', label: 'ACOS', align: 'right', width: 85, sortable: true, sortValue: (a) => a.metrics.acosPct ?? -1, render: (a) => pctP(a.metrics.acosPct) },
    { key: 'sold', label: 'Sold', align: 'right', width: 65, render: (a) => intlN(a.metrics.soldQty) },
  ], [c])

  const kwColumns: Column<KeywordRow>[] = useMemo(() => [
    { key: 'text', label: 'Keyword', sticky: true, width: 240, sortable: true, sortValue: (k) => k.text, render: (k) => <span className="eb-kw">{k.text}</span> },
    { key: 'match', label: 'Match', width: 90, render: (k) => <span className="eb-chip eb-chip--dim">{k.matchType}</span> },
    { key: 'group', label: 'Ad group', width: 160, sortable: true, sortValue: (k) => k.adGroupName ?? '', render: (k) => k.adGroupName ?? '—' },
    {
      key: 'bid', label: 'Bid', align: 'right', width: 90, sortable: true, sortValue: (k) => k.bidCents ?? -1,
      render: (k) => (k.bidCents != null ? eurC(k.bidCents) : <span title={dynamicBidding ? 'Dynamic bidding — eBay sets bids; manual edits locked' : undefined}>{dynamicBidding ? 'dynamic' : '—'}</span>),
    },
    { key: 'status', label: 'Status', width: 90, render: (k) => <StatusChip status={k.status} /> },
    { key: 'impr', label: 'Impr.', align: 'right', width: 85, sortable: true, sortValue: (k) => k.metrics.impressions, render: (k) => intlN(k.metrics.impressions) },
    { key: 'clicks', label: 'Clicks', align: 'right', width: 75, sortable: true, sortValue: (k) => k.metrics.clicks, render: (k) => intlN(k.metrics.clicks) },
    { key: 'fees', label: 'Ad fees', align: 'right', width: 95, sortable: true, sortValue: (k) => k.metrics.adFeesCents, render: (k) => eurC(k.metrics.adFeesCents) },
    { key: 'sales', label: 'Ad sales', align: 'right', width: 100, render: (k) => eurC(k.metrics.salesCents) },
  ], [dynamicBidding])

  return (
    <div className="eb-page">
      <AdsPageHeader
        title={c ? c.name : 'Campaign'}
        subtitle={c ? `started ${new Date(c.startDate).toLocaleDateString('en-GB')}${c.endDate ? ` · ended ${new Date(c.endDate).toLocaleDateString('en-GB')}` : ''}` : 'Loading campaign…'}
        markets={c ? [c.marketplace] : []}
        market={c?.marketplace ?? ''}
        onMarketChange={() => {}}
      />

      <div className="eb-controls">
        <Link href="/marketing/ads/ebay/campaigns" className="eb-linkbtn"><ArrowLeft size={13} aria-hidden /> All campaigns</Link>
        <Select value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Date range">
          {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </Select>
        <FreshnessLine f={data?.freshness} />
      </div>

      {error && <Banner tone="danger" title="Couldn't load this campaign">{error} — <button className="eb-linkbtn" onClick={reload}>retry</button></Banner>}
      {loading && <Skeleton height={380} />}

      {c && (
        <>
          <section className="eb-panel eb-panel--head">
            <div className="eb-headchips">
              <StrategyChip fundingModel={c.fundingModel} targetingType={c.targetingType} channels={c.channels} />
              <StatusChip status={c.status} />
              {c.isRulesBased && <span className="eb-chip eb-chip--rules" title="eBay auto-adds/removes matching listings daily; selection rules are immutable (clone to change)">rules-based</span>}
              {c.nexusManaged ? <span className="eb-chip eb-chip--nexus">Nexus-managed</span> : <span className="eb-chip eb-chip--dim">Seller Hub</span>}
              {c.adRateStrategy && <span className="eb-chip eb-chip--dim" title={c.adRateStrategy === 'DYNAMIC' ? `Follows eBay's suggested rate${(c.dynamicAdRatePrefs as { adRateCapPercent?: string })?.adRateCapPercent ? ` capped at ${(c.dynamicAdRatePrefs as { adRateCapPercent?: string }).adRateCapPercent}%` : ''}` : 'Fixed rate'}>{c.adRateStrategy.toLowerCase()} rate</span>}
              {isSmart && <span className="eb-chip eb-chip--dim" title="eBay picks keywords + bids under your max CPC">smart targeting</span>}
            </div>
            <div className="eb-headstats">
              <div><span className="k">{isCps ? 'Campaign rate' : 'Daily budget'}</span><span className="v">{isCps ? (c.bidPercentage != null ? `${c.bidPercentage}%` : 'per-ad') : c.dailyBudgetCents != null ? `${eurC(c.dailyBudgetCents)}/day` : '—'}</span></div>
              {!isCps && <div><span className="k">Budget edits today</span><span className="v" title="eBay hard limit: 15 budget updates per campaign per day">{c.budgetUpdatesToday} / 15</span></div>}
              <div><span className="k">Window ad fees</span><span className="v">{eurC(totals.adFeesCents)}</span></div>
              <div><span className="k">Window ad sales</span><span className="v">{eurC(totals.salesCents)} <em>any-click</em></span></div>
              <div><span className="k">eBay ACOS</span><span className="v">{pctP(totals.acosPct)}</span></div>
              <div><span className="k">Sold</span><span className="v">{intlN(totals.soldQty)}</span></div>
            </div>
          </section>

          {isOffsite ? (
            <EmptyState title="Promoted Offsite campaign" description="Offsite campaigns are campaign-level only: eBay manages placement and CPC on external networks (Google). There are no per-listing ads or keywords to show; performance appears in the trend once eBay reports it." />
          ) : (
            <>
              <section className="eb-panel">
                <header className="eb-panel-head"><h3>Ads ({data.ads.length})</h3><span className="eb-panel-note">Rate-at-ad-level is the truth — ad rates override the campaign default{c.bidPercentage != null ? ` (${c.bidPercentage}%)` : ''}.</span></header>
                {data.ads.length === 0 ? (
                  <EmptyState title="No ads synced for this campaign" description={c.isRulesBased ? 'Rules-based campaigns attach listings on eBay side; the hourly entity sync mirrors them here.' : 'The hourly entity sync mirrors ads from eBay.'} />
                ) : (
                  <DataGrid<AdRow> columns={adColumns} rows={data.ads} rowKey={(a) => a.id} initialSort={{ key: 'fees', dir: 'desc' }} maxHeight={430} />
                )}
              </section>

              {!isCps && !isSmart && (
                <>
                  <section className="eb-panel">
                    <header className="eb-panel-head">
                      <h3>Keywords ({data.keywords.length}) · {data.adGroups.length} ad groups</h3>
                      {dynamicBidding && <span className="eb-panel-note">Dynamic bidding is ON — eBay adjusts bids daily; manual bid edits are locked by eBay.</span>}
                    </header>
                    {data.keywords.length === 0 ? (
                      <EmptyState title="No keywords" description="Manual Priority campaigns target keywords per ad group; the hourly sync mirrors them here." />
                    ) : (
                      <DataGrid<KeywordRow> columns={kwColumns} rows={data.keywords} rowKey={(k) => k.id} initialSort={{ key: 'clicks', dir: 'desc' }} maxHeight={380} />
                    )}
                  </section>

                  <section className="eb-panel">
                    <header className="eb-panel-head"><h3>Negative keywords ({data.negativeKeywords.length})</h3><span className="eb-panel-note">eBay supports EXACT and PHRASE negatives (no broad).</span></header>
                    {data.negativeKeywords.length === 0 ? (
                      <EmptyState title="No negative keywords" />
                    ) : (
                      <div className="eb-negatives">
                        {data.negativeKeywords.map((n) => (
                          <span key={n.id} className="eb-chip eb-chip--neg" title={`${n.matchType} · ${n.status}`}>−{n.text}<em>{n.matchType.toLowerCase()}</em></span>
                        ))}
                      </div>
                    )}
                  </section>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
