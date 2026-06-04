'use client'

// Per-product Mapping tab — a dense matrix of how every field resolves
// across the channels/markets this product is listed on (rows = fields,
// columns = channel·market + a Master column), with provenance badges.
// Read-only in B.2; scope/cascade/adopt-master actions land in B.4–B.6.
//
// Backed by GET /api/products/:id/mapping/matrix (B.1). Rows are virtualized
// (@tanstack/react-virtual); the header row + the field column are sticky.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Loader2, SlidersHorizontal, Plus } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { useFieldLinks } from '../_shared/cockpit-shell'
import FieldSourceBadge from '../_shared/cockpit-shell/FieldSourceBadge'
import FieldScopePopover, { type ScopeMember } from '../_shared/cockpit-shell/FieldScopePopover'
import CatalogCascadeDrawer from '../_shared/cockpit-shell/CatalogCascadeDrawer'
import RuleEditorDrawer from '../_shared/cockpit-shell/RuleEditorDrawer'
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
  sourceAttr?: string
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

// Heuristic: which fields are free text worth auto-translating when linked.
function isTranslatableField(fieldKey: string): boolean {
  return /title|name|description|bullet|keyword|feature|search_term|caption/i.test(fieldKey)
}

const coordKey = (c: MatrixCoordinate) => `${c.channel}:${c.marketplace}`
const CHANNEL_SHORT: Record<string, string> = { AMAZON: 'AMZ', SHOPIFY: 'Shopify', WOOCOMMERCE: 'Woo' }
const coordLabel = (c: MatrixCoordinate) => `${CHANNEL_SHORT[c.channel] ?? c.channel}·${c.marketplace}`

const FIELD_COL = 200
const MASTER_COL = 150
const CELL_COL = 150
const ROW_H = 38

interface MappingTabProduct {
  id: string
  name?: string | null
  brand?: string | null
  manufacturer?: string | null
  description?: string | null
  bulletPoints?: unknown
  keywords?: unknown
  isParent?: boolean
  productType?: string | null
}

