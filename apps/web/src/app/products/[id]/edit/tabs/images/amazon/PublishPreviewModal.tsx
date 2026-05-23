'use client'

// IA.2 — Pre-publish preview modal.
//
// Operator clicks "Preview publish" → this fetches the resolver's
// plan for the current marketplace and renders a per-ASIN × per-slot
// table. Each cell shows the thumbnail of the image that WOULD
// publish + a small chip showing the cascade level that won
// (variation override > group override > product fallback).
//
// Coverage chips per row + global header chip make it obvious
// where the gaps are before the operator commits.

import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/utils'
import { beFetch } from '../api'

const AMAZON_SLOTS = ['MAIN', 'PT01', 'PT02', 'PT03', 'PT04', 'PT05', 'PT06', 'PT07', 'PT08', 'SWCH'] as const
type AmazonSlot = typeof AMAZON_SLOTS[number]

interface PreviewSlotCell {
  url: string
  listingImageId: string
  origin: 'MARKETPLACE' | 'PLATFORM' | 'GLOBAL'
  scope: 'variation' | 'product'
}

interface PreviewVariantRow {
  variationId: string
  sku: string
  amazonAsin: string | null
  attributes: Record<string, string>
  slots: Partial<Record<AmazonSlot, PreviewSlotCell | null>>
  filledSlots: number
  totalSlots: number
  hasMain: boolean
  missingSlots: AmazonSlot[]
}

interface PreviewResponse {
  productId: string
  marketplace: string
  activeAxis: string | null
  totalVariants: number
  variantsWithAsin: number
  variantsWithMain: number
  rows: PreviewVariantRow[]
}

interface Props {
  open: boolean
  productId: string
  marketplace: string  // IT | DE | FR | ES | UK — never ALL (per-market preview)
  activeAxis: string
  onClose: () => void
  onConfirmPublish?: () => void
}

function sourceLabel(c: PreviewSlotCell): string {
  // Compact one-line indicator of where the resolver found this image.
  // 'variation' = exact variant row; 'product' = group/product-level
  // fallback. origin = scope width.
  const where = c.scope === 'variation' ? 'variant' : 'group/product'
  if (c.origin === 'MARKETPLACE') return `${where} · this market`
  if (c.origin === 'PLATFORM')    return `${where} · all markets`
  return `${where} · all channels`
}

