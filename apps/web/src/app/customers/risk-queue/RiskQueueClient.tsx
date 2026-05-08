'use client'

// AU.6 — Dedicated risk-queue triage page.
//
// The list view (CustomersWorkspace) shows ALL customers; risk
// triage gets buried behind a filter. This page is the single
// place an ops user opens first thing in the morning to clear
// the manual-review backlog.
//
// Backend: GET /api/customers/risk-queue (O.22). Returns
// customers with riskFlag IN (HIGH, MEDIUM) OR manualReviewState =
// PENDING, ordered PENDING-first.
//
// Per-row actions (PATCH /api/customers/:id/manual-review):
//   - Approve   → state=APPROVED → drop off the queue
//   - Reject    → state=REJECTED → drop off, but stays scored
//   - Re-score  → POST /api/customers/:id/recompute-risk

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { RefreshCw, Check, X } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'

type RiskRow = {
  id: string
  email: string
  name: string | null
  totalOrders: number
  totalSpentCents: number
  lastOrderAt: string | null
  riskFlag: string | null
  manualReviewState: string | null
  lastRiskComputedAt: string | null
}

const RISK_VARIANT: Record<string, 'success' | 'warning' | 'danger'> = {
  LOW: 'success',
  MEDIUM: 'warning',
  HIGH: 'danger',
}

export default function RiskQueueClient() {
  const { toast } = useToast()
  const [rows, setRows] = useState<RiskRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'PENDING' | 'ALL'>('PENDING')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/customers/risk-queue?limit=200`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      setRows(data.customers ?? [])
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    refresh()
  }, [refresh])

  const filtered =
    filter === 'PENDING'
      ? rows.filter((r) => r.manualReviewState === 'PENDING')
      : rows

  const setReview = async (
    id: string,
    state: 'APPROVED' | 'REJECTED' | 'PENDING',
  ) => {
    setBusyId(id)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/customers/${id}/manual-review`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state }),
        },
      )
      if (!res.ok) throw new Error(await res.text())
      toast.success(
        state === 'APPROVED'
          ? 'Approved — removed from queue'
          : state === 'REJECTED'
            ? 'Rejected — removed from queue'
            : 'Marked pending',
      )
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusyId(null)
    }
  }
  const recompute = async (id: string) => {
    setBusyId(id)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/customers/${id}/recompute-risk`,
        { method: 'POST' },
      )
      if (!res.ok) throw new Error(await res.text())
      toast.success('Re-scored')
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusyId(null)
    }
  }

  const pendingCount = rows.filter((r) => r.manualReviewState === 'PENDING').length
  const highCount = rows.filter((r) => r.riskFlag === 'HIGH').length
  const mediumCount = rows.filter((r) => r.riskFlag === 'MEDIUM').length

  return (
    <div className="p-6 space-y-4">
      <PageHeader
        title="Risk Queue"
        description="Customers flagged for manual review. Clear the backlog daily."
        breadcrumbs={[
          { label: 'Customers', href: '/customers' },
          { label: 'Risk Queue' },
        ]}
        actions={
          <button
            onClick={refresh}
            className="h-8 px-3 inline-flex items-center gap-1.5 text-sm border border-slate-200 rounded hover:bg-slate-50"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        }
      />

      <div className="grid grid-cols-3 gap-3">
        <Card title="Pending review">
          <div className="text-2xl font-semibold text-amber-600">
            {pendingCount}
          </div>
        </Card>
        <Card title="High risk">
          <div className="text-2xl font-semibold text-rose-600">{highCount}</div>
        </Card>
        <Card title="Medium risk">
          <div className="text-2xl font-semibold text-amber-600">
            {mediumCount}
          </div>
        </Card>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => setFilter('PENDING')}
          className={`h-8 px-3 text-sm rounded border ${
            filter === 'PENDING'
              ? 'bg-slate-900 text-white border-slate-900'
              : 'border-slate-200 hover:bg-slate-50'
          }`}
        >
          Pending only
        </button>
        <button
          onClick={() => setFilter('ALL')}
          className={`h-8 px-3 text-sm rounded border ${
            filter === 'ALL'
              ? 'bg-slate-900 text-white border-slate-900'
              : 'border-slate-200 hover:bg-slate-50'
          }`}
        >
          All flagged
        </button>
      </div>

      <Card title={`Queue (${filtered.length})`}>
        {loading ? (
          <Skeleton className="h-32" />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Check}
            title="Queue clear"
            description="No customers awaiting review."
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-md text-slate-500 border-b border-slate-200">
              <tr>
                <th className="text-left py-2 px-2">Customer</th>
                <th className="text-left py-2 px-2">Risk</th>
                <th className="text-left py-2 px-2">Review</th>
                <th className="text-right py-2 px-2">Orders</th>
                <th className="text-right py-2 px-2">LTV</th>
                <th className="text-left py-2 px-2">Last order</th>
                <th className="text-right py-2 px-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-slate-100 hover:bg-slate-50"
                >
                  <td className="py-2 px-2">
                    <Link
                      href={`/customers/${r.id}`}
                      className="text-blue-600 hover:underline font-medium"
                    >
                      {r.name ?? r.email}
                    </Link>
                    {r.name && (
                      <div className="text-md text-slate-500">{r.email}</div>
                    )}
                  </td>
                  <td className="py-2 px-2">
                    {r.riskFlag ? (
                      <Badge variant={RISK_VARIANT[r.riskFlag] ?? 'default'}>
                        {r.riskFlag}
                      </Badge>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="py-2 px-2">
                    {r.manualReviewState ? (
                      <Badge
                        variant={
                          r.manualReviewState === 'PENDING'
                            ? 'warning'
                            : r.manualReviewState === 'APPROVED'
                              ? 'success'
                              : 'danger'
                        }
                      >
                        {r.manualReviewState}
                      </Badge>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="py-2 px-2 text-right">{r.totalOrders}</td>
                  <td className="py-2 px-2 text-right">
                    €{(r.totalSpentCents / 100).toFixed(2)}
                  </td>
                  <td className="py-2 px-2 text-md text-slate-600">
                    {r.lastOrderAt
                      ? new Date(r.lastOrderAt).toLocaleDateString()
                      : '—'}
                  </td>
                  <td className="py-2 px-2">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        disabled={busyId === r.id}
                        onClick={() => setReview(r.id, 'APPROVED')}
                        title="Approve — clear from queue"
                        className="h-7 px-2 inline-flex items-center gap-1 text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 disabled:opacity-50"
                      >
                        <Check className="w-3 h-3" /> Approve
                      </button>
                      <button
                        disabled={busyId === r.id}
                        onClick={() => setReview(r.id, 'REJECTED')}
                        title="Reject — clear from queue, keep flagged"
                        className="h-7 px-2 inline-flex items-center gap-1 text-xs bg-rose-50 text-rose-700 border border-rose-200 rounded hover:bg-rose-100 disabled:opacity-50"
                      >
                        <X className="w-3 h-3" /> Reject
                      </button>
                      <button
                        disabled={busyId === r.id}
                        onClick={() => recompute(r.id)}
                        title="Re-score from current orders"
                        className="h-7 px-2 inline-flex items-center gap-1 text-xs border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50"
                      >
                        <RefreshCw className="w-3 h-3" /> Re-score
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
