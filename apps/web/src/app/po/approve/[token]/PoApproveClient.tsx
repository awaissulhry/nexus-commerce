'use client'

// PO-Plus.2 — Public approver client. Token-gated, no auth.

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface PublicItem {
  sku: string
  quantityOrdered: number
  unitCostCents: number
  note: string | null
}

interface PublicView {
  poNumber: string
  status: string
  currencyCode: string
  totalCents: number
  expectedDeliveryDate: string | null
  notes: string | null
  expired: boolean
  approverAckExpiresAt: string | null
  supplier: { name: string; email: string | null } | null
  items: PublicItem[]
}

function fmt(cents: number, code: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
    }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`
  }
}

type Outcome = 'approved' | 'declined' | null

export default function PoApproveClient({ token }: { token: string }) {
  const [po, setPo] = useState<PublicView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [declineReason, setDeclineReason] = useState('')
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/po/approve/${token}`, {
        cache: 'no-store',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as PublicView
      setPo(data)
      // Pre-existing outcomes: PO already left REVIEW.
      if (data.status === 'APPROVED') setOutcome('approved')
      if (data.status === 'DRAFT' || data.status === 'CANCELLED') {
        // Could be either declined-via-this-link or operator-side. We
        // only assert "declined" via this link when the status went
        // back to DRAFT; CANCELLED is an operator action.
        setOutcome(data.status === 'DRAFT' ? 'declined' : null)
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  const approve = async () => {
    setBusy('approve')
    setActionError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/po/approve/${token}/approve`, {
        method: 'POST',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      setOutcome('approved')
      await load()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const decline = async () => {
    setBusy('decline')
    setActionError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/po/approve/${token}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: declineReason || null }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      setOutcome('declined')
      await load()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-base text-slate-500 inline-flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      </div>
    )
  }

  if (loadError || !po) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white border border-red-200 rounded-lg p-6">
          <div className="inline-flex items-center gap-2 text-red-700 font-semibold mb-2">
            <XCircle className="w-5 h-5" />
            Approval link unavailable
          </div>
          <p className="text-base text-slate-700">
            {loadError ?? 'This approval link is invalid or has been revoked.'}
          </p>
          <p className="text-sm text-slate-500 mt-3">
            If you received this from a teammate, ask them to re-submit the PO for review.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4">
      <div className="max-w-3xl mx-auto bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 bg-slate-900 text-white">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h1 className="text-xl font-semibold font-mono">{po.poNumber}</h1>
            <span className="text-sm opacity-80">
              {po.expired
                ? 'Link expired'
                : `Expires ${po.approverAckExpiresAt?.slice(0, 10) ?? '—'}`}
            </span>
          </div>
          {po.supplier?.name && (
            <div className="text-sm opacity-80 mt-1">Supplier: {po.supplier.name}</div>
          )}
        </div>

        {outcome === 'approved' && (
          <div className="px-6 py-4 bg-green-50 border-b border-green-200 inline-flex items-center gap-2 text-green-700 w-full">
            <CheckCircle2 className="w-5 h-5" />
            <span className="font-medium">
              You approved this PO. The buyer can now send it to the supplier.
            </span>
          </div>
        )}
        {outcome === 'declined' && (
          <div className="px-6 py-4 bg-red-50 border-b border-red-200 inline-flex items-center gap-2 text-red-700 w-full">
            <XCircle className="w-5 h-5" />
            <span className="font-medium">
              You declined this PO. It has been sent back to the buyer as a draft.
            </span>
          </div>
        )}

        <div className="px-6 py-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-base border-b border-slate-200">
          <Field label="Total">
            <span className="font-semibold tabular-nums">
              {fmt(po.totalCents, po.currencyCode)}
            </span>
          </Field>
          <Field label="Lines">
            <span>{po.items.length}</span>
          </Field>
          <Field label="Expected delivery">
            <span>
              {po.expectedDeliveryDate ? po.expectedDeliveryDate.slice(0, 10) : '—'}
            </span>
          </Field>
          <Field label="Currency">
            <span className="font-mono">{po.currencyCode}</span>
          </Field>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-base">
            <thead className="bg-slate-50 text-sm text-slate-600 border-b border-slate-200">
              <tr>
                <th className="text-left font-medium px-4 py-2 w-10">#</th>
                <th className="text-left font-medium px-4 py-2">SKU</th>
                <th className="text-right font-medium px-4 py-2">Qty</th>
                <th className="text-right font-medium px-4 py-2">Unit cost</th>
                <th className="text-right font-medium px-4 py-2">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {po.items.map((it, i) => (
                <tr key={i} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2 text-sm text-slate-500">{i + 1}</td>
                  <td className="px-4 py-2 font-mono text-sm">
                    {it.sku}
                    {it.note && (
                      <div className="text-xs text-slate-600 italic mt-0.5">{it.note}</div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{it.quantityOrdered}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {fmt(it.unitCostCents, po.currencyCode)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium">
                    {fmt(it.unitCostCents * it.quantityOrdered, po.currencyCode)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {po.notes && (
          <div className="px-6 py-4 border-t border-slate-200">
            <div className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">
              Buyer notes
            </div>
            <div className="text-base text-slate-900 whitespace-pre-wrap">{po.notes}</div>
          </div>
        )}

        {!outcome && !po.expired && po.status === 'REVIEW' && (
          <div className="px-6 py-5 border-t border-slate-200 space-y-4 bg-slate-50">
            <div>
              <label className="text-sm font-medium text-slate-700 block mb-1">
                If declining — reason (optional)
              </label>
              <input
                type="text"
                value={declineReason}
                onChange={(e) => setDeclineReason(e.target.value)}
                placeholder="e.g. revise quantities, wait for next quarter, …"
                className="h-9 px-2 text-base border border-slate-200 rounded bg-white text-slate-900 w-full"
              />
            </div>

            {actionError && (
              <div className="text-sm text-red-700 inline-flex items-center gap-1">
                <AlertCircle className="w-3 h-3" /> {actionError}
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={approve}
                disabled={busy !== null}
                className="h-9 px-4 inline-flex items-center gap-1.5 text-base font-medium rounded bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {busy === 'approve' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-4 h-4" />
                )}
                Approve
              </button>
              <button
                type="button"
                onClick={decline}
                disabled={busy !== null}
                className="h-9 px-4 inline-flex items-center gap-1.5 text-base font-medium rounded bg-white text-red-700 border border-red-200 hover:bg-red-50 disabled:opacity-50"
              >
                {busy === 'decline' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <XCircle className="w-4 h-4" />
                )}
                Decline
              </button>
            </div>
          </div>
        )}

        <div className="px-6 py-3 text-xs text-slate-500 border-t border-slate-200">
          Your decision is logged on the buyer's side. If you weren't expecting this,
          forward the email to the sender for context.
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-sm text-slate-500 uppercase tracking-wide mb-1">{label}</div>
      <div className="text-base text-slate-900">{children}</div>
    </div>
  )
}
