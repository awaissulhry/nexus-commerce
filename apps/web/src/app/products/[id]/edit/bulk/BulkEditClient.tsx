'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

type FieldType = 'text' | 'number' | 'select' | 'boolean'
type FieldCategory =
  | 'universal'
  | 'pricing'
  | 'inventory'
  | 'identifiers'
  | 'physical'
  | 'content'
  | 'amazon'
  | 'ebay'
  | 'category'

interface FieldDef {
  id: string
  label: string
  type: FieldType
  category: FieldCategory
  options?: string[]
  width?: number
  editable: boolean
  required?: boolean
  helpText?: string
}

interface Product {
  id: string
  sku: string
  name: string
  parentId: string | null
  isParent?: boolean
  productType?: string | null
  categoryAttributes?: Record<string, unknown> | null
  variationAttributes?: Record<string, unknown> | null
  [key: string]: unknown
}

interface Props {
  product: Product
  childrenList: Product[]
  fields: FieldDef[]
}

// ── Group taxonomy ──────────────────────────────────────────────
//
// Pulls categories from the field-registry's existing `category` tag.
// Channel-scoped fields (amazon_*, ebay_*) are filtered out — this
// editor is master-data only (S.1). Each group has a colour swatch
// that paints the header band so the eye can scan column blocks at
// glance, like merged-cell groups in Excel.

const GROUP_ORDER: FieldCategory[] = [
  'universal',
  'identifiers',
  'pricing',
  'inventory',
  'physical',
  'content',
  'category',
]

const GROUP_LABEL: Record<FieldCategory, string> = {
  universal: 'Identity',
  identifiers: 'Identifiers',
  pricing: 'Pricing',
  inventory: 'Inventory',
  physical: 'Physical',
  content: 'Marketing copy',
  category: 'Category attributes',
  amazon: 'Amazon',
  ebay: 'eBay',
}

const GROUP_TONE: Record<FieldCategory, { band: string; cell: string; text: string }> = {
  universal: {
    band: 'bg-slate-100 border-slate-300',
    cell: 'bg-white',
    text: 'text-slate-900',
  },
  identifiers: {
    band: 'bg-indigo-50 border-indigo-200',
    cell: 'bg-indigo-50/30',
    text: 'text-indigo-900',
  },
  pricing: {
    band: 'bg-emerald-50 border-emerald-200',
    cell: 'bg-emerald-50/30',
    text: 'text-emerald-900',
  },
  inventory: {
    band: 'bg-amber-50 border-amber-200',
    cell: 'bg-amber-50/30',
    text: 'text-amber-900',
  },
  physical: {
    band: 'bg-sky-50 border-sky-200',
    cell: 'bg-sky-50/30',
    text: 'text-sky-900',
  },
  content: {
    band: 'bg-violet-50 border-violet-200',
    cell: 'bg-violet-50/30',
    text: 'text-violet-900',
  },
  category: {
    band: 'bg-rose-50 border-rose-200',
    cell: 'bg-rose-50/30',
    text: 'text-rose-900',
  },
  amazon: {
    band: 'bg-orange-50 border-orange-200',
    cell: 'bg-orange-50/30',
    text: 'text-orange-900',
  },
  ebay: {
    band: 'bg-teal-50 border-teal-200',
    cell: 'bg-teal-50/30',
    text: 'text-teal-900',
  },
}

// Identity stays open by default; the rest collapse to keep the table
// scannable. User can toggle with the chevron in the group header.
const DEFAULT_OPEN: ReadonlySet<FieldCategory> = new Set([
  'universal',
  'identifiers',
])

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'
const SAVE_DEBOUNCE_MS = 600