export default function PublishPreviewModal({
  open,
  productId,
  marketplace,
  activeAxis,
  onClose,
  onConfirmPublish,
}: Props) {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<PreviewResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drillCell, setDrillCell] = useState<{ row: PreviewVariantRow; slot: AmazonSlot } | null>(null)

  useEffect(() => {
    if (!open) return
    setData(null)
    setError(null)
    setLoading(true)
    const qs = new URLSearchParams({ marketplace, activeAxis })
    beFetch(`/api/products/${productId}/amazon-images/preview?${qs.toString()}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error ?? `Preview failed: ${res.status}`)
        }
        return res.json() as Promise<PreviewResponse>
      })
      .then((r) => setData(r))
      .catch((err) => setError(err instanceof Error ? err.message : 'Preview failed'))
      .finally(() => setLoading(false))
  }, [open, productId, marketplace, activeAxis])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-6xl max-h-[85vh] flex flex-col overflow-hidden">
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Publish preview — Amazon {marketplace}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              What will publish on next Submit. Empty cells won't send anything for that slot.
            </p>
          </div>
          <IconButton size="sm" onClick={onClose} aria-label="Close">
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        {/* Headline coverage */}
        {data && (
          <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center gap-4 text-xs">
            <span className="text-slate-500 dark:text-slate-400">Variants:</span>
            <span className="font-mono text-slate-700 dark:text-slate-200">
              {data.variantsWithAsin}/{data.totalVariants} with ASIN
            </span>
            <span className="text-slate-300 dark:text-slate-700">·</span>
            <span className="font-mono text-slate-700 dark:text-slate-200">
              {data.variantsWithMain}/{data.totalVariants} with MAIN
            </span>
            {data.variantsWithMain < data.variantsWithAsin && (
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium">
                <AlertTriangle className="w-3 h-3" />
                {data.variantsWithAsin - data.variantsWithMain} ASINs missing MAIN
              </span>
            )}
            {data.activeAxis && (
              <span className="text-slate-400 ml-auto">axis: {data.activeAxis}</span>
            )}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-auto px-5 py-4">
          {loading && (
            <div className="flex items-center justify-center py-12 text-slate-400 gap-2 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Resolving plan…
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">
              <AlertTriangle className="w-4 h-4 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          {data && data.rows.length === 0 && (
            <div className="text-center py-12 text-sm text-slate-400">No variants to preview.</div>
          )}
          {data && data.rows.length > 0 && (
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr>
                  <th className="text-left px-2 py-1 sticky top-0 bg-white dark:bg-slate-900 z-10 border-b border-slate-200 dark:border-slate-700">SKU / ASIN</th>
                  <th className="text-left px-2 py-1 sticky top-0 bg-white dark:bg-slate-900 z-10 border-b border-slate-200 dark:border-slate-700">Attributes</th>
                  {AMAZON_SLOTS.map((s) => (
                    <th key={s} className="px-1 py-1 sticky top-0 bg-white dark:bg-slate-900 z-10 border-b border-slate-200 dark:border-slate-700 text-center font-mono text-[10px]">
                      {s}
                    </th>
                  ))}
                  <th className="px-2 py-1 sticky top-0 bg-white dark:bg-slate-900 z-10 border-b border-slate-200 dark:border-slate-700 text-center">Cover</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr
                    key={row.variationId}
                    className={cn(
                      'border-b border-slate-100 dark:border-slate-800',
                      !row.hasMain && row.amazonAsin && 'bg-red-50/30 dark:bg-red-950/10',
                      !row.amazonAsin && 'opacity-50',
                    )}
                  >
                    <td className="px-2 py-1.5 align-top">
                      <div className="font-mono text-slate-700 dark:text-slate-200">{row.sku}</div>
                      <div className="font-mono text-[10px] text-slate-400">{row.amazonAsin ?? 'no ASIN'}</div>
                    </td>
                    <td className="px-2 py-1.5 align-top text-slate-600 dark:text-slate-300">
                      {Object.entries(row.attributes).map(([k, v]) => (
                        <span key={k} className="inline-block mr-1.5">
                          <span className="text-slate-400">{k}:</span> <span className="text-slate-700 dark:text-slate-200">{v}</span>
                        </span>
                      ))}
                    </td>
                    {AMAZON_SLOTS.map((slot) => {
                      const cell = row.slots[slot]
                      const isMainEmpty = slot === 'MAIN' && !cell && !!row.amazonAsin
                      return (
                        <td key={slot} className="px-0.5 py-0.5 align-middle text-center">
                          <button
                            type="button"
                            onClick={() => setDrillCell({ row, slot })}
                            className={cn(
                              'w-9 h-9 rounded border flex items-center justify-center overflow-hidden bg-slate-50 dark:bg-slate-800 transition-colors',
                              cell
                                ? cell.scope === 'variation'
                                  ? 'border-blue-300 dark:border-blue-700'
                                  : 'border-slate-200 dark:border-slate-700 opacity-70'
                                : isMainEmpty
                                  ? 'border-red-300 dark:border-red-700 bg-red-50/50 dark:bg-red-950/20'
                                  : 'border-dashed border-slate-200 dark:border-slate-700',
                            )}
                            title={cell ? sourceLabel(cell) : isMainEmpty ? 'MAIN missing — Amazon will reject' : 'empty'}
                          >
                            {cell
                              ? <img src={cell.url} alt="" className="w-full h-full object-contain" loading="lazy" />
                              : <span className="text-[9px] text-slate-300 dark:text-slate-600">·</span>
                            }
                          </button>
                        </td>
                      )
                    })}
                    <td className="px-2 py-1.5 align-middle text-center">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full',
                          row.filledSlots === row.totalSlots
                            ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                            : row.hasMain
                              ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300'
                              : 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300',
                        )}
                      >
                        {row.filledSlots === row.totalSlots && <CheckCircle2 className="w-3 h-3" />}
                        {row.filledSlots}/{row.totalSlots}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Drill-down for a single cell */}
        {drillCell && (
          <div className="absolute inset-0 z-10 flex items-center justify-center p-4 bg-black/40" onClick={() => setDrillCell(null)}>
            <div
              className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {drillCell.row.sku} · {drillCell.slot}
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    {drillCell.row.amazonAsin ?? 'no ASIN'} · {marketplace}
                  </p>
                </div>
                <IconButton size="sm" onClick={() => setDrillCell(null)} aria-label="Close">
                  <X className="w-4 h-4" />
                </IconButton>
              </div>
              {drillCell.row.slots[drillCell.slot] ? (
                <div className="space-y-2">
                  <div className="aspect-square w-full rounded-lg bg-slate-100 dark:bg-slate-800 overflow-hidden border border-slate-200 dark:border-slate-700">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={drillCell.row.slots[drillCell.slot]!.url} alt="" className="w-full h-full object-contain" />
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-300">
                    Source: {sourceLabel(drillCell.row.slots[drillCell.slot]!)}
                  </p>
                  <p className="text-[11px] font-mono text-slate-400 truncate" title={drillCell.row.slots[drillCell.slot]!.listingImageId}>
                    listingImage: {drillCell.row.slots[drillCell.slot]!.listingImageId}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-slate-500 dark:text-slate-400 italic">
                  No image resolved for this cell. Nothing will publish for this slot.
                </p>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-slate-100 dark:border-slate-800">
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            The publisher uses the same cascade — this is exactly what will submit.
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} className="text-xs">Close</Button>
            {onConfirmPublish && (
              <Button
                size="sm"
                onClick={() => { onConfirmPublish(); onClose() }}
                disabled={!data || data.variantsWithMain === 0}
                className="text-xs"
              >
                Publish to {marketplace}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
