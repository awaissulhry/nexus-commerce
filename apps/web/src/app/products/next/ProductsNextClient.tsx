'use client'

// No design-system stylesheet imports here on purpose. The root layout (app/layout.tsx)
// loads tokens-global -> primitives -> components -> patterns -> a11y for the whole app, in
// that exact cascade order. This page used to re-import `tokens.css`, which additionally
// republishes the eleven platform aliases (--text-*, --surface-*, --border-*) at :root for as
// long as the page is mounted — the same names app/globals.css defines as Tailwind RGB
// channels. Nothing here needs them any more: this page's CSS is entirely on `--nds-*`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  MoreHorizontal,
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
import type { ProductRow, Tag as ProductTag } from '@/app/products/_types'
import { Thumbnail, DensityContext, type Density } from '@/app/_shared/grid-lens'

// DS Primitives
import {
  Button,
  Input,
  Pill,
  SegmentedControl,
  Spinner,
  Tag,
  type SegmentedOption,
  type Tone,
} from '@/design-system/primitives'
// DS Components
import {
  Banner,
  CoverageSummary,
  DataGrid,
  EmptyState,
  Menu,
  MetricStrip,
  ToastProvider,
  useToast,
  type Column,
  type MenuItemDef,
  type Metric,
} from '@/design-system/components'
// DS Patterns
import {
  FilterBar,
  GridToolbar,
  PageHeader,
  type FilterDimension,
} from '@/design-system/patterns'

// Canonical platform formatters — cents-based money, fixed locale so SSR and client agree.
import { eur0, num, formatDate } from '@/design-system/lib'

import styles from './styles.module.css'
import { InventoryCell } from './InventoryCell'
import { TagDialog } from './TagDialog'
import { InventoryEditorModal } from './InventoryEditorModal'
import { ProductsSkeleton } from './ProductsSkeleton'

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

// usePolledList prepends getBackendUrl() for any '/api/' path, so this hits the
// real backend (rich {products, stats} with coverage/tags), not the local Next
// stub route handler.
//
// `?parent=<id>` scopes the whole page to ONE variation family — the same grid, the same
// columns, the same filters, showing only that parent's variants. The endpoint scopes its
// `stats` block to the query too, so the KPI tiles report the family rather than the catalogue
// without this page doing anything: measured on AIREON, `{total: 40, active: 40, inStock: 18,
// outOfStock: 22}`.
/**
 * The Sales / Units window. ONE constant, so the two columns can never describe different
 * periods — they are the same fact counted two ways and must move together.
 *
 * Seven days. On this catalogue that is 4 products with sales out of 14 (31 orders, €2,255),
 * where 90 days shows 7 — a shorter window is a narrower truth, not a smaller number.
 */
const SALES_WINDOW_DAYS = 7

/** Every bulk endpoint rejects more than this with a 400. Mirrored here so the page can say so
 *  before the round trip rather than relaying the server's raw message after it. */
const BULK_MAX = 200

/** Which page warning the operator has already read and closed. Holds the warning's VALUE. */
const WARNING_DISMISS_KEY = 'products-next:dismissed-warning'

function pollUrlFor(parentId: string | null): string {
  const common = `limit=200&includeCoverage=true&includeTags=true&includeSales=true&salesDays=${SALES_WINDOW_DAYS}`
  return parentId
    ? `/api/products?parentId=${encodeURIComponent(parentId)}&${common}`
    : `/api/products?page=1&${common}`
}

const DENSITY_OPTIONS: SegmentedOption[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'cozy', label: 'Cozy' },
  { value: 'spacious', label: 'Spacious' },
]

/**
 * The density switch maps onto DataGrid's own `size` tiers instead of a stylesheet reaching in
 * with `:global(.nds-grid tbody td)`. The DS grew `lg`/`xl` specifically so a Compact / Cozy /
 * Spacious control would have somewhere to point — overriding the padding from outside left the
 * header, the font size and the empty state on the default tier while only the body cells moved.
 */
const GRID_SIZE: Record<DensityMode, 'xs' | 'md' | 'lg'> = {
  compact: 'xs',
  cozy: 'md',
  spacious: 'lg',
}

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

/** A parent's fetched variations: the capped preview, plus what the family really holds. */
interface ChildBatch {
  rows: ProductRow[]
  total: number
}
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
// Column preferences
// ─────────────────────────────────────────────────────────────────

/**
 * Where the operator's column order + visibility live. `DataGrid` owns the reading, the writing
 * and the reconciliation of columns added after they last opened the dialog — this page only
 * names the drawer.
 *
 * A FRESH key, not the two it replaces (`products-next:columns` holding `[{key,visible}]` and
 * `products-next:layout` holding sticky+sort). The DS stores a `PreferencesValue`, a different
 * shape under the same name; pointing at the old keys would have the grid read a record it can
 * only partly understand. Anyone who had customised these columns gets the default order once,
 * and the two dead keys are simply never read again.
 */
const GRID_PREFS_KEY = 'products-next:grid'

/**
 * How many variations a parent shows inline before handing off to the family surface.
 *
 * Ten, not "all of them". At Spacious a row is 85px, so AIREON's 40 children inline are ~3,400px
 * — about four screens — and the other 13 parents are gone from the list. Two expanded families
 * and the grid stops being a grid. It also sidesteps the server's 200-row ceiling, which this
 * page has no paging for: the full set belongs on the surface built to page it.
 *
 * Ten rather than the fifteen Seller Central shows, because these rows are taller and carry five
 * columns to Amazon's twelve — fifteen of ours is more scrolling for less information.
 */
