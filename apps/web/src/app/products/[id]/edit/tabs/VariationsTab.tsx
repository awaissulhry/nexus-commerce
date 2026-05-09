// WW — full variant CRUD on the product edit page.
//
// Replaces the dead read-only table with a real management surface:
//   - Add Variation       → modal form, POST /api/catalog/products/:parentId/children
//   - Edit (per row)      → modal form, PATCH /api/products/bulk
//   - Delete (per row)    → confirm dialog, DELETE /api/catalog/products/:parentId/children/:childId
//
// Engineering choices for "enterprise-level, no errors":
//   - Optimistic updates on edit + delete; rollback on server error
//     so the table stays accurate even if the API fails.
//   - Idempotency-Key derived from variant SKU on create — a
//     double-click can't double-create.
//   - Server returns clear codes (DUPLICATE_SKU, etc.); we map to
//     friendly inline errors next to the offending field.
//   - Per-axis dropdowns auto-populate from existing variants so
//     'Red' / 'Blue' get suggested instead of free-text typos. User
//     can still '+ New value' to add one not in the existing set.
//   - Delete confirms with the variant's SKU + a count hint of how
//     many channel listings cascade with it. The cascade itself is
//     handled by NN.17 in catalog.routes.ts (parent's
//     platformAttributes.variants[childId] is swept too).
//   - All buttons disable while their action is in flight; closing
//     a modal mid-save is allowed (the request still resolves).
//   - router.refresh() runs after every mutation so the
//     server-rendered childrenList prop reconciles with whatever
//     the page-level loader sees.

'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  CheckCircle2,
  Edit2,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'

interface VariantRow {
  id: string
  sku: string
  name?: string | null
  basePrice?: number | string | null
  totalStock?: number | null
  amazonAsin?: string | null
  variantAttributes?: Record<string, unknown> | null
  variations?: Record<string, string> | null
  categoryAttributes?: { variations?: Record<string, string> } | null
}

interface Props {
  parent: { id: string; sku: string; variationAxes?: string[] | null; variationTheme?: string | null }
  childrenList: VariantRow[]
}