export default function BulkEditClient({
  product,
  childrenList,
  fields,
}: Props) {
  const router = useRouter()

  // Drop channel-prefixed fields — master-only view.
  const masterFields = useMemo(
    () =>
      fields.filter(
        (f) => f.category !== 'amazon' && f.category !== 'ebay',
      ),
    [fields],
  )

  // Group fields by category in the canonical order.
  const grouped = useMemo(() => {
    const out: Array<{ category: FieldCategory; fields: FieldDef[] }> = []
    for (const cat of GROUP_ORDER) {
      const list = masterFields.filter((f) => f.category === cat)
      if (list.length === 0) continue
      out.push({ category: cat, fields: list })
    }
    // Push any uncategorised buckets onto the end (defensive).
    const seen = new Set(GROUP_ORDER)
    const others = new Map<FieldCategory, FieldDef[]>()
    for (const f of masterFields) {
      if (seen.has(f.category)) continue
      const arr = others.get(f.category) ?? []
      arr.push(f)
      others.set(f.category, arr)
    }
    for (const [cat, list] of others) {
      out.push({ category: cat, fields: list })
    }
    return out
  }, [masterFields])

  const [openGroups, setOpenGroups] = useState<Set<FieldCategory>>(
    () => new Set(DEFAULT_OPEN),
  )
  const toggleGroup = useCallback((cat: FieldCategory) => {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }, [])

  // Rows: parent + every variant. Held in local state so inline edits
  // and add / delete operations land without a full page reload.
  const [rows, setRows] = useState<Product[]>(() => [product, ...childrenList])

  const [status, setStatus] = useState<SaveStatus>('idle')
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [cellErrors, setCellErrors] = useState<Map<string, string>>(new Map())
  const dirtyRef = useRef<
    Map<string, { id: string; field: string; value: unknown }>
  >(new Map())
  const saveTimer = useRef<number | null>(null)

  const flush = useCallback(async () => {
    if (dirtyRef.current.size === 0) {
      setStatus('idle')
      return
    }
    const changes = Array.from(dirtyRef.current.values())
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/bulk`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
      })
      const json = await res.json()
      if (!res.ok) {
        throw new Error(json?.error ?? `HTTP ${res.status}`)
      }
      const errors = (json.errors ?? []) as Array<{
        id: string
        field: string
        error: string
      }>
      const failedKeys = new Set(errors.map((e) => `${e.id}:${e.field}`))
      const errMap = new Map<string, string>()
      for (const e of errors) errMap.set(`${e.id}:${e.field}`, e.error)
      setCellErrors(errMap)
      // Clear successful changes from dirty.
      const nextDirty = new Map(dirtyRef.current)
      for (const c of changes) {
        const k = `${c.id}:${c.field}`
        if (!failedKeys.has(k)) nextDirty.delete(k)
      }
      dirtyRef.current = nextDirty
      if (errors.length === 0) {
        setStatus('saved')
        setStatusMsg(null)
        window.setTimeout(() => {
          setStatus((s) => (s === 'saved' ? 'idle' : s))
        }, 1500)
      } else {
        setStatus('error')
        setStatusMsg(`${errors.length} cell${errors.length === 1 ? '' : 's'} failed to save`)
      }
    } catch (e) {
      setStatus('error')
      setStatusMsg(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const setCell = useCallback(
    (productId: string, field: string, value: unknown) => {
      setRows((prev) =>
        prev.map((r) => {
          if (r.id !== productId) return r
          if (field.startsWith('attr_')) {
            const stripped = field.replace(/^attr_/, '')
            const next: Record<string, unknown> = {
              ...(r.categoryAttributes ?? {}),
            }
            if (value === null || value === undefined || value === '') {
              delete next[stripped]
            } else {
              next[stripped] = value
            }
            return { ...r, categoryAttributes: next }
          }
          return { ...r, [field]: value }
        }),
      )
      dirtyRef.current.set(`${productId}:${field}`, {
        id: productId,
        field,
        value,
      })
      setStatus('saving')
      setStatusMsg(null)
      // Clear any prior error on this cell so the UI reflects the
      // user's retry intent.
      setCellErrors((prev) => {
        if (!prev.has(`${productId}:${field}`)) return prev
        const next = new Map(prev)
        next.delete(`${productId}:${field}`)
        return next
      })
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        void flush()
      }, SAVE_DEBOUNCE_MS)
    },
    [flush],
  )

  // ── Add / delete variant ────────────────────────────────────
  const [addingVariant, setAddingVariant] = useState(false)
  const [draftVariant, setDraftVariant] = useState<{
    sku: string
    name: string
    basePrice: string
    totalStock: string
  }>({ sku: '', name: '', basePrice: '0', totalStock: '0' })

  const handleAddVariant = useCallback(async () => {
    if (!product.isParent) return
    if (!draftVariant.sku.trim() || !draftVariant.name.trim()) {
      setStatus('error')
      setStatusMsg('SKU and name are required for a new variant')
      return
    }
    setStatus('saving')
    setStatusMsg(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/catalog/products/${product.id}/children`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sku: draftVariant.sku.trim(),
            name: draftVariant.name.trim(),
            basePrice: Number(draftVariant.basePrice) || 0,
            totalStock: Number(draftVariant.totalStock) || 0,
          }),
        },
      )
      const json = await res.json()
      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
      }
      const newChild = json.data as Product
      setRows((prev) => [...prev, newChild])
      setAddingVariant(false)
      setDraftVariant({ sku: '', name: '', basePrice: '0', totalStock: '0' })
      setStatus('saved')
      window.setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 1500)
    } catch (e) {
      setStatus('error')
      setStatusMsg(e instanceof Error ? e.message : String(e))
    }
  }, [draftVariant, product.id, product.isParent])

  const handleDeleteVariant = useCallback(async (variantId: string) => {
    if (!window.confirm('Delete this variant? This removes its listings, offers, and image rows. Cannot be undone.')) {
      return
    }
    setStatus('saving')
    setStatusMsg(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/catalog/products/${variantId}`,
        { method: 'DELETE' },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
      }
      setRows((prev) => prev.filter((r) => r.id !== variantId))
      setStatus('saved')
      window.setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 1500)
    } catch (e) {
      setStatus('error')
      setStatusMsg(e instanceof Error ? e.message : String(e))
    }
  }, [])

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => router.push(`/products/${product.id}/edit`)}
              className="p-1 -m-1 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-900"
              aria-label="Back to edit"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-[14px] font-semibold text-slate-900 truncate max-w-[480px]">
                  Bulk edit · {product.name}
                </h1>
                {product.isParent && (
                  <Badge variant="info">{rows.length - 1} variants</Badge>
                )}
                <SavePill status={status} message={statusMsg} />
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5 font-mono">
                {product.sku}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push(`/products/${product.id}/edit`)}
            >
              Done
            </Button>
          </div>
        </div>
        {/* ── Group header band ─────────────────────────────────── */}
        <div className="px-6 pb-2 flex items-center gap-1 flex-wrap">
          {grouped.map((g) => {
            const tone = GROUP_TONE[g.category]
            const open = openGroups.has(g.category)
            return (
              <button
                key={g.category}
                type="button"
                onClick={() => toggleGroup(g.category)}
                className={cn(
                  'inline-flex items-center gap-1 h-6 px-2 text-[11px] border rounded transition-colors',
                  tone.band,
                  tone.text,
                  open ? 'opacity-100' : 'opacity-70 hover:opacity-100',
                )}
                title={`${open ? 'Collapse' : 'Expand'} ${GROUP_LABEL[g.category]}`}
              >
                {open ? (
                  <ChevronRight className="w-3 h-3 rotate-90 transition-transform" />
                ) : (
                  <ChevronRight className="w-3 h-3 transition-transform" />
                )}
                <span className="font-semibold">
                  {GROUP_LABEL[g.category] ?? g.category}
                </span>
                <span className="opacity-60 tabular-nums">
                  {g.fields.length}
                </span>
              </button>
            )
          })}
        </div>
      </header>

      {/* ── Spreadsheet ───────────────────────────────────────── */}
      <main className="flex-1 overflow-auto px-2 pb-8">
        <table className="border-separate border-spacing-0 text-[12px]">
          <thead className="sticky top-0 z-10 bg-white">
            {/* Group band row */}
            <tr>
              <th
                className="sticky left-0 z-20 bg-white border-b border-r border-slate-200 px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500"
                style={{ minWidth: 240 }}
              >
                Variant
              </th>
              {grouped.map((g) => {
                const tone = GROUP_TONE[g.category]
                const open = openGroups.has(g.category)
                const colSpan = open ? g.fields.length : 1
                return (
                  <th
                    key={g.category}
                    colSpan={colSpan}
                    className={cn(
                      'border-b border-r-2 px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide',
                      tone.band,
                      tone.text,
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.category)}
                      className="inline-flex items-center gap-1"
                    >
                      {open ? (
                        <ChevronRight className="w-3 h-3 rotate-90 transition-transform" />
                      ) : (
                        <ChevronRight className="w-3 h-3 transition-transform" />
                      )}
                      {GROUP_LABEL[g.category] ?? g.category}
                      <span className="opacity-60 tabular-nums">
                        {open
                          ? g.fields.length
                          : `${g.fields.length} hidden`}
                      </span>
                    </button>
                  </th>
                )
              })}
              <th
                className="border-b border-l border-slate-200 px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500 bg-white"
                style={{ width: 40 }}
              />
            </tr>
            {/* Field name row */}
            <tr>
              <th
                className="sticky left-0 z-20 bg-white border-b border-r border-slate-200 px-2 py-1 text-left text-[11px] font-medium text-slate-700"
                style={{ minWidth: 240 }}
              >
                <span className="text-slate-400 text-[10px]">SKU · Name</span>
              </th>
              {grouped.flatMap((g) => {
                const tone = GROUP_TONE[g.category]
                const open = openGroups.has(g.category)
                if (!open) {
                  return [
                    <th
                      key={`${g.category}__placeholder`}
                      className={cn(
                        'border-b border-r-2 px-2 py-1 text-left text-[10px] italic text-slate-500',
                        tone.band,
                      )}
                      style={{ width: 80 }}
                    >
                      collapsed
                    </th>,
                  ]
                }
                return g.fields.map((f, i) => (
                  <th
                    key={f.id}
                    className={cn(
                      'border-b px-2 py-1 text-left text-[11px] font-medium text-slate-700',
                      tone.band,
                      i === g.fields.length - 1
                        ? 'border-r-2'
                        : 'border-r border-slate-200',
                    )}
                    style={{ width: f.width ?? 120 }}
                    title={f.helpText ?? f.label}
                  >
                    <div className="truncate">
                      {f.label}
                      {f.required && (
                        <span className="text-rose-600 ml-0.5">*</span>
                      )}
                    </div>
                  </th>
                ))
              })}
              <th
                className="border-b border-l border-slate-200 px-2 py-1 bg-white"
                style={{ width: 40 }}
              />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => {
              const isParent = row.id === product.id
              return (
                <tr key={row.id} className="hover:bg-slate-50/40">
                  <td
                    className={cn(
                      'sticky left-0 z-10 border-b border-r border-slate-200 px-2 py-1 align-top',
                      rowIdx % 2 === 0 ? 'bg-white' : 'bg-slate-50/60',
                    )}
                    style={{ minWidth: 240 }}
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0">
                        <div className="font-mono text-[11px] text-slate-700 truncate">
                          {row.sku}
                        </div>
                        <div className="text-[11px] text-slate-500 truncate">
                          {row.name}
                        </div>
                      </div>
                      {isParent && (
                        <Badge variant="info" mono>
                          parent
                        </Badge>
                      )}
                    </div>
                  </td>
                  {grouped.flatMap((g) => {
                    const tone = GROUP_TONE[g.category]
                    const open = openGroups.has(g.category)
                    if (!open) {
                      // Placeholder cell for the collapsed group.
                      return [
                        <td
                          key={`${row.id}_${g.category}__placeholder`}
                          className={cn(
                            'border-b border-r-2 px-2 py-1 italic text-slate-400 text-[10px] align-top',
                            tone.cell,
                          )}
                          style={{ width: 80 }}
                        >
                          —
                        </td>,
                      ]
                    }
                    return g.fields.map((f, i) => {
                      const isAttr = f.id.startsWith('attr_')
                      const stripped = isAttr ? f.id.replace(/^attr_/, '') : null
                      const rawVal = isAttr
                        ? (row.categoryAttributes as Record<string, unknown> | null)?.[
                            stripped!
                          ]
                        : (row as Record<string, unknown>)[f.id]
                      const cellKey = `${row.id}:${f.id}`
                      const errMsg = cellErrors.get(cellKey)
                      return (
                        <td
                          key={f.id}
                          className={cn(
                            'border-b px-1 py-0.5 align-top',
                            tone.cell,
                            i === g.fields.length - 1
                              ? 'border-r-2'
                              : 'border-r border-slate-200',
                            errMsg && 'ring-1 ring-rose-400',
                          )}
                          style={{ width: f.width ?? 120 }}
                          title={errMsg ?? undefined}
                        >
                          <Cell
                            field={f}
                            value={rawVal}
                            disabled={!f.editable}
                            onCommit={(v) => setCell(row.id, f.id, v)}
                          />
                        </td>
                      )
                    })
                  })}
                  <td
                    className="border-b border-l border-slate-200 px-1 py-0.5 align-top bg-white"
                    style={{ width: 40 }}
                  >
                    {!isParent && (
                      <button
                        type="button"
                        onClick={() => handleDeleteVariant(row.id)}
                        className="text-slate-400 hover:text-rose-600 p-1"
                        aria-label="Delete variant"
                        title="Delete this variant"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
            {/* Add-variant row */}
            {product.isParent && (
              <tr className="bg-emerald-50/40">
                <td
                  colSpan={
                    1 +
                    grouped.reduce(
                      (n, g) =>
                        n + (openGroups.has(g.category) ? g.fields.length : 1),
                      0,
                    ) +
                    1
                  }
                  className="border-b border-slate-200 px-2 py-2"
                >
                  {addingVariant ? (
                    <div className="flex items-center gap-2 flex-wrap">
                      <input
                        type="text"
                        placeholder="SKU"
                        value={draftVariant.sku}
                        onChange={(e) =>
                          setDraftVariant({ ...draftVariant, sku: e.target.value })
                        }
                        className="h-7 px-2 text-[12px] font-mono border border-slate-300 rounded w-40"
                      />
                      <input
                        type="text"
                        placeholder="Name"
                        value={draftVariant.name}
                        onChange={(e) =>
                          setDraftVariant({ ...draftVariant, name: e.target.value })
                        }
                        className="h-7 px-2 text-[12px] border border-slate-300 rounded w-64"
                      />
                      <input
                        type="number"
                        placeholder="Price"
                        value={draftVariant.basePrice}
                        onChange={(e) =>
                          setDraftVariant({
                            ...draftVariant,
                            basePrice: e.target.value,
                          })
                        }
                        className="h-7 px-2 text-[12px] border border-slate-300 rounded w-24"
                      />
                      <input
                        type="number"
                        placeholder="Stock"
                        value={draftVariant.totalStock}
                        onChange={(e) =>
                          setDraftVariant({
                            ...draftVariant,
                            totalStock: e.target.value,
                          })
                        }
                        className="h-7 px-2 text-[12px] border border-slate-300 rounded w-24"
                      />
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={handleAddVariant}
                      >
                        Create
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setAddingVariant(false)
                          setDraftVariant({
                            sku: '',
                            name: '',
                            basePrice: '0',
                            totalStock: '0',
                          })
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setAddingVariant(true)}
                      className="inline-flex items-center gap-1.5 text-[12px] font-medium text-emerald-700 hover:text-emerald-900"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add variant
                    </button>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </main>
    </div>
  )
}

// ── Cell editor ────────────────────────────────────────────────

function Cell({
  field,
  value,
  disabled,
  onCommit,
}: {
  field: FieldDef
  value: unknown
  disabled: boolean
  onCommit: (v: unknown) => void
}) {
  const display =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value)

  if (disabled) {
    return (
      <div className="px-1.5 py-1 text-[12px] text-slate-500 truncate" title={display}>
        {display || '—'}
      </div>
    )
  }

  if (field.type === 'select') {
    return (
      <select
        value={display}
        onChange={(e) => onCommit(e.target.value || null)}
        className="w-full h-6 px-1 text-[12px] border border-transparent hover:border-slate-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-transparent rounded"
      >
        <option value="">—</option>
        {(field.options ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    )
  }

  if (field.type === 'number') {
    return (
      <input
        type="text"
        defaultValue={display}
        onBlur={(e) => {
          const raw = e.target.value
          if (raw === '') {
            onCommit(null)
          } else {
            const n = Number(raw.replace(',', '.'))
            if (!Number.isNaN(n)) onCommit(n)
            else onCommit(raw)
          }
        }}
        className="w-full h-6 px-1 text-[12px] tabular-nums border border-transparent hover:border-slate-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-transparent rounded"
      />
    )
  }

  if (field.type === 'boolean') {
    const v = value === true || value === 'true'
    return (
      <input
        type="checkbox"
        checked={v}
        onChange={(e) => onCommit(e.target.checked)}
        className="ml-1 w-3.5 h-3.5"
      />
    )
  }

  // text
  return (
    <input
      type="text"
      defaultValue={display}
      onBlur={(e) => onCommit(e.target.value === '' ? null : e.target.value)}
      className="w-full h-6 px-1 text-[12px] border border-transparent hover:border-slate-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-transparent rounded"
    />
  )
}

function SavePill({
  status,
  message,
}: {
  status: SaveStatus
  message: string | null
}) {
  if (status === 'idle') return null
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded border',
        status === 'saving' && 'border-slate-200 text-slate-600 bg-slate-50',
        status === 'saved' && 'border-emerald-200 text-emerald-700 bg-emerald-50',
        status === 'error' && 'border-rose-200 text-rose-700 bg-rose-50',
      )}
    >
      {status === 'saving' && <Loader2 className="w-3 h-3 animate-spin" />}
      {status === 'saved' && <CheckCircle2 className="w-3 h-3" />}
      {status === 'error' && <AlertCircle className="w-3 h-3" />}
      {status === 'saving' && 'Saving…'}
      {status === 'saved' && 'Saved'}
      {status === 'error' && (message ?? 'Save failed')}
    </span>
  )
}
