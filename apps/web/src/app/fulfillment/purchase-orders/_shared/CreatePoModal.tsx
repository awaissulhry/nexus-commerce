'use client'

// PO.5 — Smart Create PO modal.
//
// Replaces the minimal SKU-typing form with a supplier-aware draft
// builder. Operator flow:
//
//   1. Pick supplier (combobox or "no supplier" escape hatch).
//      → modal auto-fills currency (Supplier.defaultCurrency),
//        expected delivery date (today + supplier.leadTimeDays),
//        and the default warehouse.
//   2. Type into the SKU cell → typeahead hits
//      /api/fulfillment/suppliers/:id/catalog?q=… and renders
//      SupplierProduct + Product rows with cost / MOQ / case-pack.
//      Picking a row autofills productId, supplierSku, unit cost,
//      and prefills quantity = MOQ.
//   3. Quantity field shows MOQ + case-pack hints inline:
//      - red border + "Min order N" when qty < MOQ
//      - "Round up to N (case of M)" hint with a one-click apply
//   4. Currency picker — defaults to supplier currency, common
//      shortcuts (EUR/USD/GBP/CNY) + free text fallback. When the
//      chosen currency != EUR the footer renders an FX preview
//      pulled from /fulfillment/fx-rate.
//   5. Notes + per-line note popover.
//
// Multi-warehouse split + ship-to override are scoped to PO.15.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  AlertCircle,
  Calendar,
  Check,
  Loader2,
  Package,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────────────────

interface SupplierOption {
  id: string
  name: string
  isActive: boolean
  defaultCurrency: string | null
  leadTimeDays: number
}

interface WarehouseOption {
  id: string
  code: string
  name: string | null
  isDefault: boolean
}

interface CatalogItem {
  id: string
  supplierSku: string | null
  costCents: number | null
  currencyCode: string | null
  moq: number
  casePack: number | null
  leadTimeDaysOverride: number | null
  isPrimary: boolean
  product: {
    id: string
    sku: string
    name: string
    basePrice: number | string | null
  } | null
}

interface DraftLine {
  uid: string
  // Auto-filled from catalog row
  productId: string | null
  supplierSku: string | null
  // Operator-typed or catalog-picked
  sku: string
  // Per-line constraints (from catalog row, used by the qty validator)
  moq: number
  casePack: number | null
  // Operator-typed values
  quantityOrdered: string
  unitCostCents: string
  note: string
  // UI state
  noteEditing: boolean
}

let lineSeq = 0
const newLine = (): DraftLine => ({
  uid: `l${++lineSeq}`,
  productId: null,
  supplierSku: null,
  sku: '',
  moq: 1,
  casePack: null,
  quantityOrdered: '',
  unitCostCents: '',
  note: '',
  noteEditing: false,
})

// ── Helpers ────────────────────────────────────────────────────────

const CURRENCY_CHOICES = ['EUR', 'USD', 'GBP', 'CNY', 'JPY', 'CHF', 'SEK']

function todayPlusDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + Math.max(0, days))
  return d.toISOString().slice(0, 10)
}

function parseCentsField(value: string): number {
  // Accept "12", "12.34", "12,34" (Italian decimal). Negative → 0.
  const normalized = value.replace(',', '.').trim()
  if (!normalized) return 0
  const n = parseFloat(normalized)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n * 100)
}

function roundUpToCasePack(qty: number, casePack: number | null): number {
  if (!casePack || casePack <= 1) return qty
  return Math.ceil(qty / casePack) * casePack
}

// ── Component ──────────────────────────────────────────────────────

