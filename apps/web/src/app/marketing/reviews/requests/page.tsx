'use client'

/**
 * SR.4 — Post-purchase review request workspace.
 *
 * Shows the review request queue: scheduled, sent, failed counts +
 * a table of upcoming scheduled requests. Manual trigger for the mailer
 * cron. Links out to the review rules (D.7 engine).
 *
 * The productType-aware timing rules (optimalSendDelayDays) live in
 * review-scheduler.service.ts on the API. The mailer cron runs every
 * 4h under NEXUS_ENABLE_REVIEW_INGEST=1.
 */

import { useEffect, useState } from 'react'
import { Mail, AlertCircle, TrendingUp } from 'lucide-react'
import Link from 'next/link'
import { getBackendUrl } from '@/lib/backend-url'
import { ReviewsNav } from '../_shared/ReviewsNav'
import { RequestsActionsClient } from './RequestsActionsClient'
import { RequestRowActions } from './RequestRowActions'
import { PipelineHealthBanner, type PipelineHealth } from './PipelineHealthBanner'
import { TestModeClient } from './test/TestModeClient'

interface Analytics {
  window: { since: string; until: string; days: number }
  overall: { sent: number; reviewedAfter: number; conversionRate: number }
  perMarketplace: Array<{ marketplace: string; sent: number; reviewedAfter: number; conversionRate: number }>
  perProductType: Array<{ productType: string; sent: number; reviewedAfter: number; conversionRate: number }>
  perRule?: Array<{
    ruleId: string | null
    ruleName: string
    ruleScope: string | null
    ruleMarketplace: string | null
    ruleActive: boolean
    sent: number
    reviewedAfter: number
    conversionRate: number
  }>
  daily: Array<{ date: string; sent: number; reviewedAfter: number }>
}

async function fetchAnalytics(): Promise<Analytics | null> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/reviews/analytics?windowDays=30`, { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as Analytics
  } catch {
    return null
  }
}

interface Stats {
  scheduled: number
  sent: number
  failed: number
  skipped: number
  skippedReasons?: Array<{ reason: string; count: number }>
  due: number
  retrying?: number
  upcoming: Array<{
    id: string
    orderId: string
    scheduledFor: string | null
    channel: string
    order: {
      channelOrderId: string | null
      channel: string
      marketplace: string | null
      customerName: string | null
      items: Array<{
        product: { name: string; productType: string | null } | null
      }>
    } | null
  }>
  sentiment?: {
    pending: number
    positive: number
    negative: number
  }
  mailer?: {
    isPaused: boolean
    pausedReason: string | null
    pausedAt: string | null
    pausedBy: string | null
  }
  pipelineHealth?: PipelineHealth
}

async function fetchStats(): Promise<Stats> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/reviews/requests/stats`, {
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as Stats
  } catch {
    return { scheduled: 0, sent: 0, failed: 0, skipped: 0, due: 0, upcoming: [] }
  }
}

