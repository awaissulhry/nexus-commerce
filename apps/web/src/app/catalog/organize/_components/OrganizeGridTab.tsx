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
    try {
      const res = await fetch(`${getBackendUrl()}/api/catalog/organize/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: stagedChanges.map((c) => ({
            productId: c.product.id,
            toParentId: c.targetParent.id,
            attributes: c.attributes,
          })),
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        onStatus({ kind: 'error', text: json?.error ?? `Publish failed (HTTP ${res.status})` })
        return
      }

      const { published, errors, undoExpiresAt } = json as {
        published: number
        errors: Array<{ productId: string; sku: string; error: string }>
        sessionId: string  // kept for Phase 5 history panel
        undoExpiresAt: string
      }

      // Remove successfully published changes; keep any that errored.
      const erroredIds = new Set(errors.map((e) => e.productId))
      setStagedChanges((prev) => prev.filter((c) => erroredIds.has(c.product.id)))

      emitInvalidation({ type: 'pim.changed', meta: { attached: published } })
      void refetch()

      if (errors.length === 0) {
        setReviewOpen(false)
        const expiryHours = Math.round(
          (new Date(undoExpiresAt).getTime() - Date.now()) / 3_600_000
        )
        toast.success(
          `Published ${published} change${published === 1 ? '' : 's'}. Undo available for ${expiryHours}h.`
        )
      } else {
        onStatus({
          kind: 'error',
          text: `${errors.length} error${errors.length > 1 ? 's' : ''}: ${errors[0]?.error}`,
        })
      }
    } catch (err) {
      onStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setPublishing(false)
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

// ─── COMMON_THEMES ───────────────────────────────────────────────────
// Mirrors the theme picker in /catalog/organize's PromoteModal.
const COMMON_THEMES: Array<{ value: string; label: string; hint: string }> = [
  { value: 'Size',           label: 'Size',           hint: 'XS / S / M / L / XL' },
  { value: 'Color',          label: 'Color',          hint: 'Black / Brown / Red…' },
  { value: 'Size / Color',   label: 'Size + Color',   hint: 'Apparel default' },
  { value: 'Size / Material',label: 'Size + Material',hint: 'Boots, jackets' },
  { value: 'BodyType / Size',label: 'Body type + Size',hint: "Men's / Women's / Kids'" },
]

// ─── AttachDrawer ─────────────────────────────────────────────────────
// Full slide-in drawer (placement="drawer-right") with:
//   • COMMON_THEMES picker when the parent has no variation axes
//   • Per-axis AxisCombobox with autocomplete from existing sibling values
//   • Conflict detection (same attribute combination already taken)
//   • Preview tile showing the full "Axis: Value" combination
//   • Amazon variationTheme badge when the parent has one
type DrawerPhase = 'loading' | 'error' | 'pick-theme' | 'assign'

interface ExistingChild {
  id: string
  sku: string
  attrs: Record<string, string>
}

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
  const [phase, setPhase] = useState<DrawerPhase>('loading')
  const [axes, setAxes] = useState<string[]>([])
  const [existingValues, setExistingValues] = useState<Map<string, string[]>>(new Map())
  const [existingChildren, setExistingChildren] = useState<ExistingChild[]>([])
  const [variationTheme, setVariationTheme] = useState<string | null>(null)
  const [attributes, setAttributes] = useState<Record<string, string>>({})
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [customTheme, setCustomTheme] = useState('')
  const [themeChoice, setThemeChoice] = useState<string | null>(null)

  // Fetch parent's variation axes + sibling attribute values
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

        // Per-axis suggestion lists from existing siblings
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
          list.sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
          )
          valMap.set(ax, list)
        }
        setExistingValues(valMap)
        setExistingChildren(children)
        setVariationTheme(typeof data?.variationTheme === 'string' ? data.variationTheme : null)

        if (rawAxes.length > 0) {
          setAxes(rawAxes)
          setAttributes(Object.fromEntries(rawAxes.map((ax) => [ax, ''])))
          setPhase('assign')
        } else {
          setPhase('pick-theme')
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setFetchError(err instanceof Error ? err.message : String(err))
          setPhase('error')
        }
      })
    return () => { cancelled = true }
  }, [targetParent.id])

  // When user picks a theme, derive axes and advance
  const applyTheme = useCallback((theme: string) => {
    const parsed = theme.split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean)
    if (parsed.length === 0) return
    setAxes(parsed)
    setAttributes(Object.fromEntries(parsed.map((ax) => [ax, ''])))
    setPhase('assign')
  }, [])

  // Conflict: another sibling already has the same full attribute combo
  const conflict = useMemo<ExistingChild | null>(() => {
    if (axes.length === 0) return null
    const allFilled = axes.every((ax) => (attributes[ax] ?? '').trim() !== '')
    if (!allFilled) return null
    return (
      existingChildren.find((child) =>
        axes.every(
          (ax) =>
            child.attrs[ax]?.toLowerCase() ===
            (attributes[ax] ?? '').trim().toLowerCase()
        )
      ) ?? null
    )
  }, [axes, attributes, existingChildren])

  const previewPairs = useMemo(
    () => axes.filter((ax) => (attributes[ax] ?? '').trim()).map((ax) => [ax, attributes[ax].trim()] as [string, string]),
    [axes, attributes]
  )

  const canConfirm =
    phase === 'assign' &&
    (axes.length === 0 || axes.every((ax) => (attributes[ax] ?? '').trim() !== ''))

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
      size="xl"
      placement="drawer-right"
      dismissOnEscape
      dismissOnBackdrop={false}
    >
      <div className="flex flex-col gap-5 min-h-[200px]">

        {/* ── Product → Parent header ─────────────────────────────── */}
        <div className="flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 mb-0.5">
              Moving
            </div>
            <div className="font-mono text-sm font-medium text-slate-800 dark:text-slate-100 truncate">
              {product.sku}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 truncate">{product.name}</div>
          </div>
          <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 mb-0.5">
              Into parent
            </div>
            <div className="font-mono text-sm font-medium text-blue-700 dark:text-blue-300 truncate">
              {targetParent.sku}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 truncate">{targetParent.name}</div>
          </div>
        </div>

        {/* ── Loading ──────────────────────────────────────────────── */}
        {phase === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400 py-4 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading variation axes…
          </div>
        )}

        {/* ── Error ────────────────────────────────────────────────── */}
        {phase === 'error' && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 text-sm text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 rounded-lg px-3 py-2.5">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>Couldn't load axes: {fetchError}. You can still stage the change without attributes.</span>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setPhase('assign')}>
              Continue without attributes
            </Button>
          </div>
        )}

        {/* ── Pick variation theme (parent has no axes) ─────────────── */}
        {phase === 'pick-theme' && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              <strong className="text-slate-800 dark:text-slate-200">{targetParent.sku}</strong> has no variation axes yet.
              Pick a theme to define which attributes differentiate children, or skip and set them later.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {COMMON_THEMES.map((t) => {
                const active = themeChoice === t.value
                return (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setThemeChoice(t.value)}
                    className={`text-left rounded-lg border px-3 py-2.5 transition-colors ${
                      active
                        ? 'border-blue-400 bg-blue-50/60 dark:bg-blue-950/40 ring-1 ring-blue-300'
                        : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-600'
                    }`}
                  >
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{t.label}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{t.hint}</div>
                  </button>
                )
              })}
              {/* Custom theme */}
              <div
                className={`rounded-lg border px-3 py-2.5 transition-colors ${
                  themeChoice === 'CUSTOM'
                    ? 'border-blue-400 bg-blue-50/60 dark:bg-blue-950/40 ring-1 ring-blue-300'
                    : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setThemeChoice('CUSTOM')}
                  className="text-left w-full"
                >
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Custom…</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">e.g. "Color / Material"</div>
                </button>
                {themeChoice === 'CUSTOM' && (
                  <input
                    type="text"
                    value={customTheme}
                    onChange={(e) => setCustomTheme(e.target.value)}
                    placeholder="Axis1 / Axis2"
                    autoFocus
                    className="mt-2 w-full h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                )}
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <Button
                variant="primary"
                size="sm"
                disabled={!themeChoice || (themeChoice === 'CUSTOM' && !customTheme.trim())}
                onClick={() => {
                  const theme = themeChoice === 'CUSTOM' ? customTheme.trim() : (themeChoice ?? '')
                  applyTheme(theme)
                }}
              >
                <Check className="w-3.5 h-3.5" />
                Use this theme
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { setAxes([]); setAttributes({}); setPhase('assign') }}>
                Skip — no attributes
              </Button>
            </div>
          </div>
        )}

        {/* ── Attribute assignment ──────────────────────────────────── */}
        {phase === 'assign' && (
          <div className="space-y-4">
            {axes.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400 italic">
                No variation attributes — the product will be attached without them. You can set attributes from the parent's Variations tab later.
              </p>
            ) : (
              <>
                <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Set attributes for <span className="font-mono text-slate-900 dark:text-slate-100">{product.sku}</span>
                </p>
                {axes.map((ax) => (
                  <AxisCombobox
                    key={ax}
                    axis={ax}
                    value={attributes[ax] ?? ''}
                    suggestions={existingValues.get(ax) ?? []}
                    onChange={(v) => setAttributes((prev) => ({ ...prev, [ax]: v }))}
                  />
                ))}
              </>
            )}

            {/* Conflict banner */}
            {conflict && (
              <div className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-700 rounded-lg px-3 py-2.5">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>
                  This combination is already taken by{' '}
                  <span className="font-mono font-semibold">{conflict.sku}</span>.
                  You can still stage the change but publishing may fail.
                </span>
              </div>
            )}

            {/* Preview tile */}
            {previewPairs.length > 0 && (
              <div className="rounded-lg border border-teal-200 dark:border-teal-800 bg-teal-50/60 dark:bg-teal-950/30 px-3 py-2.5">
                <p className="text-xs font-medium text-teal-700 dark:text-teal-400 mb-1.5">Will appear as</p>
                <div className="flex flex-wrap gap-1.5">
                  {previewPairs.map(([ax, val]) => (
                    <span
                      key={ax}
                      className="inline-flex items-center gap-1 text-xs bg-white dark:bg-teal-900/40 border border-teal-300 dark:border-teal-700 text-teal-800 dark:text-teal-200 px-2 py-0.5 rounded-full font-medium"
                    >
                      <span className="opacity-60">{ax}:</span> {val}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Amazon variation_theme badge */}
            {variationTheme && (
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <span className="font-medium">Amazon variation_theme:</span>
                <code className="bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-700 dark:text-slate-300">
                  {variationTheme}
                </code>
              </div>
            )}
          </div>
        )}
      </div>

      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        {phase === 'assign' && (
          <Button
            variant="primary"
            size="sm"
            onClick={handleConfirm}
            disabled={!canConfirm}
          >
            <Check className="w-3.5 h-3.5" />
            Stage change
          </Button>
        )}
      </ModalFooter>
    </Modal>
  )
}

// ─── AxisCombobox ─────────────────────────────────────────────────────
// Type-to-filter combobox for a single variation axis.
// Shows a dropdown with filtered suggestions from existing siblings.
// Keyboard nav: ArrowDown opens / navigates, Enter selects, Escape closes.
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
    () =>
      suggestions.filter((s) =>
        s.toLowerCase().includes(value.toLowerCase())
      ),
    [suggestions, value]
  )

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!inputRef.current?.closest('[data-combobox]')?.contains(e.target as Node)) {
        setOpen(false)
        setFocused(-1)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const pick = useCallback(
    (val: string) => {
      onChange(val)
      setOpen(false)
      setFocused(-1)
      inputRef.current?.focus()
    },
    [onChange]
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setFocused((f) => Math.min(f + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocused((f) => Math.max(f - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (focused >= 0 && filtered[focused]) {
        pick(filtered[focused])
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
      setFocused(-1)
    } else {
      setOpen(true)
    }
  }

  // Scroll focused item into view
  useEffect(() => {
    if (focused < 0) return
    const el = listRef.current?.children[focused] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  const isEmpty = value.trim() === ''
  const isNewValue = value.trim() !== '' && !suggestions.includes(value.trim())

  return (
    <div data-combobox className="relative">
      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
        {axis}
      </label>
      <div className={`flex items-center border rounded-md transition-colors ${
        isEmpty
          ? 'border-slate-200 dark:border-slate-700'
          : isNewValue
            ? 'border-teal-400 dark:border-teal-600'
            : 'border-blue-400 dark:border-blue-600'
      }`}>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => { onChange(e.target.value); setOpen(true); setFocused(-1) }}
          onFocus={() => { if (filtered.length > 0) setOpen(true) }}
          onKeyDown={onKeyDown}
          placeholder={`Enter ${axis} value`}
          autoComplete="off"
          className="flex-1 h-8 px-2.5 text-sm bg-transparent focus:outline-none rounded-md text-slate-800 dark:text-slate-100 placeholder-slate-400"
        />
        {isNewValue && (
          <span className="text-xs text-teal-600 dark:text-teal-400 pr-2.5 font-medium whitespace-nowrap">
            New
          </span>
        )}
        {!isEmpty && !isNewValue && (
          <Check className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400 mr-2.5 flex-shrink-0" />
        )}
      </div>
      {open && filtered.length > 0 && (
        <ul
          ref={listRef}
          className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md shadow-lg z-50 max-h-36 overflow-y-auto py-1"
        >
          {filtered.map((s, i) => (
            <li
              key={s}
              onMouseDown={(e) => { e.preventDefault(); pick(s) }}
              onMouseEnter={() => setFocused(i)}
              className={`px-2.5 py-1.5 text-sm cursor-pointer transition-colors ${
                i === focused
                  ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
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
  AMAZON:   'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800',
  EBAY:     'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800',
  SHOPIFY:  'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800',
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
      size="3xl"
      placement="top"
      dismissOnEscape={!publishing}
      dismissOnBackdrop={!publishing}
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Publishes hierarchy changes to the catalog and enqueues channel sync via OutboundSyncQueue.
          After publishing you can undo within <strong className="text-slate-700 dark:text-slate-300">48 hours</strong>.
        </p>
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Product</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">→ Parent</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Attributes</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Channels</th>
                <th className="px-3 py-2 w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {changes.map((c) => {
                // Derive channel impact from syncChannels + coverage already in ProductRow.
                const channels = c.product.syncChannels ?? []
                const coverage = c.product.coverage ?? {}
                return (
                  <tr key={c.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                    <td className="px-3 py-2.5 align-top">
                      <div className="font-mono text-xs text-slate-700 dark:text-slate-300">{c.product.sku}</div>
                      <div className="text-xs text-slate-400 truncate max-w-[140px]">{c.product.name}</div>
                      {c.product.amazonAsin && (
                        <div className="text-[10px] font-mono text-slate-400 dark:text-slate-500 mt-0.5">
                          {c.product.amazonAsin}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <div className="font-mono text-xs text-blue-700 dark:text-blue-400">{c.targetParent.sku}</div>
                      <div className="text-xs text-slate-400 truncate max-w-[140px]">{c.targetParent.name}</div>
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      {Object.keys(c.attributes).length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(c.attributes).map(([k, v]) => v ? (
                            <span key={k} className="inline-flex items-center gap-0.5 text-xs bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300 border border-teal-200 dark:border-teal-800 px-1.5 py-0.5 rounded-full">
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
                            const tone = CHANNEL_TONE[ch] ?? 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
                            return (
                              <span key={ch} className={`inline-flex items-center gap-1 text-[10px] font-medium border px-1.5 py-0.5 rounded-full whitespace-nowrap ${tone}`}>
                                {ch}
                                {cov && (
                                  <span className="opacity-70">
                                    {cov.live > 0 ? `${cov.live}L` : cov.draft > 0 ? `${cov.draft}D` : '—'}
                                  </span>
                                )}
                              </span>
                            )
                          })}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 align-top">
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
                )
              })}
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
