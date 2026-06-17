'use client'

// PO.10 — Three-way match panel.
//
// Renders on the detail-page Summary tab when the PO has any receive
// activity. Pulls /api/fulfillment/purchase-orders/:id/match which
// joins PO line items with rolled-up InboundShipmentItem actuals.
//
// Three columns per line:
//   PO (ordered)   ↔   Receipt (actual)   ↔   Invoice (placeholder)
//
// Status per line:
//   matched         green   — qty + cost within tolerance
//   partial         amber   — received < ordered by more than tolerance
//   over            red     — received > ordered (over-receipt)
//   price-variance  amber   — PPV exceeds the warning threshold (env)
//   pending         slate   — nothing received yet
//
// Invoice ingestion is deferred. The third column shows a "not
// tracked" badge so the matrix layout stays consistent for PO.11+
// when landed-cost / invoice surfaces.

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { cn } from '@/lib/utils'
import { formatCurrency } from './po-lens'

interface MatchLine {
  purchaseOrderItemId: string
  productId: string | null
  sku: string
  supplierSku: string | null
  note: string | null
  orderedQty: number
  receivedQty: number
  openQty: number
  orderedUnitCostCents: number
  receivedAvgUnitCostCents: number | null
  orderedSubtotalCents: number
  receivedSubtotalCents: number
  qtyDelta: number
  ppvBp: number
  ppvCents: number
  status: 'matched' | 'partial' | 'over' | 'price-variance' | 'pending'
  // PO.11 — landed cost (after prorated shipping/customs/duties/insurance).
  landedUnitCentsPoCcy: number | null
  landedUnitCentsEur: number | null
  landedSubtotalCentsEur: number
}

interface LandedRollup {
  goodsEurCents: number
  overheadShippingEurCents: number
  overheadCustomsEurCents: number
  overheadDutiesEurCents: number
  overheadInsuranceEurCents: number
  overheadTotalEurCents: number
  totalEurCents: number
  /** Overhead's share of total landed cost, in basis points. */
  overheadShareBp: number
}

interface MatchResponse {
  poNumber: string
  status: string
  currencyCode: string
  toleranceUnits: number
  ppvWarningBp: number
  totals: {
    orderedQty: number
    receivedQty: number
    shortfallUnits: number
    orderedCents: number
    receivedCents: number
    varianceCents: number
    withinTolerance: boolean
  }
  landed: LandedRollup
  flags: {
    ppvLines: number
    overReceiptLines: number
    underReceiptLines: number
  }
  invoice: { status: 'not-tracked' }
  linkedShipmentCount: number
  lines: MatchLine[]
}

