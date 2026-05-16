/**
 * AD.2 — Campaign detail drawer.
 *
 * Server-renders the campaign + nested adGroups + productAds, plus the
 * BidHistory timeline. The history feed surfaces both operator + future
 * automation-rule writes (AD.3+).
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft, History } from 'lucide-react'
import { AdvertisingNav } from '../../_shared/AdvertisingNav'
import { getBackendUrl } from '@/lib/backend-url'
import { formatEurAmount, formatPct } from '../../_shared/formatters'

export const dynamic = 'force-dynamic'

interface CampaignDetail {
  campaign: {
    id: string
    name: string
    type: string
    status: string
    marketplace: string | null
    externalCampaignId: string | null
    dailyBudget: string
    biddingStrategy: string
    impressions: number
    clicks: number
    spend: string
    sales: string
    acos: string | null
    roas: string | null
    trueProfitCents: number
    trueProfitMarginPct: string | null
    lastSyncedAt: string | null
    lastSyncStatus: string | null
    adGroups: Array<{
      id: string
      name: string
      defaultBidCents: number
      status: string
      impressions: number
      clicks: number
      spendCents: number
      salesCents: number
      targets: Array<{
        id: string
        kind: string
        expressionType: string
        expressionValue: string
        bidCents: number
        status: string
        impressions: number
        clicks: number
        spendCents: number
        salesCents: number
      }>
      productAds: Array<{
        id: string
        asin: string | null
        sku: string | null
        productId: string | null
        status: string
      }>
    }>
  } | null
}

interface BidHistoryRow {
  id: string
  entityType: string
  entityId: string
  field: string
  oldValue: string | null
  newValue: string | null
  changedAt: string
  changedBy: string
  reason: string | null
}

async function fetchDetail(id: string): Promise<CampaignDetail | null> {
  const res = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${id}`, {
    cache: 'no-store',
  })
  if (res.status === 404) return null
  if (!res.ok) return null
  return (await res.json()) as CampaignDetail
}

async function fetchBidHistory(id: string): Promise<BidHistoryRow[]> {
  const res = await fetch(
    `${getBackendUrl()}/api/advertising/bid-history?campaignId=${id}&limit=100`,
    { cache: 'no-store' },
  )
  if (!res.ok) return []
  const json = (await res.json()) as { items: BidHistoryRow[] }
  return json.items
}

export default async function CampaignDetailPage({ params }: { params: { id: string } }) {
  const [detail, history] = await Promise.all([
    fetchDetail(params.id),
    fetchBidHistory(params.id),
  ])
  if (!detail?.campaign) notFound()
  const c = detail.campaign

  return (
    <div className="px-4 py-4">
      <div className="mb-2">
        <Link
          href="/marketing/advertising/campaigns"
          className="inline-flex items-center gap-1 text-xs text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
        >
          <ChevronLeft className="h-3 w-3" /> Campaigns
        </Link>
      </div>
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{c.name}</h1>
      <div className="text-xs text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-2 flex-wrap">
        <span className="font-mono">{c.marketplace ?? '—'}</span>
        <span>·</span>
        <span className="uppercase">{c.type}</span>
        <span>·</span>
        <span>{c.status}</span>
        {c.externalCampaignId && (
          <>
            <span>·</span>
            <span className="font-mono text-[11px]">{c.externalCampaignId}</span>
          </>
        )}
      </div>
      <AdvertisingNav />

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <Stat label="Budget €/d" value={formatEurAmount(Number(c.dailyBudget))} />
        <Stat label="Spend" value={formatEurAmount(Number(c.spend))} />
        <Stat label="Sales" value={formatEurAmount(Number(c.sales))} />
        <Stat label="ACOS" value={c.acos != null ? formatPct(Number(c.acos)) : '—'} />
        <Stat
          label="True Margin"
          value={c.trueProfitMarginPct != null ? formatPct(Number(c.trueProfitMarginPct)) : '—'}
        />
      </div>

      {/* Ad-groups */}
      <section className="mb-6">
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          Ad-group ({c.adGroups.length})
        </h2>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md divide-y divide-slate-200 dark:divide-slate-800">
          {c.adGroups.length === 0 ? (
            <div className="px-3 py-4 text-sm text-slate-500">No ad groups synced.</div>
          ) : (
            c.adGroups.map((ag) => (
              <div key={ag.id} className="px-3 py-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{ag.name}</span>
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">
                    {ag.status}
                  </span>
                  <span className="text-xs text-slate-500 ml-auto tabular-nums">
                    Bid €{(ag.defaultBidCents / 100).toFixed(2)} · Spend{' '}
                    {formatEurAmount(ag.spendCents / 100)} · Sales{' '}
                    {formatEurAmount(ag.salesCents / 100)}
                  </span>
                </div>
                {ag.targets.length > 0 && (
                  <ul className="mt-1 ml-3 space-y-0.5">
                    {ag.targets.map((t) => (
                      <li
                        key={t.id}
                        className="text-xs text-slate-600 dark:text-slate-400 flex items-center gap-2 flex-wrap"
                      >
                        <span className="font-mono text-slate-900 dark:text-slate-100 truncate max-w-[280px]">
                          {t.expressionValue}
                        </span>
                        <span className="text-[10px] uppercase tracking-wider px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
                          {t.kind} · {t.expressionType}
                        </span>
                        <span className="ml-auto tabular-nums">
                          €{(t.bidCents / 100).toFixed(2)} · {t.impressions.toLocaleString('en-US')} imp ·{' '}
                          {formatEurAmount(t.spendCents / 100)} spend
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {ag.productAds.length > 0 && (
                  <ul className="mt-1 ml-3 space-y-0.5">
                    {ag.productAds.map((pa) => (
                      <li
                        key={pa.id}
                        className="text-xs text-slate-600 dark:text-slate-400 flex items-center gap-2"
                      >
                        <span className="text-[10px] uppercase px-1 py-0.5 rounded bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
                          ProductAd
                        </span>
                        {pa.productId ? (
                          <Link
                            href={`/products/${pa.productId}`}
                            className="text-blue-600 dark:text-blue-400 hover:underline font-mono"
                          >
                            {pa.sku ?? pa.asin}
                          </Link>
                        ) : (
                          <span className="font-mono">{pa.sku ?? pa.asin}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))
          )}
        </div>
      </section>

      {/* Bid history timeline */}
      <section>
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2 flex items-center gap-2">
          <History className="h-4 w-4" />
          Change history ({history.length})
        </h2>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
          {history.length === 0 ? (
            <div className="px-3 py-4 text-sm text-slate-500">
              No changes recorded.
            </div>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {history.map((h) => (
                <li key={h.id} className="px-3 py-2 text-xs flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-slate-500 tabular-nums w-32">
                    {new Date(h.changedAt).toLocaleString('en-GB', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider px-1 py-0.5 rounded ring-1 ring-inset bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">
                    {h.entityType}
                  </span>
                  <span className="text-slate-700 dark:text-slate-300">{h.field}:</span>
                  <span className="font-mono text-rose-700 dark:text-rose-400 line-through">
                    {h.oldValue ?? '—'}
                  </span>
                  <span className="text-slate-500">→</span>
                  <span className="font-mono text-emerald-700 dark:text-emerald-400">
                    {h.newValue ?? '—'}
                  </span>
                  <span className="ml-auto text-[11px] text-slate-500">{h.changedBy}</span>
                  {h.reason && (
                    <span className="basis-full text-[11px] text-slate-500 dark:text-slate-400 italic">
                      {h.reason}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className="text-base font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
        {value}
      </div>
    </div>
  )
}
