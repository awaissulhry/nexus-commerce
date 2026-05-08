'use client'

/**
 * O.8d — extracted from OrdersWorkspace.tsx. Read-only history view
 * of the D.7 review-request engine: shows the last N requests
 * across rules + manual triggers + Amazon Solicitations stub
 * outcomes. The CRUD surface (rule editor, dry-run, presets) lives
 * at /orders/reviews/rules and is preserved as the existing review
 * feature per the engagement directive.
 *
 * Two operator actions inline:
 *   • "Run engine now" → POST /api/review-engine/tick (processes
 *     SCHEDULED requests, runs eligibility re-check, fires the
 *     Amazon SP-API solicitation when the adapter is wired).
 *   • Refresh → re-pulls /api/review-requests.
 *
 * Self-contained state; no parent props.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { RefreshCw, Sparkles, Star } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { channelTone, REVIEW_STATUS_TONE } from '../_lib/tone'

type ReviewRequestRow = {
  id: string
  orderId: string
  channel: string
  status: string
  sentAt: string | null
  scheduledFor: string | null
  errorMessage: string | null
  suppressedReason: string | null
  rule: { name: string } | null
  order: { channelOrderId: string } | null
}

export function ReviewsLens() {
  const { toast } = useToast()
  const [requests, setRequests] = useState<ReviewRequestRow[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)

  const refresh = useCallback(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/review-requests?pageSize=200`, {
      cache: 'no-store',
    })
      .then((r) => r.json())
      .then((data) => setRequests(data.items ?? []))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const tickEngine = async () => {
    setRunning(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/review-engine/tick`, {
        method: 'POST',
      })
      const data = await res.json()
      toast.success(
        `Engine ran: ${data.processed} processed · ${data.sent} sent · ${data.failed} failed · ${data.suppressed} suppressed`,
      )
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Link
          href="/orders/reviews/rules"
          className="h-8 px-3 text-base bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 inline-flex items-center gap-1.5"
        >
          <Sparkles size={12} /> Manage rules
        </Link>
        <button
          onClick={tickEngine}
          disabled={running}
          className="h-8 px-3 text-base bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          <RefreshCw size={12} className={running ? 'animate-spin' : ''} /> Run
          engine now
        </button>
        <button
          onClick={refresh}
          className="h-8 px-3 text-base border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
      {loading ? (
        <Card>
          <div className="text-md text-slate-500 py-8 text-center">
            Loading review requests…
          </div>
        </Card>
      ) : requests.length === 0 ? (
        <EmptyState
          icon={Star}
          title="No review requests yet"
          description="Create a rule, run it, or send manually from an order detail."
          action={{ label: 'Manage rules', href: '/orders/reviews/rules' }}
        />
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-md">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">
                    Order
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">
                    Channel
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">
                    Status
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">
                    Rule
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">
                    Sent / Scheduled
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">
                    Reason
                  </th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={`/orders/${r.orderId}`}
                        className="font-mono text-base text-blue-600 hover:underline"
                      >
                        {r.order?.channelOrderId ?? r.orderId.slice(0, 12)}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block text-xs font-semibold uppercase px-1.5 py-0.5 border rounded ${channelTone(r.channel)}`}
                      >
                        {r.channel}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block text-xs uppercase tracking-wider font-semibold px-1.5 py-0.5 border rounded ${REVIEW_STATUS_TONE[r.status] ?? 'bg-slate-50 text-slate-500 border-slate-200'}`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-600">
                      {r.rule?.name ?? (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-500">
                      {r.sentAt
                        ? new Date(r.sentAt).toLocaleString()
                        : r.scheduledFor
                          ? `→ ${new Date(r.scheduledFor).toLocaleString()}`
                          : '—'}
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-500 max-w-[260px] truncate">
                      {r.errorMessage ?? r.suppressedReason ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
