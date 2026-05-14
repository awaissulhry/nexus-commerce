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
  ArrowRight,
  Check,
  ChevronRight,
  Loader2,
  RefreshCw,
  Search,
  Unlink,
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

/** 'attach' — standalone/child → parent.  'detach' — child → standalone. */
export type StagedChangeAction = 'attach' | 'detach'

export interface StagedChange {
  id: string
  action: StagedChangeAction
  product: ProductRow
  /** null for detach changes. */
  targetParent: ProductRow | null
  attributes: Record<string, string>
}

interface PendingDrop {
  /** One or more products being attached (multi-select drag). */
  products: ProductRow[]
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
      if (next.has(parentId)) { next.delete(parentId) }
      else { next.add(parentId); void fetchChildrenFor(parentId) }
      return next
    })
  }, [fetchChildrenFor])

  // ── selection ─────────────────────────────────────────────────────
  const toggleSelect = useCallback((id: string, _shift: boolean) => {
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
    if (!dragged || !target || !target.isParent || dragged.id === target.id) return

    // Collect all products to attach.
    // If the dragged item is part of the selection, include all selected
    // non-parent products that aren't already children of this target.
    let toAttach: ProductRow[]
    if (selected.has(dragged.id) && selected.size > 1) {
      toAttach = allProducts.filter(
        (p) =>
          selected.has(p.id) &&
          !p.isParent &&
          p.parentId !== target.id &&
          !stagedChanges.some((c) => c.action === 'attach' && c.product.id === p.id && c.targetParent?.id === target.id),
      )
    } else {
      if (dragged.parentId === target.id) return
      if (stagedChanges.some((c) => c.action === 'attach' && c.product.id === dragged.id && c.targetParent?.id === target.id)) return
      toAttach = [dragged]
    }

    if (toAttach.length === 0) return
    setPendingDrop({ products: toAttach, targetParent: target })
  }, [selected, allProducts, stagedChanges])

  const handleStageConfirm = useCallback((changes: StagedChange[]) => {
    setStagedChanges((prev) => {
      const newIds = new Set(changes.map((c) => c.product.id))
      return [...prev.filter((c) => !newIds.has(c.product.id)), ...changes]
    })
    setPendingDrop(null)
  }, [])

  // Stage detach for all selected child rows.
  const stageDetach = useCallback(() => {
    const toDetach = allProducts.filter(
      (p) => selected.has(p.id) && !p.isParent && !!p.parentId,
    )
    if (toDetach.length === 0) return
    setStagedChanges((prev) => {
      const newIds = new Set(toDetach.map((p) => p.id))
      const without = prev.filter((c) => !newIds.has(c.product.id))
      const detachChanges: StagedChange[] = toDetach.map((p) => ({
        id: `detach:${p.id}:${Date.now()}`,
        action: 'detach',
        product: p,
        targetParent: null,
        attributes: {},
      }))
      return [...without, ...detachChanges]
    })
    setSelected(new Set())
  }, [allProducts, selected])

  const discardChange = useCallback((id: string) => {
    setStagedChanges((prev) => prev.filter((c) => c.id !== id))
  }, [])

  const discardAll = useCallback(() => { setStagedChanges([]) }, [])

  // ── publish ───────────────────────────────────────────────────────
  const publish = useCallback(async () => {
    if (stagedChanges.length === 0) return
    setPublishing(true)

    const attachChanges = stagedChanges.filter((c) => c.action === 'attach')
    const detachChanges = stagedChanges.filter((c) => c.action === 'detach')
    let totalPublished = 0
    const allErrors: string[] = []

    try {
      // ── attach ────────────────────────────────────────────────
      if (attachChanges.length > 0) {
        const res = await fetch(`${getBackendUrl()}/api/catalog/organize/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            changes: attachChanges.map((c) => ({
              productId: c.product.id,
              toParentId: c.targetParent!.id,
              attributes: c.attributes,
            })),
          }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          allErrors.push(json?.error ?? `Attach publish failed (HTTP ${res.status})`)
        } else {
          const { published, errors, undoExpiresAt } = json as {
            published: number
            errors: Array<{ productId: string; error: string }>
            sessionId: string
            undoExpiresAt: string
          }
          totalPublished += published
          const errIds = new Set(errors.map((e) => e.productId))
          setStagedChanges((prev) => prev.filter((c) => c.action !== 'attach' || errIds.has(c.product.id)))
          if (errors.length > 0) allErrors.push(...errors.map((e) => `${e.productId}: ${e.error}`))
          if (published > 0 && errors.length === 0) {
            const expiryHours = Math.round((new Date(undoExpiresAt).getTime() - Date.now()) / 3_600_000)
            toast.success(`Attached ${published} product${published === 1 ? '' : 's'}. Undo available for ${expiryHours}h.`)
          }
        }
      }

      // ── detach ────────────────────────────────────────────────
      if (detachChanges.length > 0) {
        const res = await fetch(`${getBackendUrl()}/api/amazon/pim/unlink-child`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productIds: detachChanges.map((c) => c.product.id) }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok || json?.success === false) {
          allErrors.push(json?.error ?? `Detach failed (HTTP ${res.status})`)
        } else {
          const detached: number = json.detached ?? detachChanges.length
          totalPublished += detached
          setStagedChanges((prev) => prev.filter((c) => c.action !== 'detach'))
          if (detached > 0) toast.success(`Detached ${detached} product${detached === 1 ? '' : 's'} → standalone.`)
        }
      }

      if (totalPublished > 0) {
        emitInvalidation({ type: 'pim.changed', meta: { published: totalPublished } })
        void refetch()
      }

      if (allErrors.length === 0 && stagedChanges.filter(c => !['attach','detach'].includes(c.action)).length === 0) {
        setReviewOpen(false)
      } else if (allErrors.length > 0) {
        onStatus({ kind: 'error', text: `${allErrors.length} error(s): ${allErrors[0]}` })
      }
    } catch (err) {
      onStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setPublishing(false)
    }
  }, [stagedChanges, refetch, toast, onStatus])

  // ── derived selection info ────────────────────────────────────────
  const selectedChildren = useMemo(
    () => allProducts.filter((p) => selected.has(p.id) && !p.isParent && !!p.parentId),
    [allProducts, selected],
  )

  const parentCount = allProducts.filter((p) => p.isParent).length
  const standaloneCount = allProducts.filter((p) => !p.isParent && !p.parentId).length

  // ── render ────────────────────────────────────────────────────────
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

          {/* Detach selected children */}
          {selectedChildren.length > 0 && (
            <button
              type="button"
              onClick={stageDetach}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 text-xs font-medium text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 rounded-md hover:bg-rose-100 dark:hover:bg-rose-950/60 transition-colors"
            >
              <Unlink className="w-3 h-3" />
              Stage detach ({selectedChildren.length})
            </button>
          )}

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

      {/* DragOverlay */}
      <DragOverlay dropAnimation={null}>
        {activeProduct ? <DragPreview product={activeProduct} selectionCount={selected.has(activeProduct.id) ? selected.size : 1} /> : null}
      </DragOverlay>

      {/* Attribute drawer — shown after a valid drop */}
      {pendingDrop && (
        <AttachDrawer
          products={pendingDrop.products}
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
function DragPreview({ product, selectionCount }: { product: ProductRow; selectionCount: number }) {
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
        <div className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">
          {selectionCount > 1 ? `+ ${selectionCount - 1} more selected` : product.name}
        </div>
      </div>
    </div>
  )
}

// ─── COMMON_THEMES ───────────────────────────────────────────────────
const COMMON_THEMES: Array<{ value: string; label: string; hint: string }> = [
  { value: 'Size',            label: 'Size',            hint: 'XS / S / M / L / XL' },
  { value: 'Color',           label: 'Color',           hint: 'Black / Brown / Red…' },
  { value: 'Size / Color',    label: 'Size + Color',    hint: 'Apparel default' },
  { value: 'Size / Material', label: 'Size + Material', hint: 'Boots, jackets' },
  { value: 'BodyType / Size', label: 'Body type + Size',hint: "Men's / Women's / Kids'" },
]

// ─── AttachDrawer ─────────────────────────────────────────────────────
// Full slide-in drawer with:
//   • COMMON_THEMES picker when the parent has no variation axes
//   • Per-axis AxisCombobox with autocomplete from existing siblings
//   • Batch support: one attribute-row per product in the drop
//   • Conflict detection (same combo already taken by a sibling)
//   • Preview tile showing the filled attribute combination
//   • Amazon variationTheme badge when the parent has one
type DrawerPhase = 'loading' | 'error' | 'pick-theme' | 'assign'

interface ExistingChild {
  id: string
  sku: string
  attrs: Record<string, string>
}

function AttachDrawer({
  products,
  targetParent,
  onConfirm,
  onCancel,
}: {
  products: ProductRow[]
  targetParent: ProductRow
  onConfirm: (changes: StagedChange[]) => void
  onCancel: () => void
}) {
  const [phase, setPhase] = useState<DrawerPhase>('loading')
  const [axes, setAxes] = useState<string[]>([])
  const [existingValues, setExistingValues] = useState<Map<string, string[]>>(new Map())
  const [existingChildren, setExistingChildren] = useState<ExistingChild[]>([])
  const [variationTheme, setVariationTheme] = useState<string | null>(null)
  // batchAttrs: productId → axis → value
  const [batchAttrs, setBatchAttrs] = useState<Record<string, Record<string, string>>>({})
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [themeChoice, setThemeChoice] = useState<string | null>(null)
  const [customTheme, setCustomTheme] = useState('')

  useEffect(() => {
    let cancelled = false
    setPhase('loading')
    setFetchError(null)
    fetch(`${getBackendUrl()}/api/catalog/products/${encodeURIComponent(targetParent.id)}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return
        const data = json?.data ?? json
        const rawAxes: string[] =
          Array.isArray(data?.variationAxes) && data.variationAxes.length > 0
            ? data.variationAxes
            : typeof data?.variationTheme === 'string' && data.variationTheme.trim()
              ? data.variationTheme.split(/\s*\/\s*/).filter(Boolean)
              : []

        const valMap = new Map<string, string[]>()
        for (const ax of rawAxes) valMap.set(ax, [])
        const variants: Array<{ id?: string; sku?: string; variationAttributes?: Record<string, unknown> }> =
          data?.variations ?? []
        const children: ExistingChild[] = []
        for (const v of variants) {
          const attrs: Record<string, string> = {}
          for (const ax of rawAxes) {
            const val = String((v.variationAttributes ?? {})[ax] ?? '').trim()
            if (!val) continue
            attrs[ax] = val
            const list = valMap.get(ax)!
            if (!list.includes(val)) list.push(val)
          }
          children.push({ id: v.id ?? '', sku: v.sku ?? '', attrs })
        }
        for (const [ax, list] of valMap) {
          list.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
          valMap.set(ax, list)
        }

        setExistingValues(valMap)
        setExistingChildren(children)
        setVariationTheme(typeof data?.variationTheme === 'string' ? data.variationTheme : null)

        if (rawAxes.length > 0) {
          setAxes(rawAxes)
          setBatchAttrs(Object.fromEntries(products.map((p) => [p.id, Object.fromEntries(rawAxes.map((ax) => [ax, '']))])))
          setPhase('assign')
        } else {
          setPhase('pick-theme')
        }
      })
      .catch((err) => {
        if (!cancelled) { setFetchError(err instanceof Error ? err.message : String(err)); setPhase('error') }
      })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetParent.id])

  const applyTheme = useCallback((theme: string) => {
    const parsed = theme.split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean)
    if (parsed.length === 0) return
    setAxes(parsed)
    setBatchAttrs(Object.fromEntries(products.map((p) => [p.id, Object.fromEntries(parsed.map((ax) => [ax, '']))])))
    setPhase('assign')
  }, [products])

  const setAttr = useCallback((productId: string, axis: string, value: string) => {
    setBatchAttrs((prev) => ({ ...prev, [productId]: { ...(prev[productId] ?? {}), [axis]: value } }))
  }, [])

  // Conflict detection: for each product, check if its combo matches an existing sibling.
  const conflicts = useMemo<Map<string, ExistingChild>>(() => {
    const m = new Map<string, ExistingChild>()
    if (axes.length === 0) return m
    for (const p of products) {
      const pAttrs = batchAttrs[p.id] ?? {}
      const allFilled = axes.every((ax) => (pAttrs[ax] ?? '').trim() !== '')
      if (!allFilled) continue
      const conflict = existingChildren.find((child) =>
        axes.every((ax) => child.attrs[ax]?.toLowerCase() === (pAttrs[ax] ?? '').trim().toLowerCase())
      )
      if (conflict) m.set(p.id, conflict)
    }
    return m
  }, [axes, products, batchAttrs, existingChildren])

  const canConfirm =
    phase === 'assign' &&
    (axes.length === 0 ||
      products.every((p) => axes.every((ax) => (batchAttrs[p.id]?.[ax] ?? '').trim() !== '')))

  const handleConfirm = () => {
    const changes: StagedChange[] = products.map((p) => ({
      id: `${targetParent.id}:${p.id}:${Date.now()}`,
      action: 'attach' as const,
      product: p,
      targetParent,
      attributes: Object.fromEntries(
        Object.entries(batchAttrs[p.id] ?? {}).map(([k, v]) => [k, v.trim()])
      ),
    }))
    onConfirm(changes)
  }

  const isBatch = products.length > 1

  return (
    <Modal
      open
      onClose={onCancel}
      title={isBatch ? `Attach ${products.length} products to parent` : 'Attach to parent'}
      size="xl"
      placement="drawer-right"
      dismissOnEscape
      dismissOnBackdrop={false}
    >
      <div className="flex flex-col gap-5 min-h-[200px]">

        {/* Header */}
        <div className="flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
          <div className="flex-1 min-w-0">
            <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">Moving</div>
            {isBatch ? (
              <div className="text-xs font-medium text-slate-800 dark:text-slate-100">
                {products.map((p) => p.sku).join(', ')}
              </div>
            ) : (
              <>
                <div className="font-mono text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{products[0]!.sku}</div>
                <div className="text-xs text-slate-400 truncate">{products[0]!.name}</div>
              </>
            )}
          </div>
          <ArrowRight className="w-4 h-4 text-slate-400 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs text-blue-600 dark:text-blue-400 mb-0.5">Into parent</div>
            <div className="font-mono text-sm font-medium text-blue-700 dark:text-blue-300 truncate">{targetParent.sku}</div>
            <div className="text-xs text-slate-400 truncate">{targetParent.name}</div>
          </div>
        </div>

        {/* Loading */}
        {phase === 'loading' && (
          <div className="flex items-center justify-center gap-2 text-sm text-slate-500 py-4">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading variation axes…
          </div>
        )}

        {/* Error */}
        {phase === 'error' && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 text-sm text-rose-700 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 rounded-lg px-3 py-2.5">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>Couldn't load axes: {fetchError}. You can still stage without attributes.</span>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setPhase('assign')}>
              Continue without attributes
            </Button>
          </div>
        )}

        {/* Pick theme */}
        {phase === 'pick-theme' && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              <strong className="text-slate-800 dark:text-slate-200">{targetParent.sku}</strong> has no variation axes.
              Pick a theme, or skip and attach without attributes.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {COMMON_THEMES.map((t) => {
                const active = themeChoice === t.value
                return (
                  <button key={t.value} type="button" onClick={() => setThemeChoice(t.value)}
                    className={`text-left rounded-lg border px-3 py-2.5 transition-colors ${active ? 'border-blue-400 bg-blue-50/60 dark:bg-blue-950/40 ring-1 ring-blue-300' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-300'}`}>
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{t.label}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{t.hint}</div>
                  </button>
                )
              })}
              <div className={`rounded-lg border px-3 py-2.5 transition-colors ${themeChoice === 'CUSTOM' ? 'border-blue-400 bg-blue-50/60 dark:bg-blue-950/40 ring-1 ring-blue-300' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900'}`}>
                <button type="button" onClick={() => setThemeChoice('CUSTOM')} className="text-left w-full">
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Custom…</div>
                  <div className="text-xs text-slate-500 mt-0.5">e.g. "Color / Material"</div>
                </button>
                {themeChoice === 'CUSTOM' && (
                  <input type="text" value={customTheme} onChange={(e) => setCustomTheme(e.target.value)}
                    placeholder="Axis1 / Axis2" autoFocus
                    className="mt-2 w-full h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
                )}
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="primary" size="sm"
                disabled={!themeChoice || (themeChoice === 'CUSTOM' && !customTheme.trim())}
                onClick={() => applyTheme(themeChoice === 'CUSTOM' ? customTheme.trim() : (themeChoice ?? ''))}>
                <Check className="w-3.5 h-3.5" /> Use this theme
              </Button>
              <Button variant="secondary" size="sm"
                onClick={() => { setAxes([]); setBatchAttrs({}); setPhase('assign') }}>
                Skip — no attributes
              </Button>
            </div>
          </div>
        )}

        {/* Assign */}
        {phase === 'assign' && (
          <div className="space-y-4">
            {axes.length === 0 ? (
              <p className="text-sm text-slate-500 italic">
                No variation attributes — products will be attached without them.
              </p>
            ) : isBatch ? (
              /* ── Batch table ── */
              <div>
                <p className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                  Set attributes for each product:
                </p>
                <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-800">
                      <tr>
                        <th className="px-2 py-1.5 text-left text-xs font-semibold text-slate-500">Product</th>
                        {axes.map((ax) => (
                          <th key={ax} className="px-2 py-1.5 text-left text-xs font-semibold text-slate-500">{ax}</th>
                        ))}
                        <th className="px-2 py-1.5 w-6" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {products.map((p) => {
                        const conflict = conflicts.get(p.id)
                        return (
                          <tr key={p.id} className={conflict ? 'bg-amber-50/40 dark:bg-amber-950/20' : ''}>
                            <td className="px-2 py-1.5 font-mono text-xs text-slate-700 dark:text-slate-300 max-w-[100px] truncate">
                              {p.sku}
                            </td>
                            {axes.map((ax) => (
                              <td key={ax} className="px-2 py-1.5 min-w-[100px]">
                                <AxisCombobox
                                  axis={ax}
                                  value={batchAttrs[p.id]?.[ax] ?? ''}
                                  suggestions={existingValues.get(ax) ?? []}
                                  onChange={(v) => setAttr(p.id, ax, v)}
                                />
                              </td>
                            ))}
                            <td className="px-2 py-1.5">
                              {conflict && (
                                <span title={`Taken by ${conflict.sku}`}>
                                  <AlertCircle className="w-3.5 h-3.5 text-amber-500" />
                                </span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                {conflicts.size > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-300 mt-1.5">
                    ⚠ {conflicts.size} attribute combo{conflicts.size > 1 ? 's are' : ' is'} already taken — you can still stage but publishing may fail.
                  </p>
                )}
              </div>
            ) : (
              /* ── Single-product form ── */
              <div className="space-y-3">
                <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Set attributes for <span className="font-mono text-slate-900 dark:text-slate-100">{products[0]!.sku}</span>
                </p>
                {axes.map((ax) => (
                  <AxisCombobox
                    key={ax}
                    axis={ax}
                    value={batchAttrs[products[0]!.id]?.[ax] ?? ''}
                    suggestions={existingValues.get(ax) ?? []}
                    onChange={(v) => setAttr(products[0]!.id, ax, v)}
                  />
                ))}
                {conflicts.has(products[0]!.id) && (
                  <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-700 rounded-lg px-3 py-2.5">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <span>Combo taken by <span className="font-mono font-semibold">{conflicts.get(products[0]!.id)!.sku}</span>. Can still stage, but publishing may fail.</span>
                  </div>
                )}
                {/* Preview tile */}
                {axes.some((ax) => (batchAttrs[products[0]!.id]?.[ax] ?? '').trim()) && (
                  <div className="rounded-lg border border-teal-200 dark:border-teal-800 bg-teal-50/60 dark:bg-teal-950/30 px-3 py-2.5">
                    <p className="text-xs font-medium text-teal-700 dark:text-teal-400 mb-1.5">Will appear as</p>
                    <div className="flex flex-wrap gap-1.5">
                      {axes.filter((ax) => (batchAttrs[products[0]!.id]?.[ax] ?? '').trim()).map((ax) => (
                        <span key={ax} className="inline-flex items-center gap-1 text-xs bg-white dark:bg-teal-900/40 border border-teal-300 dark:border-teal-700 text-teal-800 dark:text-teal-200 px-2 py-0.5 rounded-full font-medium">
                          <span className="opacity-60">{ax}:</span> {batchAttrs[products[0]!.id]?.[ax]}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Amazon theme badge */}
            {variationTheme && (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span className="font-medium">Amazon variation_theme:</span>
                <code className="bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-700 dark:text-slate-300">{variationTheme}</code>
              </div>
            )}
          </div>
        )}
      </div>

      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
        {phase === 'assign' && (
          <Button variant="primary" size="sm" onClick={handleConfirm} disabled={!canConfirm}>
            <Check className="w-3.5 h-3.5" />
            {isBatch ? `Stage ${products.length} changes` : 'Stage change'}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  )
}

// ─── AxisCombobox ─────────────────────────────────────────────────────
function AxisCombobox({
  axis,
  value,
  suggestions,
  onChange,
}: {
  axis: string
  value: string
  suggestions: string[]
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const filtered = useMemo(
    () => suggestions.filter((s) => s.toLowerCase().includes(value.toLowerCase())),
    [suggestions, value],
  )

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!inputRef.current?.closest('[data-combobox]')?.contains(e.target as Node)) {
        setOpen(false); setFocused(-1)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const pick = useCallback((val: string) => {
    onChange(val); setOpen(false); setFocused(-1); inputRef.current?.focus()
  }, [onChange])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setFocused((f) => Math.min(f + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocused((f) => Math.max(f - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (focused >= 0 && filtered[focused]) pick(filtered[focused]) }
    else if (e.key === 'Escape') { setOpen(false); setFocused(-1) }
    else setOpen(true)
  }

  useEffect(() => {
    if (focused < 0) return
    const el = listRef.current?.children[focused] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  const isEmpty = value.trim() === ''
  const isNew = value.trim() !== '' && !suggestions.includes(value.trim())

  return (
    <div data-combobox className="relative">
      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">{axis}</label>
      <div className={`flex items-center border rounded-md transition-colors ${isEmpty ? 'border-slate-200 dark:border-slate-700' : isNew ? 'border-teal-400 dark:border-teal-600' : 'border-blue-400 dark:border-blue-600'}`}>
        <input ref={inputRef} type="text" value={value}
          onChange={(e) => { onChange(e.target.value); setOpen(true); setFocused(-1) }}
          onFocus={() => { if (filtered.length > 0) setOpen(true) }}
          onKeyDown={onKeyDown}
          placeholder={`Enter ${axis} value`}
          autoComplete="off"
          className="flex-1 h-8 px-2.5 text-sm bg-transparent focus:outline-none rounded-md text-slate-800 dark:text-slate-100 placeholder-slate-400"
        />
        {isNew && <span className="text-xs text-teal-600 dark:text-teal-400 pr-2.5 font-medium whitespace-nowrap">New</span>}
        {!isEmpty && !isNew && <Check className="w-3.5 h-3.5 text-blue-500 mr-2.5 flex-shrink-0" />}
      </div>
      {open && filtered.length > 0 && (
        <ul ref={listRef} className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md shadow-lg z-50 max-h-36 overflow-y-auto py-1">
          {filtered.map((s, i) => (
            <li key={s}
              onMouseDown={(e) => { e.preventDefault(); pick(s) }}
              onMouseEnter={() => setFocused(i)}
              className={`px-2.5 py-1.5 text-sm cursor-pointer transition-colors ${i === focused ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300' : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─── channel-tone helper ─────────────────────────────────────────────
const CHANNEL_TONE: Record<string, string> = {
  AMAZON:  'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800',
  EBAY:    'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800',
  SHOPIFY: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800',
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
  const attachCount = changes.filter((c) => c.action === 'attach').length
  const detachCount = changes.filter((c) => c.action === 'detach').length

  return (
    <Modal
      open
      onClose={onClose}
      title={`Review ${changes.length} staged change${changes.length === 1 ? '' : 's'}`}
      size="3xl"
      placement="top"
      dismissOnEscape={!publishing}
      dismissOnBackdrop={!publishing}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap text-sm text-slate-500 dark:text-slate-400">
          {attachCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-teal-500 inline-block" />
              {attachCount} attach {attachCount === 1 ? 'change' : 'changes'}
            </span>
          )}
          {detachCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-rose-500 inline-block" />
              {detachCount} detach {detachCount === 1 ? 'change' : 'changes'}
            </span>
          )}
          <span className="text-xs">Publishes to catalog + enqueues channel sync. Attach changes undoable for 48h.</span>
        </div>

        <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">Product</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">Action</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">Attributes</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">Channels</th>
                <th className="px-3 py-2 w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {changes.map((c) => {
                const channels = c.product.syncChannels ?? []
                const coverage = c.product.coverage ?? {}
                const isDetach = c.action === 'detach'
                return (
                  <tr key={c.id} className={`hover:bg-slate-50/50 dark:hover:bg-slate-800/30 ${isDetach ? 'bg-rose-50/20 dark:bg-rose-950/10' : ''}`}>
                    <td className="px-3 py-2.5 align-top">
                      <div className="font-mono text-xs text-slate-700 dark:text-slate-300">{c.product.sku}</div>
                      <div className="text-xs text-slate-400 truncate max-w-[140px]">{c.product.name}</div>
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      {isDetach ? (
                        <span className="inline-flex items-center gap-1 text-xs text-rose-700 dark:text-rose-400 font-medium">
                          <Unlink className="w-3 h-3" /> → Standalone
                        </span>
                      ) : (
                        <div>
                          <div className="flex items-center gap-1 text-xs">
                            <ChevronRight className="w-3 h-3 text-slate-400" />
                            <span className="font-mono text-blue-700 dark:text-blue-400 truncate max-w-[100px]">
                              {c.targetParent?.sku}
                            </span>
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      {Object.keys(c.attributes).length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(c.attributes).map(([k, v]) => v ? (
                            <span key={k} className="text-xs bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300 border border-teal-200 dark:border-teal-800 px-1.5 py-0.5 rounded-full">
                              <span className="opacity-60">{k}:</span> {v}
                            </span>
                          ) : null)}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400 italic">none</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      {channels.length === 0 ? (
                        <span className="text-xs text-slate-400 italic">unlisted</span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {channels.map((ch) => {
                            const cov = coverage[ch]
                            const tone = CHANNEL_TONE[ch] ?? 'bg-slate-50 text-slate-600 border-slate-200'
                            return (
                              <span key={ch} className={`inline-flex items-center gap-1 text-[10px] font-medium border px-1.5 py-0.5 rounded-full ${tone}`}>
                                {ch}
                                {cov && <span className="opacity-70">{cov.live > 0 ? `${cov.live}L` : cov.draft > 0 ? `${cov.draft}D` : '—'}</span>}
                              </span>
                            )
                          })}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <button type="button" onClick={() => onDiscard(c.id)} disabled={publishing}
                        aria-label={`Remove ${c.product.sku}`}
                        className="p-1 rounded text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors disabled:opacity-30">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={publishing}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={onPublish} disabled={publishing || changes.length === 0}>
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
        <button type="button" onClick={onDiscardAll} className="text-xs text-slate-400 hover:text-white transition-colors">
          Discard all
        </button>
        <button type="button" onClick={onReview}
          className="inline-flex items-center gap-1 text-xs font-semibold bg-teal-400 hover:bg-teal-300 text-slate-900 px-3 py-1 rounded-full transition-colors">
          Review & Publish
          <ChevronRight className="w-3 h-3" />
        </button>
      </div>
    </div>
  )
}