const VARIATION_PREVIEW_CAP = 10

/**
 * The preview is sorted LOWEST STOCK FIRST, so the ten rows you get are the ten worth looking
 * at. An arbitrary prefix of a 40-variation family tells you nothing; Seller Central's does
 * exactly that. `sort=stock-asc` is the server's own key — verified against the live endpoint,
 * which returns the zero-stock children first where the default order returns 10, 10, 1, 10.
 */
const VARIATION_PREVIEW_SORT = 'stock-asc'

/** Sort fields offered in the Customise dialog — the grid's sortable columns. These are the same
 *  three the dialog carried before column prefs moved onto the grid; the headers sort too, and
 *  both drive one piece of state. */
const SORT_FIELD_OPTIONS = [
  { value: 'product', label: 'Product name' },
  { value: 'available', label: 'Available stock' },
  { value: 'price', label: 'Price' },
]

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
      String(p.childCount ?? 0),
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

/**
 * How many variations a parent has — from `childCount`, NOT `variantCount`.
 *
 * The API returns both and only one of them is real. `Product` carries TWO relations that both
 * sound like variations: `children Product[] @relation("ProductHierarchy")`, commented "Child
 * variations", which is the parent/child hierarchy this catalogue actually uses; and
 * `variations ProductVariation[]`, a separate table that is empty here. `products.routes.ts`
 * fills `variantCount` from `_count.variations` — the empty one — so it came back 0 for all 14
 * products while `childCount` read 40, 40, 10, 8, 8.
 *
 * That is why this label never appeared: it was gated on a field that is always zero. The
 * expand chevron beside it always worked, because it reads `childCount`. Same row, same
 * concept, two fields, one of them dead.
 */
function variationCount(row: ProductRow): number {
  return row.childCount ?? 0
}

