'use client'

// EC.6 — VariationsMatrixCard
//
// Visual Color × Size grid (or any 1-or-2 chosen axes) for the
// eBay variation parent listing. Reads the Matrix tab's canonical
// child variant data via the new /api/ebay/cockpit/variation-cells
// endpoint and lets operators set per-cell price + quantity
// overrides without leaving the cockpit.
//
// What ships in EC.6 substrate:
//   • Axis picker (1 or 2 of product.variationAxes)
//   • Per-axis sort-order editor (drag-free for substrate; arrow
//     buttons reorder values)
//   • Grid render with one cell per child variant
//   • Per-cell inline edit for priceOverride + quantity
//   • Save All button (batch PATCH)
//   • 250-variant cap counter (eBay's hard limit)
//   • "Inherit from Matrix tab" — clears overrides so the master
//     value shows through
//
// Deferred to EC.6b / later:
//   • Drag-fill (Excel-style range fill)
//   • Per-cell image (image-per-color already lives in IM.5 EbayPanel;
//     EC.7 surfaces it inline here)
//   • Per-cell condition / aspect override
//   • Push-back toggle (also update master?)

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Save, AlertTriangle, Eraser, ChevronUp, ChevronDown, Sparkles } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { useRouter } from 'next/navigation'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'

const EBAY_VARIANT_CAP = 250

interface Cell {
  childProductId: string
  sku: string
  variationAttributes: Record<string, string>
  listing: {
    id: string
    priceOverride: number | null
    price: number | null
    quantity: number | null
    listingStatus: string
    externalListingId: string | null
  } | null
}

interface MatrixData {
  parentProductId: string
  marketplace: string
  declaredAxes: string[]
  pickedAxes: string[]
  axisSortOrder: Record<string, string[]>
  cells: Cell[]
  childCount: number
}

interface DirtyCell {
  priceOverride?: number | null
  quantity?: number | null
}

interface Props {
  productId: string
  marketplace: string
  currency: string
  /** True when the parent product is multi-variant. Empty otherwise. */
  isParentWithChildren: boolean
}

