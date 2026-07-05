'use client'

// PO.14 — Advanced-filters popover + saved-view chips for the PO list.
//
// Saved views are click-to-apply presets (no per-user persistence yet —
// that lives in PO.18 polish when a user-saved-view model is justified
// for a single-operator brand like Xavia).
//
// Advanced filters: date range (expectedDeliveryDate), supplier
// multi-select, value range (cents), warehouse, currency. All state
// goes through URL params so links are shareable.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  Filter,
  Loader2,
  Sparkles,
  X,
} from 'lucide-react'
import { DateField as DsDateField } from '@/design-system/components/DateField'
import { Listbox } from '@/design-system/components/Listbox'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────────────────

export interface AdvancedFilterState {
  supplierIds: string[]
  warehouseId: string | null
  currencyCode: string | null
  expectedFrom: string | null // YYYY-MM-DD
  expectedTo: string | null
  minValueCents: number | null
  maxValueCents: number | null
  lateOnly: boolean
}

export const EMPTY_ADVANCED: AdvancedFilterState = {
  supplierIds: [],
  warehouseId: null,
  currencyCode: null,
  expectedFrom: null,
  expectedTo: null,
  minValueCents: null,
  maxValueCents: null,
  lateOnly: false,
}

export function advancedToParams(
  state: AdvancedFilterState,
): Record<string, string | undefined> {
  return {
    supplierIds: state.supplierIds.length ? state.supplierIds.join(',') : undefined,
    warehouseId: state.warehouseId ?? undefined,
    currencyCode: state.currencyCode ?? undefined,
    expectedFrom: state.expectedFrom ?? undefined,
    expectedTo: state.expectedTo ?? undefined,
    minValueCents: state.minValueCents != null ? String(state.minValueCents) : undefined,
    maxValueCents: state.maxValueCents != null ? String(state.maxValueCents) : undefined,
    lateOnly: state.lateOnly ? 'true' : undefined,
  }
}

export function advancedFromParams(
  params: URLSearchParams,
): AdvancedFilterState {
  const min = params.get('minValueCents')
  const max = params.get('maxValueCents')
  return {
    supplierIds: (params.get('supplierIds') ?? '').split(',').filter(Boolean),
    warehouseId: params.get('warehouseId') || null,
    currencyCode: params.get('currencyCode') || null,
    expectedFrom: params.get('expectedFrom') || null,
    expectedTo: params.get('expectedTo') || null,
    minValueCents: min != null ? Number(min) : null,
    maxValueCents: max != null ? Number(max) : null,
    lateOnly: params.get('lateOnly') === 'true',
  }
}

export function countActiveFilters(state: AdvancedFilterState): number {
  let n = 0
  if (state.supplierIds.length) n++
  if (state.warehouseId) n++
  if (state.currencyCode) n++
  if (state.expectedFrom || state.expectedTo) n++
  if (state.minValueCents != null || state.maxValueCents != null) n++
  if (state.lateOnly) n++
  return n
}

// ── Saved views (built-in presets) ─────────────────────────────────

export interface SavedView {
  id: string
  label: string
  status?: string // comma-separated for multi
  advanced: Partial<AdvancedFilterState>
}

// Concrete dates can't live in module scope (they'd freeze at import
// time); we compute them at apply-time inside the callback.
export const BUILT_IN_VIEWS: SavedView[] = [
  {
    id: 'late',
    label: 'Late POs',
    advanced: { lateOnly: true },
  },
  {
    id: 'awaiting-approval',
    label: 'Awaiting approval',
    status: 'REVIEW',
    advanced: {},
  },
  {
    id: 'this-week',
    label: 'Deliveries this week',
    advanced: { /* expectedFrom/To filled at apply-time */ },
  },
  {
    id: 'my-drafts',
    label: 'Drafts',
    status: 'DRAFT',
    advanced: {},
  },
  {
    id: 'received',
    label: 'Received',
    status: 'RECEIVED',
    advanced: {},
  },
]