export function ThreeWayMatchPanel({ poId }: { poId: string }) {
  const [data, setData] = useState<MatchResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/purchase-orders/${poId}/match`,
        { cache: 'no-store' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      setData(await res.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [poId])

  useEffect(() => {
    load()
  }, [load])

  // PO.10 — receive events (inbound.received) and PO updates both
  // shift the match analysis. Re-fetch on either family.
  useInvalidationChannel(
    ['inbound.received', 'inbound.updated', 'po.updated', 'po.received'],
    useCallback(
      (event) => {
        if (!event.id || event.id === poId) load()
      },
      [load, poId],
    ),
  )

  if (loading && !data) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg p-6 text-base text-slate-500 dark:text-slate-400 inline-flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading match…
      </div>
    )
  }
  if (error || !data) {
    return (
      <div className="text-md text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-center gap-2">
        <AlertCircle className="w-4 h-4" />
        {error ?? 'No match data'}
      </div>
    )
  }

  // Hide the panel entirely on POs with zero receives — the read-only
  // SummaryPane already shows the line table.
  if (data.totals.receivedQty === 0) {
    return null
  }

  const { totals, flags, currencyCode } = data

  return (
    <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg overflow-hidden">
      <div className="px-4 py-2 border-b border-default dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide flex items-center justify-between">
        <span>Three-way match</span>
        <span className="text-sm font-normal text-slate-500 dark:text-slate-400 normal-case tracking-normal">
          {data.linkedShipmentCount} {data.linkedShipmentCount === 1 ? 'shipment' : 'shipments'}
          {' · tolerance '}
          {data.toleranceUnits}u · PPV warn {(data.ppvWarningBp / 100).toFixed(1)}%
        </span>
      </div>

      {/* Roll-up tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 border-b border-default dark:border-slate-700">
        <Tile
          label="Ordered"
          primary={`${totals.orderedQty} u`}
          secondary={formatCurrency(totals.orderedCents, currencyCode)}
        />
        <Tile
          label="Received"
          primary={`${totals.receivedQty} u`}
          secondary={formatCurrency(totals.receivedCents, currencyCode)}
          tone={
            totals.shortfallUnits > 0
              ? 'amber'
              : totals.shortfallUnits < 0
                ? 'red'
                : 'green'
          }
        />
        <Tile
          label="Variance"
          primary={
            totals.varianceCents === 0
              ? '—'
              : `${totals.varianceCents > 0 ? '+' : '−'}${formatCurrency(Math.abs(totals.varianceCents), currencyCode)}`
          }
          secondary={
            totals.shortfallUnits === 0
              ? 'qty matched'
              : totals.shortfallUnits > 0
                ? `${totals.shortfallUnits} u short`
                : `${Math.abs(totals.shortfallUnits)} u over`
          }
          tone={
            totals.varianceCents > 0
              ? 'red'
              : totals.varianceCents < 0
                ? 'green'
                : 'slate'
          }
        />
        <Tile
          label="Flags"
          primary={
            flags.ppvLines + flags.overReceiptLines + flags.underReceiptLines === 0
              ? 'Clean'
              : `${flags.ppvLines + flags.overReceiptLines + flags.underReceiptLines} ${
                  flags.ppvLines + flags.overReceiptLines + flags.underReceiptLines === 1 ? 'line' : 'lines'
                }`
          }
          secondary={
            [
              flags.ppvLines > 0 && `${flags.ppvLines} PPV`,
              flags.overReceiptLines > 0 && `${flags.overReceiptLines} over`,
              flags.underReceiptLines > 0 && `${flags.underReceiptLines} short`,
            ]
              .filter(Boolean)
              .join(' · ') || 'all matched'
          }
          tone={
            flags.ppvLines + flags.overReceiptLines + flags.underReceiptLines === 0
              ? 'green'
              : 'amber'
          }
        />
      </div>

      {/* PO.11 — Landed-cost breakdown. Only renders when there's
          actual overhead captured on a linked shipment. PO-Plus.7
          adds a "Push to catalog" affordance that snapshots the
          per-line landed cost back to SupplierProduct so future
          replenishment recommendations use true-cost rather than
          factory cost. */}
      {data.landed.overheadTotalEurCents > 0 && (
        <LandedCostBreakdown
          landed={data.landed}
          lines={data.lines}
          poId={poId}
        />
      )}

      {/* Per-line table */}
      <div className="overflow-x-auto">
        <table className="w-full text-base">
          <thead className="bg-slate-50 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-400 border-b border-default dark:border-slate-700">
            <tr>
              <th className="text-left font-medium px-3 py-1.5">SKU</th>
              <th className="text-right font-medium px-3 py-1.5" colSpan={2}>
                PO (ordered)
              </th>
              <th className="text-right font-medium px-3 py-1.5" colSpan={3}>
                Receipt (actual)
              </th>
              <th className="text-right font-medium px-3 py-1.5">Landed</th>
              <th className="text-left font-medium px-3 py-1.5">Invoice</th>
              <th className="text-left font-medium px-3 py-1.5">Status</th>
            </tr>
            <tr className="text-xs text-slate-500 dark:text-slate-400">
              <th></th>
              <th className="text-right font-medium px-3 pb-1.5">Qty</th>
              <th className="text-right font-medium px-3 pb-1.5">Cost</th>
              <th className="text-right font-medium px-3 pb-1.5">Qty</th>
              <th className="text-right font-medium px-3 pb-1.5">Avg cost</th>
              <th className="text-right font-medium px-3 pb-1.5">PPV</th>
              <th className="text-right font-medium px-3 pb-1.5">Unit (EUR)</th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l) => (
              <MatchRow key={l.purchaseOrderItemId} line={l} currency={currencyCode} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function LandedCostBreakdown({
  landed,
  lines,
  poId,
}: {
  landed: LandedRollup
  lines: MatchLine[]
  poId: string
}) {
  const sharePct = landed.overheadShareBp / 100
  const pushableLines = lines.filter(
    (l) => l.productId != null && l.landedUnitCentsEur != null && l.landedUnitCentsEur > 0,
  )
  const [pushing, setPushing] = useState(false)
  const [pushed, setPushed] = useState<number | null>(null)
  const [pushError, setPushError] = useState<string | null>(null)

  const pushAll = async () => {
    setPushing(true)
    setPushError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/purchase-orders/${poId}/push-landed-cost`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lines: pushableLines.map((l) => ({
              productId: l.productId,
              landedCostCents: l.landedUnitCentsEur,
            })),
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      setPushed(data.updatedProductIds?.length ?? 0)
      window.setTimeout(() => setPushed(null), 4000)
    } catch (err) {
      setPushError(err instanceof Error ? err.message : String(err))
    } finally {
      setPushing(false)
    }
  }

  return (
    <div className="px-4 py-3 border-b border-default dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
      <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
          Landed cost (EUR)
        </span>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          Overhead is {sharePct.toFixed(1)}% of total landed
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-base">
        <CostCell label="Goods" cents={landed.goodsEurCents} />
        <CostCell label="Shipping" cents={landed.overheadShippingEurCents} />
        <CostCell label="Customs" cents={landed.overheadCustomsEurCents} />
        <CostCell label="Duties" cents={landed.overheadDutiesEurCents} />
        <CostCell label="Insurance" cents={landed.overheadInsuranceEurCents} />
        <CostCell label="Total" cents={landed.totalEurCents} bold />
      </div>

      {pushableLines.length > 0 && (
        <div className="mt-3 pt-3 border-t border-default dark:border-slate-700 flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm text-slate-600 dark:text-slate-400">
            {pushableLines.length} line{pushableLines.length === 1 ? '' : 's'} can
            push landed cost back to SupplierProduct as "true cost" for
            future replenishment math.
          </div>
          <div className="inline-flex items-center gap-2">
            {pushed != null && (
              <span className="text-sm text-green-700 dark:text-green-300 inline-flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />
                Pushed {pushed} catalog row{pushed === 1 ? '' : 's'}
              </span>
            )}
            {pushError && (
              <span className="text-sm text-red-700 dark:text-red-300 inline-flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                {pushError}
              </span>
            )}
            <button
              type="button"
              onClick={pushAll}
              disabled={pushing}
              className="h-7 px-3 inline-flex items-center gap-1.5 text-sm font-medium rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
              title="Update SupplierProduct.lastLandedCostCents for these lines"
            >
              {pushing ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3 h-3" />
              )}
              Push to catalog
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function CostCell({
  label,
  cents,
  bold,
}: {
  label: string
  cents: number
  bold?: boolean
}) {
  return (
    <div>
      <div className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">
        {label}
      </div>
      <div
        className={cn(
          'tabular-nums',
          bold ? 'font-semibold text-slate-900 dark:text-slate-100' : 'text-slate-700 dark:text-slate-300',
        )}
      >
        {cents === 0 ? '—' : formatCurrency(cents, 'EUR')}
      </div>
    </div>
  )
}

function MatchRow({ line, currency }: { line: MatchLine; currency: string }) {
  const ppvLabel =
    line.ppvBp === 0
      ? '—'
      : `${line.ppvBp > 0 ? '+' : ''}${(line.ppvBp / 100).toFixed(2)}%`

  const statusVariantMap: Record<MatchLine['status'], 'success' | 'warning' | 'danger' | 'info' | 'default'> = {
    matched: 'success',
    partial: 'warning',
    over: 'danger',
    'price-variance': 'warning',
    pending: 'default',
  }

  return (
    <tr className="border-b border-subtle dark:border-slate-800 last:border-0">
      <td className="px-3 py-2 font-mono text-sm">
        {line.sku}
        {line.supplierSku && line.supplierSku !== line.sku && (
          <div className="text-xs text-slate-500 dark:text-slate-400">supplier: {line.supplierSku}</div>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{line.orderedQty}</td>
      <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
        {formatCurrency(line.orderedUnitCostCents, currency)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        <span className={cn(
          line.qtyDelta > 0 && 'text-red-700 dark:text-red-300',
          line.qtyDelta < 0 && 'text-amber-700 dark:text-amber-300',
          line.qtyDelta === 0 && 'text-slate-900 dark:text-slate-100',
        )}>
          {line.receivedQty}
        </span>
        {line.qtyDelta !== 0 && (
          <span className="text-xs ml-1 text-slate-500 dark:text-slate-400 inline-flex items-center align-middle">
            {line.qtyDelta > 0 ? (
              <ArrowUpRight className="w-3 h-3" />
            ) : (
              <ArrowDownRight className="w-3 h-3" />
            )}
            {Math.abs(line.qtyDelta)}
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {line.receivedAvgUnitCostCents != null
          ? formatCurrency(line.receivedAvgUnitCostCents, currency)
          : '—'}
      </td>
      <td
        className={cn(
          'px-3 py-2 text-right tabular-nums',
          Math.abs(line.ppvBp) >= 200 && (line.ppvBp > 0 ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'),
        )}
        title={
          line.ppvCents !== 0
            ? `Cost variance: ${line.ppvCents > 0 ? '+' : '−'}${formatCurrency(Math.abs(line.ppvCents), currency)}`
            : undefined
        }
      >
        {ppvLabel}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {line.landedUnitCentsEur != null ? (
          <span
            className="text-slate-900 dark:text-slate-100"
            title={`Landed subtotal: ${formatCurrency(line.landedSubtotalCentsEur, 'EUR')} EUR`}
          >
            {formatCurrency(line.landedUnitCentsEur, 'EUR')}
          </span>
        ) : (
          <span className="text-tertiary dark:text-slate-500">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-sm text-tertiary dark:text-slate-500">
        <span className="inline-flex items-center gap-1">
          <Minus className="w-3 h-3" /> not tracked
        </span>
      </td>
      <td className="px-3 py-2">
        <Badge variant={statusVariantMap[line.status]} size="sm">
          {line.status === 'price-variance' ? 'PPV' : line.status}
        </Badge>
      </td>
    </tr>
  )
}

function Tile({
  label,
  primary,
  secondary,
  tone = 'slate',
}: {
  label: string
  primary: string
  secondary?: string
  tone?: 'green' | 'amber' | 'red' | 'slate'
}) {
  const toneCls: Record<typeof tone, string> = {
    green: 'text-green-700 dark:text-green-300',
    amber: 'text-amber-700 dark:text-amber-300',
    red: 'text-red-700 dark:text-red-300',
    slate: 'text-slate-900 dark:text-slate-100',
  } as any
  const Icon = tone === 'green' ? CheckCircle2 : tone === 'red' || tone === 'amber' ? AlertCircle : null
  return (
    <div className="px-4 py-3 border-r last:border-r-0 border-default dark:border-slate-700">
      <div className="text-sm text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">
        {label}
      </div>
      <div className={cn('text-lg font-semibold tabular-nums inline-flex items-center gap-1.5', toneCls[tone])}>
        {Icon && <Icon className="w-4 h-4" />}
        {primary}
      </div>
      {secondary && (
        <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{secondary}</div>
      )}
    </div>
  )
}