export default function VariationsMatrixCard({
  productId,
  marketplace,
  currency,
  isParentWithChildren,
}: Props) {
  const router = useRouter()
  const [data, setData] = useState<MatrixData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dirtyCells, setDirtyCells] = useState<Record<string, DirtyCell>>({})
  const [pickedAxesDraft, setPickedAxesDraft] = useState<string[]>([])
  const [pickedDirty, setPickedDirty] = useState(false)
  const [sortDraft, setSortDraft] = useState<Record<string, string[]>>({})
  const [sortDirty, setSortDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  // Fetch matrix data.
  const refresh = useCallback(async () => {
    if (!isParentWithChildren) return
    setLoading(true)
    setError(null)
    try {
      const u = new URL(`${getBackendUrl()}/api/ebay/cockpit/variation-cells`)
      u.searchParams.set('parentProductId', productId)
      u.searchParams.set('marketplace', marketplace)
      const res = await fetch(u.toString())
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error ?? `HTTP ${res.status}`)
      } else {
        setData(json as MatrixData)
        setPickedAxesDraft((json as MatrixData).pickedAxes)
        setSortDraft((json as MatrixData).axisSortOrder)
        setPickedDirty(false)
        setSortDirty(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [productId, marketplace, isParentWithChildren])

  useEffect(() => { refresh() }, [refresh])

  // Available axes = declaredAxes ∩ (axes actually present in children).
  const availableAxes = useMemo(() => {
    if (!data) return []
    const observed = new Set<string>()
    for (const c of data.cells) {
      for (const k of Object.keys(c.variationAttributes ?? {})) observed.add(k)
    }
    // Honour declared order if present, else fall back to observation order.
    const declared = data.declaredAxes.filter((a) => observed.has(a))
    const extras = [...observed].filter((a) => !declared.includes(a))
    return [...declared, ...extras]
  }, [data])

  // Per-axis distinct values, ordered by sortDraft (custom) or insertion.
  const axisValues = useMemo(() => {
    const out: Record<string, string[]> = {}
    if (!data) return out
    for (const axis of availableAxes) {
      const seen = new Set<string>()
      const ins: string[] = []
      for (const c of data.cells) {
        const v = c.variationAttributes?.[axis]
        if (v && !seen.has(v)) {
          seen.add(v)
          ins.push(v)
        }
      }
      const order = sortDraft[axis] ?? []
      const ordered = order.filter((v) => seen.has(v))
      const rest = ins.filter((v) => !ordered.includes(v))
      out[axis] = [...ordered, ...rest]
    }
    return out
  }, [data, availableAxes, sortDraft])

  const rowAxis = pickedAxesDraft[0] ?? availableAxes[0]
  const colAxis = pickedAxesDraft[1] ?? (availableAxes[1] ?? null)
  const rowValues = rowAxis ? axisValues[rowAxis] ?? [] : []
  const colValues = colAxis ? axisValues[colAxis] ?? [] : []

  // Cell lookup by (rowVal, colVal).
  const cellAt = useCallback(
    (rv: string, cv: string | null): Cell | null => {
      if (!data) return null
      for (const c of data.cells) {
        const matchesRow = c.variationAttributes?.[rowAxis ?? ''] === rv
        const matchesCol = colAxis ? c.variationAttributes?.[colAxis] === cv : true
        if (matchesRow && matchesCol) return c
      }
      return null
    },
    [data, rowAxis, colAxis],
  )

  const dirtyCount = Object.keys(dirtyCells).length
  const cellCount = data?.cells.length ?? 0
  const overCap = cellCount > EBAY_VARIANT_CAP

  const handleCellEdit = useCallback(
    (childId: string, patch: DirtyCell) => {
      setDirtyCells((d) => ({ ...d, [childId]: { ...d[childId], ...patch } }))
    },
    [],
  )

  const handlePickAxis = useCallback((slot: 0 | 1, next: string | null) => {
    setPickedAxesDraft((cur) => {
      const out = [...cur]
      if (next === null) {
        out.splice(slot, 1)
      } else {
        out[slot] = next
        // Prevent the same axis in both slots.
        if (slot === 0 && out[1] === next) out.splice(1, 1)
        if (slot === 1 && out[0] === next) out[0] = next === out[0] ? availableAxes.find((a) => a !== next) ?? '' : out[0]
      }
      return out.filter(Boolean).slice(0, 2)
    })
    setPickedDirty(true)
  }, [availableAxes])

  const handleMoveAxisValue = useCallback(
    (axis: string, value: string, dir: -1 | 1) => {
      setSortDraft((cur) => {
        const order = cur[axis] ?? axisValues[axis] ?? []
        const idx = order.indexOf(value)
        if (idx === -1) {
          // Value wasn't in custom order yet — seed with observed order.
          const seeded = [...(axisValues[axis] ?? [])]
          const sIdx = seeded.indexOf(value)
          if (sIdx === -1) return cur
          const target = sIdx + dir
          if (target < 0 || target >= seeded.length) return cur
          ;[seeded[sIdx], seeded[target]] = [seeded[target]!, seeded[sIdx]!]
          return { ...cur, [axis]: seeded }
        }
        const target = idx + dir
        if (target < 0 || target >= order.length) return cur
        const next = [...order]
        ;[next[idx], next[target]] = [next[target]!, next[idx]!]
        return { ...cur, [axis]: next }
      })
      setSortDirty(true)
    },
    [axisValues],
  )

  const handleSaveAll = useCallback(async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const body: Record<string, unknown> = {
        parentProductId: productId,
        marketplace,
      }
      if (pickedDirty) body.pickedAxes = pickedAxesDraft
      if (sortDirty) body.axisSortOrder = sortDraft
      if (dirtyCount > 0) {
        body.cells = Object.entries(dirtyCells).map(([childProductId, patch]) => ({
          childProductId,
          priceOverride: patch.priceOverride,
          quantity: patch.quantity,
        }))
      }
      const res = await fetch(`${getBackendUrl()}/api/ebay/cockpit/variation-matrix`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j?.error ?? `HTTP ${res.status}`)
      }
      setDirtyCells({})
      setPickedDirty(false)
      setSortDirty(false)
      await refresh()
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [saving, productId, marketplace, pickedDirty, pickedAxesDraft, sortDirty, sortDraft, dirtyCount, dirtyCells, refresh, router])

  if (!isParentWithChildren) {
    return (
      <Card noPadding>
        <div className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2">
          <div className="text-md font-medium text-slate-900 dark:text-slate-100">
            Variations
          </div>
          <Badge variant="info">EC.6</Badge>
        </div>
        <div className="p-4 text-xs text-slate-500 dark:text-slate-400 italic">
          This product has no variants — single-listing flow.
          eBay variation matrix kicks in only when the product has children
          declared with variation axes (e.g. Color × Size).
        </div>
      </Card>
    )
  }

  return (
    <Card noPadding>
      <div className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2 flex-wrap">
        <div className="text-md font-medium text-slate-900 dark:text-slate-100">
          Variations Matrix
        </div>
        <Badge variant="info">EC.6</Badge>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {cellCount} {cellCount === 1 ? 'variant' : 'variants'} · cap {EBAY_VARIANT_CAP}
        </span>
        {overCap && (
          <span className="inline-flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300">
            <AlertTriangle className="w-3 h-3" /> Exceeds eBay&apos;s cap — split into multiple listings
          </span>
        )}
      </div>

      <div className="p-4 space-y-4">
        {loading && (
          <div className="text-xs text-slate-500 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading variants…
          </div>
        )}
        {error && (
          <div className="text-xs px-3 py-2 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300">
            {error}
          </div>
        )}

        {data && !loading && (
          <>
            {/* ── Axis picker ─────────────────────────────────────── */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-2">
              <div className="text-xs font-medium text-slate-700 dark:text-slate-300">Axes</div>
              <div className="flex items-center gap-3 flex-wrap text-xs">
                <AxisSelector
                  label="Rows"
                  value={pickedAxesDraft[0] ?? null}
                  available={availableAxes}
                  onChange={(v) => handlePickAxis(0, v)}
                />
                <AxisSelector
                  label="Columns"
                  value={pickedAxesDraft[1] ?? null}
                  available={availableAxes.filter((a) => a !== pickedAxesDraft[0])}
                  onChange={(v) => handlePickAxis(1, v)}
                />
                <span className="text-[10.5px] text-slate-500 dark:text-slate-400">
                  Pick 1 axis for a single column or 2 for a grid. eBay
                  supports multi-axis listings but 2 is the practical UX limit.
                </span>
              </div>
            </div>

            {/* ── Axis sort editors ──────────────────────────────── */}
            {pickedAxesDraft.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {pickedAxesDraft.map((axis) => (
                  <AxisSortEditor
                    key={axis}
                    axis={axis}
                    values={axisValues[axis] ?? []}
                    onMove={(v, dir) => handleMoveAxisValue(axis, v, dir)}
                  />
                ))}
              </div>
            )}

            {/* ── Grid ────────────────────────────────────────────── */}
            {rowAxis && rowValues.length > 0 && (
              <MatrixGrid
                rowAxis={rowAxis}
                colAxis={colAxis}
                rowValues={rowValues}
                colValues={colValues}
                cellAt={cellAt}
                dirtyCells={dirtyCells}
                onCellEdit={handleCellEdit}
                currency={currency}
              />
            )}
          </>
        )}
      </div>

      {data && !loading && (
        <div className="px-4 py-2.5 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {dirtyCount === 0 && !pickedDirty && !sortDirty ? 'All saved' : 'Unsaved changes'}
          </span>
          <button
            type="button"
            onClick={() => setDirtyCells({})}
            disabled={dirtyCount === 0}
            className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 inline-flex items-center gap-1 disabled:opacity-40"
            title="Discard unsaved per-cell edits (axis picks stay)"
          >
            <Eraser className="w-3 h-3" /> Discard cell edits
          </button>
          <button
            type="button"
            onClick={handleSaveAll}
            disabled={saving || (dirtyCount === 0 && !pickedDirty && !sortDirty)}
            className="ml-auto px-3 py-1 text-xs font-medium rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            {saving ? 'Saving…' : 'Save matrix'}
          </button>
        </div>
      )}
    </Card>
  )
}

// ── Axis selector ──────────────────────────────────────────────────────
function AxisSelector({
  label, value, available, onChange,
}: { label: string; value: string | null; available: string[]; onChange: (next: string | null) => void }) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs">
      <span className="text-slate-500 dark:text-slate-400">{label}:</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="text-sm border border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
      >
        <option value="">— none —</option>
        {available.map((a) => (
          <option key={a} value={a}>{a}</option>
        ))}
      </select>
    </label>
  )
}

