'use client'

/**
 * W9.6g — 13-week cash-flow projection card (R.20 origin).
 *
 * Extracted from ReplenishmentWorkspace.tsx. Pulls open POs +
 * active recs + trailing-30d daily revenue × 7 per week. Health
 * flags a week red when running balance < 0 and amber when below
 * the cash floor.
 *
 * Operator can edit cash-on-hand inline — saved via PUT to
 * /cash-flow/cash-on-hand.
 *
 * Adds dark-mode classes throughout the chrome (loading state,
 * header chip, cash-on-hand button, edit input, week-bucket tints,
 * balance numbers, and the legend strip).
 */

import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

export interface CashFlowResponse {
  cashOnHandCents: number | null
  dailyRevenueCents: number
  openPoCount: number
  speculativeRecCount: number
  buckets: Array<{
    weekStart: string
    outflowCents: number
    inflowCents: number
    netCents: number
    startingBalanceCents: number
    endingBalanceCents: number
    health: 'OK' | 'AMBER' | 'RED'
    items: Array<{
      kind: 'PO_DUE' | 'REC_DUE' | 'WO_DUE' | 'SALES_FORECAST'
      label: string
      cents: number
      payableDate: string
    }>
  }>
}

export function CashFlowCard() {
  const [data, setData] = useState<CashFlowResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [editingCash, setEditingCash] = useState(false)
  const [cashInput, setCashInput] = useState('')
  const [savingCash, setSavingCash] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/cash-flow/projection`,
        { cache: 'no-store' },
      )
      if (res.ok) setData(await res.json())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function saveCashOnHand() {
    setSavingCash(true)
    try {
      const cents = Math.round(Number(cashInput) * 100)
      await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/cash-flow/cash-on-hand`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cashOnHandCents: Number.isFinite(cents) ? cents : null,
          }),
        },
      )
      setEditingCash(false)
      setCashInput('')
      await load()
    } finally {
      setSavingCash(false)
    }
  }

  if (loading) {
    return (
      <Card className="p-4 mb-3">
        <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
          Cash flow projection
        </div>
        <div className="text-base text-slate-400 dark:text-slate-500 mt-2">Loading…</div>
      </Card>
    )
  }
  if (!data) return null

  const buckets = data.buckets
  const maxFlow = Math.max(
    1,
    ...buckets.map((b) => Math.max(b.outflowCents, b.inflowCents)),
  )

  return (
    <Card className="p-4 mb-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
            Cash flow projection
          </span>
          <span className="text-xs text-slate-400 dark:text-slate-500">
            {buckets.length} weeks · {data.openPoCount} open POs ·{' '}
            {data.speculativeRecCount} recs
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {data.cashOnHandCents != null && !editingCash && (
            <button
              type="button"
              onClick={() => {
                setCashInput((data.cashOnHandCents! / 100).toFixed(2))
                setEditingCash(true)
              }}
              className="text-indigo-600 dark:text-indigo-400 hover:underline"
              title="Edit cash on hand"
            >
              €
              {(data.cashOnHandCents / 100).toLocaleString('en-IE', {
                maximumFractionDigits: 0,
              })}{' '}
              on hand
            </button>
          )}
          {data.cashOnHandCents == null && !editingCash && (
            <button
              type="button"
              onClick={() => setEditingCash(true)}
              className="text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              Set cash on hand
            </button>
          )}
          {editingCash && (
            <span className="inline-flex items-center gap-1">
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="EUR"
                value={cashInput}
                onChange={(e) => setCashInput(e.target.value)}
                className="w-24 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 px-1 py-0.5 text-right font-mono"
                disabled={savingCash}
              />
              <button
                type="button"
                onClick={() => void saveCashOnHand()}
                disabled={savingCash}
                className="rounded bg-indigo-600 dark:bg-indigo-500 px-2 py-0.5 text-white disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingCash(false)
                  setCashInput('')
                }}
                className="text-slate-400 dark:text-slate-500 hover:underline"
              >
                cancel
              </button>
            </span>
          )}
        </div>
      </div>

      <div
        className="grid gap-1"
        style={{
          gridTemplateColumns: `repeat(${buckets.length}, minmax(0, 1fr))`,
        }}
      >
        {buckets.map((b) => {
          const outFrac = b.outflowCents / maxFlow
          const inFrac = b.inflowCents / maxFlow
          const tint =
            b.health === 'RED'
              ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-300 dark:border-rose-900'
              : b.health === 'AMBER'
                ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-900'
                : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800'
          return (
            <div
              key={b.weekStart}
              className={cn(
                'relative rounded border p-1 flex flex-col items-center',
                tint,
              )}
              title={`${b.weekStart}\nout: €${(b.outflowCents / 100).toFixed(0)} · in: €${(b.inflowCents / 100).toFixed(0)}\nbalance: €${(b.endingBalanceCents / 100).toFixed(0)}`}
            >
              <div className="h-12 w-full flex items-end justify-center gap-0.5">
                <div
                  className="w-1.5 bg-rose-400 dark:bg-rose-500"
                  style={{ height: `${Math.max(2, outFrac * 100)}%` }}
                  aria-label="outflow"
                />
                <div
                  className="w-1.5 bg-emerald-400 dark:bg-emerald-500"
                  style={{ height: `${Math.max(2, inFrac * 100)}%` }}
                  aria-label="inflow"
                />
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono">
                {b.weekStart.slice(5)}
              </div>
              {data.cashOnHandCents != null && (
                <div
                  className={cn(
                    'text-xs font-mono',
                    b.endingBalanceCents < 0
                      ? 'text-rose-700 dark:text-rose-400'
                      : b.health === 'AMBER'
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-slate-600 dark:text-slate-400',
                  )}
                >
                  €{(b.endingBalanceCents / 100).toFixed(0)}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-2 text-xs text-slate-500 dark:text-slate-400 flex items-center gap-3">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2 h-2 bg-rose-400 dark:bg-rose-500 rounded-sm" />{' '}
          outflow
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2 h-2 bg-emerald-400 dark:bg-emerald-500 rounded-sm" />{' '}
          inflow
        </span>
        <span className="ml-auto">
          Sales: €{(data.dailyRevenueCents / 100).toFixed(0)}/day trailing
        </span>
      </div>
    </Card>
  )
}
