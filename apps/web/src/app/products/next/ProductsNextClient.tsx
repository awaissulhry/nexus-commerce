'use client'

// Design-system style sheets (must be imported explicitly per-page).
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Copy,
  Download,
  Plus,
  Search,
  Send,
  SlidersHorizontal,
  Tag as TagIcon,
  Trash2,
  Upload,
} from 'lucide-react'

import { getBackendUrl } from '@/lib/backend-url'
import { usePolledList } from '@/lib/sync/use-polled-list'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import type { ProductRow, Tag } from '@/app/products/_types'
import { Thumbnail, DensityContext, type Density } from '@/app/_shared/grid-lens'

// DS Primitives
import {
  Button,
  Input,
  Pill,
  SegmentedControl,
  Tooltip,
  type SegmentedOption,
  type Tone,
} from '@/design-system/primitives'
// DS Components
import {
  DataGrid,
  Menu,
  ToastProvider,
  useToast,
  type Column,
  type MenuItemDef,
} from '@/design-system/components'
// DS Patterns
import {
  FilterBar,
  GridToolbar,
  PageHeader,
  PreferencesModal,
  type CustomizableColumn,
  type FilterDimension,
  type PreferencesColumnSpec,
  type PreferencesValue,
} from '@/design-system/patterns'

import styles from './styles.module.css'
import { InventoryCell } from './InventoryCell'
import { InventoryEditorModal } from './InventoryEditorModal'

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

// usePolledList prepends getBackendUrl() for any '/api/' path, so this hits the
// real backend (rich {products, stats} with coverage/tags), not the local Next
// stub route handler.
const POLL_URL =
  '/api/products?page=1&limit=200&includeCoverage=true&includeTags=true'

const DENSITY_OPTIONS: SegmentedOption[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'cozy', label: 'Cozy' },
  { value: 'spacious', label: 'Spacious' },
]

const CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY'] as const
type Channel = (typeof CHANNELS)[number]

/** Market names for publish-destination labels. */
const MARKET_NAMES: Record<string, string> = {
  IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', UK: 'United Kingdom',
}
/**
 * Publish destinations offered in the bulk "Publish" menu. Active channels only
 * (Amazon · eBay · Shopify), matching the platform's channel scope. Each entry
 * resolves to a `publish(channel, marketplace)` call.
 */
const PUBLISH_DESTINATIONS: Array<{ channel: string; marketplace: string; label: string }> = [
  ...['IT', 'DE', 'FR', 'ES'].map((m) => ({ channel: 'AMAZON', marketplace: m, label: `Amazon ${m} (${MARKET_NAMES[m] ?? m})` })),
  ...['IT', 'DE', 'FR', 'ES'].map((m) => ({ channel: 'EBAY', marketplace: m, label: `eBay ${m} (${MARKET_NAMES[m] ?? m})` })),
  { channel: 'SHOPIFY', marketplace: 'GLOBAL', label: 'Shopify' },
]

type DensityMode = 'compact' | 'cozy' | 'spacious'
type KpiTileKey = 'active' | 'out-of-stock' | 'attention' | null

/** Client-side filter state driven by the DS FilterBar. */
interface ProductFilters {
  channels: string[]
  status: string[]
  stock: string[]
  fulfillment: string[]
  productTypes: string[]
  brands: string[]
  tags: string[]
  families: string[]
  workflowStages: string[]
  missingChannels: string[]
  priceMin: string
  priceMax: string
  stockMin: string
  stockMax: string
}

const EMPTY_FILTERS: ProductFilters = {
  channels: [],
  status: [],
  stock: [],
  fulfillment: [],
  productTypes: [],
  brands: [],
  tags: [],
  families: [],
  workflowStages: [],
  missingChannels: [],
  priceMin: '',
  priceMax: '',
  stockMin: '',
  stockMax: '',
}

// ─────────────────────────────────────────────────────────────────
// Column-preferences model
// ─────────────────────────────────────────────────────────────────

const COL_PREFS_KEY = 'products-next:columns'

/**
 * Catalog of customizable columns (stable keys + display labels).
 * _sel, product, and actions are LOCKED — they're not in this catalog.
 */
const COL_CATALOG: Array<{ key: string; label: string }> = [
  { key: 'channels', label: 'Channels' },
  { key: 'status', label: 'Status' },
  { key: 'available', label: 'Available' },
  { key: 'price', label: 'Price' },
]

/** Load + reconcile column prefs from localStorage. */
function loadColPrefs(): CustomizableColumn[] {
  try {
    const raw = typeof window !== 'undefined' && localStorage.getItem(COL_PREFS_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Array<{ key: string; visible: boolean }>
      // Drop unknown keys, preserve saved order
      const valid = saved.filter((s) => COL_CATALOG.some((c) => c.key === s.key))
      // Append newly-added catalog columns (forward-compat: new columns are visible by default)
      const savedKeys = new Set(valid.map((s) => s.key))
      const appended = COL_CATALOG.filter((c) => !savedKeys.has(c.key)).map((c) => ({
        key: c.key,
        visible: true,
      }))
      return [...valid, ...appended].map((s) => ({
        key: s.key,
        label: COL_CATALOG.find((c) => c.key === s.key)!.label,
        visible: s.visible,
      }))
    }
  } catch {
    // ignore parse / storage errors
  }
  return COL_CATALOG.map((c) => ({ key: c.key, label: c.label, visible: true }))
}

/** Persist column prefs to localStorage. */
function saveColPrefs(cols: CustomizableColumn[]): void {
  try {
    localStorage.setItem(
      COL_PREFS_KEY,
      JSON.stringify(cols.map((c) => ({ key: c.key, visible: c.visible }))),
    )
  } catch {
    // ignore storage errors (private mode, quota exceeded, etc.)
  }
}

// ── Layout prefs (sticky columns + sort), driven by the Customise modal ──

const LAYOUT_PREFS_KEY = 'products-next:layout'

/** Full column registry for the Customise modal (locked product + actions frame
 *  the customizable middle). Order matches the grid: product · …middle… · actions. */
