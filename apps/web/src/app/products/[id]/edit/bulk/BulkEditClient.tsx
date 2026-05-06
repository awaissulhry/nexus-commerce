'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  Trash2,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import {
  groupForFieldId,
  isEmpty,
  parseStringArray,
  type Primitive,
  type UnionField,
  type UnionManifest,
} from '../../../_shared/attribute-editor'

// ── Types ───────────────────────────────────────────────────────

type FieldType = 'text' | 'number' | 'select' | 'boolean' | 'longtext' | 'string_array' | 'unsupported'

type MasterCategory =
  | 'universal'
  | 'pricing'
  | 'inventory'
  | 'identifiers'
  | 'physical'
  | 'content'
  | 'amazon'
  | 'ebay'
  | 'category'

interface MasterFieldDef {
  id: string
  label: string
  type: FieldType
  category: MasterCategory
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

interface ChannelListing {
  id: string
  productId: string
  channel: string
  marketplace: string
  title: string | null
  description: string | null
  bulletPointsOverride: string[] | null
  price: number | string | null
  quantity: number | null
  platformAttributes: Record<string, any> | null
  variationTheme?: string | null
}

interface Props {
  product: Product
  childrenList: Product[]
  fields: MasterFieldDef[]
  /** Schema-derived attribute fields for the master productType,
   *  fetched server-side so every required + optional Amazon attribute
   *  surfaces as an editable column on the master tab (writes to
   *  Product.categoryAttributes via attr_* prefix). */
  masterSchemaFields?: UnionField[]
}

type ActiveTab = 'master' | string // string = `${channel}:${marketplace}` uppercase

interface MarketplaceTab {
  channel: string
  marketplace: string
  channelKey: string
  /** Number of listings the product (parent + variants) currently has
   *  on this marketplace. Surfaced as a chip on the tab. */
  listingCount: number
}

// Normalised field shape used by the cell renderer + group taxonomy.
// Master tabs project MasterFieldDef into this; marketplace tabs project
// UnionField. Keeps the table render path single-source.
interface NormalField {
  id: string
  label: string
  type: FieldType
  groupKey: string
  options?: Array<{ value: string; label: string }>
  width?: number
  editable: boolean
  required?: boolean
  helpText?: string
  maxLength?: number
}

// ── Group taxonomy ──────────────────────────────────────────────

const MASTER_GROUP_ORDER: MasterCategory[] = [
  'universal',
  'identifiers',
  'pricing',
  'inventory',
  'physical',
  'content',
  'category',
]

const MASTER_GROUP_LABEL: Record<MasterCategory, string> = {
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

// Schema-driven groups (matches the curated taxonomy in
// _shared/attribute-editor.tsx so cells map to the same colour as on
// the per-channel editor).
const MARKETPLACE_GROUP_ORDER = [
  'Identity',
  'Marketing copy',
  'Variation attributes',
  'Audience',
  'Categorisation',
  'Pricing & fulfillment',
  'Physical attributes',
  'Compliance & safety',
  'Other attributes',
] as const

interface GroupTone {
  band: string
  cell: string
  text: string
}

const TONE_BY_GROUP: Record<string, GroupTone> = {
  // master
  universal: { band: 'bg-slate-100 border-slate-300', cell: 'bg-white', text: 'text-slate-900' },
  identifiers: { band: 'bg-indigo-50 border-indigo-200', cell: 'bg-indigo-50/30', text: 'text-indigo-900' },
  pricing: { band: 'bg-emerald-50 border-emerald-200', cell: 'bg-emerald-50/30', text: 'text-emerald-900' },
  inventory: { band: 'bg-amber-50 border-amber-200', cell: 'bg-amber-50/30', text: 'text-amber-900' },
  physical: { band: 'bg-sky-50 border-sky-200', cell: 'bg-sky-50/30', text: 'text-sky-900' },
  content: { band: 'bg-violet-50 border-violet-200', cell: 'bg-violet-50/30', text: 'text-violet-900' },
  category: { band: 'bg-rose-50 border-rose-200', cell: 'bg-rose-50/30', text: 'text-rose-900' },
  amazon: { band: 'bg-orange-50 border-orange-200', cell: 'bg-orange-50/30', text: 'text-orange-900' },
  ebay: { band: 'bg-teal-50 border-teal-200', cell: 'bg-teal-50/30', text: 'text-teal-900' },
  // marketplace (schema)
  Identity: { band: 'bg-slate-100 border-slate-300', cell: 'bg-white', text: 'text-slate-900' },
  'Marketing copy': { band: 'bg-violet-50 border-violet-200', cell: 'bg-violet-50/30', text: 'text-violet-900' },
  'Variation attributes': { band: 'bg-fuchsia-50 border-fuchsia-200', cell: 'bg-fuchsia-50/30', text: 'text-fuchsia-900' },
  Audience: { band: 'bg-cyan-50 border-cyan-200', cell: 'bg-cyan-50/30', text: 'text-cyan-900' },
  Categorisation: { band: 'bg-rose-50 border-rose-200', cell: 'bg-rose-50/30', text: 'text-rose-900' },
  'Pricing & fulfillment': { band: 'bg-emerald-50 border-emerald-200', cell: 'bg-emerald-50/30', text: 'text-emerald-900' },
  'Physical attributes': { band: 'bg-sky-50 border-sky-200', cell: 'bg-sky-50/30', text: 'text-sky-900' },
  'Compliance & safety': { band: 'bg-amber-50 border-amber-200', cell: 'bg-amber-50/30', text: 'text-amber-900' },
  'Other attributes': { band: 'bg-slate-50 border-slate-200', cell: 'bg-slate-50/30', text: 'text-slate-700' },
}

const NEUTRAL_TONE: GroupTone = {
  band: 'bg-slate-100 border-slate-200',
  cell: 'bg-white',
  text: 'text-slate-900',
}

const DEFAULT_OPEN_MASTER: ReadonlySet<string> = new Set(['universal', 'identifiers'])
const DEFAULT_OPEN_MARKETPLACE: ReadonlySet<string> = new Set(['Identity'])

/** Master tab dedupe table — schema fields that already have a Product
 *  column are dropped from the schema projection so the master tab
 *  doesn't render two editors for the same value. Keys are schema field
 *  ids; values are the master FieldDef.id they collide with. */
const MASTER_BY_SCHEMA_ID: Record<string, string> = {
  item_name: 'name',
  brand: 'brand',
  manufacturer: 'manufacturer',
  product_description: 'description',
  // weight / dimensions
  item_weight: 'weightValue',
  item_dimensions: 'dimLength',
  // gtins / identifiers
  externally_assigned_product_identifier: 'gtin',
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'
const SAVE_DEBOUNCE_MS = 600

// ── Field projection helpers ────────────────────────────────────

function projectMasterField(f: MasterFieldDef): NormalField {
  return {
    id: f.id,
    label: f.label,
    type: f.type,
    groupKey: f.category,
    options: f.options?.map((o) => ({ value: o, label: o })),
    width: f.width,
    editable: f.editable,
    required: f.required,
    helpText: f.helpText,
  }
}

function projectSchemaField(f: UnionField): NormalField {
  const type: FieldType =
    f.kind === 'text'
      ? 'text'
      : f.kind === 'longtext'
      ? 'longtext'
      : f.kind === 'enum'
      ? 'select'
      : f.kind === 'number'
      ? 'number'
      : f.kind === 'boolean'
      ? 'boolean'
      : f.kind === 'string_array'
      ? 'string_array'
      : 'unsupported'
  return {
    id: f.id,
    label: f.label,
    type,
    groupKey: groupForFieldId(f.id),
    options: f.options,
    width: type === 'longtext' || type === 'string_array' ? 280 : 160,
    editable: f.kind !== 'unsupported',
    required: f.requiredFor.length > 0,
    helpText: f.description,
    maxLength: f.maxLength,
  }
}

// Read the value a ChannelListing carries for a given schema field id.
// Mirrors the per-channel editor's getListingFieldValue logic so the
// spreadsheet shows the same value the editor would.
function readListingValue(
  listing: ChannelListing | undefined,
  fieldId: string,
): Primitive | undefined {
  if (!listing) return undefined
  if (fieldId === 'item_name' && listing.title) return listing.title
  if (fieldId === 'product_description' && listing.description) return listing.description
  if (
    fieldId === 'bullet_point' &&
    Array.isArray(listing.bulletPointsOverride) &&
    listing.bulletPointsOverride.length > 0
  ) {
    return JSON.stringify(listing.bulletPointsOverride)
  }
  const attrs =
    listing.platformAttributes && typeof listing.platformAttributes.attributes === 'object'
      ? (listing.platformAttributes.attributes as Record<string, unknown>)
      : null
  const v = attrs?.[fieldId]
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  return undefined
}

// ── Component ───────────────────────────────────────────────────

export default function BulkEditClient({
  product,
  childrenList,
  fields,
  masterSchemaFields = [],
}: Props) {
  const router = useRouter()

  // Drop channel-prefixed master fields — we surface channel data via
  // the per-marketplace tabs instead.
  const masterFields = useMemo<MasterFieldDef[]>(
    () => fields.filter((f) => f.category !== 'amazon' && f.category !== 'ebay'),
    [fields],
  )

  // Schema-derived attr_* fields for the master productType. These
  // fold the entire required + optional Amazon attribute set onto the
  // master tab (where they write to Product.categoryAttributes via
  // the attr_* prefix that PATCH /api/products/bulk already supports).
  // Skipped when a static registry id already covers the same attribute
  // (e.g. attr_brand → registry has `brand` as a Product column).
  const masterSchemaProjected = useMemo<NormalField[]>(() => {
    if (masterSchemaFields.length === 0) return []
    const registryIds = new Set(masterFields.map((f) => f.id))
    const out: NormalField[] = []
    for (const f of masterSchemaFields) {
      if (f.kind === 'unsupported') continue
      // Skip schema fields whose master equivalent already exists as
      // a Product column. Otherwise the master tab would render two
      // editors that fight over storage (e.g. brand vs attr_brand).
      const masterEquivalent = MASTER_BY_SCHEMA_ID[f.id]
      if (masterEquivalent && registryIds.has(masterEquivalent)) continue
      const projected = projectSchemaField(f)
      // Move from `id` to `attr_<id>` so the bulk PATCH endpoint routes
      // it into Product.categoryAttributes instead of attempting to
      // write to a non-existent Product column.
      out.push({ ...projected, id: `attr_${f.id}` })
    }
    return out
  }, [masterSchemaFields, masterFields])

  // ── Tabs ───────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<ActiveTab>('master')
  const [marketplaceTabs, setMarketplaceTabs] = useState<MarketplaceTab[]>([])

  // ── Rows (parent + variants) ───────────────────────────────────
  const [rows, setRows] = useState<Product[]>(() => [product, ...childrenList])

  // ── Per-marketplace data ───────────────────────────────────────
  // listings[variantId][channelKey] = ChannelListing
  const [listingsByVariant, setListingsByVariant] = useState<
    Map<string, Map<string, ChannelListing>>
  >(new Map())
  // schema manifest per marketplace tab — fetched on first activation.
  const [manifests, setManifests] = useState<Map<string, UnionManifest>>(
    new Map(),
  )
  const [schemaLoading, setSchemaLoading] = useState<Set<string>>(new Set())
  const [schemaErrors, setSchemaErrors] = useState<Map<string, string>>(
    new Map(),
  )

  // ── Fetch all listings on mount + when refresh button is hit ──
  const reloadListings = useCallback(async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${product.id}/all-listings`,
        { cache: 'no-store' },
      )
      if (!res.ok) return
      const grouped = (await res.json()) as Record<string, ChannelListing[]>
      const flat: ChannelListing[] = []
      for (const arr of Object.values(grouped)) {
        for (const l of arr ?? []) flat.push(l)
      }
      // Index by variantId → channelKey
      const map = new Map<string, Map<string, ChannelListing>>()
      for (const l of flat) {
        const ck = `${l.channel}:${l.marketplace}`.toUpperCase()
        let inner = map.get(l.productId)
        if (!inner) {
          inner = new Map<string, ChannelListing>()
          map.set(l.productId, inner)
        }
        inner.set(ck, l)
      }
      setListingsByVariant(map)
      // Discover marketplace tabs from the listing set. Order: AMAZON
      // first, then alphabetical channel; marketplaces alphabetical
      // within channel.
      const seen = new Set<string>()
      const counts = new Map<string, number>()
      for (const l of flat) {
        const ck = `${l.channel}:${l.marketplace}`.toUpperCase()
        seen.add(ck)
        counts.set(ck, (counts.get(ck) ?? 0) + 1)
      }
      const tabs: MarketplaceTab[] = Array.from(seen)
        .map((ck) => {
          const [channel, marketplace] = ck.split(':')
          return {
            channel: channel!,
            marketplace: marketplace!,
            channelKey: ck,
            listingCount: counts.get(ck) ?? 0,
          }
        })
        .sort((a, b) => {
          // AMAZON first
          if (a.channel !== b.channel) {
            if (a.channel === 'AMAZON') return -1
            if (b.channel === 'AMAZON') return 1
            return a.channel.localeCompare(b.channel)
          }
          return a.marketplace.localeCompare(b.marketplace)
        })
      setMarketplaceTabs(tabs)
    } catch {
      /* non-fatal */
    }
  }, [product.id])

  useEffect(() => {
    void reloadListings()
  }, [reloadListings])

  // ── Fetch schema for the active marketplace tab on activation ──
  // NN.8 — session-storage cache so schema survives page reloads.
  // Key includes productType because the schema is type-keyed; if
  // the user changes productType mid-session, the manifest is
  // invalid and must be refetched. TTL 30 min — schemas don't
  // change often but a long-open tab shouldn't show a multi-hour
  // stale view either.
  const ensureSchema = useCallback(
    async (channelKey: string, force = false) => {
      if (!force && manifests.has(channelKey)) return
      const [channel, marketplace] = channelKey.split(':')
      if (!channel || !marketplace) return

      const cacheKey = `nexus_schema_v1:${product.id}:${channelKey}:${
        product.productType ?? ''
      }`
      const SCHEMA_TTL_MS = 30 * 60 * 1000

      // sessionStorage hit?
      if (!force && typeof window !== 'undefined') {
        try {
          const raw = window.sessionStorage.getItem(cacheKey)
          if (raw) {
            const parsed = JSON.parse(raw) as {
              at: number
              manifest: UnionManifest
            }
            if (
              parsed?.at &&
              Date.now() - parsed.at < SCHEMA_TTL_MS &&
              parsed.manifest
            ) {
              setManifests((prev) => {
                const next = new Map(prev)
                next.set(channelKey, parsed.manifest)
                return next
              })
              return
            }
          }
        } catch {
          /* ignore parse errors — fall through to fetch */
        }
      }

      setSchemaLoading((prev) => new Set(prev).add(channelKey))
      setSchemaErrors((prev) => {
        const next = new Map(prev)
        next.delete(channelKey)
        return next
      })
      try {
        const url = new URL(
          `${getBackendUrl()}/api/products/${product.id}/listings/${channel}/${marketplace}/schema`,
        )
        url.searchParams.set('all', '1')
        if (force) url.searchParams.set('refresh', '1')
        const res = await fetch(url.toString(), { cache: 'no-store' })
        const json = await res.json()
        if (!res.ok) {
          throw new Error(json?.error ?? `HTTP ${res.status}`)
        }
        const manifest = json as UnionManifest
        setManifests((prev) => {
          const next = new Map(prev)
          next.set(channelKey, manifest)
          return next
        })
        if (typeof window !== 'undefined') {
          try {
            window.sessionStorage.setItem(
              cacheKey,
              JSON.stringify({ at: Date.now(), manifest }),
            )
          } catch {
            /* quota exceeded — non-fatal */
          }
        }
      } catch (e) {
        setSchemaErrors((prev) => {
          const next = new Map(prev)
          next.set(channelKey, e instanceof Error ? e.message : String(e))
          return next
        })
      } finally {
        setSchemaLoading((prev) => {
          const next = new Set(prev)
          next.delete(channelKey)
          return next
        })
      }
    },
    [manifests, product.id, product.productType],
  )

  useEffect(() => {
    if (activeTab !== 'master') void ensureSchema(activeTab)
  }, [activeTab, ensureSchema])

  // ── Active fields + group ordering for the current tab ────────
  const activeFields: NormalField[] = useMemo(() => {
    if (activeTab === 'master') {
      // Static registry fields (Product columns) + schema-derived
      // attr_* fields so every required + optional attribute lands on
      // the master tab.
      return [
        ...masterFields.map(projectMasterField),
        ...masterSchemaProjected,
      ]
    }
    const m = manifests.get(activeTab)
    return m ? m.fields.map(projectSchemaField) : []
  }, [activeTab, masterFields, masterSchemaProjected, manifests])

  // Master tab now mixes two group taxonomies: registry categories
  // (universal / identifiers / pricing / …) for Product columns + schema
  // group names (Identity / Marketing copy / Variation attributes / …)
  // for the attr_* fields. Concat the orderings; the rendered group
  // list naturally drops empty buckets so the user only sees groups
  // that actually have fields.
  const groupOrder: ReadonlyArray<string> =
    activeTab === 'master'
      ? [...MASTER_GROUP_ORDER, ...MARKETPLACE_GROUP_ORDER]
      : MARKETPLACE_GROUP_ORDER
  const groupLabel = (key: string) =>
    MASTER_GROUP_LABEL[key as MasterCategory] ?? key

  const grouped = useMemo(() => {
    const out: Array<{ key: string; fields: NormalField[] }> = []
    const seen = new Set<string>()
    for (const key of groupOrder) {
      const list = activeFields.filter((f) => f.groupKey === key)
      if (list.length === 0) continue
      out.push({ key: String(key), fields: list })
      seen.add(String(key))
    }
    // catch-all for fields whose group isn't in the canonical order
    const others = new Map<string, NormalField[]>()
    for (const f of activeFields) {
      if (seen.has(f.groupKey)) continue
      const arr = others.get(f.groupKey) ?? []
      arr.push(f)
      others.set(f.groupKey, arr)
    }
    for (const [key, list] of others) {
      out.push({ key, fields: list })
    }
    return out
  }, [activeFields, groupOrder])

  // Group expansion state — separate per-tab so the master collapse
  // doesn't fight with marketplace collapse.
  const [openGroupsByTab, setOpenGroupsByTab] = useState<
    Map<ActiveTab, Set<string>>
  >(new Map())
  const openGroups = useMemo(() => {
    const existing = openGroupsByTab.get(activeTab)
    if (existing) return existing
    return activeTab === 'master' ? DEFAULT_OPEN_MASTER : DEFAULT_OPEN_MARKETPLACE
  }, [activeTab, openGroupsByTab])
  const toggleGroup = useCallback(
    (key: string) => {
      setOpenGroupsByTab((prev) => {
        const next = new Map(prev)
        const cur = new Set(next.get(activeTab) ?? openGroups)
        if (cur.has(key)) cur.delete(key)
        else cur.add(key)
        next.set(activeTab, cur)
        return next
      })
    },
    [activeTab, openGroups],
  )

  // ── Save plumbing ──────────────────────────────────────────────
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [cellErrors, setCellErrors] = useState<Map<string, string>>(new Map())

  // Master dirty: keyed `${productId}:${field}` → change record
  const masterDirtyRef = useRef<
    Map<string, { id: string; field: string; value: unknown }>
  >(new Map())
  // Channel dirty: keyed `${productId}:${channelKey}:${field}` → record
  const channelDirtyRef = useRef<
    Map<
      string,
      {
        productId: string
        channel: string
        marketplace: string
        field: string
        value: unknown
      }
    >
  >(new Map())
  const saveTimer = useRef<number | null>(null)

  const flushMaster = useCallback(async () => {
    if (masterDirtyRef.current.size === 0) return
    const changes = Array.from(masterDirtyRef.current.values())
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/bulk`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)
      const errs = (json.errors ?? []) as Array<{
        id: string
        field: string
        error: string
      }>
      const failed = new Set(errs.map((e) => `${e.id}:${e.field}`))
      const errMap = new Map<string, string>(cellErrors)
      // Clear successes
      for (const c of changes) {
        const k = `${c.id}:${c.field}`
        if (!failed.has(k)) {
          masterDirtyRef.current.delete(k)
          errMap.delete(k)
        }
      }
      // Add failures
      for (const e of errs) errMap.set(`${e.id}:${e.field}`, e.error)
      setCellErrors(errMap)
      return errs.length === 0
    } catch (e) {
      setStatus('error')
      setStatusMsg(e instanceof Error ? e.message : String(e))
      return false
    }
  }, [cellErrors])