// ─────────────────────────────────────────────────────────────────
// Sub-components (module-level so they don't re-mount on each render)
// ─────────────────────────────────────────────────────────────────

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
    <div className={styles.productCell}>
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
            <Spinner size={12} />
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
        {/* Title is a same-tab link to the editor; the "Open" pill (revealed
            on cell hover) opens the editor in a NEW tab. Styling mirrors the
            ads-manager campaign-name cell exactly (h10 blue #1f6fde). */}
        <div className={styles.ptitleRow}>
          <Link
            href={`/products/${row.id}/edit`}
            className={styles.ptitleLink}
            title={row.name}
            onClick={(e) => e.stopPropagation()}
          >
            {row.name}
          </Link>
          <a
            className={styles.openBtn}
            href={`/products/${row.id}/edit`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink size={11} /> Open
          </a>
        </div>
        <div className={styles.psub}>
          <span className={styles.skuTag}>{row.sku}</span>
          {row.productType && <Tag>{row.productType}</Tag>}
          {!isChild && variationCount(row) > 0 && (
            <span className={styles.varCount}>
              {variationCount(row)} {variationCount(row) === 1 ? 'variation' : 'variations'}
            </span>
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
      <Button asChild size="sm">
        <Link href={`/products/${row.id}/edit`}>Edit</Link>
      </Button>
      <Menu
        label={<MoreHorizontal size={15} />}
        items={menuItems}
        align="right"
        triggerProps={{ className: 'nds-btn sm icon', 'aria-label': `More actions for ${row.name}` }}
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Inner component (uses DS toast context)
// ─────────────────────────────────────────────────────────────────

function ProductsNextInner() {
  const { toast } = useToast()

  // The family scope. Null on the normal catalogue view.
  const searchParams = useSearchParams()
  const familyId = searchParams?.get('parent') ?? null

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
  // Both halves matter: `rows` is the capped preview we fetched, `total` is how many the family
  // actually has. Keeping the total from the SERVER's own response (not from the parent row's
  // childCount) means the footer's "of 40" is the count for the very query that produced these
  // rows, and cannot drift from it.
  const [childrenByParent, setChildrenByParent] = useState<Record<string, ChildBatch>>({})
  const [loadingChildren, setLoadingChildren] = useState<Set<string>>(new Set())

  // Sort, held here and handed to DataGrid as a CONTROLLED pair. The grid does the ordering
  // (each sortable column declares a `sortValue`); this page only needs to read the current key
  // to keep the Product column's default. Children ride with their parent through `getSubRows`,
  // so sorting no longer risks scattering them — which is why it can be the grid's job again.
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'product', dir: 'asc' })

  // The Customise dialog is DataGrid's; the page owns only whether it is open, because the
  // trigger lives out in the toolbar rather than in the grid's own prefs bar.
  const [customizeOpen, setCustomizeOpen] = useState(false)

  // Inventory editor modal
  const [modalRow, setModalRow] = useState<ProductRow | null>(null)

  // ── Data ──────────────────────────────────────────────────────
  const { data, loading, error, refetch } = usePolledList<{
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
    salesUnattributed: Array<{ channel: string; orders: number; units: number; revenueCents: number }> | null
  }>({
    url: pollUrlFor(familyId),
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
  // `—` until a response actually lands. Counting an array that is empty because the fetch
  // failed reports a measured zero for something never measured.
  const needsAttentionCount = useMemo<number | null>(
    () => (data == null ? null : products.filter((r) => r.photoCount === 0).length),
    [data, products],
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

  // ── Rows handed to the grid ───────────────────────────────────
  // TOP-LEVEL ONLY. Children are supplied on demand by `getSubRows` and rendered by DataGrid as
  // real rows under the SAME columns, so a variation's price sits under the same Price header as
  // its parent's. This used to be one flattened array with the children spliced in by hand, which
  // is precisely the arrangement that forced sorting to be disabled: any re-sort scattered the
  // children away from their parents. The grid sorts these rows now and the children follow.
  const topLevelRows = useMemo(
    () => (familyId ? filtered : filtered.filter((r) => r.parentId === null)),
    [filtered, familyId],
  )

  /** Children for an expanded parent — a single sentinel row while they are still being fetched.
   *  DataGrid only calls this for rows in `expandedParents`. */
  const subRowsFor = useCallback(
    (row: ProductRow): ProductRow[] =>
      loadingChildren.has(row.id)
        ? [makeLoadingRow(row.id)]
        : (childrenByParent[row.id]?.rows ?? []),
    [loadingChildren, childrenByParent],
  )

  /**
   * The full-width row beneath an expanded family. `DataGrid.renderExpanded` owns the colSpan —
   * only the grid knows the column count, and it shifts with `selectable` and with every hidden
   * column, which is the number every hand-rolled version gets wrong the first time a column is
   * toggled off.
   *
   * Shown for EVERY family, not only capped ones. The button's value was never "see the rest" —
   * it is a page scoped to one family, and that is worth reaching whether the family has three
   * variations or forty. Gating it on the cap meant the only way to open a small family in its
   * own tab was to know the `?parent=` URL by hand.
   *
   * The two cases are genuinely different actions, so they do not share a label: capped, the
   * click GETS YOU THE REST and the count belongs in the button; complete, you are already
   * looking at all of them and the click only FOCUSES them. A single "View all 3" sitting under
   * three visible rows would be a control that lies about what it does.
   */
  const renderFamilyFooter = useCallback(
    (row: ProductRow) => {
      const batch = childrenByParent[row.id]
      if (!batch || batch.total === 0) return null
      const capped = batch.total > batch.rows.length
      return (
        <div className={styles.famFoot}>
          <span className={styles.famFootCount}>
            {capped ? (
              <>
                Showing <b>{batch.rows.length}</b> of <b>{batch.total}</b> variations · lowest stock first
              </>
            ) : (
              <>
                <b>{batch.total}</b> {batch.total === 1 ? 'variation' : 'variations'} · lowest stock first
              </>
            )}
          </span>
          {/* A real DS Button, and a real <a> with target=_blank — so it opens in a new tab, and
              middle-click / cmd-click behave the way the operator expects. `rel="noopener"` is
              not optional on a _blank link: without it the opened tab gets a handle on this one
              via window.opener. Plain <a> rather than next/link — there is no client-side
              navigation to preserve when the destination is a new tab. */}
          <Button asChild size="sm" variant="secondary">
            <a
              href={`/products/next?parent=${encodeURIComponent(row.id)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {capped ? `View all ${batch.total}` : 'Open family'} <ExternalLink size={13} />
            </a>
          </Button>
        </div>
      )
    },
    [childrenByParent],
  )


  /** The sentinel is a placeholder, not a product: no checkbox, and never in select-all. */
  const rowIsSelectable = useCallback((row: ProductRow) => !isLoadingRow(row), [])

  // ── Mutations (real backend calls, mirroring the live /products page) ──
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const selectedIds = useMemo(() => [...selected], [selected])

  // The parent this page is scoped to. The list response carries the CHILDREN, which know their
  // parentId but not the parent's name — so the header needs its own small read. Null until it
  // lands, and on the unscoped catalogue view it is never requested.
  const [family, setFamily] = useState<ProductRow | null>(null)
  useEffect(() => {
    if (!familyId) {
      setFamily(null)
      return
    }
    let cancelled = false
    fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(familyId)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: ProductRow) => { if (!cancelled) setFamily(d) })
      .catch(() => { /* header falls back to the SKU-less wording */ })
    return () => { cancelled = true }
  }, [familyId])

  /**
   * Which channels COUNT for this merchant — the active connections, not every channel the
   * platform supports. The grid used to hard-code ['AMAZON','EBAY','SHOPIFY'] and so rendered a
   * permanent grey Shopify mark on every row for a channel that is `isActive: false`. Driving it
   * from here is also the scalability answer: connect Etsy and the column includes it with no
   * code change, drop a connection and it stops being counted as a gap.
   */
  const [activeChannels, setActiveChannels] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    fetch(`${getBackendUrl()}/api/connections`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { connections?: Array<{ channel: string; isActive: boolean }> }) => {
        if (cancelled) return
        setActiveChannels([...new Set((d.connections ?? []).filter((c) => c.isActive).map((c) => c.channel))])
      })
      .catch(() => { /* no roster ⇒ the cell says "no channels" rather than inventing one */ })
    return () => { cancelled = true }
  }, [])

  // Tags for the bulk "Tag" menu — fetched once (they change rarely).
  const [allTags, setAllTags] = useState<ProductTag[]>([])
  const refreshTags = useCallback(() => {
    fetch(`${getBackendUrl()}/api/tags`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { items?: ProductTag[] }) => setAllTags(d.items ?? []))
      .catch(() => { /* tags are optional; the dialog offers to create the first one */ })
  }, [])
  useEffect(() => { refreshTags() }, [refreshTags])

  /** Run a bulk mutation against the backend, then broadcast so the grid (and
   *  every other open tab) refetches via the invalidation channel. */
  /** What a bulk endpoint actually reports back. Every one of them returns HTTP 200 for a
   *  PARTIAL failure, so the body is the only place the truth lives. */
  interface BulkResult {
    ok?: boolean
    /** bulk-status */ updated?: number
    /** bulk-duplicate */ created?: number
    /** bulk-soft-delete */ changed?: number
    skipped?: number
    errors?: Array<{ id: string; error: string }>
  }

  const runBulk = useCallback(
    async (
      /** Given the SERVER's count, produce the sentence. Never the selection size — see below. */
      label: (n: number) => string,
      path: string,
      body: Record<string, unknown>,
      ids: string[],
      source: string,
      opts?: { clearSelection?: boolean },
    ) => {
      if (!ids.length || busy) return
      // Every one of these endpoints rejects more than 200 ids with a 400. Saying so before the
      // round trip beats relaying a raw server string after it, and select-all with variations
      // expanded reaches 315 on this catalogue — so this is reachable, not theoretical.
      if (ids.length > BULK_MAX) {
        toast(`Select ${BULK_MAX} or fewer — that action can't take ${ids.length} at once.`, 'danger')
        return
      }
      setBusy(true)
      try {
        const res = await fetch(`${getBackendUrl()}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const payload = (await res.json().catch(() => ({}))) as BulkResult & { error?: string }
        if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`)

        emitInvalidation({ type: 'product.updated', meta: { productIds: ids, source } })

        // 🔴 The count comes from the SERVER, not from the selection. These endpoints skip rows
        // that are already in the target state and collect per-row failures, so "Marked 5
        // active" was a claim about what was asked for, not what happened.
        const n = payload.updated ?? payload.created ?? payload.changed ?? ids.length
        const failed = payload.errors?.length ?? 0
        if (failed > 0) {
          // A partial failure arrives as HTTP 200 with `ok: false`. Checking only the status
          // showed a green success toast over rows that never changed.
          toast(`${label(n)} · ${failed} failed`, 'danger')
        } else if (n === 0) {
          toast('Nothing changed — already in that state', 'neutral')
        } else {
          toast(label(n), 'success')
        }
        if (opts?.clearSelection !== false) setSelected(new Set())
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Action failed', 'danger')
      } finally {
        setBusy(false)
      }
    },
    [busy, toast],
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
  // The tag dialog replaces a Menu whose only entry was "No tags yet", disabled — with zero
  // tags in the database, tagging was unreachable rather than imperfect.
  const [tagDialogOpen, setTagDialogOpen] = useState(false)
  const selectedRows = useMemo(() => {
    const byId = new Map<string, ProductRow>()
    for (const p of products) byId.set(p.id, p)
    for (const list of Object.values(childrenByParent)) for (const c of list.rows) byId.set(c.id, c)
    return selectedIds.map((id) => byId.get(id)).filter((r): r is ProductRow => !!r)
  }, [selectedIds, products, childrenByParent])

  /**
   * How many VARIATIONS the current selection reaches.
   *
   * Selecting a parent selects the parent — one row, one tick. The checkbox answers "which rows",
   * not "how deep", because the depth differs per action and folding them together would make
   * select-all unusable (14 parents expand to 315, and every bulk endpoint caps at 200). So the
   * reach is stated instead of implied, and stated BEFORE the click rather than in the toast
   * afterwards.
   */
  const selectionReach = useMemo(() => {
    const parents = selectedRows.filter((r) => r.parentId === null)
    return parents.reduce((n, r) => n + (r.childCount ?? 0), 0)
  }, [selectedRows])

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
        (n) => `Marked ${n} ${status.toLowerCase()}`,
        '/api/products/bulk-status',
        { productIds: selectedIds, status, includeChildren: true },
        selectedIds,
        'bulk-status',
      ),
    [runBulk, selectedIds],
  )

  const duplicateBulk = useCallback(
    (ids: string[]) =>
      runBulk(
        (n) => `Duplicated ${n} ${n === 1 ? 'product' : 'products'}`,
        '/api/products/bulk-duplicate',
        { productIds: ids, includeChildren: true },
        ids,
        'bulk-duplicate',
      ),
    [runBulk],
  )

  const softDeleteBulk = useCallback(
    () =>
      runBulk(
        (n) => `Moved ${n} to recycle bin`,
        '/api/products/bulk-soft-delete',
        { productIds: selectedIds, includeChildren: true },
        selectedIds,
        'bulk-soft-delete',
      ),
    [runBulk, selectedIds],
  )

  // ── Variation expansion ───────────────────────────────────────
  // Children are lazy-fetched on first expand and cached; collapsing re-hides without evicting.
  //
  // The cache lives in state (it drives render) but is GUARDED through a ref, because a state
  // read inside an async guard is a snapshot from render time. Same for the in-flight set: two
  // calls landing in one tick both saw "not loading yet" and both fetched.
  const childrenRef = useRef(childrenByParent)
  childrenRef.current = childrenByParent
  const inFlightRef = useRef<Set<string>>(new Set())

  const fetchChildrenFor = useCallback(async (parentId: string) => {
    if (childrenRef.current[parentId] !== undefined) return // already fetched
    if (inFlightRef.current.has(parentId)) return // already asking
    inFlightRef.current.add(parentId)
    setLoadingChildren((prev) => new Set(prev).add(parentId))
    try {
      // Ask for the CAP, not the family. `limit` was omitted entirely before this — and the
      // endpoint defaults to 50 — so a parent with more than 50 variations quietly rendered 50
      // under a label promising the full count. Now the cap is explicit and the response's own
      // `total` says what was left behind, so the footer can never disagree with the rows.
      const params = new URLSearchParams({
        parentId,
        limit: String(VARIATION_PREVIEW_CAP),
        sort: VARIATION_PREVIEW_SORT,
        includeCoverage: 'true',
        includeTags: 'true',
        includeSales: 'true',
        salesDays: String(SALES_WINDOW_DAYS),
      })
      const res = await fetch(`${getBackendUrl()}/api/products?${params.toString()}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`${res.status}`)
      const data = (await res.json()) as { products?: ProductRow[]; total?: number }
      const rows = data.products ?? []
      setChildrenByParent((prev) => ({
        ...prev,
        [parentId]: { rows, total: data.total ?? rows.length },
      }))
    } catch {
      // Mark as fetched but empty so re-expand shows nothing rather than spinning forever.
      setChildrenByParent((prev) => ({ ...prev, [parentId]: { rows: [], total: 0 } }))
    } finally {
      inFlightRef.current.delete(parentId)
      setLoadingChildren((prev) => {
        const next = new Set(prev)
        next.delete(parentId)
        return next
      })
    }
  }, [])

  // Expansion is STATE; fetching is an effect of that state. It used to be a side effect fired
  // from inside the `setExpandedParents` updater — and an updater must be pure, because React
  // invokes it twice in development. Measured before this change: one click on a chevron fired
  // TWO identical requests for the same 40 children.
  useEffect(() => {
    for (const id of expandedParents) void fetchChildrenFor(id)
  }, [expandedParents, fetchChildrenFor])

  // Now dependency-free, so it no longer changes identity on every child load — which was
  // rebuilding the whole `columns` array, and with it every cell, each time one landed.
  const toggleExpand = useCallback((parentId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev)
      if (next.has(parentId)) next.delete(parentId)
      else next.add(parentId)
      return next
    })
  }, [])

  // ── Column definitions ────────────────────────────────────────
  // Structure: [product (locked)] [...movable, in the operator's order...] [actions (locked)]
  //
  // Selection is DataGrid's (`selectable`), so there is no checkbox column here. Sorting is
  // DataGrid's too: a column says `sortable` + `sortValue` and the grid renders its own header
  // button, announces `aria-sort`, and orders the rows.
  //
  // `prefsLocked` on product/actions holds them at the ends of the Customise dialog WITHOUT
  // pinning them — the sticky toggles stay gone, which is what was asked for.
  const columns = useMemo(
    (): Column<ProductRow>[] => {
      // ── Locked: product name / thumb ────────────────────────
      const productCol: Column<ProductRow> = {
        key: 'product',
        group: 'Identity',
        label: 'Product',
        prefsLocked: true,
        sortable: true,
        sortValue: (row) => row.name.toLowerCase(),
        render: (row) => {
          if (isLoadingRow(row)) {
            return (
              <div className={styles.childLoadingRow}>
                <Spinner size={12} />
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
        group: 'Meta',
        label: '',
        prefsLabel: 'Actions',
        prefsLocked: true,
        width: 120,
        render: (row) => {
          if (isLoadingRow(row)) return null
          return <RowActions row={row} onDuplicate={(id) => void duplicateBulk([id])} />
        },
      }

      // ── Movable columns, keyed so the dialog can reorder them ─
      const movable: Column<ProductRow>[] = [
        {
          key: 'channels',
          group: 'Identity',
          label: 'Channels',
          width: 130,
          render: (row) => {
            if (isLoadingRow(row)) return null
            // Resolve each ACTIVE channel to one state. Order matters: an error outranks a live
            // listing on the same channel, because the error is the thing to act on. `draft` is
            // tested before falling through to missing — the column this replaces did not, and
            // reported 13 of 14 products as "not listed" while they held draft listings.
            const channels = activeChannels.map((ch) => {
              const cov = getCov(row, ch as Channel)
              if (!cov || cov.total === 0) return { channel: ch, state: 'missing' as const, detail: 'not listed' }
              if (cov.error > 0) return { channel: ch, state: 'issues' as const, detail: `${cov.error} error${cov.error > 1 ? 's' : ''}` }
              if (cov.live > 0) return { channel: ch, state: 'live' as const, detail: `${cov.live} live` }
              if (cov.draft > 0) return { channel: ch, state: 'draft' as const, detail: `${cov.draft} draft` }
              return { channel: ch, state: 'missing' as const, detail: 'not listed' }
            })
            return <CoverageSummary channels={channels} />
          },
        },
        {
          key: 'status',
          group: 'Identity',
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
        {
          key: 'tags',
          group: 'Identity',
          label: 'Tags',
          width: 150,
          // Not sortable: a row can hold several tags, so there is no single value to order by,
          // and a sort that silently picked the first one would be a lie dressed as a feature.
          render: (row) => {
            if (isLoadingRow(row)) return null
            const tags = row.tags ?? []
            if (tags.length === 0) return null
            // Two, then a count. Three chips already overflow 150px at the shortest realistic
            // names, and a wrapping cell would drive the row height — which the Product cell
            // owns. The tooltip carries the full set.
            const shown = tags.slice(0, 2)
            const rest = tags.length - shown.length
            return (
              <span className={styles.tagCell} title={tags.map((t) => t.name).join(', ')}>
                {shown.map((t) => (
                  <span key={t.id} className={styles.tagChip}>
                    <span className={styles.tagDot} style={{ background: t.color ?? 'var(--nds-text-3)' }} />
                    {t.name}
                  </span>
                ))}
                {rest > 0 && <span className={styles.tagMore}>+{rest}</span>}
              </span>
            )
          },
        },
        {
          key: 'available',
          group: 'Inventory',
          label: 'Available',
          width: 120,
          sortable: true,
          sortValue: (row) => row.totalStock,
          render: (row) => {
            if (isLoadingRow(row)) return null
            return <InventoryCell row={row} onOpen={setModalRow} />
          },
        },
        {
          key: 'sales',
          group: 'Commerce',
          label: `Sales (${SALES_WINDOW_DAYS}d)`,
          prefsLabel: 'Sales',
          width: 110,
          numeric: true,
          sortable: true,
          sortValue: (row) => row.sales?.revenueCents ?? -1,
          render: (row) => {
            if (isLoadingRow(row)) return null
            const sales = row.sales
            // Three distinct states, rendered as three distinct things. `undefined`/null means
            // the list was not asked for sales; zero means it was asked and the answer is none.
            // Collapsing those into one dash is the mistake that made `variantCount` look
            // measured when it was never populated.
            if (!sales) return null
            if (sales.revenueCents === 0) {
              return (
                <span className={styles.noSales} title={`No sales in the last ${sales.days} days`}>
                  —
                </span>
              )
            }
            return eur0(sales.revenueCents)
          },
        },
        {
          key: 'units',
          group: 'Commerce',
          label: `Units (${SALES_WINDOW_DAYS}d)`,
          prefsLabel: 'Units',
          width: 92,
          numeric: true,
          sortable: true,
          sortValue: (row) => row.sales?.units ?? -1,
          render: (row) => {
            if (isLoadingRow(row)) return null
            const sales = row.sales
            if (!sales) return null
            if (sales.units === 0) {
              return (
                <span className={styles.noSales} title={`No units sold in the last ${sales.days} days`}>
                  —
                </span>
              )
            }
            return num(sales.units)
          },
        },
        {
          key: 'price',
          group: 'Commerce',
          label: 'Price',
          width: 96,
          numeric: true,
          sortable: true,
          sortValue: (row) => row.basePrice,
          render: (row) => {
            if (isLoadingRow(row)) return null
            return fmtEur(row.basePrice)
          },
        },
        {
          key: 'updated',
          group: 'Meta',
          label: 'Last updated',
          width: 118,
          sortable: true,
          sortValue: (row) => row.updatedAt ?? '',
          render: (row) => {
            if (isLoadingRow(row)) return null
            return <span className={styles.updatedCell}>{formatDate(row.updatedAt)}</span>
          },
        },
      ]

      return [productCol, ...movable, actionsCol]
    },
    [
      duplicateBulk,
      expandedParents,
      loadingChildren,
      toggleExpand,
      // The Channels cell reads this. Omitting it froze the column on the empty roster it was
      // built with, so every row read "no channels" while /api/connections answered 200 —
      // a stale closure, not a data problem, and invisible from the network tab.
      activeChannels,
    ],
  )

  /** Export what the grid is SHOWING — parents in the current sort order, each followed by the
   *  variations expanded under it. The grid does the ordering now, so this reproduces it from the
   *  SAME `sortValue` the column declares rather than keeping a second comparator that can drift
   *  out of agreement with the one on screen. */
  const exportRows = useMemo(() => {
    const sortValue = columns.find((c) => c.key === sort.key)?.sortValue
    const parents = sortValue
      ? [...topLevelRows].sort((a, b) => {
          const av = sortValue(a)
          const bv = sortValue(b)
          const dir = sort.dir === 'asc' ? 1 : -1
          return av < bv ? -dir : av > bv ? dir : 0
        })
      : topLevelRows
    const out: ProductRow[] = []
    for (const parent of parents) {
      out.push(parent)
      if (expandedParents.has(parent.id)) {
        out.push(...subRowsFor(parent).filter((r) => !isLoadingRow(r)))
      }
    }
    return out
  }, [columns, sort, topLevelRows, expandedParents, subRowsFor])

  // ── KPI tiles ──────────────────────────────────────────────────
  // The DS MetricStrip renders these. Each tile is a real button element with `aria-pressed`,
  // because each one TOGGLES a filter. They used to be divs carrying role="button" and a
  // hand-written onKeyDown, with no pressed state at all — which is what `onClick`/`active`
  // were added to the component to end.
  const kpiMetrics = useMemo<Metric[]>(() => {
    const tiles: Array<{ tileKey: KpiTileKey; label: string; value: number | string; hint: string; accent: string }> = [
      { tileKey: null, label: 'Total', value: stats?.total ?? '—', hint: 'all statuses', accent: 'var(--nds-primary)' },
      { tileKey: 'active', label: 'Active', value: stats?.active ?? '—', hint: 'live & selling', accent: 'var(--nds-success)' },
      { tileKey: 'out-of-stock', label: 'Out of stock', value: stats?.outOfStock ?? '—', hint: 'no available units', accent: 'var(--nds-danger)' },
      { tileKey: 'attention', label: 'Needs attention', value: needsAttentionCount ?? '—', hint: 'photos · GTIN · description', accent: 'var(--nds-warning)' },
    ]
    return tiles.map((t) => ({
      label: t.label,
      value: t.value,
      hint: t.hint,
      accent: t.accent,
      active: activeTile === t.tileKey,
      onClick: () => setActiveTile((prev) => (prev === t.tileKey ? null : t.tileKey)),
    }))
  }, [stats, needsAttentionCount, activeTile])

  /**
   * Which warning the operator has already dismissed — the VALUE, not a boolean.
   *
   * A dismissed-forever flag turns a warning into one you have disabled: the figure could go
   * from €950 to €9,500 and the banner would stay hidden. Storing what was dismissed means the
   * banner comes back the moment it has something different to say, and stays gone while the
   * answer is the one already read and accepted.
   */
  const [dismissedWarning, setDismissedWarning] = useState<string | null>(null)
  useEffect(() => {
    try {
      setDismissedWarning(localStorage.getItem(WARNING_DISMISS_KEY))
    } catch {
      // private mode / quota — the banner simply always shows, which is the safe direction
    }
  }, [])

  const dismissWarning = useCallback((key: string) => {
    setDismissedWarning(key)
    try {
      localStorage.setItem(WARNING_DISMISS_KEY, key)
    } catch {
      // dismissal just won't survive a reload; nothing else breaks
    }
  }, [])

  // Fold the per-channel orphan rows into one honest sentence. Null when sales were not
  // requested, or when every line attributed cleanly — there is nothing to say then.
  const unattributed = useMemo(() => {
    const rows = data?.salesUnattributed
    if (!rows || rows.length === 0) return null
    const cents = rows.reduce((sum, r) => sum + r.revenueCents, 0)
    const orders = rows.reduce((sum, r) => sum + r.orders, 0)
    if (cents === 0) return null
    const channels = rows
      .filter((r) => r.revenueCents > 0)
      .sort((a, b) => b.revenueCents - a.revenueCents)
      .map((r) => `${r.channel.toLowerCase()} ${eur0(r.revenueCents)}`)
      .join(' · ')
    return {
      // Identity of THIS warning: change the money or the count and it is a new thing to say.
      key: `unattributed:${cents}:${orders}`,
      text: `${eur0(cents)} across ${orders} ${orders === 1 ? 'order' : 'orders'}`,
      why: `those order lines carry no product link (${channels})`,
    }
  }, [data])

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
    // Sourced from every tag that EXISTS, not from the tags found on loaded rows. Built from
    // the rows, this dimension could only ever offer tags already visible — and with nothing
    // tagged it never rendered at all, which is why it looked like there was no tag filter.
    if (allTags.length)
      dims.push({ key: 'tags', label: 'Tags', kind: 'multiselect', value: filters.tags, onChange: (v) => setF('tags', v), options: allTags.map((t) => ({ value: t.name, label: t.name })) })
    if (facetOptions.families.length)
      dims.push({ key: 'families', label: 'Family', kind: 'multiselect', value: filters.families, onChange: (v) => setF('families', v), options: facetOptions.families.map(([code, label]) => ({ value: code, label })) })
    if (facetOptions.stages.length)
      dims.push({ key: 'workflowStages', label: 'Workflow stage', kind: 'multiselect', value: filters.workflowStages, onChange: (v) => setF('workflowStages', v), options: facetOptions.stages.map(([code, label]) => ({ value: code, label })) })
    dims.push({ key: 'missingChannels', label: 'Missing channel', kind: 'multiselect', value: filters.missingChannels, onChange: (v) => setF('missingChannels', v), options: CHANNEL_OPTS })
    dims.push({ key: 'price', label: 'Price', kind: 'range', unit: '€', min: filters.priceMin, max: filters.priceMax, onChange: (min, max) => setFilters((p) => ({ ...p, priceMin: min, priceMax: max })) })
    dims.push({ key: 'stockUnits', label: 'Stock units', kind: 'range', min: filters.stockMin, max: filters.stockMax, onChange: (min, max) => setFilters((p) => ({ ...p, stockMin: min, stockMax: max })) })
    return dims
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, facetOptions, setF, allTags])

  // ── Toolbar counts (top-level products only; children ride with parents) ──
  const totalCount = useMemo(
    () => (familyId ? products.length : products.filter((p) => p.parentId === null).length),
    [products, familyId],
  )
  const shownCount = useMemo(
    () => topLevelRows.length,
    [topLevelRows],
  )

  // Drop the delete confirmation if the selection is cleared elsewhere.
  useEffect(() => {
    if (selected.size === 0 && confirmDelete) setConfirmDelete(false)
  }, [selected, confirmDelete])

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className={styles.wrap}>
      {/* Page header. In family scope it names the FAMILY, not the catalogue — the page is the
          same grid, and the only thing that tells you which of the two you are looking at is
          this. "Import"/"New product" are catalogue actions and would be lies here, so the
          scoped view offers the way back instead. */}
      <PageHeader
        title={familyId ? (family?.name ?? 'Variation family') : 'Products'}
        subtitle={
          familyId
            ? `${stats?.total ?? '—'} variations${family?.sku ? ` of ${family.sku}` : ''}`
            : `${stats?.total ?? '—'} products · synced live across Amazon, eBay & Shopify`
        }
        actions={
          <div className={styles.acts}>
            {familyId ? (
              <Button asChild size="sm">
                <Link href="/products/next">
                  <ArrowLeft size={13} /> All products
                </Link>
              </Button>
            ) : (
              <>
                <Button size="sm" onClick={() => router.push('/products/upload')}>
                  <Upload size={13} /> Import
                </Button>
                <Button size="sm" variant="primary" onClick={() => router.push('/products/new')}>
                  <Plus size={13} /> New product
                </Button>
              </>
            )}
          </div>
        }
      />

      {/* KPI tiles — click to filter rows client-side */}
      <MetricStrip metrics={kpiMetrics} className={styles.kpis} />

      {/* Revenue the Sales column cannot show. An order line with no productId is a real sale
          that no product row can carry, so without this the column silently under-reports while
          looking precise. Only rendered when there IS something to admit. */}
      {unattributed && unattributed.key !== dismissedWarning && (
        <Banner
          tone="warning"
          className={styles.unattributed}
          onDismiss={() => dismissWarning(unattributed.key)}
        >
          {unattributed.text} not shown in Sales — {unattributed.why}
        </Banner>
      )}

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
      <div className="nds-gridcard">
        <GridToolbar
          count={
            selected.size > 0 ? (
              <>
                Selected <b>{selected.size}</b> {selected.size === 1 ? 'product' : 'products'}
                {selectionReach > 0 && (
                  <span className={styles.reachNote}>
                    {' · '}actions also reach <b>{selectionReach}</b>{' '}
                    {selectionReach === 1 ? 'variation' : 'variations'}
                  </span>
                )}
              </>
            ) : (
              familyId ? (
                <>Viewing <b>{shownCount}</b> of <b>{totalCount}</b> variations</>
              ) : (
                <>Viewing <b>{shownCount}</b> of <b>{totalCount}</b> products</>
              )
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
                onClick={() => exportProductsCsv(exportRows)}
                disabled={shownCount === 0}
              >
                <Download size={13} /> Export
              </Button>
              <Pill tone={error ? 'danger' : 'success'} dot size="md">
                {error ? 'Not syncing' : loading ? 'Syncing…' : 'Live'}
              </Pill>
            </>
          }
        >
          {selected.size > 0 ? (
            <span className={styles.selActions}>
              <Button size="sm" disabled={busy} onClick={() => setStatusBulk('ACTIVE')}>Activate</Button>
              <Button size="sm" disabled={busy} onClick={() => setStatusBulk('DRAFT')}>Draft</Button>
              <Button size="sm" disabled={busy} onClick={() => setStatusBulk('INACTIVE')}>Inactive</Button>
              <Button size="sm" disabled={busy} onClick={() => setTagDialogOpen(true)}>
                <TagIcon size={13} /> Tag
              </Button>
              <Menu
                label={<><Send size={13} /> Publish <ChevronDown size={11} /></>}
                items={publishMenuItems}
                triggerProps={{ className: 'nds-btn sm', disabled: busy }}
              />
              <Button size="sm" disabled={busy} onClick={() => duplicateBulk(selectedIds)}>
                <Copy size={13} /> Duplicate
              </Button>
              {confirmDelete ? (
                <Button size="sm" variant="danger" disabled={busy} onClick={() => { setConfirmDelete(false); void softDeleteBulk() }}>
                  Delete {selected.size + selectionReach}
                </Button>
              ) : (
                <Button size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={13} /> Delete
                </Button>
              )}
              <Button
                variant="link"
                size="sm"
                onClick={() => { setSelected(new Set()); setConfirmDelete(false) }}
              >
                Clear
              </Button>
            </span>
          ) : (
            <span className={styles.searchField}>
              <Input
                leadingIcon={<Search size={13} style={{ color: 'var(--nds-text-3)' }} />}
                placeholder="Search products…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ width: '100%' }}
              />
            </span>
          )}
        </GridToolbar>

        {/* Data grid. DensityContext.Provider keeps the shared Thumbnail size-aware, matching
            /products exactly (compact 32 / comfortable 40 / spacious 56); the grid's own row
            density is the DS `size` tier rather than a stylesheet reaching into `.nds-grid td`.
            The Customise dialog is the grid's — rendered by it, opened from the toolbar. */}
        <DensityContext.Provider value={mapDensity(density)}>
          <DataGrid<ProductRow>
            columns={columns}
            rows={topLevelRows}
            rowKey={(r) => r.id}
            size={GRID_SIZE[density]}
            selectable
            selected={selected}
            onSelectedChange={setSelected}
            rowSelectable={rowIsSelectable}
            subRowSelectable
            selectAllHint="Select every product listed here, plus any variations currently expanded"
            getSubRows={subRowsFor}
            renderExpanded={renderFamilyFooter}
            expanded={expandedParents}
            sort={sort}
            onSortChange={setSort}
            customizable
            storageKey={GRID_PREFS_KEY}
            prefsSortFields={SORT_FIELD_OPTIONS}
            customizeOpen={customizeOpen}
            onCustomizeOpenChange={setCustomizeOpen}
            emptyState={
              error ? (
                // A failed fetch is NOT an empty catalogue and NOT a slow one. Showing the
                // skeleton here left the grid shimmering forever on a 401, which reads as
                // "still loading" and sent this session looking for a bug in the rebuild.
                <EmptyState
                  icon={<AlertTriangle size={20} />}
                  title="Couldn't load products"
                  description={error}
                  action={
                    <Button size="sm" variant="secondary" onClick={() => void refetch()}>
                      Try again
                    </Button>
                  }
                />
              ) : data == null ? (
                // Initial load (no response yet) — skeleton, never "no products".
                <ProductsSkeleton />
              ) : (
                <span style={{ color: 'var(--nds-text-muted)' }}>
                  No products match this filter.
                </span>
              )
            }
          />
        </DensityContext.Provider>
      </div>

      {/* Tag dialog — the selection's tags, tri-state across the rows it covers. */}
      <TagDialog
        open={tagDialogOpen}
        onClose={() => setTagDialogOpen(false)}
        selection={selectedRows}
        allTags={allTags}
        onTagsChanged={refreshTags}
        onApplied={({ added, removed, products: n }) => {
          const bits = [added ? `+${added}` : '', removed ? `−${removed}` : ''].filter(Boolean).join(' ')
          toast(`${bits} on ${n} ${n === 1 ? 'product' : 'products'}`, 'success')
          emitInvalidation({ type: 'product.updated', meta: { productIds: selectedIds, source: 'bulk-tag' } })
          refreshTags()
        }}
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