export function CreatePoModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void | Promise<void>
}) {
  const { t } = useTranslations()

  // ── Suppliers + warehouses (loaded once) ────────────────────────
  const [suppliers, setSuppliers] = useState<SupplierOption[] | null>(null)
  const [warehouses, setWarehouses] = useState<WarehouseOption[] | null>(null)

  // ── Header state ────────────────────────────────────────────────
  const [supplierId, setSupplierId] = useState<string>('')
  const [warehouseId, setWarehouseId] = useState<string>('')
  const [expectedDate, setExpectedDate] = useState('')
  const [currency, setCurrency] = useState<string>('EUR')
  const [notes, setNotes] = useState('')

  // ── Lines ───────────────────────────────────────────────────────
  const [lines, setLines] = useState<DraftLine[]>([newLine()])

  // ── Submit ─────────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── FX preview ─────────────────────────────────────────────────
  const [fxToEur, setFxToEur] = useState<number | null>(null)
  const [fxLoading, setFxLoading] = useState(false)

  // ── Load suppliers + warehouses + default warehouse ─────────────
  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch(`${getBackendUrl()}/api/fulfillment/suppliers?activeOnly=true`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .catch(() => ({ items: [] })),
      fetch(`${getBackendUrl()}/api/fulfillment/warehouses`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .catch(() => ({ items: [] })),
    ]).then(([sData, wData]) => {
      if (cancelled) return
      setSuppliers(sData.items ?? [])
      setWarehouses(wData.items ?? [])
      const defaultWh = (wData.items ?? []).find((w: WarehouseOption) => w.isDefault)
      if (defaultWh) setWarehouseId(defaultWh.id)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // ── Esc closes ──────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [submitting, onClose])

  // ── Supplier change → autofill defaults ─────────────────────────
  const selectedSupplier = useMemo(
    () => suppliers?.find((s) => s.id === supplierId) ?? null,
    [suppliers, supplierId],
  )
  useEffect(() => {
    if (!selectedSupplier) return
    // Currency: prefer supplier default, fall back to EUR. Always
    // set to the supplier default on supplier switch — if the operator
    // wants to override, they can pick after.
    setCurrency((selectedSupplier.defaultCurrency || 'EUR').toUpperCase())
    // Expected delivery: today + leadTimeDays. Only autofill when the
    // field is still empty so we don't blow away an operator edit.
    setExpectedDate((prev) =>
      prev ? prev : todayPlusDays(selectedSupplier.leadTimeDays ?? 14),
    )
  }, [selectedSupplier])

  // ── FX preview (currency → EUR) ─────────────────────────────────
  useEffect(() => {
    let cancelled = false
    if (!currency || currency === 'EUR') {
      setFxToEur(null)
      return
    }
    setFxLoading(true)
    fetch(
      `${getBackendUrl()}/api/fulfillment/fx-rate?from=${encodeURIComponent(
        currency,
      )}&to=EUR`,
      { cache: 'no-store' },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return
        const rate = data?.rate
        setFxToEur(typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null)
      })
      .catch(() => {
        if (!cancelled) setFxToEur(null)
      })
      .finally(() => {
        if (!cancelled) setFxLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [currency])

  // ── Totals ──────────────────────────────────────────────────────
  const totalCents = lines.reduce((s, l) => {
    const qty = parseInt(l.quantityOrdered, 10) || 0
    const cost = parseCentsField(l.unitCostCents)
    return s + qty * cost
  }, 0)
  const totalEurCents = fxToEur ? Math.round(totalCents * fxToEur) : null

  // ── Line mutators ───────────────────────────────────────────────
  const updateLine = useCallback((uid: string, patch: Partial<DraftLine>) => {
    setLines((prev) => prev.map((l) => (l.uid === uid ? { ...l, ...patch } : l)))
  }, [])
  const removeLine = useCallback((uid: string) => {
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((l) => l.uid !== uid)))
  }, [])
  const addLine = useCallback(() => {
    setLines((prev) => [...prev, newLine()])
  }, [])

  // ── Apply a catalog pick to a draft line ─────────────────────────
  const applyCatalogPick = useCallback(
    (uid: string, picked: CatalogItem) => {
      const sku = picked.product?.sku ?? picked.supplierSku ?? ''
      updateLine(uid, {
        productId: picked.product?.id ?? null,
        supplierSku: picked.supplierSku ?? null,
        sku,
        moq: picked.moq,
        casePack: picked.casePack,
        // Prefill quantity = MOQ; operator can bump.
        quantityOrdered:
          picked.moq && picked.moq > 1 ? String(picked.moq) : '1',
        // Prefill unit cost from SupplierProduct (whose currency is
        // assumed to match the PO header currency; PO.5 doesn't do
        // per-line conversion — that's PO.15's job).
        unitCostCents:
          picked.costCents != null ? (picked.costCents / 100).toFixed(2) : '',
      })
    },
    [updateLine],
  )

  // ── Submit ──────────────────────────────────────────────────────
  const submit = async () => {
    setError(null)
    const validLines = lines.filter(
      (l) => l.sku.trim() && parseInt(l.quantityOrdered, 10) > 0,
    )
    if (validLines.length === 0) {
      setError(t('po.create.error.noLines'))
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/purchase-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId: supplierId || undefined,
          warehouseId: warehouseId || undefined,
          expectedDeliveryDate: expectedDate || undefined,
          currencyCode: currency || 'EUR',
          notes: notes.trim() || undefined,
          items: validLines.map((l) => ({
            productId: l.productId ?? undefined,
            sku: l.sku.trim(),
            supplierSku: l.supplierSku ?? undefined,
            quantityOrdered: parseInt(l.quantityOrdered, 10),
            unitCostCents: parseCentsField(l.unitCostCents),
            note: l.note.trim() || undefined,
          })),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      await onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-po-title"
    >
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-slate-200 dark:border-slate-700 sticky top-0 bg-white dark:bg-slate-900 z-10">
          <h2
            id="create-po-title"
            className="text-lg font-semibold text-slate-900 dark:text-slate-100"
          >
            {t('po.create.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="h-8 w-8 inline-flex items-center justify-center rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label={t('po.create.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Header — supplier / warehouse / expected / currency */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">
                {t('po.create.supplier')}
              </label>
              <select
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                disabled={submitting}
                className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              >
                <option value="">{t('po.create.supplierNone')}</option>
                {suppliers?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {selectedSupplier && (
                <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                  Lead time: {selectedSupplier.leadTimeDays}d · default{' '}
                  {(selectedSupplier.defaultCurrency || 'EUR').toUpperCase()}
                </div>
              )}
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">
                Warehouse
              </label>
              <select
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
                disabled={submitting}
                className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              >
                <option value="">— Default —</option>
                {warehouses?.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code}
                    {w.name ? ` · ${w.name}` : ''}
                    {w.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">
                {t('po.create.expectedDate')}
              </label>
              <div className="relative">
                <Calendar
                  size={12}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 pointer-events-none"
                />
                <input
                  type="date"
                  value={expectedDate}
                  onChange={(e) => setExpectedDate(e.target.value)}
                  disabled={submitting}
                  className="w-full h-9 pl-7 pr-2 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                />
              </div>
              {selectedSupplier && expectedDate === todayPlusDays(selectedSupplier.leadTimeDays ?? 14) && (
                <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                  Auto = today + {selectedSupplier.leadTimeDays}d
                </div>
              )}
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">
                Currency
              </label>
              <div className="flex items-center gap-1">
                <select
                  value={CURRENCY_CHOICES.includes(currency) ? currency : '__other__'}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === '__other__') return
                    setCurrency(v)
                  }}
                  disabled={submitting}
                  className="flex-1 h-9 px-2 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                >
                  {CURRENCY_CHOICES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  <option value="__other__">Other…</option>
                </select>
                {!CURRENCY_CHOICES.includes(currency) && (
                  <input
                    type="text"
                    maxLength={3}
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                    disabled={submitting}
                    className="w-16 h-9 px-2 text-base font-mono uppercase border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                    placeholder="XXX"
                  />
                )}
              </div>
              {currency !== 'EUR' && (
                <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                  {fxLoading
                    ? 'Loading FX rate…'
                    : fxToEur != null
                      ? `1 ${currency} ≈ €${fxToEur.toFixed(4)}`
                      : 'No FX rate available'}
                </div>
              )}
            </div>
          </div>

          {/* Line items table */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                {t('po.create.lines')}
              </label>
              <button
                type="button"
                onClick={addLine}
                disabled={submitting}
                className="text-sm px-2 py-1 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1"
              >
                <Plus size={11} /> {t('po.create.addLine')}
              </button>
            </div>
            <div className="border border-slate-200 dark:border-slate-700 rounded overflow-visible">
              <table className="w-full text-base">
                <thead className="bg-slate-50 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
                  <tr>
                    <th className="text-left font-medium px-2 py-1.5">SKU / Product</th>
                    <th className="text-right font-medium px-2 py-1.5 w-32">Qty</th>
                    <th className="text-right font-medium px-2 py-1.5 w-32">Unit cost</th>
                    <th className="text-right font-medium px-2 py-1.5 w-28">Subtotal</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <LineRow
                      key={l.uid}
                      line={l}
                      supplierId={supplierId}
                      submitting={submitting}
                      currency={currency}
                      onUpdate={updateLine}
                      onRemove={() => removeLine(l.uid)}
                      onCatalogPick={(picked) => applyCatalogPick(l.uid, picked)}
                      canRemove={lines.length > 1}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-sm text-slate-500 dark:text-slate-400 mt-1 text-right tabular-nums">
              {t('po.create.total')}:{' '}
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {formatMoney(totalCents, currency)}
              </span>
              {totalEurCents != null && currency !== 'EUR' && (
                <span className="ml-2 text-slate-400 dark:text-slate-500">
                  ≈ {formatMoney(totalEurCents, 'EUR')}
                </span>
              )}
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">
              {t('po.create.notes')}
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={submitting}
              rows={3}
              placeholder={t('po.create.notesPlaceholder')}
              className="w-full px-2 py-1.5 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500"
            />
          </div>

          {error && (
            <div className="text-md text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-700 sticky bottom-0 bg-white dark:bg-slate-900">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            {t('po.create.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={submitting}>
            {submitting ? t('po.create.creating') : t('po.create.create')}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Line row + autocomplete ────────────────────────────────────────

function formatMoney(cents: number, code: string): string {
  const amount = cents / 100
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${code}`
  }
}

function LineRow({
  line,
  supplierId,
  submitting,
  currency,
  onUpdate,
  onRemove,
  onCatalogPick,
  canRemove,
}: {
  line: DraftLine
  supplierId: string
  submitting: boolean
  currency: string
  onUpdate: (uid: string, patch: Partial<DraftLine>) => void
  onRemove: () => void
  onCatalogPick: (picked: CatalogItem) => void
  canRemove: boolean
}) {
  const qty = parseInt(line.quantityOrdered, 10) || 0
  const moqViolation = qty > 0 && line.moq > 1 && qty < line.moq
  const caseAlignedQty = roundUpToCasePack(qty, line.casePack)
  const caseHintNeeded =
    qty > 0 && line.casePack && line.casePack > 1 && caseAlignedQty !== qty

  const subtotalCents = qty * parseCentsField(line.unitCostCents)

  return (
    <tr className="border-b border-slate-100 dark:border-slate-800 last:border-0 align-top">
      <td className="px-2 py-1.5">
        <SkuAutocomplete
          line={line}
          supplierId={supplierId}
          submitting={submitting}
          onTextChange={(sku) =>
            onUpdate(line.uid, {
              sku,
              // Clear catalog binding when the operator edits the SKU
              // text directly — they're either typing a brand-new SKU
              // or about to pick a fresh suggestion.
              productId: null,
              supplierSku: null,
              moq: 1,
              casePack: null,
            })
          }
          onPick={onCatalogPick}
        />
        {/* Per-line note row — collapsed into a "+ note" pill until clicked. */}
        {line.noteEditing || line.note ? (
          <div className="mt-1">
            <textarea
              value={line.note}
              onChange={(e) => onUpdate(line.uid, { note: e.target.value })}
              onBlur={() => onUpdate(line.uid, { noteEditing: false })}
              disabled={submitting}
              rows={1}
              placeholder="Line note (e.g. lot code, defect spec)"
              className="w-full px-2 py-1 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 placeholder:text-slate-400 dark:placeholder:text-slate-500"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onUpdate(line.uid, { noteEditing: true })}
            className="mt-1 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 inline-flex items-center gap-1"
          >
            + line note
          </button>
        )}
      </td>
      <td className="px-2 py-1.5">
        <input
          type="number"
          min="1"
          value={line.quantityOrdered}
          onChange={(e) => onUpdate(line.uid, { quantityOrdered: e.target.value })}
          disabled={submitting}
          className={cn(
            'w-full h-8 px-2 text-base text-right tabular-nums border rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100',
            moqViolation
              ? 'border-red-300 dark:border-red-700 bg-red-50/30 dark:bg-red-950/20'
              : 'border-slate-200 dark:border-slate-700',
          )}
        />
        {moqViolation && (
          <div className="text-xs text-red-700 dark:text-red-300 mt-0.5 text-right">
            Min {line.moq}
          </div>
        )}
        {caseHintNeeded && (
          <button
            type="button"
            onClick={() =>
              onUpdate(line.uid, { quantityOrdered: String(caseAlignedQty) })
            }
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline mt-0.5 text-right block w-full"
            title={`Round up to ${caseAlignedQty} (case of ${line.casePack})`}
          >
            → {caseAlignedQty} (case of {line.casePack})
          </button>
        )}
      </td>
      <td className="px-2 py-1.5">
        <input
          type="number"
          min="0"
          step="0.01"
          value={line.unitCostCents}
          onChange={(e) => onUpdate(line.uid, { unitCostCents: e.target.value })}
          disabled={submitting}
          placeholder="0.00"
          className="w-full h-8 px-2 text-base text-right tabular-nums border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
        />
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums font-medium text-slate-900 dark:text-slate-100">
        {subtotalCents > 0 ? formatMoney(subtotalCents, currency) : '—'}
      </td>
      <td className="px-1 py-1.5 text-center">
        <button
          type="button"
          onClick={onRemove}
          disabled={submitting || !canRemove}
          className="h-8 w-8 inline-flex items-center justify-center rounded text-slate-400 dark:text-slate-500 hover:text-rose-700 dark:hover:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-30"
          aria-label="Remove line"
        >
          <Trash2 size={12} />
        </button>
      </td>
    </tr>
  )
}

// ── SKU autocomplete ───────────────────────────────────────────────

function SkuAutocomplete({
  line,
  supplierId,
  submitting,
  onTextChange,
  onPick,
}: {
  line: DraftLine
  supplierId: string
  submitting: boolean
  onTextChange: (sku: string) => void
  onPick: (picked: CatalogItem) => void
}) {
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<CatalogItem[]>([])
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Outside-click closes the popover.
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Debounced search.
  useEffect(() => {
    if (!supplierId || !open) {
      setResults([])
      return
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    setLoading(true)
    debounceRef.current = window.setTimeout(async () => {
      try {
        const url = new URL(
          `${getBackendUrl()}/api/fulfillment/suppliers/${supplierId}/catalog`,
        )
        if (line.sku.trim()) url.searchParams.set('q', line.sku.trim())
        const res = await fetch(url.toString(), { cache: 'no-store' })
        if (res.ok) {
          const data = await res.json()
          setResults(data.items ?? [])
        }
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 200)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
  }, [supplierId, line.sku, open])

  const showHint = supplierId && !line.productId

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={line.sku}
        onChange={(e) => onTextChange(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder={supplierId ? 'Type SKU or product name…' : 'SKU'}
        disabled={submitting}
        className="w-full h-8 px-2 text-base font-mono border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500"
      />
      {line.productId && (
        <div className="text-xs text-green-700 dark:text-green-300 mt-0.5 inline-flex items-center gap-1">
          <Check className="w-3 h-3" />
          Linked to catalog
        </div>
      )}
      {open && supplierId && (
        <div className="absolute left-0 right-0 top-full mt-1 z-30 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded shadow-lg max-h-64 overflow-y-auto">
          {loading && (
            <div className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400 inline-flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Searching…
            </div>
          )}
          {!loading && results.length === 0 && (
            <div className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
              No catalog matches.{' '}
              <span className="text-slate-400 dark:text-slate-500">Type to create a free SKU.</span>
            </div>
          )}
          {!loading &&
            results.map((r) => {
              const p = r.product
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    onPick(r)
                    setOpen(false)
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800 border-b border-slate-100 dark:border-slate-800 last:border-0"
                >
                  <div className="flex items-center gap-2">
                    <Package className="w-3 h-3 text-slate-400 dark:text-slate-500 flex-shrink-0" />
                    <span className="font-mono text-sm text-slate-900 dark:text-slate-100">
                      {p?.sku ?? r.supplierSku ?? '—'}
                    </span>
                    {p?.name && (
                      <span className="text-sm text-slate-500 dark:text-slate-400 truncate">
                        · {p.name}
                      </span>
                    )}
                    {r.isPrimary && (
                      <span className="text-xs text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-950/40 px-1 rounded">
                        primary
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-3">
                    {r.costCents != null && (
                      <span className="tabular-nums">
                        {formatMoney(r.costCents, r.currencyCode || 'EUR')}
                      </span>
                    )}
                    {r.moq > 1 && <span>MOQ {r.moq}</span>}
                    {r.casePack && r.casePack > 1 && <span>case {r.casePack}</span>}
                    {r.supplierSku && r.supplierSku !== p?.sku && (
                      <span className="font-mono">supplier #{r.supplierSku}</span>
                    )}
                  </div>
                </button>
              )
            })}
        </div>
      )}
      {showHint && line.sku && !line.productId && !open && (
        <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          Free SKU (not in catalog)
        </div>
      )}
    </div>
  )
}