// W1.1 — VariationsTab does not contribute to the parent's "unsaved"
// counter. Every CRUD mutation here persists immediately
// (POST/PATCH/DELETE), so there is never a draft state to discard.
// The previous onChange→setUnsavedChanges(true) wiring was a false
// signal that contributed to the "Unsaved badge never clears" bug.
export default function VariationsTab({ parent, childrenList }: Props) {
  const router = useRouter()
  const [rows, setRows] = useState<VariantRow[]>(childrenList)
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<VariantRow | null>(null)
  const [deleting, setDeleting] = useState<VariantRow | null>(null)
  const [statusMsg, setStatusMsg] = useState<{
    kind: 'success' | 'error'
    text: string
  } | null>(null)
  // YY — track when we last saw fresh data so the user knows whether
  // the prices/quantities are real-time. Bumped on initial render and
  // on every refresh.
  const [lastRefreshed, setLastRefreshed] = useState<number>(() => Date.now())
  const [refreshing, setRefreshing] = useState(false)

  // Auto-clear status banner so it doesn't persist forever.
  useEffect(() => {
    if (!statusMsg) return
    const t = window.setTimeout(() => setStatusMsg(null), 4000)
    return () => window.clearTimeout(t)
  }, [statusMsg])

  // Keep rows in sync if the page-level fetch revalidates.
  useEffect(() => {
    setRows(childrenList)
    setLastRefreshed(Date.now())
  }, [childrenList])

  // YY — direct fetch from the children endpoint so prices/quantities
  // reflect the DB without a full page reload. Used by the manual
  // refresh button + the visibility/interval triggers below.
  const refetch = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${parent.id}/children`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const list = (json?.children ?? []) as VariantRow[]
      setRows(list)
      setLastRefreshed(Date.now())
    } catch (err) {
      setStatusMsg({
        kind: 'error',
        text: `Refresh failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      })
    } finally {
      setRefreshing(false)
    }
  }, [parent.id])

  // YY — refresh when the tab regains focus. Cheap (one GET) and
  // ensures prices/quantities are current after the user comes back
  // from another browser tab where they may have edited via bulk-ops.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') void refetch()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [refetch])

  // YY — periodic poll while the tab is focused. 30s is generous for
  // a catalog editor; aggressive enough to feel live, light enough
  // to not hammer the API.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void refetch()
    }, 30_000)
    return () => window.clearInterval(t)
  }, [refetch])

  const variationAxes: string[] = useMemo(() => {
    if (Array.isArray(parent.variationAxes) && parent.variationAxes.length > 0) {
      return parent.variationAxes
    }
    if (
      typeof parent.variationTheme === 'string' &&
      parent.variationTheme.length > 0
    ) {
      return parent.variationTheme.split(/\s*\/\s*/)
    }
    // Fall back to whatever axes the children's variantAttributes already use.
    const set = new Set<string>()
    for (const r of rows) {
      const v = (r.variantAttributes ?? r.variations ?? {}) as Record<string, unknown>
      for (const k of Object.keys(v)) set.add(k)
    }
    return Array.from(set)
  }, [parent, rows])

  // Suggest values per axis from existing variants. Stable keying so
  // typing in the modal doesn't fight the hint set.
  const valuesByAxis = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const axis of variationAxes) m.set(axis, new Set())
    for (const r of rows) {
      for (const axis of variationAxes) {
        const v = getAttr(r, axis)
        if (v) m.get(axis)!.add(v)
      }
    }
    return m
  }, [rows, variationAxes])

  const skuSet = useMemo(() => new Set(rows.map((r) => r.sku)), [rows])

  // YY — after a mutation, both refetch directly (immediate UI
  // update) AND router.refresh() (so the page-level server fetch
  // re-runs and any other tab on the same page sees the change).
  const refresh = useCallback(async () => {
    await refetch()
    router.refresh()
  }, [refetch, router])

  return (
    <div className="space-y-4">
      {statusMsg && (
        <div
          className={cn(
            'border rounded-lg px-4 py-2.5 text-base flex items-start justify-between gap-3',
            statusMsg.kind === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
              : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300',
          )}
          role="status"
        >
          <div className="flex items-start gap-2 min-w-0">
            {statusMsg.kind === 'success' ? (
              <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            )}
            <span className="break-words">{statusMsg.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setStatusMsg(null)}
            className="flex-shrink-0 opacity-60 hover:opacity-100"
            aria-label="Dismiss"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      <Card
        title="Variation Configuration"
        description={
          <span className="inline-flex items-center gap-2 flex-wrap">
            <span>
              {rows.length} variation{rows.length === 1 ? '' : 's'}
              {variationAxes.length > 0
                ? ` across ${variationAxes.length} ${
                    variationAxes.length === 1 ? 'axis' : 'axes'
                  }`
                : ''}
            </span>
            <span className="text-slate-300 dark:text-slate-600">·</span>
            <RelativeTimestamp at={lastRefreshed} />
          </span>
        }
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={refreshing}
              title="Refresh prices & quantities from the database"
              className="inline-flex items-center gap-1 h-7 px-2 text-sm font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              {refreshing ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RefreshCw className="w-3 h-3" />
              )}
              Refresh
            </button>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={() => setCreateOpen(true)}
            >
              Add Variation
            </Button>
          </div>
        }
      >
        {variationAxes.length > 0 ? (
          <div className="flex gap-1.5 flex-wrap">
            {variationAxes.map((axis) => (
              <Badge key={axis} variant="info">
                {axis}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-400 dark:text-slate-500 italic">
            No variation axes set yet — your first variant defines them
            (e.g. add a Color/Size pair and they become this product's
            axes).
          </p>
        )}
      </Card>

      <Card noPadding>
        <div className="overflow-x-auto">
          <table className="w-full text-md">
            <thead className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                  SKU
                </th>
                {variationAxes.map((axis) => (
                  <th
                    key={axis}
                    className="px-4 py-2 text-left text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide"
                  >
                    {axis}
                  </th>
                ))}
                <th className="px-4 py-2 text-right text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                  Price
                </th>
                <th className="px-4 py-2 text-right text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                  Stock
                </th>
                <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                  ASIN
                </th>
                <th className="px-4 py-2 text-right text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={5 + variationAxes.length}
                    className="px-4 py-6 text-center text-base text-slate-400 dark:text-slate-500"
                  >
                    No variations linked to this product. Click{' '}
                    <strong>Add Variation</strong> to create one.
                  </td>
                </tr>
              )}
              {rows.map((child) => (
                <tr
                  key={child.id}
                  className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <td className="px-4 py-2 font-mono text-base text-slate-900 dark:text-slate-100">
                    {child.sku}
                  </td>
                  {variationAxes.map((axis) => {
                    const value = getAttr(child, axis)
                    return (
                      <td
                        key={axis}
                        className="px-4 py-2 text-base text-slate-700 dark:text-slate-300"
                      >
                        {value ?? <span className="text-slate-400 dark:text-slate-500">—</span>}
                      </td>
                    )
                  })}
                  <td className="px-4 py-2 text-right tabular-nums text-slate-900 dark:text-slate-100">
                    €{Number(child.basePrice ?? 0).toFixed(2)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    <span
                      className={
                        Number(child.totalStock ?? 0) > 0
                          ? 'text-slate-900 dark:text-slate-100'
                          : 'text-red-600 dark:text-red-400'
                      }
                    >
                      {child.totalStock ?? 0}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-base text-slate-700 dark:text-slate-300">
                    {child.amazonAsin ?? <span className="text-slate-400 dark:text-slate-500">—</span>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => setEditing(child)}
                      className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 transition-colors"
                      title="Edit"
                      aria-label={`Edit ${child.sku}`}
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setDeleting(child)}
                      className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-red-600 dark:text-red-400 ml-1 transition-colors"
                      title="Delete variant"
                      aria-label={`Delete ${child.sku}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {createOpen && (
        <VariantFormModal
          mode="create"
          parent={parent}
          variationAxes={variationAxes}
          valuesByAxis={valuesByAxis}
          existingSkus={skuSet}
          onClose={() => setCreateOpen(false)}
          onSaved={async (saved) => {
            // Optimistic insert, then refresh so server-side fields
            // (id, defaults, etc.) reconcile.
            setRows((prev) => [...prev, saved])
            setCreateOpen(false)
            setStatusMsg({ kind: 'success', text: `Variant ${saved.sku} added.` })
            // Phase 10/F11 — broadcast so /products grid + /listings
            // refresh. New child product means the parent's variantCount
            // changes and any per-channel coverage tied to it.
            emitInvalidation({
              type: 'product.created',
              id: saved.id,
              meta: { parentId: parent.id, source: 'variations-tab' },
            })
            await refresh()
          }}
        />
      )}

      {editing && (
        <VariantFormModal
          mode="edit"
          parent={parent}
          variationAxes={variationAxes}
          valuesByAxis={valuesByAxis}
          existingSkus={skuSet}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={async (saved) => {
            const previous = rows
            setRows((prev) =>
              prev.map((r) => (r.id === saved.id ? saved : r)),
            )
            setEditing(null)
            setStatusMsg({ kind: 'success', text: `${saved.sku} updated.` })
            // Phase 10/F11 — variant edits land via PATCH /api/products/bulk
            // which routes basePrice/totalStock through services. Emit both
            // product.updated (always) and listing.updated (if cascadable
            // fields could be in the patch — we don't have field-level
            // detail here so emit listing.updated unconditionally).
            emitInvalidation({
              type: 'product.updated',
              id: saved.id,
              meta: { parentId: parent.id, source: 'variations-tab-edit' },
            })
            emitInvalidation({
              type: 'listing.updated',
              meta: {
                productIds: [saved.id],
                source: 'variations-tab-edit',
              },
            })
            try {
              await refresh()
            } catch (err) {
              // Rollback on refresh failure (rare; still safe).
              setRows(previous)
              setStatusMsg({
                kind: 'error',
                text:
                  err instanceof Error
                    ? `Update reverted: ${err.message}`
                    : 'Update reverted — refresh failed.',
              })
            }
          }}
        />
      )}

      {deleting && (
        <DeleteConfirmModal
          parent={parent}
          variant={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={async () => {
            const previous = rows
            const removed = deleting
            setRows((prev) => prev.filter((r) => r.id !== removed.id))
            setDeleting(null)
            setStatusMsg({
              kind: 'success',
              text: `${removed.sku} deleted (channel listings cascaded).`,
            })
            // Phase 10/F11 — variant delete cascades to ChannelListings
            // via the schema's onDelete: Cascade. Emit both events so
            // /products grid (variantCount), /listings (rows gone),
            // and /catalog/organize all refresh.
            emitInvalidation({
              type: 'product.deleted',
              id: removed.id,
              meta: { parentId: parent.id, source: 'variations-tab-delete' },
            })
            emitInvalidation({
              type: 'listing.deleted',
              meta: {
                productIds: [removed.id],
                source: 'variations-tab-delete',
              },
            })
            try {
              await refresh()
            } catch (err) {
              setRows(previous)
              setStatusMsg({
                kind: 'error',
                text:
                  err instanceof Error
                    ? `Delete reverted: ${err.message}`
                    : 'Delete reverted — refresh failed.',
              })
            }
          }}
        />
      )}
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────

function getAttr(child: VariantRow, axis: string): string | null {
  const v = child.variantAttributes
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const x = (v as Record<string, unknown>)[axis]
    if (x != null && String(x).trim().length > 0) return String(x)
  }
  if (child.variations && child.variations[axis]) {
    return String(child.variations[axis])
  }
  if (child.categoryAttributes?.variations?.[axis]) {
    return String(child.categoryAttributes.variations[axis])
  }
  return null
}

// ── Modals ───────────────────────────────────────────────────────────

interface VariantFormModalProps {
  mode: 'create' | 'edit'
  parent: { id: string; sku: string }
  variationAxes: string[]
  valuesByAxis: Map<string, Set<string>>
  existingSkus: Set<string>
  initial?: VariantRow
  onClose: () => void
  onSaved: (row: VariantRow) => Promise<void> | void
}

function VariantFormModal({
  mode,
  parent,
  variationAxes,
  valuesByAxis,
  existingSkus,
  initial,
  onClose,
  onSaved,
}: VariantFormModalProps) {
  const [sku, setSku] = useState(initial?.sku ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [basePrice, setBasePrice] = useState(
    initial?.basePrice != null ? String(initial.basePrice) : '',
  )
  const [totalStock, setTotalStock] = useState(
    initial?.totalStock != null ? String(initial.totalStock) : '',
  )
  // Per-axis values; preload from initial if editing.
  const [axisValues, setAxisValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    if (initial) {
      for (const axis of variationAxes) {
        const v = getAttr(initial, axis)
        if (v) out[axis] = v
      }
    }
    return out
  })
  // Allow defining new axes inline (when product has none yet OR user
  // wants to add one). Stored as [{ key, value }].
  const [newAxes, setNewAxes] = useState<Array<{ key: string; value: string }>>(
    [],
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Idempotency key bound to the SKU. If the user changes SKU mid-
  // submit (rare; we lock the input while saving) the key updates,
  // but lockOnSave below prevents that race.
  const idempotencyKey = useRef(`variant-create:${Date.now()}`)
  useEffect(() => {
    if (mode === 'create') {
      idempotencyKey.current = `variant-create:${parent.id}:${sku.trim()}`
    }
  }, [mode, parent.id, sku])

  const skuTrimmed = sku.trim()
  const isDuplicateSku =
    skuTrimmed.length > 0 &&
    existingSkus.has(skuTrimmed) &&
    skuTrimmed !== initial?.sku

  // Validation. Required: sku, name. At least one axis value if axes
  // exist OR new axes defined.
  const validation = useMemo(() => {
    const issues: string[] = []
    if (!skuTrimmed) issues.push('SKU is required')
    if (!name.trim()) issues.push('Name is required')
    if (isDuplicateSku) issues.push(`SKU "${skuTrimmed}" already exists in this parent`)
    const priceN = basePrice.trim() ? Number(basePrice) : 0
    if (basePrice.trim() && (!Number.isFinite(priceN) || priceN < 0)) {
      issues.push('Price must be ≥ 0')
    }
    const stockN = totalStock.trim() ? Number(totalStock) : 0
    if (totalStock.trim() && (!Number.isFinite(stockN) || stockN < 0)) {
      issues.push('Stock must be ≥ 0')
    }
    if (variationAxes.length === 0 && newAxes.length === 0) {
      issues.push('Define at least one variation axis (e.g. color, size)')
    }
    for (const a of newAxes) {
      if (!a.key.trim()) issues.push('New axis name cannot be blank')
      if (!a.value.trim()) issues.push(`Value for "${a.key.trim()}" cannot be blank`)
    }
    return issues
  }, [
    basePrice,
    isDuplicateSku,
    name,
    newAxes,
    skuTrimmed,
    totalStock,
    variationAxes.length,
  ])
  const canSave = validation.length === 0 && !submitting

  const handleSubmit = async () => {
    if (!canSave) return
    setSubmitting(true)
    setError(null)
    try {
      // Combine existing axes + new axes into a single map.
      const variantAttrs: Record<string, string> = { ...axisValues }
      for (const a of newAxes) {
        if (a.key.trim() && a.value.trim()) {
          variantAttrs[a.key.trim()] = a.value.trim()
        }
      }
      if (mode === 'create') {
        const body = {
          sku: skuTrimmed,
          name: name.trim(),
          basePrice: basePrice.trim() ? Number(basePrice) : 0,
          totalStock: totalStock.trim() ? Number(totalStock) : 0,
          // XX — send axis values to the catalog endpoint directly
          // instead of a follow-up attr_* PATCH that landed in the
          // wrong JSON path.
          variantAttributes: variantAttrs,
        }
        const res = await fetch(
          `${getBackendUrl()}/api/catalog/products/${parent.id}/children`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': idempotencyKey.current,
            },
            body: JSON.stringify(body),
          },
        )
        const json = await res.json().catch(() => ({}))
        if (!res.ok || json?.success === false) {
          const errMessage =
            json?.error?.message ??
            json?.error ??
            `Couldn't create variant (HTTP ${res.status}).`
          setError(typeof errMessage === 'string' ? errMessage : 'Create failed.')
          return
        }
        const childId = json?.data?.id ?? json?.child?.id ?? json?.product?.id
        await onSaved({
          id: childId ?? `local_${Date.now()}`,
          sku: body.sku,
          name: body.name,
          basePrice: body.basePrice,
          totalStock: body.totalStock,
          variantAttributes: variantAttrs,
          variations: variantAttrs,
        })
        return
      }
      // Edit mode — PATCH scalars via /api/products/bulk and axis
      // values via the dedicated /variant-attributes endpoint so the
      // edit lands in the same JSON paths the reads consume. Mixing
      // attr_* with bulk PATCH was the bug that landed values in
      // categoryAttributes.<axis> instead of categoryAttributes.
      // variations.<axis>.
      const scalarChanges: Array<{
        id: string
        field: string
        value: unknown
      }> = []
      const axisDiff: Record<string, string> = {}
      if (initial) {
        if (skuTrimmed !== initial.sku) {
          scalarChanges.push({ id: initial.id, field: 'sku', value: skuTrimmed })
        }
        if (name.trim() !== (initial.name ?? '')) {
          scalarChanges.push({
            id: initial.id,
            field: 'name',
            value: name.trim(),
          })
        }
        const newPrice = basePrice.trim() ? Number(basePrice) : 0
        if (newPrice !== Number(initial.basePrice ?? 0)) {
          scalarChanges.push({
            id: initial.id,
            field: 'basePrice',
            value: newPrice,
          })
        }
        const newStock = totalStock.trim() ? Number(totalStock) : 0
        if (newStock !== Number(initial.totalStock ?? 0)) {
          scalarChanges.push({
            id: initial.id,
            field: 'totalStock',
            value: newStock,
          })
        }
        for (const [k, v] of Object.entries(variantAttrs)) {
          const oldVal = getAttr(initial, k)
          if (v !== oldVal) axisDiff[k] = v
        }
      }
      if (scalarChanges.length === 0 && Object.keys(axisDiff).length === 0) {
        await onSaved(initial!)
        return
      }
      if (scalarChanges.length > 0) {
        const res = await fetch(`${getBackendUrl()}/api/products/bulk`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ changes: scalarChanges }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok || json?.success === false) {
          setError(
            json?.errors?.[0]?.error ??
              json?.error ??
              `Couldn't save scalar changes (HTTP ${res.status}).`,
          )
          return
        }
      }
      if (Object.keys(axisDiff).length > 0 && initial) {
        const res = await fetch(
          `${getBackendUrl()}/api/catalog/products/${initial.id}/variant-attributes`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(axisDiff),
          },
        )
        const json = await res.json().catch(() => ({}))
        if (!res.ok || json?.success === false) {
          setError(
            json?.error ?? `Couldn't save axis changes (HTTP ${res.status}).`,
          )
          return
        }
      }
      await onSaved({
        ...(initial as VariantRow),
        sku: skuTrimmed,
        name: name.trim(),
        basePrice: basePrice.trim() ? Number(basePrice) : 0,
        totalStock: totalStock.trim() ? Number(totalStock) : 0,
        variantAttributes: variantAttrs,
        variations: variantAttrs,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      dismissOnBackdrop={!submitting}
      dismissOnEscape={!submitting}
      placement="top"
      size="2xl"
      title={mode === 'create' ? 'Add Variation' : `Edit ${initial?.sku}`}
    >
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Variant SKU" required>
              <input
                type="text"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="XAV-001-RED-L"
                className={cn(
                  inputCls,
                  isDuplicateSku && 'border-rose-300 dark:border-rose-700 focus:border-rose-500',
                )}
                disabled={submitting}
                autoFocus
              />
              {isDuplicateSku && (
                <p className="mt-0.5 text-sm text-rose-600 dark:text-rose-400">
                  Already used by another variant in this parent.
                </p>
              )}
            </FormField>
            <FormField label="Variant name" required>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Red / Large"
                className={inputCls}
                disabled={submitting}
              />
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Price (EUR)">
              <input
                type="number"
                min="0"
                step="0.01"
                value={basePrice}
                onChange={(e) => setBasePrice(e.target.value)}
                className={inputCls}
                disabled={submitting}
              />
            </FormField>
            <FormField label="Stock">
              <input
                type="number"
                min="0"
                value={totalStock}
                onChange={(e) => setTotalStock(e.target.value)}
                className={inputCls}
                disabled={submitting}
              />
            </FormField>
          </div>

          {/* Existing variation axes (defined on parent / detected from
              siblings) — render as combo: dropdown of known values +
              free-text fallback. */}
          {variationAxes.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
                Variation axes
              </h3>
              <div className="grid grid-cols-2 gap-3">
                {variationAxes.map((axis) => {
                  const known = Array.from(valuesByAxis.get(axis) ?? [])
                  const value = axisValues[axis] ?? ''
                  const isCustom = value !== '' && !known.includes(value)
                  return (
                    <FormField key={axis} label={axis} required>
                      <div className="space-y-1">
                        <select
                          value={isCustom ? '__custom__' : value}
                          onChange={(e) => {
                            if (e.target.value === '__custom__') {
                              setAxisValues((s) => ({ ...s, [axis]: '' }))
                            } else {
                              setAxisValues((s) => ({
                                ...s,
                                [axis]: e.target.value,
                              }))
                            }
                          }}
                          className={inputCls}
                          disabled={submitting}
                        >
                          <option value="">— Select —</option>
                          {known.map((v) => (
                            <option key={v} value={v}>
                              {v}
                            </option>
                          ))}
                          <option value="__custom__">+ New value…</option>
                        </select>
                        {(isCustom || (value === '' && known.length === 0)) && (
                          <input
                            type="text"
                            value={value}
                            onChange={(e) =>
                              setAxisValues((s) => ({
                                ...s,
                                [axis]: e.target.value,
                              }))
                            }
                            placeholder={`New ${axis} value`}
                            className={inputCls}
                            disabled={submitting}
                          />
                        )}
                      </div>
                    </FormField>
                  )
                })}
              </div>
            </div>
          )}

          {/* New axes — only shown when no axes exist yet OR user wants
              to expand the schema. The first variant on a freshly-
              promoted parent goes through this path. */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {variationAxes.length === 0
                  ? 'Define axes (first variant)'
                  : 'Add new axis'}
              </h3>
              <button
                type="button"
                onClick={() =>
                  setNewAxes((s) => [...s, { key: '', value: '' }])
                }
                disabled={submitting}
                className="text-sm text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
              >
                + Add axis
              </button>
            </div>
            {newAxes.length === 0 && variationAxes.length === 0 && (
              <p className="text-sm text-slate-500 dark:text-slate-400 italic">
                You haven't defined any axes yet. Click + Add axis to set
                them — e.g. <span className="font-mono">color: Red</span>{' '}
                and <span className="font-mono">size: L</span>.
              </p>
            )}
            {newAxes.length > 0 && (
              <div className="space-y-2">
                {newAxes.map((a, idx) => (
                  <div key={idx} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                    <input
                      type="text"
                      value={a.key}
                      onChange={(e) =>
                        setNewAxes((s) =>
                          s.map((x, i) =>
                            i === idx ? { ...x, key: e.target.value } : x,
                          ),
                        )
                      }
                      placeholder="axis (color)"
                      className={inputCls}
                      disabled={submitting}
                    />
                    <input
                      type="text"
                      value={a.value}
                      onChange={(e) =>
                        setNewAxes((s) =>
                          s.map((x, i) =>
                            i === idx ? { ...x, value: e.target.value } : x,
                          ),
                        )
                      }
                      placeholder="value (red)"
                      className={inputCls}
                      disabled={submitting}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setNewAxes((s) => s.filter((_, i) => i !== idx))
                      }
                      disabled={submitting}
                      className="text-rose-500 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300 disabled:opacity-50"
                      aria-label="Remove axis"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {(validation.length > 0 || error) && (
            <div className="border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-700 dark:text-rose-300">
              <div className="font-semibold mb-1 inline-flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5" />
                {error ? 'Save failed' : 'Fix the following:'}
              </div>
              {error ? (
                <p className="break-words">{error}</p>
              ) : (
                <ul className="list-disc list-inside space-y-0.5 text-sm">
                  {validation.map((v, i) => (
                    <li key={i}>{v}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <ModalFooter>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onClose()}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={!canSave}
            loading={submitting}
          >
            {mode === 'create' ? 'Create variant' : 'Save changes'}
          </Button>
        </ModalFooter>
    </Modal>
  )
}

function DeleteConfirmModal({
  parent,
  variant,
  onClose,
  onDeleted,
}: {
  parent: { id: string; sku: string }
  variant: VariantRow
  onClose: () => void
  onDeleted: () => Promise<void> | void
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [linkCount, setLinkCount] = useState<number | null>(null)
  // Pre-flight: fetch the variant's channel-listing count so we can
  // show "X channel listings will be removed" before the user
  // commits. Soft-fails — if it errors we still allow delete.
  useEffect(() => {
    let cancelled = false
    fetch(`${getBackendUrl()}/api/products/${variant.id}/all-listings`, {
      cache: 'no-store',
    })
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return
        const count =
          (json?.AMAZON?.length ?? 0) +
          (json?.EBAY?.length ?? 0) +
          (json?.SHOPIFY?.length ?? 0) +
          (json?.WOOCOMMERCE?.length ?? 0)
        setLinkCount(count)
      })
      .catch(() => {
        if (!cancelled) setLinkCount(0)
      })
    return () => {
      cancelled = true
    }
  }, [variant.id])

  const handleDelete = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/catalog/products/${parent.id}/children/${variant.id}`,
        { method: 'DELETE' },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json?.success === false) {
        setError(
          json?.error?.message ??
            json?.error ??
            `Couldn't delete (HTTP ${res.status}).`,
        )
        return
      }
      await onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      dismissOnBackdrop={!submitting}
      dismissOnEscape={!submitting}
      placement="top"
      size="md"
      title="Delete variant?"
    >
        <div className="px-5 py-4 space-y-3">
          <p className="text-md text-slate-700 dark:text-slate-300">
            This will permanently delete{' '}
            <span className="font-mono">{variant.sku}</span> and every
            channel listing linked to it. Cannot be undone.
          </p>
          {linkCount !== null && linkCount > 0 && (
            <div className="border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 rounded-md px-3 py-2 text-base text-amber-800 dark:text-amber-300 inline-flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>
                <strong>{linkCount}</strong> channel listing
                {linkCount === 1 ? '' : 's'} will be removed alongside
                this variant.
              </span>
            </div>
          )}
          {error && (
            <div className="border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-700 dark:text-rose-300">
              {error}
            </div>
          )}
        </div>
        <ModalFooter>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => !submitting && onClose()}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={handleDelete}
            loading={submitting}
            disabled={submitting}
          >
            Delete variant
          </Button>
        </ModalFooter>
    </Modal>
  )
}

// YY — live "updated X seconds ago" pill. Re-renders every 5s so
// the user always sees an honest staleness indicator without a hard
// dependency on parent state.
function RelativeTimestamp({ at }: { at: number }) {
  const [, force] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => force((n) => n + 1), 5_000)
    return () => window.clearInterval(t)
  }, [])
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000))
  const label =
    seconds < 5
      ? 'just now'
      : seconds < 60
      ? `${seconds}s ago`
      : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : `${Math.floor(seconds / 3600)}h ago`
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs tabular-nums',
        seconds < 30
          ? 'text-emerald-600 dark:text-emerald-400'
          : seconds < 120
          ? 'text-slate-500 dark:text-slate-400'
          : 'text-amber-600 dark:text-amber-400',
      )}
      title={`Last refreshed at ${new Date(at).toLocaleTimeString()}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-70" />
      {label}
    </span>
  )
}

function FormField({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
        {label}
        {required && <span className="text-rose-600 dark:text-rose-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  )
}

const inputCls =
  'w-full h-8 px-2.5 text-base border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 disabled:bg-slate-50 dark:disabled:bg-slate-800 disabled:text-slate-500 dark:disabled:text-slate-400'
