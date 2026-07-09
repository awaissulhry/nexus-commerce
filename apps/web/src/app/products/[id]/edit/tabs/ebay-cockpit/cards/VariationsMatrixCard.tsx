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
import { Loader2, Save, AlertTriangle, Eraser, Sparkles, Download } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { useRouter } from 'next/navigation'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/lib/i18n/use-translations'
import { AxisValueOrderEditor, type AxisEntry } from '@/components/ebay/AxisValueOrderEditor'
import { axisSynonymKey } from '@/app/products/ebay-flat-file/variationValueOrder.pure'

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
  // Legacy raw-axis-name → value order. Still returned for back-compat; EFX P3
  // migrates it into axisValueOrder (synonym-keyed) on the next matrix save.
  axisSortOrder: Record<string, string[]>
  // EFX P2/P3 — synonym-keyed (__dim0__/__dim1__/lowercase-custom) value order,
  // the canonical store the push service reads.
  axisValueOrder?: Record<string, string[]>
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

// EFX P3 — build the initial synonym-keyed value order from a matrix payload.
// Prefer the canonical axisValueOrder[synKey]; fall back to the legacy
// axisSortOrder[rawName] (remapped to its synonym key) so old listings keep
// their order and get lazily migrated on the next save.
function seedValueOrder(md: MatrixData): Record<string, string[]> {
  const observed = new Set<string>()
  for (const c of md.cells) {
    for (const k of Object.keys(c.variationAttributes ?? {})) observed.add(k)
  }
  const out: Record<string, string[]> = {}
  for (const axis of observed) {
    const synKey = axisSynonymKey(axis)
    if (synKey in out) continue // first raw name for a dimension wins
    const fromNew = md.axisValueOrder?.[synKey]
    const fromLegacy = md.axisSortOrder?.[axis]
    const seed = fromNew?.length ? fromNew : fromLegacy?.length ? fromLegacy : null
    if (seed) out[synKey] = seed
  }
  return out
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
  // EFX P3 — value order keyed by axisSynonymKey (the canonical push store),
  // replacing the legacy raw-name-keyed sortDraft.
  const [valueOrderDraft, setValueOrderDraft] = useState<Record<string, string[]>>({})
  const [valueOrderDirty, setValueOrderDirty] = useState(false)
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
        const md = json as MatrixData
        setData(md)
        setPickedAxesDraft(md.pickedAxes)
        // EFX P3 — build the synonym-keyed value order: prefer the canonical
        // axisValueOrder[synKey]; fall back to the legacy axisSortOrder[rawName]
        // (remapped to its synonym key) so old listings keep their order and get
        // lazily migrated on the next save.
        setValueOrderDraft(seedValueOrder(md))
        setNameLabels(md.axisNameLabels ?? {})
        setValueLabels(md.axisValueLabels ?? {})
        setPickedDirty(false)
        setValueOrderDirty(false)
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

  // Per-axis distinct values, ordered by the synonym-keyed valueOrderDraft
  // (custom) or insertion order. Unknown/new values are appended after the
  // stored order so nothing is ever dropped.
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
      const order = valueOrderDraft[axisSynonymKey(axis)] ?? []
      const ordered = order.filter((v) => seen.has(v))
      const rest = ins.filter((v) => !ordered.includes(v))
      out[axis] = [...ordered, ...rest]
    }
    return out
  }, [data, availableAxes, valueOrderDraft])

  // EV.3 / EFX P3 — effective variation specifics: ALL available axes, ordered
  // by the picked sequence (unranked axes appended in observation order),
  // capped at eBay's 5. Unlike the old subset picker, ordering can never drop
  // an axis — every varying dimension stays a variation specific (eBay requires
  // it); the picked order only decides row/col + buyer-facing sequence. A 2D
  // grid can only show two dimensions, so 3–5 specifics fall back to a flat
  // one-row-per-variant table.
  const effectiveAxes = useMemo(() => {
    if (availableAxes.length === 0) return []
    const rank = new Map(pickedAxesDraft.map((a, i) => [a, i]))
    return [...availableAxes]
      .sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER))
      .slice(0, 5)
  }, [availableAxes, pickedAxesDraft])
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

  // EFX P3 — feed the shared AxisValueOrderEditor. Value panels are keyed by
  // axisSynonymKey (the canonical store); synToRaw maps that back to the raw
  // axis name so the eBay-only rename slots stay keyed exactly as before.
  const editorAxes: AxisEntry[] = effectiveAxes.map((a) => ({
    key: axisSynonymKey(a),
    displayName: a,
    values: axisValues[a] ?? [],
  }))
  const synToRaw = new Map(effectiveAxes.map((a) => [axisSynonymKey(a), a]))

  // eBay-only axis-name rename input, injected into each panel heading.
  const renderAxisExtra = useCallback(
    (synKey: string) => {
      const raw = synToRaw.get(synKey) ?? synKey
      return (
        <span className="inline-flex items-center gap-1">
          <Sparkles className="w-3 h-3 text-violet-500 flex-shrink-0" />
          <input
            defaultValue={axisLabel(raw) === raw ? '' : axisLabel(raw)}
            onBlur={(e) => handleRenameAxis(raw, e.target.value)}
            placeholder={raw}
            title={t('products.edit.cockpit.ebay.variations.renameAxisTitle', { axis: raw })}
            className="normal-case font-normal bg-transparent border-b border-dashed border-slate-300 dark:border-slate-600 px-0.5 w-24 text-slate-700 dark:text-slate-300 focus:outline-none focus:border-violet-400"
          />
        </span>
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [axisLabel, handleRenameAxis, t, effectiveAxes.join('|')],
  )

  // eBay-only value rename input, injected into each value row.
  const renderValueExtra = useCallback(
    (synKey: string, value: string) => {
      const raw = synToRaw.get(synKey) ?? synKey
      return (
        <input
          defaultValue={valueLabel(raw, value) === value ? '' : valueLabel(raw, value)}
          onBlur={(e) => handleRenameValue(raw, value, e.target.value)}
          placeholder={value}
          title={t('products.edit.cockpit.ebay.variations.renameValueTitle', { value })}
          className="flex-1 min-w-0 bg-transparent border-b border-dashed border-slate-300 dark:border-slate-600 px-0.5 font-mono text-slate-700 dark:text-slate-300 focus:outline-none focus:border-violet-400"
        />
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [valueLabel, handleRenameValue, t, effectiveAxes.join('|')],
  )

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

  // EFX P3 — axis SEQ reorder (which specific a buyer picks first). The shared
  // editor hands back the full reordered list; that becomes pickedAxes on save.
  const handleAxisSeqChange = useCallback((seq: string[]) => {
    setPickedAxesDraft(seq.filter(Boolean).slice(0, 5))
    setPickedDirty(true)
  }, [])

  // EFX P3 — per-axis value order change (full array), keyed by axisSynonymKey.
  const handleAxisOrderChange = useCallback((synKey: string, values: string[]) => {
    setValueOrderDraft((cur) => ({ ...cur, [synKey]: values }))
    setValueOrderDirty(true)
  }, [])

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
      // EFX P3 — write the synonym-keyed value order (incl. lazily-migrated
      // legacy entries seeded from axisSortOrder). No longer sends axisSortOrder;
      // the server self-heals the superseded legacy keys.
      if (valueOrderDirty) body.axisValueOrder = valueOrderDraft
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
      setValueOrderDirty(false)
      setLabelsDirty(false)
      await refresh()
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [saving, productId, marketplace, pickedDirty, pickedAxesDraft, valueOrderDirty, valueOrderDraft, labelsDirty, nameLabels, valueLabels, dirtyCount, dirtyCells, refresh, router])

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
            {/* ── EFX P3 — unified axis order + per-axis value order + renames ── */}
            {effectiveAxes.length > 0 && (
              <div className="rounded-lg border border-default dark:border-slate-800 p-3 space-y-2">
                <div className="text-xs font-medium text-slate-700 dark:text-slate-300">{t('products.edit.cockpit.ebay.variations.axes')}</div>
                <AxisValueOrderEditor
                  axes={editorAxes}
                  axisSeq={effectiveAxes}
                  axisOrder={{}}
                  onAxisSeqChange={handleAxisSeqChange}
                  onAxisOrderChange={handleAxisOrderChange}
                  interaction="arrows"
                  renderAxisExtra={renderAxisExtra}
                  renderValueExtra={renderValueExtra}
                />
                <span className="text-[10.5px] text-slate-500 dark:text-slate-400 block">
                  {t('products.edit.cockpit.ebay.variations.axisHint')}
                </span>
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
            {dirtyCount === 0 && !pickedDirty && !valueOrderDirty && !labelsDirty ? t('products.edit.cockpit.ebay.variations.allSaved') : t('products.edit.cockpit.ebay.variations.unsavedChanges')}
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
            disabled={saving || (dirtyCount === 0 && !pickedDirty && !valueOrderDirty && !labelsDirty)}
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