const PREF_ALL_COLUMNS: PreferencesColumnSpec[] = [
  { key: 'product', label: 'Product', locked: true },
  { key: 'channels', label: 'Channels' },
  { key: 'status', label: 'Status' },
  { key: 'available', label: 'Available' },
  { key: 'price', label: 'Price' },
  { key: 'actions', label: 'Actions', locked: true },
]

/** Sort fields offered in the Customise modal (the grid's sortable columns). */
const SORT_FIELD_OPTIONS = [
  { value: 'product', label: 'Product name' },
  { value: 'available', label: 'Available stock' },
  { value: 'price', label: 'Price' },
]

interface LayoutPrefs {
  stickyFirst: boolean
  stickyLast: boolean
  sortBy: string
  sortDir: 'asc' | 'desc'
}

const DEFAULT_LAYOUT: LayoutPrefs = {
  stickyFirst: true,
  stickyLast: true,
  sortBy: 'product',
  sortDir: 'asc',
}

function loadLayoutPrefs(): LayoutPrefs {
  try {
    const raw = typeof window !== 'undefined' && localStorage.getItem(LAYOUT_PREFS_KEY)
    if (raw) return { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Partial<LayoutPrefs>) }
  } catch {
    // ignore
  }
  return DEFAULT_LAYOUT
}

function saveLayoutPrefs(p: LayoutPrefs): void {
  try {
    localStorage.setItem(LAYOUT_PREFS_KEY, JSON.stringify(p))
  } catch {
    // ignore
  }
}

// ─────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────

function getStatusTone(status: string): Tone {
  if (status === 'ACTIVE') return 'success'
  if (status === 'DRAFT') return 'neutral'
  return 'danger'
}

function getStatusLabel(status: string): string {
  if (status === 'ACTIVE') return 'Active'
  if (status === 'DRAFT') return 'Draft'
  return 'Inactive'
}

function fmtEur(price: number): string {
  return `€${price.toFixed(2)}`
}

/**
 * Client-side CSV export of the given rows (mirrors the live /products export).
 * No API call — builds a quoted CSV and triggers a download.
 */