export default function MappingTab({ product }: { product: MappingTabProduct }) {
  const productId = product.id
  const [data, setData] = useState<MappingMatrix | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState<'all' | 'divergent' | 'gaps'>('all')
  const [scopeTarget, setScopeTarget] = useState<{ fieldKey: string; channel: string; marketplace: string } | null>(null)
  const fieldLinks = useFieldLinks(productId)
  // B.5 — "Cascade from master" reuses the FM.10 drawer. Snapshot the
  // master content on open so the drawer's preview input stays stable.
  const [cascadeOpen, setCascadeOpen] = useState(false)
  const [cascadeChanges, setCascadeChanges] = useState<Record<string, unknown>>({})
  const [ruleDrawer, setRuleDrawer] = useState<{
    open: boolean
    initial?: { channel: string; marketplace: string; fieldKey: string }
  }>({ open: false })
  const openCascade = useCallback(() => {
    const c: Record<string, unknown> = {}
    if (product.name) c.title = product.name
    if (product.brand) c.brand = product.brand
    if (product.manufacturer) c.manufacturer = product.manufacturer
    if (product.description) c.description = product.description
    if (Array.isArray(product.bulletPoints) && product.bulletPoints.length) c.bulletPoints = product.bulletPoints
    if (Array.isArray(product.keywords) && product.keywords.length) c.keywords = product.keywords
    setCascadeChanges(c)
    setCascadeOpen(true)
  }, [product])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/${productId}/mapping/matrix`, {
        credentials: 'include',
      })
      const json = await res.json()
      if (!res.ok) setError(json?.error ?? `HTTP ${res.status}`)
      else setData(json as MappingMatrix)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => {
    void load()
  }, [load])

  // B.6 — adopt master for one divergent cell: clears that coordinate's
  // override so the field follows master, then refetch.
  const adoptMaster = useCallback(
    async (attribute: string | undefined, channel: string, marketplace: string) => {
      if (!attribute) return
      try {
        await fetch(`${getBackendUrl()}/api/products/${productId}/mapping/adopt-master`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ channel, marketplace, attribute }),
        })
      } finally {
        await load()
      }
    },
    [productId, load],
  )

  const rows = data?.fields ?? []
  const coords = data?.coordinates ?? []
  const visibleRows = useMemo(() => {
    if (filter === 'divergent') return rows.filter((r) => Object.values(r.cells).some((c) => c.diverges))
    if (filter === 'gaps') return rows.filter((r) => Object.values(r.cells).some((c) => c.missingRequired))
    return rows
  }, [rows, filter])
  const gridCols = useMemo(
    () => `${FIELD_COL}px ${MASTER_COL}px ${coords.map(() => `${CELL_COL}px`).join(' ')}`,
    [coords],
  )
  const scopeMembers: ScopeMember[] = useMemo(
    () => coords.map((c) => ({ key: coordKey(c), channel: c.channel, marketplace: c.marketplace, label: coordLabel(c) })),
    [coords],
  )

  const rowVirtualizer = useVirtualizer({
    count: visibleRows.length,
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
      <div className="space-y-4">
        <div className="rounded-lg border border-dashed border-slate-300 px-4 py-12 text-center dark:border-slate-700">
          <div className="text-sm font-medium text-slate-700 dark:text-slate-300">No mapping rules yet</div>
          <div className="mx-auto mt-1 max-w-md text-xs text-slate-500">
            {coords.length} {coords.length === 1 ? 'market has' : 'markets have'} no field-mapping rules. Add the
            first one right here — no need to leave for Settings.
          </div>
          <button
            type="button"
            onClick={() => setRuleDrawer({ open: true })}
            className="mt-3 inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-3.5 w-3.5" /> Add a rule
          </button>
        </div>
        <RuleEditorDrawer
          productType={product.productType}
          coordinates={coords.map((c) => ({ channel: c.channel, marketplace: c.marketplace }))}
          initial={ruleDrawer.initial}
          open={ruleDrawer.open}
          onClose={() => setRuleDrawer({ open: false })}
          onSaved={() => void load()}
        />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500" aria-live="polite">
        <span className="font-medium text-slate-700 dark:text-slate-300">{data.sku}</span>
        <span>
          · {coords.length} coordinates · {visibleRows.length}
          {filter !== 'all' && `/${rows.length}`} fields
        </span>
        {data.counts.divergent > 0 && (
          <button
            type="button"
            onClick={() => setFilter((f) => (f === 'divergent' ? 'all' : 'divergent'))}
            className={cn(
              'rounded px-1.5 py-0.5 transition',
              filter === 'divergent'
                ? 'bg-amber-500 text-white'
                : 'bg-amber-100 text-amber-700 hover:brightness-95 dark:bg-amber-950/40 dark:text-amber-300',
            )}
          >
            ⚠ {data.counts.divergent} divergent
          </button>
        )}
        {data.counts.missingRequired > 0 && (
          <button
            type="button"
            onClick={() => setFilter((f) => (f === 'gaps' ? 'all' : 'gaps'))}
            className={cn(
              'rounded px-1.5 py-0.5 transition',
              filter === 'gaps'
                ? 'bg-rose-500 text-white'
                : 'bg-rose-100 text-rose-700 hover:brightness-95 dark:bg-rose-950/40 dark:text-rose-300',
            )}
          >
            {data.counts.missingRequired} required gaps
          </button>
        )}
        {filter !== 'all' && (
          <button type="button" onClick={() => setFilter('all')} className="underline hover:text-slate-700 dark:hover:text-slate-300">
            clear filter
          </button>
        )}
        <button
          type="button"
          onClick={() => setRuleDrawer({ open: true })}
          title="Add a mapping rule for an unmapped field"
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
        >
          <Plus className="h-3 w-3" /> Add rule
        </button>
        <button
          type="button"
          onClick={openCascade}
          title="Preview + apply this product's master content across every mapped channel & market"
          className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300"
        >
          Cascade from master →
        </button>
      </div>
      {product.isParent && (
        <div className="text-[11px] text-slate-400">
          Product-level mapping. For per-variant values, use the Matrix tab.
        </div>
      )}
      {filter !== 'all' && visibleRows.length === 0 && (
        <div className="py-8 text-center text-xs text-slate-500">No fields match this filter.</div>
      )}

      <div
        ref={scrollRef}
        role="grid"
        aria-label="Field mapping matrix"
        aria-rowcount={visibleRows.length + 1}
        aria-colcount={coords.length + 2}
        className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200 dark:border-slate-800"
      >
        {/* sticky header */}
        <div
          role="row"
          className="sticky top-0 z-20 grid border-b border-slate-200 bg-slate-50 text-[11px] font-medium text-slate-500 dark:border-slate-800 dark:bg-slate-900"
          style={{ gridTemplateColumns: gridCols, width: 'max-content', minWidth: '100%' }}
        >
          <div role="columnheader" className="sticky left-0 z-10 bg-slate-50 px-2 py-1.5 dark:bg-slate-900">Field</div>
          <div role="columnheader" className="px-2 py-1.5">Master</div>
          {coords.map((c) => (
            <div key={coordKey(c)} role="columnheader" className="truncate px-2 py-1.5" title={`${c.channel} · ${c.marketplace}`}>
              {coordLabel(c)}
              {!c.isPublished && <span className="opacity-50"> ·draft</span>}
            </div>
          ))}
        </div>

        {/* virtualized rows */}
        <div style={{ height: rowVirtualizer.getTotalSize(), width: 'max-content', minWidth: '100%', position: 'relative' }}>
          {rowVirtualizer.getVirtualItems().map((vi) => {
            const row = visibleRows[vi.index]
            return (
              <div
                key={row.fieldKey}
                role="row"
                aria-rowindex={vi.index + 2}
                className="group absolute left-0 grid border-b border-slate-100 text-xs hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30"
                style={{
                  gridTemplateColumns: gridCols,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`,
                  height: vi.size,
                }}
              >
                <div role="rowheader" className="sticky left-0 z-10 flex min-w-0 items-center gap-1 bg-white px-2 py-1.5 dark:bg-slate-950">
                  <span className="truncate font-mono text-slate-700 dark:text-slate-300" title={row.fieldKey}>
                    {row.label}
                  </span>
                  {row.required && (
                    <span className="text-rose-500" title="required">
                      *
                    </span>
                  )}
                </div>
                <div role="gridcell" className="truncate px-2 py-1.5 text-slate-500" title={fmt(row.master)}>
                  {fmt(row.master)}
                </div>
                {coords.map((c) => {
                  const cell = row.cells[coordKey(c)]
                  if (!cell) {
                    return (
                      <div key={coordKey(c)} role="gridcell" className="px-2 py-1.5 text-slate-300 dark:text-slate-700">
                        ·
                      </div>
                    )
                  }
                  return (
                    <div
                      key={coordKey(c)}
                      role="gridcell"
                      className={cn(
                        'flex min-w-0 items-center gap-1 px-2 py-1.5',
                        cell.diverges && 'bg-amber-50 dark:bg-amber-950/20',
                      )}
                    >
                      <span
                        className={cn(
                          'truncate text-slate-700 dark:text-slate-300',
                          cell.missingRequired && 'italic text-rose-400',
                        )}
                        title={fmt(cell.value)}
                      >
                        {fmt(cell.value)}
                      </span>
                      <FieldSourceBadge
                        source={toFieldSource(cell.provenance, cell.needsTranslation)}
                        onClick={() =>
                          setScopeTarget({ fieldKey: row.fieldKey, channel: c.channel, marketplace: c.marketplace })
                        }
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setRuleDrawer({
                            open: true,
                            initial: { channel: c.channel, marketplace: c.marketplace, fieldKey: row.fieldKey },
                          })
                        }
                        title="Edit mapping rule"
                        className="shrink-0 rounded px-0.5 text-slate-400 opacity-0 hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100 dark:hover:bg-slate-800"
                      >
                        <SlidersHorizontal className="h-3 w-3" />
                      </button>
                      {cell.diverges && (
                        <button
                          type="button"
                          onClick={() => adoptMaster(row.sourceAttr, c.channel, c.marketplace)}
                          title="Adopt master — drop this override so the field follows master"
                          className="ml-auto shrink-0 rounded px-1 text-[10px] text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/40"
                        >
                          adopt
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      <FieldScopePopover
        open={scopeTarget !== null}
        onClose={() => setScopeTarget(null)}
        fieldLabel={scopeTarget?.fieldKey ?? ''}
        marketLabel={scopeTarget ? `${scopeTarget.channel} ${scopeTarget.marketplace}` : ''}
        scope={scopeTarget ? fieldLinks.scopeFor(scopeTarget.fieldKey) : 'master'}
        selectedMembers={scopeTarget ? fieldLinks.memberKeysFor(scopeTarget.fieldKey) : []}
        members={scopeMembers}
        canTranslate={scopeTarget ? isTranslatableField(scopeTarget.fieldKey) : false}
        onApply={(r) => {
          if (scopeTarget) void fieldLinks.setScope(scopeTarget.fieldKey, r).then(() => load())
        }}
      />

      <CatalogCascadeDrawer
        productId={productId}
        open={cascadeOpen}
        changes={cascadeChanges}
        onClose={() => setCascadeOpen(false)}
        onApplied={() => {
          setCascadeOpen(false)
          void load()
        }}
      />

      <RuleEditorDrawer
        productType={product.productType}
        coordinates={coords.map((c) => ({ channel: c.channel, marketplace: c.marketplace }))}
        initial={ruleDrawer.initial}
        open={ruleDrawer.open}
        onClose={() => setRuleDrawer({ open: false })}
        onSaved={() => void load()}
      />
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
