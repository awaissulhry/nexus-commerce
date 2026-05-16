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

import Link from 'next/link'
import { Mail, AlertCircle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { ReviewsNav } from '../_shared/ReviewsNav'
import { RequestsActionsClient } from './RequestsActionsClient'

export const dynamic = 'force-dynamic'

interface Stats {
  scheduled: number
  sent: number
  failed: number
  skipped: number
  due: number
  upcoming: Array<{
    id: string
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
const TIMING_DISPLAY: Array<{ match: string[]; days: number; label: string }> = [
  { match: ['Casco', 'Helmet'], days: 21, label: 'Helmet' },
  { match: ['Combinat', 'Suit'], days: 16, label: 'Suit' },
  { match: ['Giacca', 'Giubbotto', 'Jacket'], days: 14, label: 'Jacket' },
  { match: ['Stivali', 'Boot'], days: 14, label: 'Boots' },
  { match: ['Pantalon'], days: 12, label: 'Trousers' },
  { match: ['Guanti', 'Glove'], days: 10, label: 'Gloves' },
]

export default async function ReviewRequestsPage() {
  const stats = await fetchStats()

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
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <Stat label="Scheduled" value={stats.scheduled} tone={stats.scheduled > 0 ? 'amber' : null} />
        <Stat label="Due now" value={stats.due} tone={stats.due > 0 ? 'rose' : null} />
        <Stat label="Sent" value={stats.sent} tone="emerald" />
        <Stat label="Failed" value={stats.failed} tone={stats.failed > 0 ? 'rose' : null} />
        <Stat label="Skipped" value={stats.skipped} />
      </div>

      <RequestsActionsClient />

      {/* Upcoming queue */}
      <section className="mb-6">
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          Upcoming ({stats.upcoming.length})
        </h2>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
          {stats.upcoming.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-slate-500">
              No scheduled requests. Run the mailer cron to schedule newly delivered orders.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-950/50 border-b border-slate-200 dark:border-slate-800">
                <tr className="text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <th className="px-3 py-2">Send date</th>
                  <th className="px-3 py-2">Order</th>
                  <th className="px-3 py-2">Channel</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2">Product</th>
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
                        {order?.channelOrderId?.slice(0, 14) ?? '—'}
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
                          <span className="ml-1 text-slate-400 text-[10px]">
                            ({product.productType})
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* Timing reference */}
      <section className="mb-6">
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          Optimal timing by product type
        </h2>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 dark:bg-slate-950/50 border-b border-slate-200 dark:border-slate-800">
              <tr className="text-left uppercase tracking-wider text-slate-500 dark:text-slate-400">
                <th className="px-3 py-2">Product type</th>
                <th className="px-3 py-2">Keywords matched</th>
                <th className="px-3 py-2 text-right">Delay (days post-delivery)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {TIMING_DISPLAY.map((t) => (
                <tr key={t.label}>
                  <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">{t.label}</td>
                  <td className="px-3 py-2 text-slate-500 font-mono">{t.match.join(', ')}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-blue-700 dark:text-blue-300">
                    {t.days}d
                  </td>
                </tr>
              ))}
              <tr className="bg-slate-50 dark:bg-slate-950/40">
                <td className="px-3 py-2 text-slate-500">All other types</td>
                <td className="px-3 py-2 text-slate-400 italic">default</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-400">12d</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
          Amazon orders are clamped to 4–25 days (Solicitations API window). eBay/Shopify orders
          use the raw delay above with no cap.
        </p>
      </section>

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
            See also:{' '}
            <Link
              href="/settings/review-rules"
              className="underline text-amber-700 dark:text-amber-300"
            >
              Review Rules (D.7)
            </Link>{' '}
            for the D.7 engine configuration.
          </div>
        </div>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'emerald' | 'amber' | 'rose' | null
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
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className={`text-base font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  )
}
