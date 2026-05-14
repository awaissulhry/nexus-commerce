'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  AlertCircle,
  Check,
  ChevronRight,
  Loader2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import { VirtualizedGrid } from '@/app/products/_components/GridView'
import { usePolledList } from '@/lib/sync/use-polled-list'
import { getBackendUrl } from '@/lib/backend-url'
import { DENSITY_CELL_CLASS } from '@/lib/theme'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import type { ProductRow } from '@/app/products/_types'
import type { ColumnDef } from '@/app/products/_columns'

// ─── column set ─────────────────────────────────────────────────────
const ORGANIZE_COLUMNS: ColumnDef[] = [
  { key: 'product',     label: 'Product',  subLabel: 'ASIN | SKU', width: 380, locked: true },
  { key: 'productType', label: 'Type',     width: 120 },
  { key: 'brand',       label: 'Brand',    width: 120 },
  { key: 'variants',    label: 'Var.',     width: 70 },
  { key: 'coverage',    label: 'Channels', width: 180 },
  { key: 'actions',     label: '',         width: 140, locked: true },
]

// ─── types ───────────────────────────────────────────────────────────
type RoleFilter = 'all' | 'parents' | 'standalone'

export interface StagedChange {
  id: string
  product: ProductRow
  targetParent: ProductRow
  /** Axis → value map, e.g. { Taglia: 'M', Colore: 'Nero' } */
  attributes: Record<string, string>
}

interface PendingDrop {
  product: ProductRow
  targetParent: ProductRow
}