export function materializeView(v: SavedView): {
  status: string | null
  advanced: AdvancedFilterState
} {
  let advanced: AdvancedFilterState = { ...EMPTY_ADVANCED, ...v.advanced }
  if (v.id === 'this-week') {
    const today = new Date()
    const yyyy = today.toISOString().slice(0, 10)
    const plus7 = new Date(today.getTime() + 7 * 86400_000).toISOString().slice(0, 10)
    advanced = { ...advanced, expectedFrom: yyyy, expectedTo: plus7 }
  }
  return { status: v.status ?? null, advanced }
}

// ── Popover ────────────────────────────────────────────────────────

interface SupplierOption {
  id: string
  name: string
}

interface WarehouseOption {
  id: string
  code: string
  name: string | null
}

const CURRENCIES = ['EUR', 'USD', 'GBP', 'CNY', 'JPY', 'CHF', 'SEK']

export function AdvancedFiltersButton({
  value,
  onChange,
}: {
  value: AdvancedFilterState
  onChange: (next: AdvancedFilterState) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<AdvancedFilterState>(value)
  const [suppliers, setSuppliers] = useState<SupplierOption[] | null>(null)
  const [warehouses, setWarehouses] = useState<WarehouseOption[] | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Re-sync the draft whenever the parent value changes externally
  // (e.g. a saved view applies).
  useEffect(() => {
    setDraft(value)
  }, [value])

  // Outside click → close.
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        btnRef.current &&
        !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Lazy-load suppliers + warehouses on first open.
  useEffect(() => {
    if (!open || (suppliers && warehouses)) return
    Promise.all([
      fetch(`${getBackendUrl()}/api/fulfillment/suppliers?activeOnly=true`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .catch(() => ({ items: [] })),
      fetch(`${getBackendUrl()}/api/fulfillment/warehouses`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .catch(() => ({ items: [] })),
    ]).then(([s, w]) => {
      setSuppliers((s.items ?? []) as SupplierOption[])
      setWarehouses((w.items ?? []) as WarehouseOption[])
    })
  }, [open, suppliers, warehouses])

  const active = countActiveFilters(value)

  const apply = () => {
    onChange(draft)
    setOpen(false)
  }
  const reset = () => {
    setDraft(EMPTY_ADVANCED)
  }

  return (
    <div className="relative inline-block">
      <button
        ref={btnRef}
        type="button"
        onClick={() => {
          setDraft(value)
          setOpen((v) => !v)
        }}
        className={cn(
          'h-8 px-2 inline-flex items-center gap-1.5 text-sm border rounded transition-colors',
          active > 0
            ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900'
            : 'border-default dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800',
        )}
        title="Advanced filters"
        aria-label="Advanced filters"
      >
        <Filter className="w-3.5 h-3.5" />
        Filters
        {active > 0 && (
          <span className="ml-0.5 text-xs font-semibold tabular-nums">{active}</span>
        )}
        <ChevronDown className={cn('w-3 h-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-full mt-1 z-40 w-96 max-w-[calc(100vw-2rem)] bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg shadow-lg"
        >
          <div className="px-4 py-2 border-b border-default dark:border-slate-700 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
              Filters
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-7 w-7 inline-flex items-center justify-center rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>

          <div className="p-4 space-y-3 max-h-[60vh] overflow-y-auto">
            {/* Late only */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.lateOnly}
                onChange={(e) => setDraft((d) => ({ ...d, lateOnly: e.target.checked }))}
                className="w-4 h-4 accent-slate-900 dark:accent-slate-100"
              />
              <span className="text-base text-slate-700 dark:text-slate-300">
                Late only (past expected delivery)
              </span>
            </label>

            {/* Date range */}
            <div>
              <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                Expected delivery
              </div>
              <div className="grid grid-cols-2 gap-2">
                <DateField
                  label="From"
                  value={draft.expectedFrom}
                  onChange={(v) => setDraft((d) => ({ ...d, expectedFrom: v }))}
                />
                <DateField
                  label="To"
                  value={draft.expectedTo}
                  onChange={(v) => setDraft((d) => ({ ...d, expectedTo: v }))}
                />
              </div>
            </div>

            {/* Suppliers */}
            <div>
              <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                Suppliers
              </div>
              <SupplierChips
                suppliers={suppliers}
                selectedIds={draft.supplierIds}
                onChange={(ids) => setDraft((d) => ({ ...d, supplierIds: ids }))}
              />
            </div>

            {/* Warehouse + currency */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Warehouse
                </div>
                <Listbox
                  value={draft.warehouseId ?? ''}
                  onChange={(v) =>
                    setDraft((d) => ({ ...d, warehouseId: v || null }))
                  }
                  ariaLabel="Warehouse"
                  className="w-full"
                  options={[
                    { value: '', label: 'Any' },
                    ...(warehouses ?? []).map((w) => ({
                      value: w.id,
                      label: `${w.code}${w.name ? ` · ${w.name}` : ''}`,
                    })),
                  ]}
                />
              </div>
              <div>
                <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Currency
                </div>
                <Listbox
                  value={draft.currencyCode ?? ''}
                  onChange={(v) =>
                    setDraft((d) => ({ ...d, currencyCode: v || null }))
                  }
                  ariaLabel="Currency"
                  className="w-full"
                  options={[
                    { value: '', label: 'Any' },
                    ...CURRENCIES.map((c) => ({ value: c, label: c })),
                  ]}
                />
              </div>
            </div>

            {/* Value range */}
            <div>
              <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                Total value
              </div>
              <div className="grid grid-cols-2 gap-2">
                <CentsField
                  label="Min"
                  cents={draft.minValueCents}
                  onChange={(v) => setDraft((d) => ({ ...d, minValueCents: v }))}
                />
                <CentsField
                  label="Max"
                  cents={draft.maxValueCents}
                  onChange={(v) => setDraft((d) => ({ ...d, maxValueCents: v }))}
                />
              </div>
            </div>
          </div>

          <div className="border-t border-default dark:border-slate-700 px-4 py-2 flex items-center justify-between">
            <button
              type="button"
              onClick={reset}
              className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={apply}
              className="h-8 px-3 inline-flex items-center text-base font-medium rounded bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border border-slate-900 dark:border-slate-100 hover:bg-slate-800"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Saved-view chips ───────────────────────────────────────────────

export function SavedViewChips({
  onApply,
  activeViewId,
}: {
  onApply: (view: SavedView) => void
  activeViewId?: string | null
}) {
  return (
    <div className="inline-flex items-center gap-1 flex-wrap">
      <span className="inline-flex items-center text-sm text-slate-500 dark:text-slate-400 gap-1 mr-1">
        <Sparkles className="w-3 h-3" />
        Views:
      </span>
      {BUILT_IN_VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          onClick={() => onApply(v)}
          className={cn(
            'h-7 px-2 inline-flex items-center text-sm rounded border transition-colors',
            activeViewId === v.id
              ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900'
              : 'border-default dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
          )}
        >
          {v.label}
        </button>
      ))}
    </div>
  )
}

// ── Active-filter pills (under the toolbar) ────────────────────────

export function ActiveFilterPills({
  state,
  suppliers,
  warehouses,
  onClear,
}: {
  state: AdvancedFilterState
  suppliers: SupplierOption[] | null
  warehouses: WarehouseOption[] | null
  onClear: (key: keyof AdvancedFilterState) => void
}) {
  const pills: Array<{ key: keyof AdvancedFilterState; label: string }> = []
  if (state.lateOnly) pills.push({ key: 'lateOnly', label: 'Late only' })
  if (state.expectedFrom || state.expectedTo) {
    pills.push({
      key: 'expectedFrom',
      label: `Expected ${state.expectedFrom ?? '…'} → ${state.expectedTo ?? '…'}`,
    })
  }
  if (state.supplierIds.length) {
    const names = state.supplierIds
      .map((id) => suppliers?.find((s) => s.id === id)?.name ?? id.slice(0, 6))
      .join(', ')
    pills.push({ key: 'supplierIds', label: `Supplier: ${names}` })
  }
  if (state.warehouseId) {
    const w = warehouses?.find((x) => x.id === state.warehouseId)
    pills.push({ key: 'warehouseId', label: `Warehouse: ${w?.code ?? state.warehouseId.slice(0, 6)}` })
  }
  if (state.currencyCode) pills.push({ key: 'currencyCode', label: `Currency: ${state.currencyCode}` })
  if (state.minValueCents != null || state.maxValueCents != null) {
    const min = state.minValueCents != null ? `€${(state.minValueCents / 100).toFixed(0)}` : '…'
    const max = state.maxValueCents != null ? `€${(state.maxValueCents / 100).toFixed(0)}` : '…'
    pills.push({ key: 'minValueCents', label: `Value ${min}-${max}` })
  }

  if (pills.length === 0) return null

  return (
    <div className="inline-flex items-center gap-1 flex-wrap">
      {pills.map((p) => (
        <span
          key={p.key}
          className="inline-flex items-center gap-1 h-7 px-2 text-sm rounded border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300"
        >
          {p.label}
          <button
            type="button"
            onClick={() => onClear(p.key)}
            className="hover:bg-blue-100 dark:hover:bg-blue-900/40 rounded-full"
            aria-label={`Remove ${p.key}`}
          >
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────

function DateField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string | null
  onChange: (next: string | null) => void
}) {
  return (
    <div>
      <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">{label}</div>
      <DsDateField
        value={value ?? ''}
        onChange={(v) => onChange(v || null)}
        ariaLabel={label}
        className="w-full"
      />
    </div>
  )
}

function CentsField({
  label,
  cents,
  onChange,
}: {
  label: string
  cents: number | null
  onChange: (next: number | null) => void
}) {
  return (
    <div>
      <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">{label}</div>
      <div className="relative">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-tertiary dark:text-slate-500 pointer-events-none text-sm">
          €
        </span>
        <input
          type="number"
          min="0"
          step="1"
          value={cents != null ? Math.round(cents / 100) : ''}
          onChange={(e) => {
            const raw = e.target.value
            if (raw === '') onChange(null)
            else {
              const n = parseFloat(raw)
              onChange(Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null)
            }
          }}
          placeholder="0"
          className="w-full h-9 pl-6 pr-2 text-base border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
        />
      </div>
    </div>
  )
}

function SupplierChips({
  suppliers,
  selectedIds,
  onChange,
}: {
  suppliers: SupplierOption[] | null
  selectedIds: string[]
  onChange: (next: string[]) => void
}) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    if (!suppliers) return []
    const q = query.trim().toLowerCase()
    if (!q) return suppliers.slice(0, 20)
    return suppliers
      .filter((s) => s.name.toLowerCase().includes(q))
      .slice(0, 20)
  }, [suppliers, query])

  const toggle = useCallback(
    (id: string) => {
      const next = selectedIds.includes(id)
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id]
      onChange(next)
    },
    [selectedIds, onChange],
  )

  if (!suppliers) {
    return (
      <div className="text-sm text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading suppliers…
      </div>
    )
  }

  return (
    <div>
      {suppliers.length > 8 && (
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search suppliers…"
          className="w-full h-8 px-2 text-base border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 mb-1.5"
        />
      )}
      <div className="flex items-center gap-1 flex-wrap">
        {filtered.map((s) => {
          const on = selectedIds.includes(s.id)
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => toggle(s.id)}
              className={cn(
                'h-7 px-2 inline-flex items-center text-sm rounded border transition-colors',
                on
                  ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900'
                  : 'border-default dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
              )}
            >
              {s.name}
            </button>
          )
        })}
        {filtered.length === 0 && (
          <span className="text-sm text-slate-500 dark:text-slate-400">No suppliers match.</span>
        )}
      </div>
    </div>
  )
}