// ── Axis sort editor ──────────────────────────────────────────────────
function AxisSortEditor({
  axis, values, onMove,
}: { axis: string; values: string[]; onMove: (value: string, dir: -1 | 1) => void }) {
  return (
    <div className="rounded border border-slate-200 dark:border-slate-800 p-2 space-y-1">
      <div className="text-[11px] font-medium text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
        <Sparkles className="w-3 h-3 text-violet-500" /> {axis} order ({values.length})
      </div>
      <div className="space-y-1">
        {values.map((v, i) => (
          <div key={v} className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-slate-50 dark:bg-slate-800/60">
            <button
              type="button"
              onClick={() => onMove(v, -1)}
              disabled={i === 0}
              className="p-0.5 text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 disabled:opacity-30"
              aria-label={`Move ${v} up`}
            >
              <ChevronUp className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => onMove(v, +1)}
              disabled={i === values.length - 1}
              className="p-0.5 text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 disabled:opacity-30"
              aria-label={`Move ${v} down`}
            >
              <ChevronDown className="w-3 h-3" />
            </button>
            <span className="font-mono text-slate-700 dark:text-slate-300">{v}</span>
            <span className="text-[10px] text-slate-400 ml-auto">{i + 1}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Matrix grid ────────────────────────────────────────────────────────
function MatrixGrid({
  rowAxis, colAxis, rowValues, colValues, cellAt, dirtyCells, onCellEdit, currency,
}: {
  rowAxis: string
  colAxis: string | null
  rowValues: string[]
  colValues: string[]
  cellAt: (rv: string, cv: string | null) => Cell | null
  dirtyCells: Record<string, DirtyCell>
  onCellEdit: (childId: string, patch: DirtyCell) => void
  currency: string
}) {
  const cols = colAxis ? colValues : [null]
  return (
    <div className="overflow-x-auto -mx-4 px-4">
      <table className="text-xs border-collapse">
        <thead>
          <tr>
            <th className="text-[10.5px] uppercase tracking-wide text-slate-400 font-medium px-2 py-1 text-left">
              {rowAxis} \\ {colAxis ?? '(none)'}
            </th>
            {cols.map((cv, i) => (
              <th key={i} className="text-[11px] font-semibold text-slate-700 dark:text-slate-300 px-2 py-1 text-left whitespace-nowrap">
                {cv ?? '—'}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowValues.map((rv) => (
            <tr key={rv}>
              <td className="text-[11px] font-semibold text-slate-700 dark:text-slate-300 pr-2 py-1 whitespace-nowrap align-top">
                {rv}
              </td>
              {cols.map((cv, i) => {
                const c = cellAt(rv, cv)
                if (!c) {
                  return (
                    <td key={i} className="align-top p-1">
                      <div className="w-32 h-16 rounded border border-dashed border-slate-200 dark:border-slate-800 flex items-center justify-center text-[10.5px] text-slate-300">
                        no variant
                      </div>
                    </td>
                  )
                }
                return (
                  <td key={i} className="align-top p-1">
                    <CellEditor
                      cell={c}
                      dirty={dirtyCells[c.childProductId]}
                      currency={currency}
                      onChange={(patch) => onCellEdit(c.childProductId, patch)}
                    />
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Cell editor ────────────────────────────────────────────────────────
function CellEditor({
  cell, dirty, currency, onChange,
}: {
  cell: Cell
  dirty: DirtyCell | undefined
  currency: string
  onChange: (patch: DirtyCell) => void
}) {
  const priceVal = dirty?.priceOverride !== undefined
    ? dirty.priceOverride
    : cell.listing?.priceOverride ?? null
  const qtyVal = dirty?.quantity !== undefined
    ? dirty.quantity
    : cell.listing?.quantity ?? null
  const status = cell.listing?.listingStatus ?? 'DRAFT'
  const statusTone =
    status === 'ACTIVE' ? 'bg-emerald-500'
    : status === 'ERROR' ? 'bg-rose-500'
    : status === 'ENDED' || status === 'INACTIVE' ? 'bg-slate-400'
    : 'bg-amber-500'
  const isDirty = dirty !== undefined

  return (
    <div className={cn(
      'w-32 rounded border p-1.5 text-[10.5px] space-y-1',
      isDirty
        ? 'border-amber-300 dark:border-amber-700 bg-amber-50/40 dark:bg-amber-950/20'
        : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900',
    )}>
      <div className="flex items-center gap-1 min-w-0">
        <span className={cn('inline-block w-1.5 h-1.5 rounded-full shrink-0', statusTone)} title={status} />
        <span className="font-mono text-[10px] text-slate-500 truncate">{cell.sku}</span>
      </div>
      <input
        type="number"
        step="0.01"
        min="0"
        value={priceVal ?? ''}
        onChange={(e) => onChange({ priceOverride: e.target.value === '' ? null : parseFloat(e.target.value) })}
        placeholder={`${currency} —`}
        className="w-full text-[11px] border border-slate-200 dark:border-slate-700 rounded px-1 py-0.5 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
        title="Price override"
      />
      <input
        type="number"
        step="1"
        min="0"
        value={qtyVal ?? ''}
        onChange={(e) => onChange({ quantity: e.target.value === '' ? null : parseInt(e.target.value, 10) })}
        placeholder="qty"
        className="w-full text-[11px] border border-slate-200 dark:border-slate-700 rounded px-1 py-0.5 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
        title="Quantity"
      />
    </div>
  )
}