// ─── main component ──────────────────────────────────────────────────
export default function OrganizeGridTab({
  onStatus,
}: {
  onStatus: (s: { kind: 'success' | 'error'; text: string }) => void
}) {
  const { toast } = useToast()

  // ── data ──────────────────────────────────────────────────────────
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  const [childrenByParent, setChildrenByParent] = useState<Record<string, ProductRow[]>>({})
  const [loadingChildren, setLoadingChildren] = useState<Set<string>>(new Set())

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search), 250)
    return () => window.clearTimeout(t)
  }, [search])

  const url = useMemo(() => {
    const qs = new URLSearchParams({ limit: '500', includeCoverage: 'true', includeTags: 'true', sort: 'updated' })
    if (debouncedSearch.trim()) qs.set('search', debouncedSearch.trim())
    return `/api/products?${qs.toString()}`
  }, [debouncedSearch])

  const { data, loading, error, refetch } = usePolledList<{ products: ProductRow[]; total: number }>({
    url,
    intervalMs: 30_000,
    invalidationTypes: ['pim.changed', 'product.created', 'product.deleted', 'product.updated'],
  })

  useEffect(() => {
    if (error) onStatus({ kind: 'error', text: `Couldn't load products: ${error}` })
  }, [error, onStatus])

  const prevProductsRef = useRef<ProductRow[]>([])
  useEffect(() => {
    if (data?.products && data.products !== prevProductsRef.current) {
      prevProductsRef.current = data.products
      setChildrenByParent({})
    }
  }, [data?.products])

  const allProducts = data?.products ?? []

  const products = useMemo(() => {
    if (roleFilter === 'parents') return allProducts.filter((p) => p.isParent)
    if (roleFilter === 'standalone') return allProducts.filter((p) => !p.isParent && !p.parentId)
    return allProducts
  }, [allProducts, roleFilter])

  // ── children lazy-load ────────────────────────────────────────────
  const fetchChildrenFor = useCallback(async (parentId: string) => {
    if (childrenByParent[parentId]) return
    setLoadingChildren((prev) => { const n = new Set(prev); n.add(parentId); return n })
    try {
      const qs = new URLSearchParams({ parentId, limit: '200', includeCoverage: 'true', includeTags: 'true' })
      const res = await fetch(`${getBackendUrl()}/api/products?${qs.toString()}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`${res.status}`)
      const json = await res.json()
      setChildrenByParent((prev) => ({ ...prev, [parentId]: json.products ?? [] }))
    } catch {
      setChildrenByParent((prev) => ({ ...prev, [parentId]: [] }))
    } finally {
      setLoadingChildren((prev) => { const n = new Set(prev); n.delete(parentId); return n })
    }
  }, [childrenByParent])

  const toggleExpand = useCallback((parentId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev)
      if (next.has(parentId)) {
        next.delete(parentId)
      } else {
        next.add(parentId)
        void fetchChildrenFor(parentId)
      }
      return next
    })
  }, [fetchChildrenFor])

  // ── selection ─────────────────────────────────────────────────────
  const toggleSelect = useCallback((id: string, _shiftKey: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === products.length ? new Set() : new Set(products.map((p) => p.id))
    )
  }, [products])

  const allSelected = products.length > 0 && selected.size === products.length

  const onChanged = useCallback(() => { void refetch() }, [refetch])

  // ── DnD state ─────────────────────────────────────────────────────
  const [activeProduct, setActiveProduct] = useState<ProductRow | null>(null)
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null)
  const [stagedChanges, setStagedChanges] = useState<StagedChange[]>([])
  const [reviewOpen, setReviewOpen] = useState(false)
  const [publishing, setPublishing] = useState(false)

  const stagedProductIds = useMemo(
    () => new Set(stagedChanges.map((c) => c.product.id)),
    [stagedChanges],
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  )

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const product = event.active.data.current?.product as ProductRow | undefined
    setActiveProduct(product ?? null)
  }, [])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveProduct(null)
    const { active, over } = event
    if (!over) return

    const dragged = active.data.current?.product as ProductRow | undefined
    const target = over.data.current?.product as ProductRow | undefined
    if (!dragged || !target) return

    // Validation
    if (dragged.id === target.id) return
    if (!target.isParent) return
    // Already a child of this parent
    if (dragged.parentId === target.id) return
    // Already staged to this parent
    if (stagedChanges.some((c) => c.product.id === dragged.id && c.targetParent.id === target.id)) return

    setPendingDrop({ product: dragged, targetParent: target })
  }, [stagedChanges])

  const handleStageConfirm = useCallback((change: StagedChange) => {
    setStagedChanges((prev) => {
      // Replace any existing staged change for the same product
      const without = prev.filter((c) => c.product.id !== change.product.id)
      return [...without, change]
    })
    setPendingDrop(null)
  }, [])

  const discardChange = useCallback((id: string) => {
    setStagedChanges((prev) => prev.filter((c) => c.id !== id))
  }, [])

  const discardAll = useCallback(() => {
    setStagedChanges([])
  }, [])

  // ── publish ───────────────────────────────────────────────────────
  const publish = useCallback(async () => {
    if (stagedChanges.length === 0) return
    setPublishing(true)
    let successCount = 0
    const errors: string[] = []

    for (const change of stagedChanges) {
      try {
        const res = await fetch(`${getBackendUrl()}/api/pim/attach-to-parent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': `organize:${change.targetParent.id}:${change.product.id}`,
          },
          body: JSON.stringify({
            parentId: change.targetParent.id,
            productIds: [change.product.id],
            axisValues: { [change.product.id]: change.attributes },
          }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok || json?.success === false) {
          errors.push(`${change.product.sku}: ${json?.error ?? `HTTP ${res.status}`}`)
        } else {
          successCount++
        }
      } catch (err) {
        errors.push(`${change.product.sku}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    setPublishing(false)

    if (errors.length === 0) {
      setStagedChanges([])
      setReviewOpen(false)
      emitInvalidation({ type: 'pim.changed', meta: { attached: successCount } })
      void refetch()
      toast.success(`Published ${successCount} change${successCount === 1 ? '' : 's'}.`)
    } else {
      if (successCount > 0) {
        setStagedChanges((prev) =>
          prev.filter((c) => errors.some((e) => e.startsWith(c.product.sku + ':')))
        )
        void refetch()
      }
      onStatus({ kind: 'error', text: `${errors.length} error${errors.length > 1 ? 's' : ''}: ${errors[0]}` })
    }
  }, [stagedChanges, refetch, toast, onStatus])

  // ── render ────────────────────────────────────────────────────────
  const parentCount = allProducts.filter((p) => p.isParent).length
  const standaloneCount = allProducts.filter((p) => !p.isParent && !p.parentId).length

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="space-y-3">
        {/* Toolbar */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search SKU, name, brand…"
              className="w-full h-8 pl-8 pr-2 text-base border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div className="flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-0.5">
            {(
              [
                { id: 'all',        label: `All (${allProducts.length})` },
                { id: 'parents',    label: `Parents (${parentCount})` },
                { id: 'standalone', label: `Standalone (${standaloneCount})` },
              ] as Array<{ id: RoleFilter; label: string }>
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setRoleFilter(opt.id)}
                className={`h-6 px-2.5 text-xs font-medium rounded transition-colors ${
                  roleFilter === opt.id
                    ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void refetch()}
            disabled={loading}
            className="inline-flex items-center gap-1 h-7 px-2 text-sm font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Refresh
          </button>
        </div>

        {/* Grid */}
        <VirtualizedGrid
          products={products}
          visible={ORGANIZE_COLUMNS}
          density="comfortable"
          cellPad={DENSITY_CELL_CLASS.comfortable}
          selected={selected}
          toggleSelect={toggleSelect}
          toggleSelectAll={toggleSelectAll}
          allSelected={allSelected}
          sortBy="updated"
          onSort={() => {}}
          expandedParents={expandedParents}
          childrenByParent={childrenByParent}
          loadingChildren={loadingChildren}
          onToggleExpand={toggleExpand}
          onTagEdit={() => {}}
          onChanged={onChanged}
          focusedRowId={null}
          searchTerm={debouncedSearch}
          riskFlaggedSkus={new Set()}
          draggable
          stagedProductIds={stagedProductIds}
          activeProductId={activeProduct?.id ?? null}
        />
      </div>

      {/* DragOverlay — floating preview while dragging */}
      <DragOverlay dropAnimation={null}>
        {activeProduct ? <DragPreview product={activeProduct} /> : null}
      </DragOverlay>

      {/* Attribute drawer — shown after a valid drop */}
      {pendingDrop && (
        <AttachDrawer
          product={pendingDrop.product}
          targetParent={pendingDrop.targetParent}
          onConfirm={handleStageConfirm}
          onCancel={() => setPendingDrop(null)}
        />
      )}

      {/* Review modal */}
      {reviewOpen && (
        <ReviewModal
          changes={stagedChanges}
          publishing={publishing}
          onDiscard={discardChange}
          onPublish={publish}
          onClose={() => setReviewOpen(false)}
        />
      )}

      {/* Floating staged-changes bar */}
      {stagedChanges.length > 0 && !reviewOpen && (
        <StagingBar
          count={stagedChanges.length}
          onReview={() => setReviewOpen(true)}
          onDiscardAll={discardAll}
        />
      )}
    </DndContext>
  )
}

// ─── DragPreview ─────────────────────────────────────────────────────
function DragPreview({ product }: { product: ProductRow }) {
  return (
    <div className="bg-white dark:bg-slate-800 border border-blue-300 dark:border-blue-600 rounded-lg shadow-xl px-3 py-2 flex items-center gap-2.5 max-w-[300px] cursor-grabbing">
      {product.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={product.imageUrl} alt="" className="w-9 h-9 rounded object-cover flex-shrink-0" />
      ) : (
        <div className="w-9 h-9 rounded bg-slate-100 dark:bg-slate-700 flex-shrink-0" />
      )}
      <div className="min-w-0">
        <div className="text-xs font-mono text-slate-400 dark:text-slate-500 truncate">{product.sku}</div>
        <div className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{product.name}</div>
      </div>
    </div>
  )
}

// ─── AttachDrawer ─────────────────────────────────────────────────────
// Simple attribute-assignment modal shown after drag-and-drop.
// Phase 3 will upgrade this to a full slide-in drawer with autocomplete.
function AttachDrawer({
  product,
  targetParent,
  onConfirm,
  onCancel,
}: {
  product: ProductRow
  targetParent: ProductRow
  onConfirm: (change: StagedChange) => void
  onCancel: () => void
}) {
  const [axes, setAxes] = useState<string[]>([])
  const [existingValues, setExistingValues] = useState<Map<string, string[]>>(new Map())
  const [attributes, setAttributes] = useState<Record<string, string>>({})
  const [fetching, setFetching] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Fetch parent's variation axes + existing variant attribute values
  useEffect(() => {
    let cancelled = false
    setFetching(true)
    setFetchError(null)
    fetch(`${getBackendUrl()}/api/catalog/products/${encodeURIComponent(targetParent.id)}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return
        const data = json?.data ?? json
        const rawAxes: string[] = Array.isArray(data?.variationAxes) && data.variationAxes.length > 0
          ? data.variationAxes
          : typeof data?.variationTheme === 'string' && data.variationTheme.trim()
            ? data.variationTheme.split(/\s*\/\s*/).filter(Boolean)
            : []
        // Build per-axis suggestion lists from existing variants
        const valMap = new Map<string, string[]>()
        for (const ax of rawAxes) valMap.set(ax, [])
        const variants: Array<{ variationAttributes?: Record<string, unknown> }> = data?.variations ?? []
        for (const v of variants) {
          for (const ax of rawAxes) {
            const val = String((v.variationAttributes ?? {})[ax] ?? '').trim()
            if (!val) continue
            const list = valMap.get(ax)!
            if (!list.includes(val)) list.push(val)
          }
        }
        for (const [ax, list] of valMap) {
          list.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
          valMap.set(ax, list)
        }
        if (!cancelled) {
          setAxes(rawAxes)
          setExistingValues(valMap)
          setAttributes(Object.fromEntries(rawAxes.map((ax) => [ax, ''])))
          setFetching(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setFetchError(err instanceof Error ? err.message : String(err))
          setFetching(false)
        }
      })
    return () => { cancelled = true }
  }, [targetParent.id])

  const canConfirm = axes.length === 0 || axes.every((ax) => (attributes[ax] ?? '').trim() !== '')

  const handleConfirm = () => {
    onConfirm({
      id: `${targetParent.id}:${product.id}:${Date.now()}`,
      product,
      targetParent,
      attributes: Object.fromEntries(
        Object.entries(attributes).map(([k, v]) => [k, v.trim()])
      ),
    })
  }

  return (
    <Modal
      open
      onClose={onCancel}
      title="Attach to parent"
      size="lg"
      placement="top"
      dismissOnEscape
      dismissOnBackdrop
    >
      <div className="space-y-4">
        {/* Product → parent line */}
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <span className="font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-700 dark:text-slate-300">
            {product.sku}
          </span>
          <ChevronRight className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
          <span className="font-mono bg-blue-50 dark:bg-blue-950/40 px-1.5 py-0.5 rounded text-blue-700 dark:text-blue-300">
            {targetParent.sku}
          </span>
          <span className="text-slate-500 dark:text-slate-400 truncate">{targetParent.name}</span>
        </div>

        {fetching && (
          <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400 py-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading variation axes…
          </div>
        )}

        {fetchError && (
          <div className="flex items-start gap-2 text-sm text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 rounded-md px-3 py-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>Couldn't load axes: {fetchError}. You can still stage without attributes.</span>
          </div>
        )}

        {!fetching && axes.length === 0 && !fetchError && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            This parent has no variation axes defined. The product will be attached without attributes — you can set them later from the Variations tab.
          </p>
        )}

        {!fetching && axes.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Set variation attributes for <span className="font-mono">{product.sku}</span>:
            </p>
            {axes.map((ax) => {
              const known = existingValues.get(ax) ?? []
              const val = attributes[ax] ?? ''
              const isCustom = val !== '' && !known.includes(val)
              return (
                <div key={ax}>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">{ax}</label>
                  <select
                    value={isCustom ? '__custom__' : val}
                    onChange={(e) => {
                      const v = e.target.value === '__custom__' ? '' : e.target.value
                      setAttributes((prev) => ({ ...prev, [ax]: v }))
                    }}
                    className="w-full h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">— Select —</option>
                    {known.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                    <option value="__custom__">+ New value…</option>
                  </select>
                  {(isCustom || (val === '' && known.length === 0)) && (
                    <input
                      type="text"
                      value={val}
                      onChange={(e) => setAttributes((prev) => ({ ...prev, [ax]: e.target.value }))}
                      placeholder={`Enter ${ax} value`}
                      className="mt-1 w-full h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      autoFocus
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={fetching}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleConfirm}
          disabled={fetching || !canConfirm}
        >
          <Check className="w-3.5 h-3.5" />
          Stage change
        </Button>
      </ModalFooter>
    </Modal>
  )
}

// ─── ReviewModal ──────────────────────────────────────────────────────
function ReviewModal({
  changes,
  publishing,
  onDiscard,
  onPublish,
  onClose,
}: {
  changes: StagedChange[]
  publishing: boolean
  onDiscard: (id: string) => void
  onPublish: () => void
  onClose: () => void
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title={`Review ${changes.length} staged change${changes.length === 1 ? '' : 's'}`}
      size="2xl"
      placement="top"
      dismissOnEscape={!publishing}
      dismissOnBackdrop={!publishing}
    >
      <div className="space-y-2">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Each change calls <code className="text-xs bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded">/pim/attach-to-parent</code> and updates catalog hierarchy. Channel listings are updated via the outbound sync queue.
        </p>
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Product</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">→ Parent</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Attributes</th>
                <th className="px-3 py-2 w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {changes.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                  <td className="px-3 py-2.5">
                    <div className="font-mono text-xs text-slate-600 dark:text-slate-400">{c.product.sku}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-500 truncate max-w-[160px]">{c.product.name}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="font-mono text-xs text-blue-700 dark:text-blue-400">{c.targetParent.sku}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-500 truncate max-w-[160px]">{c.targetParent.name}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    {Object.keys(c.attributes).length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(c.attributes).map(([k, v]) => v ? (
                          <span key={k} className="inline-flex items-center gap-0.5 text-xs bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300 border border-teal-200 dark:border-teal-800 px-1.5 py-0.5 rounded-full">
                            <span className="opacity-70">{k}:</span> {v}
                          </span>
                        ) : null)}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400 dark:text-slate-500 italic">none</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <button
                      type="button"
                      onClick={() => onDiscard(c.id)}
                      disabled={publishing}
                      aria-label={`Remove ${c.product.sku} from staged changes`}
                      className="p-1 rounded text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors disabled:opacity-30"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={publishing}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onPublish}
          disabled={publishing || changes.length === 0}
        >
          {publishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          {publishing ? 'Publishing…' : `Publish ${changes.length} change${changes.length === 1 ? '' : 's'}`}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

// ─── StagingBar ───────────────────────────────────────────────────────
function StagingBar({
  count,
  onReview,
  onDiscardAll,
}: {
  count: number
  onReview: () => void
  onDiscardAll: () => void
}) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-4 duration-200">
      <div className="flex items-center gap-3 bg-slate-900 dark:bg-slate-800 text-white rounded-full px-5 py-2.5 shadow-2xl border border-slate-700">
        <span className="inline-flex items-center justify-center w-5 h-5 bg-teal-400 text-slate-900 rounded-full text-xs font-bold flex-shrink-0">
          {count}
        </span>
        <span className="text-sm font-medium whitespace-nowrap">
          staged change{count === 1 ? '' : 's'}
        </span>
        <div className="w-px h-4 bg-slate-600" />
        <button
          type="button"
          onClick={onDiscardAll}
          className="text-xs text-slate-400 hover:text-white transition-colors"
        >
          Discard all
        </button>
        <button
          type="button"
          onClick={onReview}
          className="inline-flex items-center gap-1 text-xs font-semibold bg-teal-400 hover:bg-teal-300 text-slate-900 px-3 py-1 rounded-full transition-colors"
        >
          Review & Publish
          <ChevronRight className="w-3 h-3" />
        </button>
      </div>
    </div>
  )
}
