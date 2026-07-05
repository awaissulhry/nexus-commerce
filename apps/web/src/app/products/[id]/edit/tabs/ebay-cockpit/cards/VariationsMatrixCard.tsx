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
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'
import { Loader2, Save, AlertTriangle, Eraser, ChevronUp, ChevronDown, Sparkles, Download } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { useRouter } from 'next/navigation'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/lib/i18n/use-translations'
import { Listbox } from '@/design-system/components/Listbox'

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
  // EV.4 — eBay-only renames. Names: { Color: "Colour" }. Values:
  // { Color: { Giallo: "Yellow" } }.
  axisNameLabels?: Record<string, string>
  axisValueLabels?: Record<string, Record<string, string>>
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
  const { t } = useTranslations()
  const router = useRouter()
  const [data, setData] = useState<MatrixData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dirtyCells, setDirtyCells] = useState<Record<string, DirtyCell>>({})
  const [pickedAxesDraft, setPickedAxesDraft] = useState<string[]>([])
  const [pickedDirty, setPickedDirty] = useState(false)
  const [sortDraft, setSortDraft] = useState<Record<string, string[]>>({})
  const [sortDirty, setSortDirty] = useState(false)
  // EV.4 — eBay-only rename drafts.
  const [nameLabels, setNameLabels] = useState<Record<string, string>>({})
  const [valueLabels, setValueLabels] = useState<Record<string, Record<string, string>>>({})
  const [labelsDirty, setLabelsDirty] = useState(false)
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
        setNameLabels((json as MatrixData).axisNameLabels ?? {})
        setValueLabels((json as MatrixData).axisValueLabels ?? {})
        setPickedDirty(false)
        setSortDirty(false)
        setLabelsDirty(false)
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

  // EV.3 — effective variation specifics (picked, else auto-default to
  // the available axes), capped at eBay's 5. A 2D grid can only show two
  // dimensions, so 3–5 specifics fall back to a flat one-row-per-variant
  // table.
  const effectiveAxes = (pickedAxesDraft.length > 0 ? pickedAxesDraft : availableAxes).slice(0, 5)
  const useFlatTable = effectiveAxes.length > 2
  const rowAxis = effectiveAxes[0] ?? null
  const colAxis = effectiveAxes[1] ?? null
  const rowValues = rowAxis ? axisValues[rowAxis] ?? [] : []
  const colValues = colAxis ? axisValues[colAxis] ?? [] : []

  // EV.4 — eBay-only display labels (raw keys stay for lookup/publish data).
  const axisLabel = useCallback((axis: string) => nameLabels[axis] || axis, [nameLabels])
  const valueLabel = useCallback(
    (axis: string, v: string) => valueLabels[axis]?.[v] || v,
    [valueLabels],
  )
  const handleRenameAxis = useCallback((axis: string, label: string) => {
    setNameLabels((cur) => {
      const next = { ...cur }
      if (label.trim() && label.trim() !== axis) next[axis] = label.trim()
      else delete next[axis]
      return next
    })
    setLabelsDirty(true)
  }, [])
  const handleRenameValue = useCallback((axis: string, value: string, label: string) => {
    setValueLabels((cur) => {
      const next = { ...cur, [axis]: { ...(cur[axis] ?? {}) } }
      if (label.trim() && label.trim() !== value) next[axis][value] = label.trim()
      else delete next[axis][value]
      if (Object.keys(next[axis]).length === 0) delete next[axis]
      return next
    })
    setLabelsDirty(true)
  }, [])

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

  // EV.7 — advisory validation against eBay's variation rules. Counts
  // (not blocking — eBay rejects at publish): variations missing a price,
  // a quantity, or any chosen-axis value.
  const validation = useMemo(() => {
    let missingPrice = 0
    let missingQty = 0
    let missingValue = 0
    for (const c of data?.cells ?? []) {
      const d = dirtyCells[c.childProductId]
      const price = d?.priceOverride !== undefined ? d.priceOverride : (c.listing?.priceOverride ?? c.listing?.price ?? null)
      const qty = d?.quantity !== undefined ? d.quantity : (c.listing?.quantity ?? null)
      if (price == null || price <= 0) missingPrice++
      if (qty == null) missingQty++
      if (effectiveAxes.some((a) => !c.variationAttributes?.[a])) missingValue++
    }
    return { missingPrice, missingQty, missingValue }
  }, [data, dirtyCells, effectiveAxes])
  const hasWarnings =
    overCap || validation.missingPrice > 0 || validation.missingQty > 0 || validation.missingValue > 0

  const handleCellEdit = useCallback(
    (childId: string, patch: DirtyCell) => {
      setDirtyCells((d) => ({ ...d, [childId]: { ...d[childId], ...patch } }))
    },
    [],
  )

  // EV.3 — generalised to any slot (eBay allows up to 5 variation
  // specifics). Picking an axis already in another slot moves it here
  // (no duplicates); picking null clears the slot.
  const handlePickAxis = useCallback((slot: number, next: string | null) => {
    setPickedAxesDraft((cur) => {
      let out = [...cur]
      if (next === null) {
        out.splice(slot, 1)
      } else {
        out = out.filter((a, i) => a !== next || i === slot)
        out[slot] = next
      }
      return out.filter(Boolean).slice(0, 5)
    })
    setPickedDirty(true)
  }, [])

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
      if (labelsDirty) {
        body.axisNameLabels = nameLabels
        body.axisValueLabels = valueLabels
      }
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
      setLabelsDirty(false)
      await refresh()
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [saving, productId, marketplace, pickedDirty, pickedAxesDraft, sortDirty, sortDraft, labelsDirty, nameLabels, valueLabels, dirtyCount, dirtyCells, refresh, router])

  if (!isParentWithChildren) {
    return (
      <Card noPadding>
        <div className="px-4 py-2.5 border-b border-subtle dark:border-slate-800 flex items-center gap-2">
          <div className="text-md font-medium text-slate-900 dark:text-slate-100">
            {t('products.edit.cockpit.ebay.variations.title')}
          </div>
          <Badge variant="info">EC.6</Badge>
        </div>
        <div className="p-4 text-xs text-slate-500 dark:text-slate-400 italic">
          {t('products.edit.cockpit.ebay.variations.noVariants')}
        </div>
      </Card>
    )
  }

  return (
    <Card noPadding>
      <div className="px-4 py-2.5 border-b border-subtle dark:border-slate-800 flex items-center gap-2 flex-wrap">
        <div className="text-md font-medium text-slate-900 dark:text-slate-100">
          {t('products.edit.cockpit.ebay.variations.matrixTitle')}
        </div>
        <Badge variant="info">EC.6</Badge>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {cellCount} {cellCount === 1 ? t('products.edit.cockpit.ebay.variations.variantSingular') : t('products.edit.cockpit.ebay.variations.variantPlural')} · {t('products.edit.cockpit.ebay.variations.cap')} {EBAY_VARIANT_CAP}
        </span>
        {overCap && (
          <span className="inline-flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300">
            <AlertTriangle className="w-3 h-3" /> {t('products.edit.cockpit.ebay.variations.exceedsCap')}
          </span>
        )}
      </div>

      <div className="p-4 space-y-4">
        {loading && (
          <div className="text-xs text-slate-500 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('products.edit.cockpit.ebay.variations.loadingVariants')}
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
            <div className="rounded-lg border border-default dark:border-slate-800 p-3 space-y-2">
              <div className="text-xs font-medium text-slate-700 dark:text-slate-300">{t('products.edit.cockpit.ebay.variations.axes')}</div>
              <div className="flex items-center gap-3 flex-wrap text-xs">
                {Array.from({ length: Math.min(5, availableAxes.length) }).map((_, i) => (
                  <AxisSelector
                    key={i}
                    label={
                      useFlatTable
                        ? t('products.edit.cockpit.ebay.variations.specificN', { n: String(i + 1) })
                        : i === 0
                          ? t('products.edit.cockpit.ebay.variations.rows')
                          : i === 1
                            ? t('products.edit.cockpit.ebay.variations.columns')
                            : t('products.edit.cockpit.ebay.variations.specificN', { n: String(i + 1) })
                    }
                    value={pickedAxesDraft[i] ?? null}
                    available={availableAxes.filter(
                      (a) => !pickedAxesDraft.some((p, j) => p === a && j !== i),
                    )}
                    onChange={(v) => handlePickAxis(i, v)}
                  />
                ))}
                <span className="text-[10.5px] text-slate-500 dark:text-slate-400">
                  {t('products.edit.cockpit.ebay.variations.axisHint')}
                </span>
              </div>
            </div>

            {/* ── Axis sort + eBay-only rename editors ───────────── */}
            {effectiveAxes.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {effectiveAxes.map((axis) => (
                  <AxisSortEditor
                    key={axis}
                    axis={axis}
                    values={axisValues[axis] ?? []}
                    onMove={(v, dir) => handleMoveAxisValue(axis, v, dir)}
                    nameLabel={axisLabel(axis)}
                    valueLabelOf={(v) => valueLabel(axis, v)}
                    onRenameAxis={(label) => handleRenameAxis(axis, label)}
                    onRenameValue={(v, label) => handleRenameValue(axis, v, label)}
                  />
                ))}
              </div>
            )}

            {/* ── EV.7 — advisory validation warnings ─────────────── */}
            {hasWarnings && (
              <div className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/30 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300 flex flex-wrap items-center gap-x-3 gap-y-1">
                <AlertTriangle aria-hidden className="w-3.5 h-3.5 shrink-0" />
                {overCap && (
                  <span>{t('products.edit.cockpit.ebay.variations.exceedsCap')}</span>
                )}
                {validation.missingPrice > 0 && (
                  <span>{validation.missingPrice} {t('products.edit.cockpit.ebay.variations.missingPrice')}</span>
                )}
                {validation.missingQty > 0 && (
                  <span>{validation.missingQty} {t('products.edit.cockpit.ebay.variations.missingQty')}</span>
                )}
                {validation.missingValue > 0 && (
                  <span>{validation.missingValue} {t('products.edit.cockpit.ebay.variations.missingValue')}</span>
                )}
                <span className="text-[10px] opacity-80">{t('products.edit.cockpit.ebay.variations.validationNote')}</span>
              </div>
            )}

            {/* ── Grid (≤2 specifics) or flat table (3–5 specifics) ── */}
            {useFlatTable ? (
              <FlatVariationTable
                axes={effectiveAxes}
                cells={data.cells}
                dirtyCells={dirtyCells}
                onCellEdit={handleCellEdit}
                currency={currency}
                axisLabel={axisLabel}
                valueLabel={valueLabel}
              />
            ) : (
              rowAxis &&
              rowValues.length > 0 && (
                <MatrixGrid
                  rowAxis={rowAxis}
                  colAxis={colAxis}
                  rowValues={rowValues}
                  colValues={colValues}
                  cellAt={cellAt}
                  dirtyCells={dirtyCells}
                  onCellEdit={handleCellEdit}
                  currency={currency}
                  axisLabel={axisLabel}
                  valueLabel={valueLabel}
                />
              )
            )}
          </>
        )}
      </div>

      {data && !loading && (
        <div className="px-4 py-2.5 border-t border-subtle dark:border-slate-800 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {dirtyCount === 0 && !pickedDirty && !sortDirty && !labelsDirty ? t('products.edit.cockpit.ebay.variations.allSaved') : t('products.edit.cockpit.ebay.variations.unsavedChanges')}
          </span>
          <button
            type="button"
            onClick={() => setDirtyCells({})}
            disabled={dirtyCount === 0}
            className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 inline-flex items-center gap-1 disabled:opacity-40"
            title={t('products.edit.cockpit.ebay.variations.discardCellEditsTooltip')}
          >
            <Eraser className="w-3 h-3" /> {t('products.edit.cockpit.ebay.variations.discardCellEdits')}
          </button>
          {/* EV.6a — File Exchange CSV (renamed specifics, current price/qty). */}
          <a
            href={`${getBackendUrl()}/api/ebay/cockpit/file-exchange-csv?parentProductId=${encodeURIComponent(productId)}&marketplace=${encodeURIComponent(marketplace)}`}
            className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 inline-flex items-center gap-1"
            title={t('products.edit.cockpit.ebay.variations.downloadCsvTooltip')}
          >
            <Download className="w-3 h-3" /> {t('products.edit.cockpit.ebay.variations.downloadCsv')}
          </a>
          <button
            type="button"
            onClick={handleSaveAll}
            disabled={saving || (dirtyCount === 0 && !pickedDirty && !sortDirty && !labelsDirty)}
            className="ml-auto px-3 py-1 text-xs font-medium rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            {saving ? t('products.edit.cockpit.ebay.variations.saving') : t('products.edit.cockpit.ebay.variations.saveMatrix')}
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
  const { t } = useTranslations()
  return (
    <label className="inline-flex items-center gap-1.5 text-xs">
      <span className="text-slate-500 dark:text-slate-400">{label}:</span>
      <Listbox
        value={value ?? ''}
        onChange={(v) => onChange(v || null)}
        ariaLabel={label}
        className="w-32"
        options={[
          { value: '', label: t('products.edit.cockpit.ebay.variations.none') },
          ...available.map((a) => ({ value: a, label: a })),
        ]}
      />
    </label>
  )
}

// ── Axis sort editor ──────────────────────────────────────────────────
function AxisSortEditor({
  axis,
  values,
  onMove,
  nameLabel,
  valueLabelOf,
  onRenameAxis,
  onRenameValue,
}: {
  axis: string
  values: string[]
  onMove: (value: string, dir: -1 | 1) => void
  // EV.4 — eBay-only renames.
  nameLabel: string
  valueLabelOf: (v: string) => string
  onRenameAxis: (label: string) => void
  onRenameValue: (v: string, label: string) => void
}) {
  const { t } = useTranslations()
  return (
    <div className="rounded border border-default dark:border-slate-800 p-2 space-y-1">
      <div className="text-[11px] font-medium text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
        <Sparkles className="w-3 h-3 text-violet-500" />
        {/* eBay-only axis-name rename; placeholder = canonical name. */}
        <input
          defaultValue={nameLabel === axis ? '' : nameLabel}
          onBlur={(e) => onRenameAxis(e.target.value)}
          placeholder={axis}
          title={t('products.edit.cockpit.ebay.variations.renameAxisTitle', { axis })}
          className="bg-transparent border-b border-dashed border-slate-300 dark:border-slate-600 px-0.5 w-28 focus:outline-none focus:border-violet-400"
        />
        <span className="text-tertiary">
          {t('products.edit.cockpit.ebay.variations.order')} ({values.length})
        </span>
      </div>
      <div className="space-y-1">
        {values.map((v, i) => (
          <div key={v} className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-slate-50 dark:bg-slate-800/60">
            <button
              type="button"
              onClick={() => onMove(v, -1)}
              disabled={i === 0}
              className="p-0.5 text-tertiary hover:text-slate-800 dark:hover:text-slate-200 disabled:opacity-30"
              aria-label={t('products.edit.cockpit.ebay.variations.moveUp', { value: v })}
            >
              <ChevronUp className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => onMove(v, +1)}
              disabled={i === values.length - 1}
              className="p-0.5 text-tertiary hover:text-slate-800 dark:hover:text-slate-200 disabled:opacity-30"
              aria-label={t('products.edit.cockpit.ebay.variations.moveDown', { value: v })}
            >
              <ChevronDown className="w-3 h-3" />
            </button>
            {/* eBay-only value rename; placeholder = canonical value. */}
            <input
              defaultValue={valueLabelOf(v) === v ? '' : valueLabelOf(v)}
              onBlur={(e) => onRenameValue(v, e.target.value)}
              placeholder={v}
              title={t('products.edit.cockpit.ebay.variations.renameValueTitle', { value: v })}
              className="flex-1 min-w-0 bg-transparent border-b border-dashed border-slate-300 dark:border-slate-600 px-0.5 font-mono text-slate-700 dark:text-slate-300 focus:outline-none focus:border-violet-400"
            />
            <span className="text-[10px] text-tertiary ml-auto">{i + 1}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Matrix grid ────────────────────────────────────────────────────────
function MatrixGrid({
  rowAxis, colAxis, rowValues, colValues, cellAt, dirtyCells, onCellEdit, currency, axisLabel, valueLabel,
}: {
  rowAxis: string
  colAxis: string | null
  rowValues: string[]
  colValues: string[]
  cellAt: (rv: string, cv: string | null) => Cell | null
  dirtyCells: Record<string, DirtyCell>
  onCellEdit: (childId: string, patch: DirtyCell) => void
  currency: string
  // EV.4 — eBay-only display labels (raw values still drive cellAt lookup).
  axisLabel: (axis: string) => string
  valueLabel: (axis: string, v: string) => string
}) {
  const { t } = useTranslations()
  const cols = colAxis ? colValues : [null]
  return (
    <div className="overflow-x-auto -mx-4 px-4">
      <table className="text-xs border-collapse">
        <thead>
          <tr>
            <th className="text-[10.5px] uppercase tracking-wide text-tertiary font-medium px-2 py-1 text-left">
              {axisLabel(rowAxis)} \\ {colAxis ? axisLabel(colAxis) : t('products.edit.cockpit.ebay.variations.noneParen')}
            </th>
            {cols.map((cv, i) => (
              <th key={i} className="text-[11px] font-semibold text-slate-700 dark:text-slate-300 px-2 py-1 text-left whitespace-nowrap">
                {cv && colAxis ? valueLabel(colAxis, cv) : '—'}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowValues.map((rv) => (
            <tr key={rv}>
              <td className="text-[11px] font-semibold text-slate-700 dark:text-slate-300 pr-2 py-1 whitespace-nowrap align-top">
                {valueLabel(rowAxis, rv)}
              </td>
              {cols.map((cv, i) => {
                const c = cellAt(rv, cv)
                if (!c) {
                  return (
                    <td key={i} className="align-top p-1">
                      <div className="w-32 h-16 rounded border border-dashed border-default dark:border-slate-800 flex items-center justify-center text-[10.5px] text-slate-300">
                        {t('products.edit.cockpit.ebay.variations.noVariant')}
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
  const { t } = useTranslations()
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
        : 'border-default dark:border-slate-800 bg-white dark:bg-slate-900',
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
        className="w-full text-[11px] border border-default dark:border-slate-700 rounded px-1 py-0.5 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
        title={t('products.edit.cockpit.ebay.variations.priceOverride')}
      />
      <input
        type="number"
        step="1"
        min="0"
        value={qtyVal ?? ''}
        onChange={(e) => onChange({ quantity: e.target.value === '' ? null : parseInt(e.target.value, 10) })}
        placeholder={t('products.edit.cockpit.ebay.variations.qtyPlaceholder')}
        className="w-full text-[11px] border border-default dark:border-slate-700 rounded px-1 py-0.5 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
        title={t('products.edit.cockpit.ebay.variations.quantity')}
      />
    </div>
  )
}

// ── Flat variation table (EV.3) ─────────────────────────────────────────
// A 2D grid can't show 3–5 variation specifics, so when more than two are
// picked we render one row per variation: a column per specific + the
// shared CellEditor (price / qty / status / SKU).
function FlatVariationTable({
  axes,
  cells,
  dirtyCells,
  onCellEdit,
  currency,
  axisLabel,
  valueLabel,
}: {
  axes: string[]
  cells: Cell[]
  dirtyCells: Record<string, DirtyCell>
  onCellEdit: (childId: string, patch: DirtyCell) => void
  currency: string
  axisLabel: (axis: string) => string
  valueLabel: (axis: string, v: string) => string
}) {
  const { t } = useTranslations()
  return (
    <div className="overflow-x-auto rounded-lg border border-default dark:border-slate-800">
      <table className="w-full text-xs">
        <thead className="bg-slate-50 dark:bg-slate-900/40 text-left text-slate-500 dark:text-slate-400">
          <tr>
            {axes.map((a) => (
              <th key={a} className="px-2 py-1.5 font-medium">
                {axisLabel(a)}
              </th>
            ))}
            <th className="px-2 py-1.5 font-medium">
              {t('products.edit.cockpit.ebay.variations.priceOverride')} /{' '}
              {t('products.edit.cockpit.ebay.variations.quantity')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {cells.map((c) => (
            <tr key={c.childProductId} className="align-top">
              {axes.map((a) => {
                const raw = c.variationAttributes?.[a]
                return (
                  <td key={a} className="px-2 py-1.5 text-slate-700 dark:text-slate-300">
                    {raw ? valueLabel(a, raw) : '—'}
                  </td>
                )
              })}
              <td className="px-2 py-1.5">
                <CellEditor
                  cell={c}
                  dirty={dirtyCells[c.childProductId]}
                  currency={currency}
                  onChange={(patch) => onCellEdit(c.childProductId, patch)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
