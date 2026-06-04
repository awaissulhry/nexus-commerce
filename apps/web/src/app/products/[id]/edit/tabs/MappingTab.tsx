'use client'

// Per-product Mapping tab — a dense matrix of how every field resolves
// across the channels/markets this product is listed on (rows = fields,
// columns = channel·market + a Master column), with provenance badges.
// Read-only in B.2; scope/cascade/adopt-master actions land in B.4–B.6.
//
// Backed by GET /api/products/:id/mapping/matrix (B.1). Rows are virtualized
// (@tanstack/react-virtual); the header row + the field column are sticky.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Loader2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import FieldSourceBadge from '../_shared/cockpit-shell/FieldSourceBadge'
import type { FieldSource } from '../_shared/cockpit-shell/contracts'

interface MatrixCell {
  value: unknown
  source: string
  provenance?: string
  needsTranslation?: boolean
  missingRequired: boolean
  appliedTransforms: string[]
  diverges: boolean
}
interface MatrixRow {
  fieldKey: string
  label: string
  required: boolean
  master: unknown
  cells: Record<string, MatrixCell>
}
interface MatrixCoordinate {
  channel: string
  marketplace: string
  hasListing: boolean
  isPublished: boolean
}
interface MappingMatrix {
  productId: string
  sku: string
  coordinates: MatrixCoordinate[]
  fields: MatrixRow[]
  counts: { coordinates: number; fields: number; divergent: number; missingRequired: number }
}

// Bridge the raw resolver provenance (ChannelFieldSource) to the UI badge's
// FieldSource vocabulary. (B.3 refines styling; the map itself lives here.)
function toFieldSource(provenance: string | undefined, needsTranslation?: boolean): FieldSource {
  if (needsTranslation) return 'translations'
  switch (provenance) {
    case 'override':
      return 'manual'
    case 'linked':
      return 'linked'
    case 'locked':
      return 'locked'
    case 'missing':
      return 'default'
    case 'default':
      return 'default'
    case 'catalogRule':
    case 'fallback':
    default:
      return 'master'
  }
}

function fmt(v: unknown): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

const coordKey = (c: MatrixCoordinate) => `${c.channel}:${c.marketplace}`
const CHANNEL_SHORT: Record<string, string> = { AMAZON: 'AMZ', SHOPIFY: 'Shopify', WOOCOMMERCE: 'Woo' }
const coordLabel = (c: MatrixCoordinate) => `${CHANNEL_SHORT[c.channel] ?? c.channel}·${c.marketplace}`

const FIELD_COL = 200
const MASTER_COL = 150
const CELL_COL = 150
const ROW_H = 38

export default function MappingTab({ productId }: { productId: string }) {
  const [data, setData] = useState<MappingMatrix | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const res = await fetch(`${getBackendUrl()}/api/products/${productId}/mapping/matrix`, {
          credentials: 'include',
        })
        const json = await res.json()
        if (!alive) return
        if (!res.ok) setError(json?.error ?? `HTTP ${res.status}`)
        else setData(json as MappingMatrix)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [productId])

  const rows = data?.fields ?? []
  const coords = data?.coordinates ?? []
  const gridCols = useMemo(
    () => `${FIELD_COL}px ${MASTER_COL}px ${coords.map(() => `${CELL_COL}px`).join(' ')}`,
    [coords],
  )

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 14,
  })

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading mapping…
      </div>
    )
  }
  if (error) {
    return (
      <div className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
        {error}
      </div>
    )
  }
  if (!data) return null
  if (coords.length === 0) {
    return (
      <EmptyState
        title="No channel listings"
        body="List this product on a channel to see how its fields map across markets."
      />
    )
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No mapping rules yet"
        body="These markets have no field-mapping rules. Set them up in Settings → Mappings."
      />
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span className="font-medium text-slate-700 dark:text-slate-300">{data.sku}</span>
        <span>· {coords.length} coordinates · {rows.length} fields</span>
        {data.counts.divergent > 0 && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            ⚠ {data.counts.divergent} divergent
          </span>
        )}
        {data.counts.missingRequired > 0 && (
          <span className="rounded bg-rose-100 px-1.5 py-0.5 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
            {data.counts.missingRequired} required gaps
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200 dark:border-slate-800"
      >
        {/* sticky header */}
        <div
          className="sticky top-0 z-20 grid border-b border-slate-200 bg-slate-50 text-[11px] font-medium text-slate-500 dark:border-slate-800 dark:bg-slate-900"
          style={{ gridTemplateColumns: gridCols, width: 'max-content', minWidth: '100%' }}
        >
          <div className="sticky left-0 z-10 bg-slate-50 px-2 py-1.5 dark:bg-slate-900">Field</div>
          <div className="px-2 py-1.5">Master</div>
          {coords.map((c) => (
            <div key={coordKey(c)} className="truncate px-2 py-1.5" title={`${c.channel} · ${c.marketplace}`}>
              {coordLabel(c)}
              {!c.isPublished && <span className="opacity-50"> ·draft</span>}
            </div>
          ))}
        </div>

        {/* virtualized rows */}
        <div style={{ height: rowVirtualizer.getTotalSize(), width: 'max-content', minWidth: '100%', position: 'relative' }}>
          {rowVirtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index]
            return (
              <div
                key={row.fieldKey}
                className="absolute left-0 grid border-b border-slate-100 text-xs hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30"
                style={{
                  gridTemplateColumns: gridCols,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`,
                  height: vi.size,
                }}
              >
                <div className="sticky left-0 z-10 flex min-w-0 items-center gap-1 bg-white px-2 py-1.5 dark:bg-slate-950">
                  <span className="truncate font-mono text-slate-700 dark:text-slate-300" title={row.fieldKey}>
                    {row.label}
                  </span>
                  {row.required && (
                    <span className="text-rose-500" title="required">
                      *
                    </span>
                  )}
                </div>
                <div className="truncate px-2 py-1.5 text-slate-500" title={fmt(row.master)}>
                  {fmt(row.master)}
                </div>
                {coords.map((c) => {
                  const cell = row.cells[coordKey(c)]
                  if (!cell) {
                    return (
                      <div key={coordKey(c)} className="px-2 py-1.5 text-slate-300 dark:text-slate-700">
                        ·
                      </div>
                    )
                  }
                  return (
                    <div key={coordKey(c)} className="flex min-w-0 items-center gap-1 px-2 py-1.5">
                      <span
                        className={cn(
                          'truncate text-slate-700 dark:text-slate-300',
                          cell.missingRequired && 'italic text-rose-400',
                        )}
                        title={fmt(cell.value)}
                      >
                        {fmt(cell.value)}
                      </span>
                      <FieldSourceBadge source={toFieldSource(cell.provenance, cell.needsTranslation)} />
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-4 py-16 text-center">
      <div className="text-sm font-medium text-slate-700 dark:text-slate-300">{title}</div>
      <div className="mx-auto mt-1 max-w-md text-xs text-slate-500">{body}</div>
    </div>
  )
}