function exportProductsCsv(rows: ProductRow[]): void {
  const header = [
    'SKU', 'Name', 'Brand', 'Type', 'Status', 'Price', 'Stock', 'Low @',
    'Fulfillment', 'Photos', 'Channels listed', 'Channel coverage', 'Tags',
    'Variants', 'Is parent', 'Parent ID', 'Updated', 'Created', 'ID',
  ]
  const matrix: string[][] = [header]
  for (const p of rows) {
    if (isLoadingRow(p)) continue
    const coverageCells = Object.entries(p.coverage ?? {}).map(
      ([ch, c]) => `${ch}:${c.live}/${c.total}`,
    )
    matrix.push([
      p.sku,
      p.name,
      p.brand ?? '',
      p.productType ?? '',
      p.status,
      p.basePrice.toFixed(2),
      String(p.totalStock),
      String(p.lowStockThreshold),
      p.fulfillmentMethod ?? '',
      String(p.photoCount),
      String(p.channelCount),
      coverageCells.join(','),
      (p.tags ?? []).map((t) => t.name).join('|'),
      String(p.variantCount),
      p.isParent ? 'true' : '',
      p.parentId ?? '',
      p.updatedAt,
      p.createdAt,
      p.id,
    ])
  }
  const csv = matrix
    .map((r) =>
      r
        .map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
        .join(','),
    )
    .join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `products-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Maps the page's local density modes to the shared DS Density type. */
function mapDensity(d: DensityMode): Density {
  if (d === 'compact') return 'compact'
  if (d === 'spacious') return 'spacious'
  return 'comfortable' // 'cozy' → 'comfortable'
}

function getCov(row: ProductRow, ch: Channel) {
  return row.coverage?.[ch] ?? null
}

// ─────────────────────────────────────────────────────────────────
// Expansion helpers
// ─────────────────────────────────────────────────────────────────

/** Sentinel row inserted in displayRows while children are being fetched. */
function makeLoadingRow(parentId: string): ProductRow {
  return {
    id: `__loading_${parentId}`,
    sku: '',
    name: '__loading__',
    brand: null,
    basePrice: 0,
    totalStock: 0,
    lowStockThreshold: 0,
    status: 'ACTIVE',
    syncChannels: [],
    imageUrl: null,
    amazonAsin: null,
    isParent: false,
    parentId,
    productType: null,
    fulfillmentMethod: null,
    family: null,
    workflowStage: null,
    photoCount: 0,
    channelCount: 0,
    variantCount: 0,
    childCount: 0,
    coverage: null,
    updatedAt: '',
    createdAt: '',
  }
}

function isLoadingRow(row: ProductRow) {
  return row.id.startsWith('__loading_')
}

// ─────────────────────────────────────────────────────────────────
// Sort header (used as column label for manually-sorted columns)
// ─────────────────────────────────────────────────────────────────

interface SortHeaderProps {
  label: string
  colKey: string
  sortKey: string
  sortDir: 'asc' | 'desc'
  onSort: (key: string) => void
}

function SortHeader({ label, colKey, sortKey, sortDir, onSort }: SortHeaderProps) {
  const active = sortKey === colKey
  return (
    <button
      type="button"
      className={`${styles.sortHeaderBtn}${active ? ' ' + styles.sortHeaderBtnActive : ''}`}
      onClick={() => onSort(colKey)}
    >
      {label}
      {active ? (
        sortDir === 'asc' ? (
          <ChevronDown size={13} style={{ color: 'var(--color-primary)' }} />
        ) : (
          <ChevronDown size={13} style={{ color: 'var(--color-primary)', transform: 'rotate(180deg)' }} />
        )
      ) : (
        <ChevronsUpDown size={13} style={{ color: 'var(--text-disabled)' }} />
      )}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────
// Sub-components (module-level so they don't re-mount on each render)
// ─────────────────────────────────────────────────────────────────

/**
 * Centered SVG checkbox. Renders as an inline-flex button so the check
 * mark is guaranteed centred via flexbox — no browser-native checkbox
 * styling needed, no DS file edits required.
 */
interface CkbProps {
  checked: boolean
  indeterminate?: boolean
  onChange: () => void
  label?: string
}
function Ckb({ checked, indeterminate, onChange, label }: CkbProps) {
  const on = checked || indeterminate
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label ?? 'Select row'}
      onClick={onChange}
      className={`${styles.ckb}${on ? ' ' + styles.ckbOn : ''}`}
    >
      {on && (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ display: 'block' }}>
          {indeterminate ? (
            <path d="M2.5 5h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          ) : (
            <path
              d="M2 5.2L4.2 7.4L8 3"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>
      )}
    </button>
  )
}

/** Product column cell: chevron + thumb + name + sku + category tag + variation count */
interface ProductCellProps {
  row: ProductRow
  /** True when this row is a child (indents the whole cell) */
  isChild?: boolean
  /** True when this parent row has expandable children */
  hasChildren?: boolean
  /** True when this parent is currently expanded */
  isExpanded?: boolean
  /** True while children are being fetched (shows spinner instead of chevron) */
  isLoadingExpand?: boolean
  /** Called when the chevron is clicked */
  onExpand?: () => void
}

function ProductCell({
  row,
  isChild,
  hasChildren,
  isExpanded,
  isLoadingExpand,
  onExpand,
}: ProductCellProps) {
  return (
    <div
      className={[styles.productCell, isChild ? styles.productCellChild : '']
        .filter(Boolean)
        .join(' ')}
    >
      {/* Chevron affordance — only shown on parent rows */}
      {hasChildren ? (
        <button
          type="button"
          className={styles.expandBtn}
          onClick={onExpand}
          aria-label={isExpanded ? 'Collapse variations' : 'Expand variations'}
          aria-expanded={isExpanded}
        >
          {isLoadingExpand ? (
            <span className={styles.expandSpinner} />
          ) : isExpanded ? (
            <ChevronDown size={14} />
          ) : (
            <ChevronRight size={14} />
          )}
        </button>
      ) : (
        /* invisible placeholder keeps thumb column aligned across all rows */
        <span className={styles.expandPlaceholder} aria-hidden />
      )}
      <Thumbnail src={row.imageUrl} photoCount={row.photoCount} alt={row.name} />
      <div className={styles.pmeta}>
        <div className={styles.ptitle}>{row.name}</div>
        <div className={styles.psub}>
          <span className={styles.skuTag}>{row.sku}</span>
          {row.productType && (
            <span className={styles.typeTag}>{row.productType}</span>
          )}
          {!isChild && (row.variantCount ?? 0) > 0 && (
            <span className={styles.varCount}>{row.variantCount} variations</span>
          )}
        </div>
      </div>
    </div>
  )
}

/** Row action cluster: Edit link + ⋯ DS Menu */
function RowActions({ row, onDuplicate }: { row: ProductRow; onDuplicate: (id: string) => void }) {
  const router = useRouter()
  const menuItems: MenuItemDef[] = [
    {
      id: 'edit',
      label: 'Edit',
      onSelect: () => router.push(`/products/${row.id}/edit`),
    },
    { id: 'duplicate', label: 'Duplicate', onSelect: () => onDuplicate(row.id) },
    {
      id: 'open-new',
      label: 'Open in new tab',
      onSelect: () => window.open(`/products/${row.id}/edit`, '_blank'),
    },
  ]

  return (
    <div className={styles.rowacts}>
      <Link href={`/products/${row.id}/edit`} className={styles.editLink}>
        Edit
      </Link>
      <Menu
        label="⋯"
        items={menuItems}
        align="right"
        triggerProps={{ className: styles.menuTrigger }}
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Inner component (uses DS toast context)
// ─────────────────────────────────────────────────────────────────

function ProductsNextInner() {
  const { toast } = useToast()

  // ── State ─────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<ProductFilters>(EMPTY_FILTERS)
  const [density, setDensity] = useState<DensityMode>('spacious')
  const [activeTile, setActiveTile] = useState<KpiTileKey>(null)
  // Two-click confirm for the (reversible) bulk soft-delete.
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Variation expansion — children are lazy-fetched on first expand and
  // cached; collapsing re-hides without evicting the cache.
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  const [childrenByParent, setChildrenByParent] = useState<Record<string, ProductRow[]>>({})
  const [loadingChildren, setLoadingChildren] = useState<Set<string>>(new Set())

  // Layout prefs (sticky columns + sort) — persisted; seed the sort + sticky state.
  const initialLayout = useMemo(loadLayoutPrefs, [])

  // Manual sort state (DataGrid re-sort is disabled so children stay grouped)
  const [sortKey, setSortKey] = useState<string>(initialLayout.sortBy)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(initialLayout.sortDir)

  // Sticky first (product) / last (actions) column, driven by the Customise modal.
  const [stickyFirst, setStickyFirst] = useState(initialLayout.stickyFirst)
  const [stickyLast, setStickyLast] = useState(initialLayout.stickyLast)

  // Column visibility + order (persisted to localStorage)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const [customCols, setCustomCols] = useState<CustomizableColumn[]>(loadColPrefs)

  // Inventory editor modal
  const [modalRow, setModalRow] = useState<ProductRow | null>(null)

  // ── Data ──────────────────────────────────────────────────────
  const { data, loading } = usePolledList<{
    products: ProductRow[]
    stats: {
      total: number
      active: number
      draft: number
      inStock: number
      outOfStock: number
    }
    total: number
    totalPages: number
  }>({
    url: POLL_URL,
    intervalMs: 30_000,
    invalidationTypes: [
      'product.updated',
      'product.created',
      'product.deleted',
      'stock.adjusted',
      'listing.updated',
    ],
  })

  const products = data?.products ?? []
  const stats = data?.stats

  // ── Derived counts ─────────────────────────────────────────────
  const needsAttentionCount = useMemo(
    () => products.filter((r) => r.photoCount === 0).length,
    [products],
  )

  // Distinct filter options derived from the loaded rows (client-side facets).
  const facetOptions = useMemo(() => {
    const types = new Set<string>()
    const brands = new Set<string>()
    const tags = new Set<string>()
    const families = new Map<string, string>()
    const stages = new Map<string, string>()
    for (const p of products) {
      if (p.productType) types.add(p.productType)
      if (p.brand) brands.add(p.brand)
      for (const t of p.tags ?? []) tags.add(t.name)
      if (p.family) families.set(p.family.code, p.family.label)
      if (p.workflowStage) stages.set(p.workflowStage.code, p.workflowStage.label)
    }
    const byStr = (a: string, b: string) => a.localeCompare(b)
    return {
      types: [...types].sort(byStr),
      brands: [...brands].sort(byStr),
      tags: [...tags].sort(byStr),
      families: [...families.entries()].sort((a, b) => a[1].localeCompare(b[1])),
      stages: [...stages.entries()].sort((a, b) => a[1].localeCompare(b[1])),
    }
  }, [products])

  // ── Client-side filter (200 rows max — fits in memory) ─────────
  const filtered = useMemo(() => {
    let rows = products

    // KPI tile filter
    if (activeTile === 'active') rows = rows.filter((r) => r.status === 'ACTIVE')
    else if (activeTile === 'out-of-stock') rows = rows.filter((r) => r.totalStock === 0)
    else if (activeTile === 'attention') rows = rows.filter((r) => r.photoCount === 0)

    // Filter bar (every dimension narrows independently; multiselects are OR within / AND across)
    const f = filters
    rows = rows.filter((r) => {
      if (f.channels.length && !f.channels.some((ch) => (getCov(r, ch as Channel)?.total ?? 0) > 0)) return false
      if (f.status.length && !f.status.includes(r.status)) return false
      if (f.stock.length) {
        const lvl = r.totalStock === 0 ? 'out' : r.totalStock <= r.lowStockThreshold ? 'low' : 'in'
        if (!f.stock.includes(lvl)) return false
      }
      if (f.fulfillment.length && !(r.fulfillmentMethod && f.fulfillment.includes(r.fulfillmentMethod))) return false
      if (f.productTypes.length && !(r.productType && f.productTypes.includes(r.productType))) return false
      if (f.brands.length && !(r.brand && f.brands.includes(r.brand))) return false
      if (f.tags.length && !(r.tags ?? []).some((t) => f.tags.includes(t.name))) return false
      if (f.families.length && !(r.family && f.families.includes(r.family.code))) return false
      if (f.workflowStages.length && !(r.workflowStage && f.workflowStages.includes(r.workflowStage.code))) return false
      // "Missing channel" = not listed on ANY of the selected channels
      if (f.missingChannels.length && !f.missingChannels.some((ch) => (getCov(r, ch as Channel)?.total ?? 0) === 0)) return false
      if (f.priceMin && r.basePrice < Number(f.priceMin)) return false
      if (f.priceMax && r.basePrice > Number(f.priceMax)) return false
      if (f.stockMin && r.totalStock < Number(f.stockMin)) return false
      if (f.stockMax && r.totalStock > Number(f.stockMax)) return false
      return true
    })

    // Text search
    if (search.trim()) {
      const q = search.toLowerCase()
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.sku.toLowerCase().includes(q) ||
          (r.productType?.toLowerCase().includes(q) ?? false),
      )
    }

    return rows
  }, [products, activeTile, filters, search])

  // ── Sorted + interleaved display rows ─────────────────────────
  // Only top-level rows (parentId === null) are shown by default.
  // When a parent is expanded, its fetched children are interleaved
  // immediately after it. DataGrid receives this pre-ordered array
  // WITHOUT initialSort so it never re-sorts and scatters children.
  const displayRows = useMemo(() => {
    const topLevel = filtered.filter((r) => r.parentId === null)

    // Sort parents by active sort key
    const sorted = [...topLevel].sort((a, b) => {
      let av: string | number
      let bv: string | number
      if (sortKey === 'available') {
        av = a.totalStock
        bv = b.totalStock
      } else if (sortKey === 'price') {
        av = a.basePrice
        bv = b.basePrice
      } else {
        // default: sort by name (product column)
        av = a.name.toLowerCase()
        bv = b.name.toLowerCase()
      }
      const dir = sortDir === 'asc' ? 1 : -1
      return av < bv ? -dir : av > bv ? dir : 0
    })

    // Interleave children / loading sentinels under each expanded parent
    const result: ProductRow[] = []
    for (const parent of sorted) {
      result.push(parent)
      if (expandedParents.has(parent.id)) {
        if (loadingChildren.has(parent.id)) {
          result.push(makeLoadingRow(parent.id))
        } else {
          result.push(...(childrenByParent[parent.id] ?? []))
        }
      }
    }
    return result
  }, [filtered, sortKey, sortDir, expandedParents, loadingChildren, childrenByParent])

  // ── Selection ─────────────────────────────────────────────────
  // allKeys includes visible children (when expanded) but excludes
  // loading sentinels so select-all doesn't try to select a phantom row.
  const allKeys = useMemo(
    () => displayRows.filter((r) => !isLoadingRow(r)).map((r) => r.id),
    [displayRows],
  )
  const allSelected = selected.size > 0 && allKeys.every((k) => selected.has(k))
  const someSelected = selected.size > 0 && !allSelected

  const toggleAll = useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(allKeys))
  }, [allSelected, allKeys])

  const toggleRow = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  // ── Mutations (real backend calls, mirroring the live /products page) ──
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const selectedIds = useMemo(() => [...selected], [selected])

  // Tags for the bulk "Tag" menu — fetched once (they change rarely).
  const [allTags, setAllTags] = useState<Tag[]>([])
  useEffect(() => {
    let cancelled = false
    fetch(`${getBackendUrl()}/api/tags`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { items?: Tag[] }) => { if (!cancelled) setAllTags(d.items ?? []) })
      .catch(() => { /* tags are optional; menu shows an empty hint */ })
    return () => { cancelled = true }
  }, [])

  /** Run a bulk mutation against the backend, then broadcast so the grid (and
   *  every other open tab) refetches via the invalidation channel. */
  const runBulk = useCallback(
    async (
      label: string,
      path: string,
      body: Record<string, unknown>,
      ids: string[],
      source: string,
      opts?: { clearSelection?: boolean },
    ) => {
      if (!ids.length || busy) return
      setBusy(true)
      try {
        const res = await fetch(`${getBackendUrl()}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const msg = await res.json().catch(() => ({}))
          throw new Error((msg as { error?: string }).error ?? `HTTP ${res.status}`)
        }
        emitInvalidation({ type: 'product.updated', meta: { productIds: ids, source } })
        toast(label, 'success')
        if (opts?.clearSelection !== false) setSelected(new Set())
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Action failed', 'danger')
      } finally {
        setBusy(false)
      }
    },
    [busy, toast],
  )

  // Tag: add a tag to the selected products. Selection is kept so the operator
  // can apply several tags in a row.
  const tagBulk = useCallback(
    (tag: Tag) =>
      runBulk(
        `Tagged ${selectedIds.length} with “${tag.name}”`,
        '/api/products/bulk-tag',
        { productIds: selectedIds, tagIds: [tag.id], mode: 'add' },
        selectedIds,
        'bulk-tag',
        { clearSelection: false },
      ),
    [runBulk, selectedIds],
  )

  // Publish: resolve the selected products to their listings on the target
  // channel/marketplace, then enqueue a publish bulk-action (2-step, like the
  // live page). Products with no listing on that channel are reported.
  const publishBulk = useCallback(
    async (channel: string, marketplace: string, label: string) => {
      if (!selectedIds.length || busy) return
      setBusy(true)
      try {
        const params = new URLSearchParams({ channel, marketplace, includeCoverage: 'false', pageSize: '500' })
        const foundRes = await fetch(`${getBackendUrl()}/api/listings?${params.toString()}`)
        if (!foundRes.ok) {
          const b = await foundRes.json().catch(() => ({}))
          throw new Error((b as { error?: string }).error ?? `Failed to load listings (${foundRes.status})`)
        }
        const found = (await foundRes.json()) as { listings?: Array<{ id: string; productId: string }> }
        const listingIds = (found.listings ?? [])
          .filter((l) => selectedIds.includes(l.productId))
          .map((l) => l.id)
        if (listingIds.length === 0) {
          throw new Error(`No existing listings on ${label} — create them in the listing wizard first`)
        }
        const res = await fetch(`${getBackendUrl()}/api/listings/bulk-action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'publish', listingIds }),
        })
        if (!res.ok) {
          const b = await res.json().catch(() => ({}))
          throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`)
        }
        emitInvalidation({ type: 'listing.updated', meta: { listingIds, source: 'products-publish', channel, marketplace } })
        emitInvalidation({ type: 'bulk-job.completed', meta: { action: 'publish', listingIds } })
        toast(`Queued publish of ${listingIds.length} to ${label}`, 'success')
        setSelected(new Set())
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Publish failed', 'danger')
      } finally {
        setBusy(false)
      }
    },
    [busy, selectedIds, toast],
  )

  // Menu items for the bulk Tag + Publish dropdowns (DS Menu).
  const tagMenuItems = useMemo<MenuItemDef[]>(() => {
    if (allTags.length === 0) return [{ id: '_empty', label: 'No tags yet', disabled: true }]
    return allTags.map((t) => ({
      id: t.id,
      label: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 8, height: 8, borderRadius: '50%', flex: 'none',
              background: t.color ?? 'var(--text-tertiary)',
            }}
          />
          {t.name}
        </span>
      ),
      onSelect: () => void tagBulk(t),
    }))
  }, [allTags, tagBulk])

  const publishMenuItems = useMemo<MenuItemDef[]>(
    () =>
      PUBLISH_DESTINATIONS.map((d) => ({
        id: `${d.channel}-${d.marketplace}`,
        label: d.label,
        onSelect: () => void publishBulk(d.channel, d.marketplace, d.label),
      })),
    [publishBulk],
  )

  const setStatusBulk = useCallback(
    (status: 'ACTIVE' | 'DRAFT' | 'INACTIVE') =>
      runBulk(
        `Marked ${selectedIds.length} ${status.toLowerCase()}`,
        '/api/products/bulk-status',
        { productIds: selectedIds, status },
        selectedIds,
        'bulk-status',
      ),
    [runBulk, selectedIds],
  )

  const duplicateBulk = useCallback(
    (ids: string[]) =>
      runBulk(
        `Duplicated ${ids.length} ${ids.length === 1 ? 'product' : 'products'}`,
        '/api/products/bulk-duplicate',
        { productIds: ids },
        ids,
        'bulk-duplicate',
      ),
    [runBulk],
  )

  const softDeleteBulk = useCallback(
    () =>
      runBulk(
        `Moved ${selectedIds.length} to recycle bin`,
        '/api/products/bulk-soft-delete',
        { productIds: selectedIds },
        selectedIds,
        'bulk-soft-delete',
      ),
    [runBulk, selectedIds],
  )

  // ── Variation expansion ───────────────────────────────────────
  const fetchChildrenFor = useCallback(async (parentId: string) => {
    if (childrenByParent[parentId] !== undefined) return // cache hit
    setLoadingChildren((prev) => {
      const next = new Set(prev)
      next.add(parentId)
      return next
    })
    try {
      const url = `${getBackendUrl()}/api/products?parentId=${encodeURIComponent(parentId)}&includeCoverage=true&includeTags=true`
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`${res.status}`)
      const data = (await res.json()) as { products?: ProductRow[] }
      setChildrenByParent((prev) => ({ ...prev, [parentId]: data.products ?? [] }))
    } catch {
      // Mark as fetched but empty so re-expand shows nothing rather than spinning
      setChildrenByParent((prev) => ({ ...prev, [parentId]: [] }))
    } finally {
      setLoadingChildren((prev) => {
        const next = new Set(prev)
        next.delete(parentId)
        return next
      })
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

  // ── Manual column sort (keeps children grouped under their parent) ─
  // DataGrid's built-in sort is disabled (no initialSort passed) so the
  // pre-ordered displayRows array is rendered as-is. Toggling a sort
  // header only updates local state which drives displayRows below.
  const handleColumnSort = useCallback((key: string) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
        return prev
      }
      setSortDir('asc')
      return key
    })
  }, [])

  // ── Column definitions ────────────────────────────────────────
  // NOTE: sortable/sortValue are intentionally omitted from all columns.
  // DataGrid's built-in sort is disabled (no initialSort) so the
  // pre-ordered displayRows array is not re-sorted. Sort headers are
  // custom SortHeader elements that update local sortKey/sortDir state.
  //
  // Structure:
  //   [_sel (locked)] [product (locked)] [...visible customizable cols in user order] [actions (locked)]
  // Customizable cols (channels · status · available · price) are driven by
  // `customCols` state (visibility + order) which is persisted to localStorage.
  const columns = useMemo(
    (): Column<ProductRow>[] => {
      // ── Locked: selection checkbox ──────────────────────────
      const selCol: Column<ProductRow> = {
        key: '_sel',
        label: (
          <Ckb
            checked={allSelected}
            indeterminate={someSelected}
            onChange={toggleAll}
            label="Select all rows"
          />
        ),
        width: 40,
        align: 'center',
        render: (row) => {
          if (isLoadingRow(row)) return null
          return (
            <Ckb
              checked={selected.has(row.id)}
              onChange={() => toggleRow(row.id)}
            />
          )
        },
      }

      // ── Locked: product name / thumb ────────────────────────
      const productCol: Column<ProductRow> = {
        key: 'product',
        label: (
          <SortHeader
            label="Product"
            colKey="product"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleColumnSort}
          />
        ),
        render: (row) => {
          if (isLoadingRow(row)) {
            return (
              <div className={styles.childLoadingRow}>
                <span className={styles.expandSpinner} />
                Loading variations…
              </div>
            )
          }
          const isChild = row.parentId !== null
          const hasChildren = row.isParent || (row.childCount ?? 0) > 0
          return (
            <ProductCell
              row={row}
              isChild={isChild}
              hasChildren={!isChild && hasChildren}
              isExpanded={expandedParents.has(row.id)}
              isLoadingExpand={loadingChildren.has(row.id)}
              onExpand={() => toggleExpand(row.id)}
            />
          )
        },
      }

      // ── Locked: row actions ─────────────────────────────────
      const actionsCol: Column<ProductRow> = {
        key: 'actions',
        label: '',
        width: 120,
        render: (row) => {
          if (isLoadingRow(row)) return null
          return <RowActions row={row} onDuplicate={(id) => void duplicateBulk([id])} />
        },
      }

      // ── All customizable column defs (keyed by catalog key) ─
      const customColDefs: Record<string, Column<ProductRow>> = {
        channels: {
          key: 'channels',
          label: 'Channels',
          width: 110,
          render: (row) => {
            if (isLoadingRow(row)) return null
            return (
              <div className={styles.chcell}>
                {CHANNELS.map((ch) => {
                  const cov = getCov(row, ch)
                  const state =
                    cov && cov.live > 0
                      ? 'on'
                      : cov && cov.error > 0
                        ? 'iss'
                        : 'off'
                  const stateClass =
                    state === 'on'
                      ? styles.chOn
                      : state === 'iss'
                        ? styles.chIss
                        : styles.chOff
                  const tipLabel = cov
                    ? `${cov.live} live · ${cov.error} errors`
                    : 'not listed'
                  return (
                    <Tooltip key={ch} label={`${ch}: ${tipLabel}`}>
                      <span className={`${styles.ch} ${stateClass}`}>
                        {ch[0]}
                      </span>
                    </Tooltip>
                  )
                })}
              </div>
            )
          },
        },
        status: {
          key: 'status',
          label: 'Status',
          width: 96,
          render: (row) => {
            if (isLoadingRow(row)) return null
            return (
              <Pill tone={getStatusTone(row.status)}>
                {getStatusLabel(row.status)}
              </Pill>
            )
          },
        },
        available: {
          key: 'available',
          label: (
            <SortHeader
              label="Available"
              colKey="available"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleColumnSort}
            />
          ),
          width: 120,
          render: (row) => {
            if (isLoadingRow(row)) return null
            return <InventoryCell row={row} onOpen={setModalRow} />
          },
        },
        price: {
          key: 'price',
          label: (
            <SortHeader
              label="Price"
              colKey="price"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleColumnSort}
            />
          ),
          width: 96,
          align: 'right',
          render: (row) => {
            if (isLoadingRow(row)) return null
            return (
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {fmtEur(row.basePrice)}
              </span>
            )
          },
        },
      }

      // ── Derive ordered visible customizable columns ─────────
      const visibleCustom = customCols
        .filter((c) => c.visible)
        .map((c) => customColDefs[c.key])
        .filter((c): c is Column<ProductRow> => !!c)

      return [selCol, productCol, ...visibleCustom, actionsCol]
    },
    [
      allSelected,
      someSelected,
      selected,
      toggleAll,
      toggleRow,
      duplicateBulk,
      sortKey,
      sortDir,
      handleColumnSort,
      expandedParents,
      loadingChildren,
      toggleExpand,
      customCols,
    ],
  )

  // ── KPI tile config ────────────────────────────────────────────
  const kpis: Array<{
    tileKey: KpiTileKey
    label: string
    value: number | string
    hint: string
    color: string
  }> = [
    {
      tileKey: null,
      label: 'Total',
      value: stats?.total ?? '—',
      hint: 'all statuses',
      color: 'var(--color-primary)',
    },
    {
      tileKey: 'active',
      label: 'Active',
      value: stats?.active ?? '—',
      hint: 'live & selling',
      color: 'var(--status-success-line)',
    },
    {
      tileKey: 'out-of-stock',
      label: 'Out of stock',
      value: stats?.outOfStock ?? '—',
      hint: 'no available units',
      color: 'var(--status-danger-line)',
    },
    {
      tileKey: 'attention',
      label: 'Needs attention',
      value: needsAttentionCount,
      hint: 'photos · GTIN · description',
      color: 'var(--status-warning-line)',
    },
  ]

  // ── Filter bar config ──────────────────────────────────────────
  const setF = useCallback(
    <K extends keyof ProductFilters>(key: K, value: ProductFilters[K]) => {
      setFilters((prev) => ({ ...prev, [key]: value }))
    },
    [],
  )

  const activeFilterCount = useMemo(() => {
    const f = filters
    return (
      f.channels.length +
      f.status.length +
      f.stock.length +
      f.fulfillment.length +
      f.productTypes.length +
      f.brands.length +
      f.tags.length +
      f.families.length +
      f.workflowStages.length +
      f.missingChannels.length +
      (f.priceMin || f.priceMax ? 1 : 0) +
      (f.stockMin || f.stockMax ? 1 : 0)
    )
  }, [filters])

  const CHANNEL_OPTS = [
    { value: 'AMAZON', label: 'Amazon' },
    { value: 'EBAY', label: 'eBay' },
    { value: 'SHOPIFY', label: 'Shopify' },
  ]

  const filterDimensions = useMemo<FilterDimension[]>(() => {
    const dims: FilterDimension[] = [
      { key: 'channels', label: 'Channel', kind: 'multiselect', value: filters.channels, onChange: (v) => setF('channels', v), options: CHANNEL_OPTS },
      {
        key: 'status',
        label: 'Status',
        kind: 'multiselect',
        value: filters.status,
        onChange: (v) => setF('status', v),
        options: [
          { value: 'ACTIVE', label: 'Active' },
          { value: 'DRAFT', label: 'Draft' },
          { value: 'INACTIVE', label: 'Inactive' },
        ],
      },
      {
        key: 'stock',
        label: 'Stock',
        kind: 'multiselect',
        value: filters.stock,
        onChange: (v) => setF('stock', v),
        options: [
          { value: 'in', label: 'In stock' },
          { value: 'low', label: 'Low stock' },
          { value: 'out', label: 'Out of stock' },
        ],
      },
      {
        key: 'fulfillment',
        label: 'Fulfilment',
        kind: 'multiselect',
        value: filters.fulfillment,
        onChange: (v) => setF('fulfillment', v),
        options: [
          { value: 'FBA', label: 'FBA' },
          { value: 'FBM', label: 'FBM' },
        ],
      },
    ]
    if (facetOptions.types.length)
      dims.push({ key: 'productTypes', label: 'Product type', kind: 'multiselect', value: filters.productTypes, onChange: (v) => setF('productTypes', v), options: facetOptions.types.map((t) => ({ value: t, label: t })) })
    if (facetOptions.brands.length)
      dims.push({ key: 'brands', label: 'Brand', kind: 'multiselect', value: filters.brands, onChange: (v) => setF('brands', v), options: facetOptions.brands.map((b) => ({ value: b, label: b })) })
    if (facetOptions.tags.length)
      dims.push({ key: 'tags', label: 'Tags', kind: 'multiselect', value: filters.tags, onChange: (v) => setF('tags', v), options: facetOptions.tags.map((t) => ({ value: t, label: t })) })
    if (facetOptions.families.length)
      dims.push({ key: 'families', label: 'Family', kind: 'multiselect', value: filters.families, onChange: (v) => setF('families', v), options: facetOptions.families.map(([code, label]) => ({ value: code, label })) })
    if (facetOptions.stages.length)
      dims.push({ key: 'workflowStages', label: 'Workflow stage', kind: 'multiselect', value: filters.workflowStages, onChange: (v) => setF('workflowStages', v), options: facetOptions.stages.map(([code, label]) => ({ value: code, label })) })
    dims.push({ key: 'missingChannels', label: 'Missing channel', kind: 'multiselect', value: filters.missingChannels, onChange: (v) => setF('missingChannels', v), options: CHANNEL_OPTS })
    dims.push({ key: 'price', label: 'Price', kind: 'range', unit: '€', min: filters.priceMin, max: filters.priceMax, onChange: (min, max) => setFilters((p) => ({ ...p, priceMin: min, priceMax: max })) })
    dims.push({ key: 'stockUnits', label: 'Stock units', kind: 'range', min: filters.stockMin, max: filters.stockMax, onChange: (min, max) => setFilters((p) => ({ ...p, stockMin: min, stockMax: max })) })
    return dims
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, facetOptions, setF])

  // ── Toolbar counts (top-level products only; children ride with parents) ──
  const totalCount = useMemo(() => products.filter((p) => p.parentId === null).length, [products])
  const shownCount = useMemo(
    () => displayRows.filter((r) => !isLoadingRow(r) && r.parentId === null).length,
    [displayRows],
  )

  // Drop the delete confirmation if the selection is cleared elsewhere.
  useEffect(() => {
    if (selected.size === 0 && confirmDelete) setConfirmDelete(false)
  }, [selected, confirmDelete])

  // ── Customise modal (column visibility/order + sticky + sort) ──
  const prefsValue = useMemo<PreferencesValue>(
    () => ({
      visibleColumns: customCols.filter((c) => c.visible).map((c) => c.key),
      stickyFirstColumn: stickyFirst,
      stickyLastColumn: stickyLast,
      pageSize: 100, // unused — products/next loads all rows client-side
      sortBy: sortKey,
      sortDir,
    }),
    [customCols, stickyFirst, stickyLast, sortKey, sortDir],
  )

  const applyPrefs = useCallback((next: PreferencesValue) => {
    // Rebuild the customizable column list: visible (in chosen order) then hidden.
    const visibleSet = new Set(next.visibleColumns)
    const rebuilt: CustomizableColumn[] = [
      ...next.visibleColumns
        .map((k) => COL_CATALOG.find((c) => c.key === k))
        .filter((c): c is (typeof COL_CATALOG)[number] => !!c)
        .map((c) => ({ key: c.key, label: c.label, visible: true })),
      ...COL_CATALOG.filter((c) => !visibleSet.has(c.key)).map((c) => ({ key: c.key, label: c.label, visible: false })),
    ]
    setCustomCols(rebuilt)
    saveColPrefs(rebuilt)
    setStickyFirst(next.stickyFirstColumn)
    setStickyLast(next.stickyLastColumn)
    setSortKey(next.sortBy)
    setSortDir(next.sortDir)
    saveLayoutPrefs({
      stickyFirst: next.stickyFirstColumn,
      stickyLast: next.stickyLastColumn,
      sortBy: next.sortBy,
      sortDir: next.sortDir,
    })
  }, [])

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className={styles.wrap}>
      {/* Page header */}
      <PageHeader
        title="Products"
        subtitle={`${stats?.total ?? '—'} products · synced live across Amazon, eBay & Shopify`}
        actions={
          <div className={styles.acts}>
            <Button size="sm" onClick={() => router.push('/products/upload')}>
              <Upload size={13} /> Import
            </Button>
            <Button size="sm" variant="primary" onClick={() => router.push('/products/new')}>
              <Plus size={13} /> New product
            </Button>
          </div>
        }
      />

      {/* KPI tiles — click to filter rows client-side */}
      <div className={styles.kpis}>
        {kpis.map((kpi) => (
          <div
            key={kpi.tileKey ?? '_total'}
            className={[
              styles.kpiTile,
              activeTile === kpi.tileKey ? styles.kpiTileActive : '',
            ]
              .filter(Boolean)
              .join(' ')}
            role="button"
            tabIndex={0}
            onClick={() =>
              setActiveTile((prev) =>
                prev === kpi.tileKey ? null : kpi.tileKey,
              )
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setActiveTile((prev) =>
                  prev === kpi.tileKey ? null : kpi.tileKey,
                )
              }
            }}
          >
            <div className={styles.kpiLabel}>
              <span
                className={styles.kpiDot}
                style={{ background: kpi.color }}
              />
              {kpi.label}
            </div>
            <div className={styles.kpiValue}>{kpi.value}</div>
            <div className={styles.kpiHint}>{kpi.hint}</div>
          </div>
        ))}
      </div>

      {/* Filter bar — the DS FilterBar (collapsible, ads-manager parity).
          Hosts every client-side filter dimension; feature page owns only config. */}
      <div className={styles.filterBar}>
        <FilterBar
          dimensions={filterDimensions}
          activeCount={activeFilterCount}
          onClear={() => setFilters(EMPTY_FILTERS)}
        />
      </div>

      {/* One card: toolbar + grid share the grid rectangle (Ad-Manager parity).
          The toolbar's left slot swaps search ⇄ selection actions; the right
          slot carries density · Customise · Export · Live. */}
      <div className="h10-ds-gridcard">
        <GridToolbar
          count={
            selected.size > 0 ? (
              <>Selected <b>{selected.size}</b> {selected.size === 1 ? 'product' : 'products'}</>
            ) : (
              <>Viewing <b>{shownCount}</b> of <b>{totalCount}</b> products</>
            )
          }
          right={
            <>
              <SegmentedControl
                options={DENSITY_OPTIONS}
                value={density}
                onChange={(v) => setDensity(v as DensityMode)}
                size="sm"
              />
              <Button size="sm" onClick={() => setCustomizeOpen(true)}>
                <SlidersHorizontal size={13} /> Customise
              </Button>
              <Button
                size="sm"
                onClick={() => exportProductsCsv(displayRows)}
                disabled={shownCount === 0}
              >
                <Download size={13} /> Export
              </Button>
              <span className={styles.liveChip}>
                <span className={styles.liveDot} />
                {loading ? 'Syncing…' : 'Live'}
              </span>
            </>
          }
        >
          {selected.size > 0 ? (
            <span className={styles.selActions}>
              <Button size="sm" disabled={busy} onClick={() => setStatusBulk('ACTIVE')}>Activate</Button>
              <Button size="sm" disabled={busy} onClick={() => setStatusBulk('DRAFT')}>Draft</Button>
              <Button size="sm" disabled={busy} onClick={() => setStatusBulk('INACTIVE')}>Inactive</Button>
              <Menu
                label={<><TagIcon size={13} /> Tag <ChevronDown size={11} /></>}
                items={tagMenuItems}
                triggerProps={{ className: 'h10-ds-btn sm', disabled: busy }}
              />
              <Menu
                label={<><Send size={13} /> Publish <ChevronDown size={11} /></>}
                items={publishMenuItems}
                triggerProps={{ className: 'h10-ds-btn sm', disabled: busy }}
              />
              <Button size="sm" disabled={busy} onClick={() => duplicateBulk(selectedIds)}>
                <Copy size={13} /> Duplicate
              </Button>
              {confirmDelete ? (
                <Button size="sm" variant="primary" disabled={busy} onClick={() => { setConfirmDelete(false); void softDeleteBulk() }}>
                  Confirm delete
                </Button>
              ) : (
                <Button size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={13} /> Delete
                </Button>
              )}
              <button type="button" className={styles.clearSel} onClick={() => { setSelected(new Set()); setConfirmDelete(false) }}>
                Clear
              </button>
            </span>
          ) : (
            <span className={styles.searchField}>
              <Input
                leadingIcon={<Search size={13} style={{ color: 'var(--text-tertiary)' }} />}
                placeholder="Search products…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ width: '100%' }}
              />
            </span>
          )}
        </GridToolbar>

        {/* Data grid — DensityContext.Provider makes the shared Thumbnail
            size-aware, matching /products exactly (compact 32 / comfortable 40 /
            spacious 56). mapDensity bridges the page's 'cozy' to 'comfortable'. */}
        <DensityContext.Provider value={mapDensity(density)}>
          <div
            className={
              density === 'compact'
                ? styles.densityCompact
                : density === 'spacious'
                  ? styles.densitySpacious
                  : undefined
            }
          >
            <DataGrid<ProductRow>
              columns={columns}
              rows={displayRows}
              rowKey={(r) => r.id}
              selected={selected}
              emptyState={
                loading ? (
                  <span style={{ color: 'var(--text-tertiary)' }}>Loading…</span>
                ) : (
                  <span style={{ color: 'var(--text-tertiary)' }}>
                    No products match this filter.
                  </span>
                )
              }
            />
          </div>
        </DensityContext.Provider>
      </div>

      {/* Customise modal — two-panel preferences (columns · sticky · sort) */}
      <PreferencesModal
        open={customizeOpen}
        onClose={() => setCustomizeOpen(false)}
        value={prefsValue}
        onConfirm={applyPrefs}
        allColumns={PREF_ALL_COLUMNS}
        defaultVisible={COL_CATALOG.map((c) => c.key)}
        sortFieldOptions={SORT_FIELD_OPTIONS}
        pageSizeChoices={[]}
        showSticky={false}
      />

      {/* Inventory editor modal — opened by clicking the Available cell */}
      <InventoryEditorModal row={modalRow} onClose={() => setModalRow(null)} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Exported wrapper — provides DS ToastProvider for this subtree
// (the root layout's ToastProvider is from the old component
// library; DS toast needs its own context boundary).
// ─────────────────────────────────────────────────────────────────

export function ProductsNextClient() {
  return (
    <ToastProvider>
      <ProductsNextInner />
    </ToastProvider>
  )
}