  const flushChannel = useCallback(async () => {
    if (channelDirtyRef.current.size === 0) return true
    // Group by (productId, channelKey)
    const groups = new Map<
      string,
      {
        productId: string
        channel: string
        marketplace: string
        attrs: Record<string, unknown>
        keys: string[]
      }
    >()
    for (const [k, v] of channelDirtyRef.current) {
      const gk = `${v.productId}:${v.channel}:${v.marketplace}`
      let g = groups.get(gk)
      if (!g) {
        g = {
          productId: v.productId,
          channel: v.channel,
          marketplace: v.marketplace,
          attrs: {},
          keys: [],
        }
        groups.set(gk, g)
      }
      g.attrs[v.field] = v.value
      g.keys.push(k)
    }
    let allOk = true
    const errMap = new Map<string, string>(cellErrors)
    await Promise.all(
      Array.from(groups.values()).map(async (g) => {
        try {
          const res = await fetch(
            `${getBackendUrl()}/api/products/${g.productId}/listings/${g.channel}/${g.marketplace}`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ attributes: g.attrs }),
            },
          )
          if (!res.ok) {
            const body = await res.json().catch(() => null)
            throw new Error(body?.error ?? `HTTP ${res.status}`)
          }
          const updated = (await res.json()) as ChannelListing
          // Update local listing snapshot so future reads see the
          // saved values.
          setListingsByVariant((prev) => {
            const next = new Map(prev)
            const inner = new Map(next.get(g.productId) ?? new Map())
            inner.set(`${g.channel}:${g.marketplace}`.toUpperCase(), updated)
            next.set(g.productId, inner)
            return next
          })
          for (const k of g.keys) {
            channelDirtyRef.current.delete(k)
            // Drop any prior cell error for this key
            errMap.delete(k)
          }
        } catch (e) {
          allOk = false
          for (const k of g.keys) {
            errMap.set(k, e instanceof Error ? e.message : String(e))
          }
        }
      }),
    )
    setCellErrors(errMap)
    return allOk
  }, [cellErrors])

  const flushAll = useCallback(async () => {
    setStatus('saving')
    const [m, c] = await Promise.all([flushMaster(), flushChannel()])
    if (
      masterDirtyRef.current.size === 0 &&
      channelDirtyRef.current.size === 0
    ) {
      if (m !== false && c !== false) {
        setStatus('saved')
        setStatusMsg(null)
        window.setTimeout(() => {
          setStatus((s) => (s === 'saved' ? 'idle' : s))
        }, 1500)
        // Phase 10/F11 — broadcast so /products grid + /listings +
        // /bulk-operations refresh within ~200ms. Bulk edit touches
        // both master fields (PATCH /api/products/bulk → cascades to
        // ChannelListing per Phase 13) AND per-channel listing
        // overrides (PUT /api/products/:id/listings/...). Emit both
        // event types unconditionally — we don't have field-level
        // detail at this level and other pages tolerate spurious
        // refreshes (the ETag short-circuit means the cost is ~50
        // bytes per page).
        const productIds = Array.from(new Set(rows.map((r) => r.id)))
        if (productIds.length > 0) {
          emitInvalidation({
            type: 'product.updated',
            meta: { productIds, source: 'bulk-edit-client' },
          })
          emitInvalidation({
            type: 'listing.updated',
            meta: { productIds, source: 'bulk-edit-client' },
          })
        }
      } else {
        setStatus('error')
        setStatusMsg('Some cells failed to save')
      }
    } else {
      setStatus('error')
      setStatusMsg('Some cells failed to save')
    }
  }, [flushChannel, flushMaster, rows])

  const armFlush = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void flushAll()
    }, SAVE_DEBOUNCE_MS)
  }, [flushAll])

  // setCell — branches on activeTab to write the right place + queue
  // the right dirty entry.
  const setCell = useCallback(
    (rowId: string, fieldId: string, value: unknown) => {
      const cellKey =
        activeTab === 'master'
          ? `${rowId}:${fieldId}`
          : `${rowId}:${activeTab}:${fieldId}`
      setStatus('saving')
      setStatusMsg(null)
      setCellErrors((prev) => {
        if (!prev.has(cellKey)) return prev
        const next = new Map(prev)
        next.delete(cellKey)
        return next
      })

      if (activeTab === 'master') {
        // Update local row
        setRows((prev) =>
          prev.map((r) => {
            if (r.id !== rowId) return r
            if (fieldId.startsWith('attr_')) {
              const stripped = fieldId.replace(/^attr_/, '')
              const cur: Record<string, unknown> = {
                ...(r.categoryAttributes ?? {}),
              }
              if (value === null || value === undefined || value === '') {
                delete cur[stripped]
              } else {
                cur[stripped] = value
              }
              return { ...r, categoryAttributes: cur }
            }
            return { ...r, [fieldId]: value }
          }),
        )
        masterDirtyRef.current.set(cellKey, { id: rowId, field: fieldId, value })
      } else {
        // Marketplace: update local listing snapshot for instant feedback
        const [channel, marketplace] = activeTab.split(':')
        setListingsByVariant((prev) => {
          const next = new Map(prev)
          const inner = new Map(next.get(rowId) ?? new Map())
          const cur = inner.get(activeTab) ?? {
            id: '',
            productId: rowId,
            channel: channel!,
            marketplace: marketplace!,
            title: null,
            description: null,
            bulletPointsOverride: null,
            price: null,
            quantity: null,
            platformAttributes: null,
          }
          // Mirror the same field-id mapping the backend uses
          let updated: ChannelListing = { ...cur }
          if (fieldId === 'item_name') {
            updated.title = typeof value === 'string' ? value : null
          } else if (fieldId === 'product_description') {
            updated.description = typeof value === 'string' ? value : null
          } else if (fieldId === 'bullet_point') {
            if (typeof value === 'string') {
              try {
                const parsed = JSON.parse(value)
                updated.bulletPointsOverride = Array.isArray(parsed)
                  ? parsed.filter((s) => typeof s === 'string')
                  : [value]
              } catch {
                updated.bulletPointsOverride = [value]
              }
            } else if (Array.isArray(value)) {
              updated.bulletPointsOverride = value.filter(
                (s) => typeof s === 'string',
              )
            }
          } else {
            const exPA =
              (cur.platformAttributes as Record<string, any> | null) ?? null
            const exAttrs =
              exPA && typeof exPA.attributes === 'object'
                ? { ...(exPA.attributes as Record<string, unknown>) }
                : {}
            if (value === null || value === undefined || value === '') {
              delete exAttrs[fieldId]
            } else {
              exAttrs[fieldId] = value
            }
            updated.platformAttributes = {
              ...(exPA ?? {}),
              attributes: exAttrs,
            }
          }
          inner.set(activeTab, updated)
          next.set(rowId, inner)
          return next
        })
        channelDirtyRef.current.set(cellKey, {
          productId: rowId,
          channel: channel!,
          marketplace: marketplace!,
          field: fieldId,
          value,
        })
      }
      armFlush()
    },
    [activeTab, armFlush],
  )

  // Flush on unmount so a pending debounce doesn't drop the last edit.
  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      if (
        masterDirtyRef.current.size > 0 ||
        channelDirtyRef.current.size > 0
      ) {
        void flushAll()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // NN.3 — beforeunload guard. When the user closes the tab or hits
  // back, surface the browser's "Leave site?" prompt so the pending
  // debounce doesn't ship after the page is gone (the unmount flush
  // races with navigation and frequently loses the last edit).
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (
        status === 'saving' ||
        masterDirtyRef.current.size > 0 ||
        channelDirtyRef.current.size > 0
      ) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [status])

  // ── Refresh button (active tab) ────────────────────────────────
  const handleRefresh = useCallback(async () => {
    setStatus('saving')
    setStatusMsg('Refreshing…')
    if (activeTab === 'master') {
      // re-fetch the product so the master row picks up upstream
      // changes (cascade saves from elsewhere, etc.)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/inventory/${product.id}`,
          { cache: 'no-store' },
        )
        if (res.ok) {
          const fresh = (await res.json()) as Product
          setRows((prev) =>
            prev.map((r) => (r.id === fresh.id ? { ...r, ...fresh } : r)),
          )
        }
      } catch {
        /* ignore */
      }
      // Also refresh children for the variant rows.
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/products/${product.id}/children`,
          { cache: 'no-store' },
        )
        if (res.ok) {
          const json = await res.json()
          const children = (json.children ?? []) as Product[]
          setRows((prev) => {
            const parent = prev.find((r) => r.id === product.id)
            return [parent ?? product, ...children]
          })
        }
      } catch {
        /* ignore */
      }
    } else {
      await ensureSchema(activeTab, true)
    }
    await reloadListings()
    setStatus('idle')
    setStatusMsg(null)
  }, [activeTab, ensureSchema, product, reloadListings])

  // ── Copy from another marketplace (replicate) ──────────────────
  // For each variant row, read the source marketplace's listing values
  // for every visible field (in the active tab's manifest) and queue
  // them to the current marketplace. Then flush. Empty source values
  // are skipped so we don't blank out unrelated fields.
  const copyFromMarketplace = useCallback(
    async (sourceChannelKey: string): Promise<{ copied: number }> => {
      if (activeTab === 'master') return { copied: 0 }
      const manifest = manifests.get(activeTab)
      if (!manifest) return { copied: 0 }
      const [channel, marketplace] = activeTab.split(':')
      let copied = 0
      for (const row of rows) {
        const sourceListing = listingsByVariant.get(row.id)?.get(sourceChannelKey)
        if (!sourceListing) continue
        for (const f of manifest.fields) {
          if (f.kind === 'unsupported') continue
          const v = readListingValue(sourceListing, f.id)
          if (isEmpty(v)) continue
          channelDirtyRef.current.set(`${row.id}:${activeTab}:${f.id}`, {
            productId: row.id,
            channel: channel!,
            marketplace: marketplace!,
            field: f.id,
            value: v as Primitive,
          })
          copied++
        }
      }
      // Optimistic local update so the spreadsheet shows the copied
      // values immediately. The flush will sync to the backend.
      setListingsByVariant((prev) => {
        const next = new Map(prev)
        for (const row of rows) {
          const sourceListing = next.get(row.id)?.get(sourceChannelKey)
          if (!sourceListing) continue
          const inner = new Map(next.get(row.id) ?? new Map())
          const cur = inner.get(activeTab)
          // Replicate the source listing's payload columns + attrs
          const replicated: ChannelListing = {
            ...(cur ??
              {
                id: '',
                productId: row.id,
                channel: channel!,
                marketplace: marketplace!,
                title: null,
                description: null,
                bulletPointsOverride: null,
                price: null,
                quantity: null,
                platformAttributes: null,
              }),
            title: sourceListing.title ?? cur?.title ?? null,
            description: sourceListing.description ?? cur?.description ?? null,
            bulletPointsOverride:
              sourceListing.bulletPointsOverride ?? cur?.bulletPointsOverride ?? null,
            platformAttributes: {
              ...(cur?.platformAttributes ?? {}),
              attributes: {
                ...((cur?.platformAttributes?.attributes as Record<string, unknown>) ?? {}),
                ...((sourceListing.platformAttributes?.attributes as Record<string, unknown>) ?? {}),
              },
            },
          }
          inner.set(activeTab, replicated)
          next.set(row.id, inner)
        }
        return next
      })
      if (copied > 0) {
        setStatus('saving')
        setStatusMsg(null)
        await flushAll()
      }
      return { copied }
    },
    [activeTab, manifests, rows, listingsByVariant, flushAll],
  )

  // ── Apply current marketplace's values to other marketplaces ──
  // For each target marketplace, iterate every variant row, read the
  // current marketplace's values for the visible field set, queue
  // writes against the target marketplace, then flush.
  const applyToMarketplaces = useCallback(
    async (targetChannelKeys: string[]): Promise<{ applied: number }> => {
      if (activeTab === 'master') return { applied: 0 }
      const manifest = manifests.get(activeTab)
      if (!manifest) return { applied: 0 }
      let applied = 0
      const tasks: Array<{
        productId: string
        channel: string
        marketplace: string
        attributes: Record<string, Primitive>
      }> = []
      for (const row of rows) {
        const sourceListing = listingsByVariant.get(row.id)?.get(activeTab)
        if (!sourceListing) continue
        const attrs: Record<string, Primitive> = {}
        for (const f of manifest.fields) {
          if (f.kind === 'unsupported') continue
          const v = readListingValue(sourceListing, f.id)
          if (isEmpty(v)) continue
          attrs[f.id] = v as Primitive
        }
        if (Object.keys(attrs).length === 0) continue
        for (const targetKey of targetChannelKeys) {
          if (targetKey === activeTab) continue
          const [tc, tm] = targetKey.split(':')
          tasks.push({
            productId: row.id,
            channel: tc!,
            marketplace: tm!,
            attributes: { ...attrs },
          })
        }
      }
      if (tasks.length === 0) return { applied: 0 }
      setStatus('saving')
      setStatusMsg(null)
      await Promise.all(
        tasks.map(async (t) => {
          try {
            const res = await fetch(
              `${getBackendUrl()}/api/products/${t.productId}/listings/${t.channel}/${t.marketplace}`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ attributes: t.attributes }),
              },
            )
            if (res.ok) {
              const updated = (await res.json()) as ChannelListing
              applied++
              setListingsByVariant((prev) => {
                const next = new Map(prev)
                const inner = new Map(next.get(t.productId) ?? new Map())
                inner.set(`${t.channel}:${t.marketplace}`.toUpperCase(), updated)
                next.set(t.productId, inner)
                return next
              })
            }
          } catch {
            /* per-task error swallowed; user can retry */
          }
        }),
      )
      setStatus('saved')
      window.setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 1500)
      return { applied }
    },
    [activeTab, manifests, rows, listingsByVariant],
  )

  // ── Add / delete variant ───────────────────────────────────────
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
      if (!res.ok || !json.success)
        throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
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
    if (
      !window.confirm(
        'Delete this variant? This removes its listings, offers, and image rows. Cannot be undone.',
      )
    )
      return
    setStatus('saving')
    setStatusMsg(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/catalog/products/${variantId}`,
        { method: 'DELETE' },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok)
        throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
      setRows((prev) => prev.filter((r) => r.id !== variantId))
      setListingsByVariant((prev) => {
        const next = new Map(prev)
        next.delete(variantId)
        return next
      })
      setStatus('saved')
      window.setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 1500)
    } catch (e) {
      setStatus('error')
      setStatusMsg(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // ── Cell readers ───────────────────────────────────────────────
  const readCellValue = useCallback(
    (row: Product, fieldId: string): unknown => {
      if (activeTab === 'master') {
        if (fieldId.startsWith('attr_')) {
          const stripped = fieldId.replace(/^attr_/, '')
          return (row.categoryAttributes as Record<string, unknown> | null)?.[stripped]
        }
        return (row as Record<string, unknown>)[fieldId]
      }
      const listing = listingsByVariant.get(row.id)?.get(activeTab)
      return readListingValue(listing, fieldId)
    },
    [activeTab, listingsByVariant],
  )

  const isMarketplaceTab = activeTab !== 'master'
  const schemaIsLoading = isMarketplaceTab && schemaLoading.has(activeTab)
  const schemaErr = isMarketplaceTab ? schemaErrors.get(activeTab) : null

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
              onClick={() => void handleRefresh()}
              title="Refresh listing data + schema for the active tab"
            >
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              Refresh
            </Button>
            {isMarketplaceTab && (
              <CopyFromMarketplaceMenu
                activeChannelKey={activeTab}
                tabs={marketplaceTabs}
                listingsByVariant={listingsByVariant}
                rows={rows}
                onPick={(sourceKey) => copyFromMarketplace(sourceKey)}
              />
            )}
            {isMarketplaceTab && (
              <ApplyToMarketplacesMenu
                activeChannelKey={activeTab}
                tabs={marketplaceTabs}
                onApply={(targetKeys) => applyToMarketplaces(targetKeys)}
              />
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push(`/products/${product.id}/edit`)}
            >
              Done
            </Button>
          </div>
        </div>

        {/* ── Tab strip ─────────────────────────────────────────── */}
        <div className="px-6 flex items-center -mb-px overflow-x-auto">
          <TabBtn
            active={activeTab === 'master'}
            onClick={() => setActiveTab('master')}
          >
            Master
          </TabBtn>
          {marketplaceTabs.map((t) => (
            <TabBtn
              key={t.channelKey}
              active={activeTab === t.channelKey}
              onClick={() => setActiveTab(t.channelKey)}
              count={t.listingCount}
            >
              <span className="font-mono">{t.channelKey}</span>
            </TabBtn>
          ))}
        </div>

        {/* ── Group expand/collapse ribbon ──────────────────────── */}
        {grouped.length > 0 && (
          <div className="px-6 pb-2 pt-1 flex items-center gap-1 flex-wrap">
            {grouped.map((g) => {
              const tone = TONE_BY_GROUP[g.key] ?? NEUTRAL_TONE
              const open = openGroups.has(g.key)
              return (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => toggleGroup(g.key)}
                  className={cn(
                    'inline-flex items-center gap-1 h-6 px-2 text-[11px] border rounded transition-colors',
                    tone.band,
                    tone.text,
                    open ? 'opacity-100' : 'opacity-70 hover:opacity-100',
                  )}
                  title={`${open ? 'Collapse' : 'Expand'} ${groupLabel(g.key)}`}
                >
                  <ChevronRight
                    className={cn(
                      'w-3 h-3 transition-transform',
                      open && 'rotate-90',
                    )}
                  />
                  <span className="font-semibold">{groupLabel(g.key)}</span>
                  <span className="opacity-60 tabular-nums">{g.fields.length}</span>
                </button>
              )
            })}
          </div>
        )}
      </header>

      {/* ── Spreadsheet ───────────────────────────────────────── */}
      <main className="flex-1 overflow-auto px-2 pb-8">
        {isMarketplaceTab && schemaIsLoading && grouped.length === 0 && (
          <div className="text-[12px] text-slate-500 inline-flex items-center gap-1.5 px-4 py-6">
            <Loader2 className="w-3 h-3 animate-spin" />
            Loading schema for {activeTab}…
          </div>
        )}
        {isMarketplaceTab && schemaErr && (
          <div className="m-4 text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2 inline-flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <div>
              {schemaErr}
              <button
                type="button"
                onClick={() => void ensureSchema(activeTab, true)}
                className="ml-2 underline"
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {grouped.length > 0 && (
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
                  const tone = TONE_BY_GROUP[g.key] ?? NEUTRAL_TONE
                  const open = openGroups.has(g.key)
                  const colSpan = open ? g.fields.length : 1
                  return (
                    <th
                      key={g.key}
                      colSpan={colSpan}
                      className={cn(
                        'border-b border-r-2 px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide',
                        tone.band,
                        tone.text,
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => toggleGroup(g.key)}
                        className="inline-flex items-center gap-1"
                      >
                        <ChevronRight
                          className={cn(
                            'w-3 h-3 transition-transform',
                            open && 'rotate-90',
                          )}
                        />
                        {groupLabel(g.key)}
                        <span className="opacity-60 tabular-nums">
                          {open ? g.fields.length : `${g.fields.length} hidden`}
                        </span>
                      </button>
                    </th>
                  )
                })}
                <th
                  className="border-b border-l border-slate-200 px-2 py-1 bg-white"
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
                  const tone = TONE_BY_GROUP[g.key] ?? NEUTRAL_TONE
                  const open = openGroups.has(g.key)
                  if (!open) {
                    return [
                      <th
                        key={`${g.key}__placeholder`}
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
                      style={{ width: f.width ?? 140 }}
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
                      const tone = TONE_BY_GROUP[g.key] ?? NEUTRAL_TONE
                      const open = openGroups.has(g.key)
                      if (!open) {
                        return [
                          <td
                            key={`${row.id}_${g.key}__placeholder`}
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
                        const rawVal = readCellValue(row, f.id)
                        const cellKey =
                          activeTab === 'master'
                            ? `${row.id}:${f.id}`
                            : `${row.id}:${activeTab}:${f.id}`
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
                            style={{ width: f.width ?? 140 }}
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
                          n + (openGroups.has(g.key) ? g.fields.length : 1),
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
                            setDraftVariant({ ...draftVariant, basePrice: e.target.value })
                          }
                          className="h-7 px-2 text-[12px] border border-slate-300 rounded w-24"
                        />
                        <input
                          type="number"
                          placeholder="Stock"
                          value={draftVariant.totalStock}
                          onChange={(e) =>
                            setDraftVariant({ ...draftVariant, totalStock: e.target.value })
                          }
                          className="h-7 px-2 text-[12px] border border-slate-300 rounded w-24"
                        />
                        <Button variant="primary" size="sm" onClick={handleAddVariant}>
                          Create
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setAddingVariant(false)
                            setDraftVariant({ sku: '', name: '', basePrice: '0', totalStock: '0' })
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
        )}
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
  field: NormalField
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

  if (disabled || field.type === 'unsupported') {
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
          <option key={opt.value} value={opt.value}>
            {opt.label}
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

  if (field.type === 'longtext') {
    return (
      <textarea
        defaultValue={display}
        rows={2}
        onBlur={(e) => onCommit(e.target.value === '' ? null : e.target.value)}
        className="w-full px-1 py-0.5 text-[12px] border border-transparent hover:border-slate-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-transparent rounded resize-y"
        maxLength={field.maxLength}
      />
    )
  }

  if (field.type === 'string_array') {
    // Show a one-line summary: first entry + (N-1 more). Click → opens
    // the row in expanded mode (deferred to v2). For S.2 we accept JSON
    // edit fallback.
    const arr = parseStringArray(display)
    const summary = arr.length === 0 ? '' : arr[0]!
    return (
      <input
        type="text"
        defaultValue={summary}
        onBlur={(e) => {
          const raw = e.target.value
          if (raw === '') {
            onCommit(null)
            return
          }
          // Replace first entry only; preserve others.
          const next = arr.slice()
          next[0] = raw
          while (next.length > 0 && next[next.length - 1] === '') next.pop()
          onCommit(next.length === 0 ? null : JSON.stringify(next))
        }}
        title={
          arr.length > 1
            ? `Edit cell shows entry 1; ${arr.length - 1} more entries — open this product's edit page for full bullet editor`
            : undefined
        }
        className="w-full h-6 px-1 text-[12px] border border-transparent hover:border-slate-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-transparent rounded"
      />
    )
  }

  // text
  return (
    <input
      type="text"
      defaultValue={display}
      onBlur={(e) => onCommit(e.target.value === '' ? null : e.target.value)}
      maxLength={field.maxLength}
      className="w-full h-6 px-1 text-[12px] border border-transparent hover:border-slate-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-transparent rounded"
    />
  )
}

// ── Tab button ─────────────────────────────────────────────────

function TabBtn({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean
  onClick: () => void
  count?: number
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 py-2 text-[12px] font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 flex-shrink-0',
        active
          ? 'border-blue-600 text-blue-700'
          : 'border-transparent text-slate-600 hover:text-slate-900',
      )}
    >
      {children}
      {typeof count === 'number' && count > 0 && (
        <span className="text-[10px] font-mono px-1 rounded bg-slate-100 text-slate-600">
          {count}
        </span>
      )}
    </button>
  )
}

// ── Save status pill ───────────────────────────────────────────

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
      {status === 'saving' && (message ?? 'Saving…')}
      {status === 'saved' && 'Saved'}
      {status === 'error' && (message ?? 'Save failed')}
    </span>
  )
}

// ── Copy from another marketplace (replicate full listing data) ──

function CopyFromMarketplaceMenu({
  activeChannelKey,
  tabs,
  listingsByVariant,
  rows,
  onPick,
}: {
  activeChannelKey: string
  tabs: MarketplaceTab[]
  listingsByVariant: Map<string, Map<string, ChannelListing>>
  rows: Product[]
  onPick: (sourceChannelKey: string) => Promise<{ copied: number }>
}) {
  const [open, setOpen] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)

  // Per-source count of variants that actually have a listing on that
  // marketplace — surfaces "AMAZON:DE — 5 variants" so the user knows
  // what's behind the menu before clicking.
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of tabs) {
      if (t.channelKey === activeChannelKey) continue
      let n = 0
      for (const row of rows) {
        if (listingsByVariant.get(row.id)?.has(t.channelKey)) n++
      }
      m.set(t.channelKey, n)
    }
    return m
  }, [tabs, listingsByVariant, rows, activeChannelKey])

  const others = tabs.filter((t) => t.channelKey !== activeChannelKey)
  if (others.length === 0) return null
  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        title={`Replicate every variant's listing data into ${activeChannelKey} from another marketplace`}
        className={cn(
          'inline-flex items-center gap-1 h-7 px-2 text-[11px] font-medium border rounded transition-colors',
          flash
            ? 'border-emerald-300 text-emerald-700 bg-emerald-50'
            : 'border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900',
        )}
      >
        <Copy className="w-3 h-3" />
        {flash ?? 'Copy from'}
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute right-0 top-full mt-1 z-20 bg-white border border-slate-200 rounded shadow-md py-1 min-w-[260px] text-[12px]">
            <div className="px-3 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
              Replicate values from
            </div>
            {others.map((t) => {
              const n = counts.get(t.channelKey) ?? 0
              return (
                <button
                  key={t.channelKey}
                  type="button"
                  disabled={n === 0}
                  onClick={async () => {
                    setOpen(false)
                    const { copied } = await onPick(t.channelKey)
                    if (copied > 0) {
                      setFlash(`Copied ${copied}`)
                      window.setTimeout(() => setFlash(null), 1800)
                    }
                  }}
                  className={cn(
                    'w-full text-left px-3 py-1.5 hover:bg-slate-50 inline-flex items-center justify-between gap-2',
                    n === 0
                      ? 'text-slate-400 cursor-not-allowed'
                      : 'text-slate-700',
                  )}
                >
                  <span className="font-mono text-[11px]">{t.channelKey}</span>
                  <span className="text-[10px] text-slate-500 tabular-nums">
                    {n === 0
                      ? 'no listings'
                      : `${n} variant${n === 1 ? '' : 's'}`}
                  </span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// ── Apply this marketplace's values to other marketplaces ──────

function ApplyToMarketplacesMenu({
  activeChannelKey,
  tabs,
  onApply,
}: {
  activeChannelKey: string
  tabs: MarketplaceTab[]
  onApply: (targetChannelKeys: string[]) => Promise<{ applied: number }>
}) {
  const [open, setOpen] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const others = tabs.filter((t) => t.channelKey !== activeChannelKey)
  const sameChannel = others.filter(
    (t) => t.channel === activeChannelKey.split(':')[0],
  )
  if (others.length === 0) return null

  const togglePick = (k: string) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  const submit = async (keys: string[]) => {
    setOpen(false)
    setPicked(new Set())
    if (keys.length === 0) return
    const { applied } = await onApply(keys)
    if (applied > 0) {
      setFlash(`Applied to ${keys.length}`)
      window.setTimeout(() => setFlash(null), 1800)
    }
  }

  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        title={`Broadcast every variant's ${activeChannelKey} listing data to other marketplaces`}
        className={cn(
          'inline-flex items-center gap-1 h-7 px-2 text-[11px] font-medium border rounded transition-colors',
          flash
            ? 'border-emerald-300 text-emerald-700 bg-emerald-50'
            : 'border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900',
        )}
      >
        <Send className="w-3 h-3" />
        {flash ?? 'Apply to'}
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => {
              setOpen(false)
              setPicked(new Set())
            }}
            aria-hidden="true"
          />
          <div className="absolute right-0 top-full mt-1 z-20 bg-white border border-slate-200 rounded shadow-md py-1 min-w-[280px] text-[12px]">
            <div className="px-3 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
              Apply this marketplace's values to
            </div>
            <button
              type="button"
              onClick={() => void submit(others.map((t) => t.channelKey))}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700 inline-flex items-center justify-between gap-2"
            >
              <span className="inline-flex items-center gap-1.5">
                <Globe className="w-3 h-3" />
                All other marketplaces
              </span>
              <span className="text-[10px] text-slate-500 tabular-nums">
                {others.length}
              </span>
            </button>
            {sameChannel.length > 0 &&
              sameChannel.length !== others.length && (
                <button
                  type="button"
                  onClick={() => void submit(sameChannel.map((t) => t.channelKey))}
                  className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700 inline-flex items-center justify-between gap-2"
                >
                  <span>
                    Other {activeChannelKey.split(':')[0]} marketplaces
                  </span>
                  <span className="text-[10px] text-slate-500 tabular-nums">
                    {sameChannel.length}
                  </span>
                </button>
              )}
            <div className="border-t border-slate-100 my-1" />
            <div className="px-3 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
              Or pick targets
            </div>
            {others.map((t) => {
              const checked = picked.has(t.channelKey)
              return (
                <button
                  key={t.channelKey}
                  type="button"
                  onClick={() => togglePick(t.channelKey)}
                  className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700 inline-flex items-center gap-2"
                >
                  <span
                    className={cn(
                      'w-3.5 h-3.5 flex-shrink-0 border rounded inline-flex items-center justify-center',
                      checked
                        ? 'border-blue-500 bg-blue-500 text-white'
                        : 'border-slate-300 bg-white',
                    )}
                  >
                    {checked && <CheckCircle2 className="w-2.5 h-2.5" />}
                  </span>
                  <span className="font-mono text-[11px]">{t.channelKey}</span>
                </button>
              )
            })}
            <div className="px-3 py-2 border-t border-slate-100 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  setPicked(new Set())
                }}
                className="text-[11px] text-slate-500 hover:text-slate-900"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={picked.size === 0}
                onClick={() => void submit(Array.from(picked))}
                className={cn(
                  'h-6 px-2 rounded text-[11px] font-medium',
                  picked.size === 0
                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700',
                )}
              >
                Apply to {picked.size}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