// Optimal delay reference (mirrored from review-scheduler.service.ts for display)
export default function ReviewRequestsPage() {
  // The API session cookie lives on the API origin (cross-site setup) — the
  // Next server can never present it, so data MUST load client-side where the
  // S3 fetch patch adds credentials. Server-side this page 401'd into zeros.
  const [data, setData] = useState<{ stats: Stats; analytics: Analytics | null } | null>(null)
  useEffect(() => {
    let alive = true
    Promise.all([fetchStats(), fetchAnalytics()]).then(([stats, analytics]) => {
      if (alive) setData({ stats, analytics })
    })
    return () => { alive = false }
  }, [])

  if (!data) {
    return (
      <div className="px-4 py-4" aria-busy="true">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
          <Mail className="h-5 w-5 text-blue-500" />
          Review Requests
        </h1>
        <div className="mt-4 grid grid-cols-2 md:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
          ))}
        </div>
      </div>
    )
  }
  const { stats, analytics } = data

  return (
    <div className="px-4 py-4">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
        <Mail className="h-5 w-5 text-blue-500" />
        Review Requests
      </h1>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
        Post-purchase review request scheduler. productType-aware timing decides the optimal
        day to ask for a review. Amazon orders use the Solicitations API; eBay &amp; Shopify
        orders receive a branded email via Resend.
      </p>
      <ReviewsNav />

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
        <Stat label="Scheduled" value={stats.scheduled} tone={stats.scheduled > 0 ? 'amber' : null} />
        <Stat label="Due now" value={stats.due} tone={stats.due > 0 ? 'rose' : null} />
        <Stat label="Retrying" value={stats.retrying ?? 0} tone={(stats.retrying ?? 0) > 0 ? 'amber' : null} />
        <Stat label="Sent" value={stats.sent} tone="emerald" />
        <Stat label="Failed" value={stats.failed} tone={stats.failed > 0 ? 'rose' : null} />
        <Stat label="Skipped" value={stats.skipped} {...skipSummary(stats.skippedReasons)} />
      </div>

      <RequestsActionsClient mailer={stats.mailer} />

      {/* RV.9.2 — pipeline health banner */}
      {stats.pipelineHealth && <PipelineHealthBanner health={stats.pipelineHealth} />}

      {/* RV.6.5 — sentiment-check funnel tiles */}
      {stats.sentiment && (stats.sentiment.pending + stats.sentiment.positive + stats.sentiment.negative > 0) && (
        <div className="mb-4">
          <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
            Sentiment funnel (negative-feedback diversion)
          </h2>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Awaiting response" value={stats.sentiment.pending} tone={stats.sentiment.pending > 0 ? 'amber' : null} />
            <Stat label="😊 Positive" value={stats.sentiment.positive} tone="emerald" />
            <Stat label="😕 Negative (diverted)" value={stats.sentiment.negative} tone={stats.sentiment.negative > 0 ? 'rose' : null} />
          </div>
          <p className="mt-1 text-[11px] text-tertiary">
            Negative customers are routed to support before they hit Amazon — average rating lift typically +0.2 to +0.5 stars.
          </p>
        </div>
      )}

      {/* RV.8.2 — Analytics. UX.5: render whenever analytics is loaded (not only
          when there are sends in-window). The whole block used to vanish if the
          only requests were older than the 30-day window, making a working page
          (126 sent all-time) look empty. */}
      {analytics && (
        <section className="mb-6">
          <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2 flex items-center gap-1.5">
            <TrendingUp className="h-4 w-4 text-emerald-500" />
            Conversion analytics — last {analytics.window.days} days
          </h2>

          {analytics.overall.sent === 0 ? (
            <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-md p-4 mb-3 text-sm text-slate-500 dark:text-slate-400">
              No review requests sent in the last {analytics.window.days} days.{' '}
              <span className="font-semibold text-slate-700 dark:text-slate-300">{stats.sent.toLocaleString()}</span> sent all-time — these analytics track only the last {analytics.window.days} days.
            </div>
          ) : (<>
          {/* Overall headline */}
          <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-md p-4 mb-3">
            <div className="flex items-baseline gap-4 flex-wrap">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500">Sent</div>
                <div className="text-2xl font-bold tabular-nums">{analytics.overall.sent.toLocaleString()}</div>
              </div>
              <div className="text-slate-300">→</div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500">Reviews after</div>
                <div className="text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
                  {analytics.overall.reviewedAfter.toLocaleString()}
                </div>
              </div>
              <div className="text-slate-300">·</div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500">Conversion</div>
                <div className="text-2xl font-bold tabular-nums text-blue-700 dark:text-blue-300">
                  {(analytics.overall.conversionRate * 100).toFixed(1)}%
                </div>
              </div>
              <div className="ml-auto text-[11px] text-tertiary">
                Industry baseline: 5–15%
              </div>
            </div>
            {/* Sparkline */}
            {analytics.daily.length > 0 && (() => {
              const max = Math.max(...analytics.daily.map((d) => d.sent), 1)
              const w = 100 / analytics.daily.length
              return (
                <svg className="w-full mt-3" style={{ height: 60 }} viewBox={`0 0 100 60`} preserveAspectRatio="none">
                  {analytics.daily.map((d, i) => {
                    const sentH = (d.sent / max) * 56
                    const reviewedH = (d.reviewedAfter / max) * 56
                    return (
                      <g key={d.date}>
                        <rect x={i * w + 0.2} y={60 - sentH} width={w - 0.4} height={sentH} fill="#94a3b8" opacity={0.6} />
                        <rect x={i * w + 0.2} y={60 - reviewedH} width={w - 0.4} height={reviewedH} fill="#10b981" />
                      </g>
                    )
                  })}
                </svg>
              )
            })()}
            <div className="flex items-center gap-4 text-[11px] text-slate-500 mt-1">
              <span className="inline-flex items-center gap-1">
                <span className="inline-block w-2 h-2 bg-slate-400 rounded-sm"></span> Sent
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block w-2 h-2 bg-emerald-500 rounded-sm"></span> Review left after (attributed)
              </span>
            </div>
          </div>

          {/* Breakdowns side-by-side */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <BreakdownTable
              title="By marketplace"
              rows={analytics.perMarketplace}
              labelKey="marketplace"
            />
            <BreakdownTable
              title="By product type"
              rows={analytics.perProductType}
              labelKey="productType"
            />
          </div>

          {/* RV.9.4 — Per-rule conversion */}
          {analytics.perRule && analytics.perRule.length > 0 && (
            <div className="mt-3">
              <PerRuleTable rows={analytics.perRule} />
            </div>
          )}
          {analytics.overall.reviewedAfter === 0 && (
            <div className="mt-3 rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              Conversion reads 0% because there are no ingested reviews to attribute yet — connect Amazon insights (Brand Analytics role) or turn on eBay / import so we can measure whether requests actually convert.
            </div>
          )}
          </>)}
        </section>
      )}

      {/* Upcoming queue */}
      <section className="mb-6">
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          Upcoming ({stats.upcoming.length})
        </h2>
        <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-md overflow-hidden">
          {stats.upcoming.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-slate-500">
              No scheduled requests. Run the mailer cron to schedule newly delivered orders.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-950/50 border-b border-default dark:border-slate-800">
                <tr className="text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <th className="px-3 py-2">Send date</th>
                  <th className="px-3 py-2">Order</th>
                  <th className="px-3 py-2">Channel</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {stats.upcoming.map((r) => {
                  const order = r.order
                  const product = order?.items[0]?.product ?? null
                  return (
                    <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-950/40">
                      <td className="px-3 py-2 text-xs font-mono tabular-nums">
                        {r.scheduledFor
                          ? new Date(r.scheduledFor).toLocaleDateString('en-GB', {
                              day: '2-digit',
                              month: '2-digit',
                            })
                          : '—'}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-700 dark:text-slate-300">
                        {order?.channelOrderId ? (
                          <Link
                            href={`/orders/${r.orderId}`}
                            className="text-blue-600 dark:text-blue-400 hover:underline"
                            title={`Open order ${order.channelOrderId}`}
                          >
                            {order.channelOrderId}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">
                          {order?.channel ?? '—'}
                          {order?.marketplace ? ` ${order.marketplace}` : ''}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">
                        {order?.customerName ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400 max-w-[200px] truncate">
                        {product?.name ?? '—'}
                        {product?.productType && (
                          <span className="ml-1 text-tertiary text-[10px]">
                            ({product.productType})
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <RequestRowActions requestId={r.id} status="SCHEDULED" />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* UX.5b — settings, timing reference & test mode tucked into a collapsed
          disclosure so the daily view stays simple (KPIs · run/pause · health ·
          analytics · upcoming). One click away, fully functional. */}
      <details className="mb-6 rounded-md border border-default dark:border-slate-800 bg-white dark:bg-slate-900">
        <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-950/40">
          Settings, timing reference &amp; test mode
        </summary>
        <div className="px-4 pb-4 pt-3 space-y-6 border-t border-default dark:border-slate-800">
      {/* Timing — the old hardcoded reference table is retired; timing is now set
          by rules + the editable per-product-type baseline (RRT-series). */}
      <section>
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Timing</h2>
        <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-md px-4 py-3 text-sm text-slate-600 dark:text-slate-300">
          When each request is sent is set by your{' '}
          <Link href="/orders/reviews/rules" className="text-blue-600 dark:text-blue-400 hover:underline">request rules</Link>{' '}
          and the editable{' '}
          <Link href="/orders/reviews/rules/timing" className="text-blue-600 dark:text-blue-400 hover:underline">per-product-type timing defaults</Link>.
          A rule’s delay (or, when it has none, the baseline table) is the “days after delivery”; Amazon orders are clamped to the 4–25 day Solicitations window.
          With the timing table empty, rules govern and anything unmatched uses the 12-day default.
        </div>
      </section>

      {/* RV.9.6 — Test mode */}
      <TestModeClient />

      {/* Env/config notice */}
      <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-md px-3 py-2 flex items-start gap-2">
        <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" aria-hidden="true" />
        <div className="text-xs text-amber-900 dark:text-amber-100 leading-relaxed space-y-1">
          <div>
            <strong>Amazon Solicitations</strong> — set{' '}
            <code className="px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50">
              NEXUS_ENABLE_AMAZON_SOLICITATIONS=true
            </code>{' '}
            to fire live API calls.
          </div>
          <div>
            <strong>eBay/Shopify email</strong> — set{' '}
            <code className="px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50">
              NEXUS_ENABLE_OUTBOUND_EMAILS=true
            </code>{' '}
            +{' '}
            <code className="px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50">
              RESEND_API_KEY
            </code>{' '}
            to send branded emails.
          </div>
          <div>
            <strong>Cron</strong> — runs every 4h under{' '}
            <code className="px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50">
              NEXUS_ENABLE_REVIEW_INGEST=1
            </code>
            . Override schedule via{' '}
            <code className="px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50">
              NEXUS_REVIEW_MAILER_SCHEDULE
            </code>
            .
          </div>
          <div>
            See also: Review Rules (D.7) in Settings → Review Automation for D.7 engine configuration.
          </div>
        </div>
      </div>
        </div>
      </details>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
  sub,
  hint,
}: {
  label: string
  value: number
  tone?: 'emerald' | 'amber' | 'rose' | null
  sub?: string
  hint?: string
}) {
  const valueClass =
    tone === 'emerald'
      ? 'text-emerald-700 dark:text-emerald-300'
      : tone === 'amber'
        ? 'text-amber-700 dark:text-amber-300'
        : tone === 'rose'
          ? 'text-rose-700 dark:text-rose-300'
          : 'text-slate-900 dark:text-slate-100'
  return (
    <div title={hint} className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className={`text-base font-semibold tabular-nums ${valueClass}`}>{value}</div>
      {sub && <div className="text-[10px] text-tertiary dark:text-slate-500 mt-0.5 leading-tight">{sub}</div>}
    </div>
  )
}

// Compact, self-explaining summary for the Skipped KPI: a short sub-line + a
// full per-reason breakdown on hover. "Skipped" is benign (e.g. Amazon already
// solicited the order) — this stops it reading as an error.
function skipSummary(reasons?: Array<{ reason: string; count: number }>): { sub?: string; hint?: string } {
  if (!reasons || reasons.length === 0) return {}
  const hint = reasons.map((r) => `${r.count} · ${r.reason}`).join('\n')
  const SHORT: Record<string, string> = {
    'Amazon already solicited a review for this order': 'already solicited by Amazon',
    'Diverted to support (negative sentiment)': 'diverted — negative',
    'No customer email on order': 'no customer email',
    'No channelOrderId for Amazon solicitation': 'missing order id',
    'No diversion response in 5d; rule fallback disabled': 'no diversion reply',
  }
  const top = reasons[0]
  let sub = SHORT[top.reason]
    ?? top.reason.replace(/^Outside Amazon.*$/i, 'outside send window').replace(/^Suppressed:.*$/i, 'suppressed / unsubscribed')
  if (sub.length > 26) sub = `${sub.slice(0, 25)}…`
  return { sub: reasons.length > 1 ? `mostly ${sub}` : sub, hint }
}

function PerRuleTable({
  rows,
}: {
  rows: Array<{
    ruleId: string | null
    ruleName: string
    ruleScope: string | null
    ruleMarketplace: string | null
    ruleActive: boolean
    sent: number
    reviewedAfter: number
    conversionRate: number
  }>
}) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-md overflow-hidden">
      <div className="px-3 py-2 border-b border-default dark:border-slate-800 text-[11px] uppercase tracking-wider text-slate-500 font-medium flex items-center justify-between">
        <span>By rule</span>
        <span className="text-[10px] normal-case text-tertiary">
          Compare conversion across active rules — keep the winners, retire the rest
        </span>
      </div>
      <table className="w-full text-xs">
        <thead className="bg-slate-50 dark:bg-slate-950/40">
          <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">
            <th className="px-3 py-1.5">Rule</th>
            <th className="px-3 py-1.5">Scope / Mkt</th>
            <th className="px-3 py-1.5 text-right">Sent</th>
            <th className="px-3 py-1.5 text-right">Reviewed</th>
            <th className="px-3 py-1.5 text-right">Rate</th>
            <th className="px-3 py-1.5">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((r) => {
            const pct = (r.conversionRate * 100).toFixed(1)
            const tone =
              r.conversionRate >= 0.1 ? 'text-emerald-700 dark:text-emerald-300'
              : r.conversionRate >= 0.05 ? 'text-blue-700 dark:text-blue-300'
              : 'text-slate-600 dark:text-slate-400'
            return (
              <tr key={r.ruleId ?? '__nullrule__'}>
                <td className="px-3 py-1.5 font-medium text-slate-700 dark:text-slate-300">
                  {r.ruleName}
                </td>
                <td className="px-3 py-1.5 text-slate-500 font-mono text-[10px]">
                  {r.ruleScope ?? '—'}
                  {r.ruleMarketplace ? ` · ${r.ruleMarketplace}` : ''}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.sent}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700 dark:text-emerald-300">{r.reviewedAfter}</td>
                <td className={`px-3 py-1.5 text-right tabular-nums font-semibold ${tone}`}>{pct}%</td>
                <td className="px-3 py-1.5">
                  {r.ruleId === null ? (
                    <span className="inline-block text-[10px] px-1.5 py-0.5 rounded ring-1 ring-inset bg-slate-50 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">
                      fallback
                    </span>
                  ) : r.ruleActive ? (
                    <span className="inline-block text-[10px] px-1.5 py-0.5 rounded ring-1 ring-inset bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900">
                      active
                    </span>
                  ) : (
                    <span className="inline-block text-[10px] px-1.5 py-0.5 rounded ring-1 ring-inset bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900">
                      inactive
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

interface BreakdownRow {
  marketplace?: string
  productType?: string
  sent: number
  reviewedAfter: number
  conversionRate: number
}

function BreakdownTable({
  title,
  rows,
  labelKey,
}: {
  title: string
  rows: BreakdownRow[]
  labelKey: 'marketplace' | 'productType'
}) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-md overflow-hidden">
      <div className="px-3 py-2 border-b border-default dark:border-slate-800 text-[11px] uppercase tracking-wider text-slate-500 font-medium">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-4 text-xs text-slate-500 text-center">No data in window.</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="bg-slate-50 dark:bg-slate-950/40">
            <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">
              <th className="px-3 py-1.5">{labelKey === 'marketplace' ? 'Mkt' : 'Product type'}</th>
              <th className="px-3 py-1.5 text-right">Sent</th>
              <th className="px-3 py-1.5 text-right">Reviewed</th>
              <th className="px-3 py-1.5 text-right">Rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((r) => {
              const label = (r as any)[labelKey] ?? '—'
              const pct = (r.conversionRate * 100).toFixed(1)
              const tone =
                r.conversionRate >= 0.1 ? 'text-emerald-700 dark:text-emerald-300'
                : r.conversionRate >= 0.05 ? 'text-blue-700 dark:text-blue-300'
                : 'text-slate-600 dark:text-slate-400'
              return (
                <tr key={label}>
                  <td className="px-3 py-1.5 font-medium text-slate-700 dark:text-slate-300">{label}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.sent}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700 dark:text-emerald-300">{r.reviewedAfter}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums font-semibold ${tone}`}>{pct}%</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
