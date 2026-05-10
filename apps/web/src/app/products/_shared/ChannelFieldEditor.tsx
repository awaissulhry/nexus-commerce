'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Copy, Loader2, RefreshCw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import ProductTypePicker from '@/components/products/ProductTypePicker'
import ChannelGroupsManager, {
  type ChannelGroup,
} from '../[id]/list-wizard/components/ChannelGroupsManager'
import {
  AI_FIELD_MAP,
  AI_SUPPORTED_FIELDS,
  FieldCard,
  FieldGroupSection,
  SchemaAgeIndicator,
  groupFields,
  isEmpty,
  type Primitive,
  type UnionManifest,
} from './attribute-editor'

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

const SAVE_DEBOUNCE_MS = 600

interface SiblingListing {
  id: string
  channel: string
  marketplace: string
  title: string | null
  description: string | null
  bulletPointsOverride: string[] | null
  platformAttributes: Record<string, any> | null
  variationTheme: string | null
}

interface Props {
  productId: string
  channel: string
  marketplace: string
  /** Master product — passed down so the OverrideMenu can offer
   *  "Copy from master" for known field mappings (item_name ← name,
   *  brand ← brand, etc.). */
  product: Record<string, any>
  /** Called after a successful save so the parent can refresh other
   *  bits of state (status bar, etc.) that depend on the listing
   *  having a row. */
  onSaved?: (listing: any) => void
  /** W1.1 — total count of dirty fields across base attributes,
   *  per-variant overrides and setup keys. ProductEditClient sums
   *  this with other tabs to drive the header's "{n} unsaved" badge.
   *  Called whenever any dirty ref changes, including after a
   *  successful flush which clears it back to zero. */
  onDirtyChange?: (count: number) => void
  /** W1.5 — toolbar Translate button on ChannelListingTab needs an
   *  imperative handle to the editor's translate-all routine. When
   *  the schema manifest is loaded, ChannelFieldEditor calls this
   *  callback with a function that iterates every AI-supported field
   *  and runs onTranslate for the active channel. The callback also
   *  fires with `null` on unmount so the parent's ref doesn't dangle. */
  bindTranslateAll?: (
    fn:
      | (() => Promise<{ translated: number; skipped: number }>)
      | null,
  ) => void
  /** W5.2 — schema-driven channel readiness. Fires after the manifest
   *  loads (and on every value change) with the count of required
   *  fields that currently have a value. The parent surfaces this in
   *  the per-listing ReadinessChecklist alongside the 5 baseline
   *  dimensions. Falls back to null when the schema can't load (no
   *  product type set, etc.) so the hero shows only the baseline. */
  onSchemaReadiness?: (
    score: { required: number; complete: number } | null,
  ) => void
}

/** Maps schema field ids to the master product columns they inherit
 *  from. Used by OverrideMenu's "Copy from master" action. Returns
 *  undefined when the field isn't a known master mapping (most schema
 *  fields aren't). */
function getMasterValue(
  product: Record<string, any>,
  fieldId: string,
): Primitive | undefined {
  switch (fieldId) {
    case 'item_name':
      return product.name ?? undefined
    case 'brand':
      return product.brand ?? undefined
    case 'manufacturer':
      return product.manufacturer ?? undefined
    case 'product_description':
      return product.description ?? undefined
    case 'bullet_point': {
      const bp = product.bulletPoints
      if (Array.isArray(bp) && bp.length > 0) return JSON.stringify(bp)
      return undefined
    }
    case 'generic_keyword': {
      const kw = product.keywords
      if (Array.isArray(kw) && kw.length > 0) return JSON.stringify(kw)
      return undefined
    }
    default:
      return undefined
  }
}

/** Reads the value a sibling listing would surface for a given field
 *  id — column lookup for known-mapped fields, falling back to
 *  platformAttributes.attributes for everything else. */
function getListingFieldValue(
  listing: SiblingListing,
  fieldId: string,
): Primitive | undefined {
  if (fieldId === 'item_name' && listing.title) return listing.title
  if (fieldId === 'product_description' && listing.description)
    return listing.description
  if (
    fieldId === 'bullet_point' &&
    Array.isArray(listing.bulletPointsOverride) &&
    listing.bulletPointsOverride.length > 0
  ) {
    return JSON.stringify(listing.bulletPointsOverride)
  }
  const attrs =
    listing.platformAttributes &&
    typeof listing.platformAttributes.attributes === 'object'
      ? (listing.platformAttributes.attributes as Record<string, unknown>)
      : null
  const v = attrs?.[fieldId]
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return v
  }
  return undefined
}

/** Q.2 — schema-driven editor for one (product, channel, marketplace).
 *  Q.3 — wires OverrideMenu so the user can copy field values from the
 *  master product or other channel listings, and broadcast a value out
 *  to multiple listings in one click. */
export default function ChannelFieldEditor({
  productId,
  channel,
  marketplace,
  product,
  onSaved,
  onDirtyChange,
  bindTranslateAll,
  onSchemaReadiness,
}: Props) {
  const [manifest, setManifest] = useState<UnionManifest | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // When the API returns code='no_ebay_category' or 'no_product_type' we show
  // a friendly nudge rather than a generic error block.
  const [noCategorySet, setNoCategorySet] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [forceRefresh, setForceRefresh] = useState(false)
  const [showAllOptional, setShowAllOptional] = useState(false)

  const [values, setValues] = useState<Record<string, Primitive>>({})
  const [expandedFields, setExpandedFields] = useState<Set<string>>(new Set())
  const [expandedVariants, setExpandedVariants] = useState<Set<string>>(
    new Set(),
  )
  // Q.4 — per-variant overrides for THIS channel listing. Stored on
  // the parent listing's platformAttributes.variants[variationId]
  // server-side; the editor mirrors the shape locally for optimistic
  // updates and debounced auto-save.
  const [variantAttrs, setVariantAttrs] = useState<
    Record<string, Record<string, Primitive>>
  >({})
  // Track which (variationId, fieldId) tuples have been touched since
  // the last successful flush, so the auto-save only PATCHes the
  // delta rather than the whole map.
  const dirtyVariantsRef = useRef<Map<string, Set<string>>>(new Map())
  const variantSaveTimer = useRef<number | null>(null)
  const [aiBusyFields, setAiBusyFields] = useState<Set<string>>(new Set())
  // Q.9 — translate-busy keys are "<fieldId>:<channelKey>" so per-
  // channel translate buttons spin independently of base AI generation.
  const [translateBusy, setTranslateBusy] = useState<Set<string>>(new Set())

  // Q.3 — sibling listings (every channel + marketplace this product
  // is published on). Used to render "Copy from AMAZON:DE" menus and
  // to broadcast values to other channels.
  const [siblings, setSiblings] = useState<SiblingListing[]>([])

  // Q.5 — per-listing setup: productType (overrides master) + variation
  // theme. Both persist to ChannelListing — productType into
  // platformAttributes.productType (no migration), variationTheme into
  // its column. Editing productType triggers a schema reload so the
  // editor surfaces the right fields.
  const [setupValues, setSetupValues] = useState<{
    productType: string
    variationTheme: string
  }>({ productType: '', variationTheme: '' })
  const setupSaveTimer = useRef<number | null>(null)
  const setupDirtyRef = useRef<Set<'productType' | 'variationTheme'>>(new Set())

  // Browse nodes + category path seeded from the active listing's platformAttributes
  const [initialBrowseNodes, setInitialBrowseNodes] = useState<number[] | null>(null)
  const [initialCategoryPath, setInitialCategoryPath] = useState<string | null>(null)

  // Q.8 — user-defined channel groups, persisted to localStorage keyed
  // by productId. The wizard stores them per-wizard-row; here on the
  // edit page there's no wizard to hang state off, and a Product-level
  // column would be a migration we don't need yet. localStorage is a
  // pragmatic single-browser persistence that the user can recreate
  // anywhere if needed.
  const [channelGroups, setChannelGroups] = useState<ChannelGroup[]>([])
  const channelGroupsKey = `nexus.channelGroups.${productId}`

  // Q.7 — GTIN exemption status for this listing. Refetched whenever
  // productType changes (which we trigger via reloadKey in
  // flushSetup) so the banner reflects the latest pick.
  const [gtinStatus, setGtinStatus] = useState<{
    needed: boolean
    reason: string
    identifier?: string | null
    applicationId?: string
    status?: string
  } | null>(null)

  const [status, setStatus] = useState<SaveStatus>('idle')
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const dirtyRef = useRef<Set<string>>(new Set())
  const saveTimer = useRef<number | null>(null)

  const channelKey = `${channel}:${marketplace}`.toUpperCase()

  // W1.1 — single source of truth for how many fields are unsaved
  // across the three dirty refs. Called from every mutation site so
  // ProductEditClient's "{n} unsaved" badge stays honest.
  const reportDirty = useCallback(() => {
    if (!onDirtyChange) return
    let n = dirtyRef.current.size + setupDirtyRef.current.size
    for (const set of dirtyVariantsRef.current.values()) {
      n += set.size
    }
    onDirtyChange(n)
  }, [onDirtyChange])

  // ── Fetch the schema manifest ────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setNoCategorySet(false)
    const url = new URL(
      `${getBackendUrl()}/api/products/${productId}/listings/${channel}/${marketplace}/schema`,
    )
    if (showAllOptional) url.searchParams.set('all', '1')
    if (forceRefresh) url.searchParams.set('refresh', '1')
    fetch(url.toString())
      .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json() }))
      .then(({ ok, status: httpStatus, json }) => {
        if (cancelled) return
        if (!ok) {
          // 409 with code='no_ebay_category' or 'no_product_type' → friendly nudge,
          // not a generic error. The setup card above already shows the picker.
          if (
            httpStatus === 409 &&
            (json?.code === 'no_ebay_category' || json?.code === 'no_product_type')
          ) {
            setNoCategorySet(true)
            setManifest(null)
            return
          }
          setError(json?.error ?? `HTTP ${httpStatus}`)
          setManifest(null)
          return
        }
        const m = json as UnionManifest
        setManifest(m)
        setValues(() => {
          const next: Record<string, Primitive> = {}
          for (const f of m.fields) {
            if (f.currentValue !== undefined && f.currentValue !== null) {
              next[f.id] = f.currentValue as Primitive
            } else if (f.defaultValue !== undefined) {
              next[f.id] = f.defaultValue as Primitive
            }
          }
          return next
        })
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [productId, channel, marketplace, reloadKey, showAllOptional, forceRefresh])

  // ── Q.8 — load/save channel groups from localStorage ────────
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(channelGroupsKey)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          setChannelGroups(parsed as ChannelGroup[])
        }
      }
    } catch {
      /* corrupted local storage — ignore and start fresh */
    }
  }, [channelGroupsKey])

  const updateChannelGroups = useCallback(
    (next: ChannelGroup[]) => {
      setChannelGroups(next)
      try {
        window.localStorage.setItem(channelGroupsKey, JSON.stringify(next))
      } catch {
        /* localStorage full or disabled — UI still works for the
         * session */
      }
    },
    [channelGroupsKey],
  )

  // ── Q.7 — fetch GTIN exemption status. Refetches when reloadKey
  // bumps (which happens after a productType change), so the banner
  // tracks the latest category pick.
  useEffect(() => {
    let cancelled = false
    fetch(
      `${getBackendUrl()}/api/products/${productId}/listings/${channel}/${marketplace}/gtin-status`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled || !json) return
        setGtinStatus(json)
      })
      .catch(() => {
        /* non-fatal — banner just won't render */
      })
    return () => {
      cancelled = true
    }
  }, [productId, channel, marketplace, reloadKey])

  // ── Q.3 — fetch sibling listings once on mount ───────────────
  // Also seeds Q.4 variant overrides for the active listing from
  // platformAttributes.variants once the matching sibling lands.
  useEffect(() => {
    let cancelled = false
    fetch(`${getBackendUrl()}/api/products/${productId}/all-listings`)
      .then((r) => (r.ok ? r.json() : null))
      .then((grouped) => {
        if (cancelled || !grouped) return
        const flat: SiblingListing[] = []
        for (const arr of Object.values(grouped) as SiblingListing[][]) {
          for (const l of arr) flat.push(l)
        }
        setSiblings(flat)
        // Seed variantAttrs + setup values from the active listing.
        const active = flat.find(
          (l) =>
            l.channel.toUpperCase() === channel.toUpperCase() &&
            l.marketplace.toUpperCase() === marketplace.toUpperCase(),
        )
        const activePT =
          (active?.platformAttributes?.productType as string | undefined) ??
          (product?.productType as string | undefined) ??
          ''
        const existingBrowseNodes =
          (active?.platformAttributes?.attributes as Record<string, any> | undefined)
            ?.recommended_browse_nodes as number[] | undefined
        const existingCategoryPath =
          (active?.platformAttributes as Record<string, any> | undefined)?.detectedCategoryPath as string | undefined
        setSetupValues({
          productType: activePT,
          variationTheme: active?.variationTheme ?? '',
        })
        setInitialBrowseNodes(existingBrowseNodes ?? null)
        setInitialCategoryPath(existingCategoryPath ?? null)
        const variants = active?.platformAttributes?.variants
        if (variants && typeof variants === 'object') {
          setVariantAttrs(() => {
            const next: Record<string, Record<string, Primitive>> = {}
            for (const [variationId, slice] of Object.entries(
              variants as Record<string, Record<string, unknown>>,
            )) {
              if (!slice || typeof slice !== 'object') continue
              const cleaned: Record<string, Primitive> = {}
              for (const [k, v] of Object.entries(slice)) {
                if (
                  typeof v === 'string' ||
                  typeof v === 'number' ||
                  typeof v === 'boolean'
                ) {
                  cleaned[k] = v
                }
              }
              if (Object.keys(cleaned).length > 0) {
                next[variationId] = cleaned
              }
            }
            return next
          })
        }
      })
      .catch(() => {
        /* sibling load failure is non-fatal — menu just won't offer
         * cross-listing copy/broadcast */
      })
    return () => {
      cancelled = true
    }
    // product?.productType is read inside the effect to seed setup
    // values, but we don't want a refetch every time the parent
    // recreates the product object — the seed is one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, channel, marketplace])

  // ── Auto-save dirty fields ───────────────────────────────────
  const flush = useCallback(async () => {
    const fields = Array.from(dirtyRef.current)
    if (fields.length === 0) {
      setStatus('idle')
      return
    }
    const attributes: Record<string, Primitive> = {}
    for (const id of fields) {
      const v = values[id]
      if (v !== undefined) attributes[id] = v
    }
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/listings/${channel}/${marketplace}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attributes }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const updated = await res.json()
      dirtyRef.current = new Set()
      reportDirty()
      setStatus('saved')
      setStatusMsg(null)
      onSaved?.(updated)
      window.setTimeout(() => {
        setStatus((s) => (s === 'saved' ? 'idle' : s))
      }, 1500)
    } catch (e) {
      setStatus('error')
      setStatusMsg(e instanceof Error ? e.message : String(e))
    }
  }, [productId, channel, marketplace, values, onSaved, reportDirty])

  const setBase = useCallback(
    (id: string, value: Primitive) => {
      setValues((prev) => ({ ...prev, [id]: value }))
      dirtyRef.current.add(id)
      reportDirty()
      setStatus('saving')
      setStatusMsg(null)
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        void flush()
      }, SAVE_DEBOUNCE_MS)
    },
    [flush, reportDirty],
  )

  // Q.5 — debounced flush for the listing-setup card. PUTs only the
  // dirty top-level keys (productType / variationTheme). When
  // productType changes, the user's expectation is that the schema
  // refreshes, so we bump reloadKey after a successful save.
  const flushSetup = useCallback(async () => {
    const dirty = setupDirtyRef.current
    if (dirty.size === 0) return
    const payload: Record<string, unknown> = {}
    for (const k of dirty) payload[k] = setupValues[k]
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/listings/${channel}/${marketplace}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const updated = await res.json()
      const productTypeChanged = dirty.has('productType')
      setupDirtyRef.current = new Set()
      reportDirty()
      onSaved?.(updated)
      if (productTypeChanged) {
        // Refresh the schema since the productType drives the field
        // union.
        setReloadKey((k) => k + 1)
      }
    } catch (e) {
      setStatus('error')
      setStatusMsg(e instanceof Error ? e.message : String(e))
    }
  }, [productId, channel, marketplace, setupValues, onSaved, reportDirty])

  const setSetup = useCallback(
    (key: 'productType' | 'variationTheme', value: string) => {
      setSetupValues((prev) => ({ ...prev, [key]: value }))
      setupDirtyRef.current.add(key)
      reportDirty()
      setStatus('saving')
      setStatusMsg(null)
      if (setupSaveTimer.current) window.clearTimeout(setupSaveTimer.current)
      setupSaveTimer.current = window.setTimeout(() => {
        void flushSetup().then(() => {
          if (
            dirtyRef.current.size === 0 &&
            dirtyVariantsRef.current.size === 0 &&
            setupDirtyRef.current.size === 0
          ) {
            setStatus('saved')
            window.setTimeout(() => {
              setStatus((s) => (s === 'saved' ? 'idle' : s))
            }, 1500)
          }
        })
      }, SAVE_DEBOUNCE_MS)
    },
    [flushSetup, reportDirty],
  )

  // Q.4 — debounced flush for variant overrides. Mirrors the base
  // flush but PUTs only `variantAttributes` so concurrent base + variant
  // edits don't step on each other.
  const flushVariants = useCallback(async () => {
    const dirty = dirtyVariantsRef.current
    if (dirty.size === 0) {
      return
    }
    const variantAttributes: Record<string, Record<string, Primitive | null>> =
      {}
    for (const [variationId, fieldIds] of dirty.entries()) {
      const slice: Record<string, Primitive | null> = {}
      const current = variantAttrs[variationId] ?? {}
      for (const fieldId of fieldIds) {
        const v = current[fieldId]
        slice[fieldId] = v === undefined ? null : v
      }
      variantAttributes[variationId] = slice
    }
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/listings/${channel}/${marketplace}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ variantAttributes }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const updated = await res.json()
      dirtyVariantsRef.current = new Map()
      reportDirty()
      onSaved?.(updated)
    } catch (e) {
      setStatus('error')
      setStatusMsg(e instanceof Error ? e.message : String(e))
    }
  }, [productId, channel, marketplace, variantAttrs, onSaved, reportDirty])

  const setVariant = useCallback(
    (variationId: string, fieldId: string, value: Primitive | undefined) => {
      setVariantAttrs((prev) => {
        const slice = { ...(prev[variationId] ?? {}) }
        if (value === undefined || value === '' || value === null) {
          delete slice[fieldId]
        } else {
          slice[fieldId] = value
        }
        return { ...prev, [variationId]: slice }
      })
      // Track dirty (variationId, fieldId) for the next flush.
      const set = dirtyVariantsRef.current.get(variationId) ?? new Set<string>()
      set.add(fieldId)
      dirtyVariantsRef.current.set(variationId, set)
      reportDirty()
      setStatus('saving')
      setStatusMsg(null)
      if (variantSaveTimer.current) window.clearTimeout(variantSaveTimer.current)
      variantSaveTimer.current = window.setTimeout(() => {
        void flushVariants().then(() => {
          if (
            dirtyRef.current.size === 0 &&
            dirtyVariantsRef.current.size === 0
          ) {
            setStatus('saved')
            window.setTimeout(() => {
              setStatus((s) => (s === 'saved' ? 'idle' : s))
            }, 1500)
          }
        })
      }, SAVE_DEBOUNCE_MS)
    },
    [flushVariants, reportDirty],
  )

  // Flush on unmount so a pending debounce doesn't drop the last edit.
  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      if (variantSaveTimer.current) window.clearTimeout(variantSaveTimer.current)
      if (setupSaveTimer.current) window.clearTimeout(setupSaveTimer.current)
      if (dirtyRef.current.size > 0) void flush()
      if (dirtyVariantsRef.current.size > 0) void flushVariants()
      if (setupDirtyRef.current.size > 0) void flushSetup()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Q.3 — broadcast a field value to other channel listings ──
  // Hits PUT for each target listing in parallel; updates the local
  // `siblings` snapshot on success so subsequent OverrideMenu reads
  // see the latest broadcast values without re-fetching.
  const broadcastToChannels = useCallback(
    async (fieldId: string, sourceChannelKey: string, targetKeys: string[]) => {
      const sourceValue =
        sourceChannelKey === channelKey
          ? values[fieldId]
          : (() => {
              const sib = siblings.find(
                (s) =>
                  `${s.channel}:${s.marketplace}`.toUpperCase() ===
                  sourceChannelKey,
              )
              return sib ? getListingFieldValue(sib, fieldId) : undefined
            })()
      if (isEmpty(sourceValue)) return

      const updates = await Promise.all(
        targetKeys.map(async (targetKey) => {
          if (targetKey === channelKey) {
            // Active listing → use setBase so the debounce + status bar
            // path handles it.
            setBase(fieldId, sourceValue as Primitive)
            return null
          }
          const sib = siblings.find(
            (s) =>
              `${s.channel}:${s.marketplace}`.toUpperCase() === targetKey,
          )
          if (!sib) return null
          try {
            const res = await fetch(
              `${getBackendUrl()}/api/products/${productId}/listings/${sib.channel}/${sib.marketplace}`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  attributes: { [fieldId]: sourceValue },
                }),
              },
            )
            if (!res.ok) return null
            return (await res.json()) as SiblingListing
          } catch {
            return null
          }
        }),
      )
      const updatedById = new Map(
        updates
          .filter((u): u is SiblingListing => !!u)
          .map((u) => [u.id, u]),
      )
      if (updatedById.size > 0) {
        setSiblings((prev) =>
          prev.map((s) => updatedById.get(s.id) ?? s),
        )
      }
    },
    [channelKey, values, siblings, productId, setBase],
  )

  // ── Bulk copy from a sibling listing ─────────────────────────
  // `fieldIds === null` copies every schema field; otherwise just the
  // ids passed in (used by the per-group "Copy from..." menu). Empty
  // sibling values are skipped so we don't blank-out fields the source
  // didn't fill. One state update + one debounce arming, regardless of
  // how many fields land — the existing flush will batch everything
  // into a single PUT.
  const copyFromSibling = useCallback(
    (sourceChannelKey: string, fieldIds: string[] | null): number => {
      const sib = siblings.find(
        (s) =>
          `${s.channel}:${s.marketplace}`.toUpperCase() === sourceChannelKey,
      )
      if (!sib || !manifest) return 0
      const ids =
        fieldIds === null ? manifest.fields.map((f) => f.id) : fieldIds
      let copied = 0
      setValues((prev) => {
        const next = { ...prev }
        for (const id of ids) {
          const v = getListingFieldValue(sib, id)
          if (isEmpty(v)) continue
          next[id] = v as Primitive
          dirtyRef.current.add(id)
          copied++
        }
        return next
      })
      if (copied === 0) return 0
      setStatus('saving')
      setStatusMsg(null)
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        void flush()
      }, SAVE_DEBOUNCE_MS)
      return copied
    },
    [siblings, manifest, flush],
  )

  /** Per-sibling counts of how many of `targetIds` have a value
   *  available, so the menu surfaces "AMAZON:DE — 12 fields" and the
   *  user knows what they're getting. */
  const countSiblingValues = useCallback(
    (sourceChannelKey: string, targetIds: string[]): number => {
      const sib = siblings.find(
        (s) =>
          `${s.channel}:${s.marketplace}`.toUpperCase() === sourceChannelKey,
      )
      if (!sib) return 0
      let n = 0
      for (const id of targetIds) {
        if (!isEmpty(getListingFieldValue(sib, id))) n++
      }
      return n
    },
    [siblings],
  )

  // ── Q.9 — translate a field for the active channel via Gemini ──
  // The single-channel /generate-content endpoint takes the (channel,
  // marketplace) tuple and returns one group's result. We map the
  // result back to the schema field id and write it via setBase so
  // it lands in the listing's saved value.
  const onTranslate = useCallback(
    async (fieldId: string, targetChannelKey: string) => {
      const aiKind = AI_FIELD_MAP[fieldId]
      if (!aiKind) return
      // Edit page is single-channel — only translate the active
      // channel. (Cross-channel translate is wizard-only territory.)
      if (targetChannelKey !== channelKey) return
      const busyKey = `${fieldId}:${targetChannelKey}`
      setTranslateBusy((prev) => {
        const next = new Set(prev)
        next.add(busyKey)
        return next
      })
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/products/${productId}/generate-content`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fields: [aiKind],
              channel,
              marketplace,
              variant: 0,
            }),
          },
        )
        if (!res.ok) return
        const json = await res.json()
        const first = json?.groups?.[0]?.result
        if (!first) return
        let value: string | undefined
        if (aiKind === 'title') value = first.title?.content
        else if (aiKind === 'description') value = first.description?.content
        else if (aiKind === 'keywords') value = first.keywords?.content
        else if (aiKind === 'bullets') {
          const bullets = first.bullets?.content
          if (Array.isArray(bullets)) {
            value = JSON.stringify(
              bullets.filter(
                (b: unknown) => typeof b === 'string' && b.trim().length > 0,
              ),
            )
          }
        }
        if (typeof value === 'string' && value.length > 0) {
          setBase(fieldId, value as Primitive)
        }
      } catch {
        /* swallow */
      } finally {
        setTranslateBusy((prev) => {
          const next = new Set(prev)
          next.delete(busyKey)
          return next
        })
      }
    },
    [productId, channel, marketplace, channelKey, setBase],
  )

  // ── W1.5 — translate every AI-supported field on the active
  //     listing in one click. ChannelListingTab's toolbar Translate
  //     button calls this via bindTranslateAll. Iterates serially
  //     so rate-limited providers don't fan out beyond their bucket;
  //     each field's setBase plugs into the existing debounced
  //     auto-save so the values land in the listing's stored
  //     attributes without a separate explicit save step. ────────
  const translateAllFields = useCallback(async () => {
    if (!manifest) return { translated: 0, skipped: 0 }
    let translated = 0
    let skipped = 0
    for (const field of manifest.fields) {
      const aiKind = AI_FIELD_MAP[field.id]
      if (!aiKind) continue
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/products/${productId}/generate-content`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fields: [aiKind],
              channel,
              marketplace,
              variant: 0,
            }),
          },
        )
        if (!res.ok) {
          skipped++
          continue
        }
        const json = await res.json().catch(() => null)
        const first = json?.groups?.[0]?.result
        if (!first) {
          skipped++
          continue
        }
        let value: string | undefined
        if (aiKind === 'title') value = first.title?.content
        else if (aiKind === 'description') value = first.description?.content
        else if (aiKind === 'keywords') value = first.keywords?.content
        else if (aiKind === 'bullets') {
          const bullets = first.bullets?.content
          if (Array.isArray(bullets)) {
            value = JSON.stringify(
              bullets.filter(
                (b: unknown) =>
                  typeof b === 'string' && b.trim().length > 0,
              ),
            )
          }
        }
        if (typeof value === 'string' && value.length > 0) {
          setBase(field.id, value as Primitive)
          translated++
        } else {
          skipped++
        }
      } catch {
        skipped++
      }
    }
    return { translated, skipped }
  }, [manifest, productId, channel, marketplace, setBase])

  // Wire the imperative handle for the parent's Translate button.
  // Only bind once the manifest is in hand — translateAllFields is a
  // no-op without it, but parents shouldn't see a stale function
  // pointer either; null while loading is the cleaner contract.
  useEffect(() => {
    if (!bindTranslateAll) return
    if (!manifest) {
      bindTranslateAll(null)
      return
    }
    bindTranslateAll(translateAllFields)
    return () => bindTranslateAll(null)
  }, [bindTranslateAll, manifest, translateAllFields])

  // ── W5.2 schema-driven readiness ─────────────────────────────
  // Counts manifest fields with `required=true` and reports how many
  // currently have a non-empty value. Fires whenever the manifest
  // OR the values change so the parent's hero card stays live as
  // the operator types. null when the schema can't be loaded (no
  // productType set, channel not yet supported, etc.) so the hero
  // shows only the 5 baseline dimensions.
  useEffect(() => {
    if (!onSchemaReadiness) return
    if (!manifest) {
      onSchemaReadiness(null)
      return
    }
    let required = 0
    let complete = 0
    for (const f of manifest.fields) {
      if (!f.required) continue
      required += 1
      const v = values[f.id]
      if (!isEmpty(v)) complete += 1
    }
    onSchemaReadiness({ required, complete })
  }, [manifest, values, onSchemaReadiness])

  // ── AI generate (master-level fill, used by the per-field
  //     "AI generate" button on the FieldCard) ───────────────────
  const aiGenerate = useCallback(
    async (fieldId: string) => {
      const aiKind = AI_FIELD_MAP[fieldId]
      if (!aiKind) return
      setAiBusyFields((prev) => {
        const next = new Set(prev)
        next.add(fieldId)
        return next
      })
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/products/${productId}/generate-content`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fields: [aiKind],
              channel,
              marketplace,
            }),
          },
        )
        if (!res.ok) return
        const json = await res.json()
        const first = json?.groups?.[0]?.result ?? json?.result
        if (!first) return
        let value: string | undefined
        if (aiKind === 'title') value = first.title?.content
        else if (aiKind === 'description') value = first.description?.content
        else if (aiKind === 'keywords') value = first.keywords?.content
        else if (aiKind === 'bullets') {
          const bullets = first.bullets?.content
          if (Array.isArray(bullets)) {
            value = JSON.stringify(
              bullets.filter(
                (b: unknown) => typeof b === 'string' && b.trim().length > 0,
              ),
            )
          }
        }
        if (typeof value === 'string' && value.length > 0) {
          setBase(fieldId, value as Primitive)
        }
      } catch {
        /* swallow */
      } finally {
        setAiBusyFields((prev) => {
          const next = new Set(prev)
          next.delete(fieldId)
          return next
        })
      }
    },
    [productId, channel, marketplace, setBase],
  )

  // ── Render ───────────────────────────────────────────────────
  const allChannelKeys = useMemo(
    () =>
      Array.from(
        new Set([
          channelKey,
          ...siblings.map(
            (s) => `${s.channel}:${s.marketplace}`.toUpperCase(),
          ),
        ]),
      ),
    [siblings, channelKey],
  )

  const unsatisfied = useMemo(() => {
    if (!manifest) return [] as Array<{ id: string; channelKey: string }>
    const out: Array<{ id: string; channelKey: string }> = []
    for (const f of manifest.fields) {
      if (f.kind === 'unsupported') continue
      if (!f.requiredFor.includes(channelKey)) continue
      if (!isEmpty(values[f.id])) continue
      out.push({ id: f.id, channelKey })
    }
    return out
  }, [manifest, values, channelKey])

  const toggleExpanded = useCallback((id: string) => {
    setExpandedFields((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <SaveStatusPill status={status} message={statusMsg} />
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Copy ALL fields from another listing of this product. */}
          {manifest && siblings.length > 1 && (
            <CopyFromSiblingMenu
              label="Copy from listing"
              activeChannelKey={channelKey}
              siblings={siblings}
              countSiblingValues={(sourceKey) =>
                countSiblingValues(
                  sourceKey,
                  manifest.fields.map((f) => f.id),
                )
              }
              onPick={(sourceKey) => copyFromSibling(sourceKey, null)}
            />
          )}
          {manifest && manifest.optionalFieldCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAllOptional((s) => !s)}
              disabled={loading}
              className={cn(
                'inline-flex items-center gap-1 h-7 px-2 text-sm border rounded disabled:opacity-40',
                showAllOptional
                  ? 'border-blue-300 text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/40 hover:bg-blue-100 dark:hover:bg-blue-900/60'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100',
              )}
            >
              {showAllOptional
                ? 'Hide optional'
                : `Show all (${manifest.optionalFieldCount} more)`}
            </button>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={loading}
            loading={loading}
            title="Re-fetch the schema from cache"
            icon={<RefreshCw className="w-3 h-3" />}
          >
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setForceRefresh(true)
              setReloadKey((k) => k + 1)
              window.setTimeout(() => setForceRefresh(false), 100)
            }}
            disabled={loading}
            className="text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900 bg-white dark:bg-slate-900 hover:bg-blue-50 dark:hover:bg-blue-950/40"
            title="Force-refresh from Amazon SP-API (bypasses 24h cache)"
            icon={<RefreshCw className="w-3 h-3" />}
          >
            Refresh schema
          </Button>
        </div>
      </div>

      {loading && !manifest && (
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 px-6 py-12 text-center text-md text-slate-500 dark:text-slate-400 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading schema…
        </div>
      )}

      {noCategorySet && !loading && (
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-slate-50 dark:bg-slate-800/50 px-4 py-6 text-center text-md text-slate-500 dark:text-slate-400">
          Pick a category in the <strong>Channel Setup</strong> card above ↑ — attribute fields load once a category is selected.
        </div>
      )}

      {error && !loading && (
        <div className="border border-rose-200 dark:border-rose-900 rounded-lg bg-rose-50 dark:bg-rose-950/40 px-4 py-3 text-md text-rose-700 dark:text-rose-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <div>{error}</div>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="mt-1 text-base font-medium underline hover:no-underline"
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {/* Q.7 — GTIN exemption banner (Amazon only) */}
      {gtinStatus && <GtinStatusBanner status={gtinStatus} />}

      {/* Q.5 — Listing setup: per-channel productType + variation theme + browse nodes */}
      <ListingSetupCard
        productId={productId}
        productType={setupValues.productType}
        variationTheme={setupValues.variationTheme}
        masterProductType={(product?.productType as string | undefined) ?? ''}
        channel={channel}
        marketplace={marketplace}
        onChange={setSetup}
        initialBrowseNodes={initialBrowseNodes}
        initialCategoryPath={initialCategoryPath}
      />

      {/* Q.8 — channel groups for bulk broadcast in OverrideMenu */}
      {siblings.length > 0 && (
        <ChannelGroupsManager
          groups={channelGroups}
          availableChannels={Array.from(
            new Set(allChannelKeys.map((k) => k)),
          ).map((k) => {
            const [platform, marketplace] = k.split(':')
            return { platform, marketplace }
          })}
          onChange={updateChannelGroups}
          defaultCollapsed
        />
      )}

      {manifest && (
        <SchemaAgeIndicator
          fetchedAt={manifest.fetchedAtByChannel[channelKey]}
          schemaVersion={manifest.schemaVersionByChannel[channelKey]}
          channelKey={channelKey}
          fetchError={
            manifest.channelsMissingSchema.find((m) => m.channelKey === channelKey)?.detail
          }
          onFetch={() => {
            setForceRefresh(true)
            setReloadKey((k) => k + 1)
          }}
        />
      )}

      {manifest && manifest.fields.length === 0 && !loading && (
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 px-4 py-6 text-center text-base text-slate-500 dark:text-slate-400">
          No fields surfaced for this channel yet.
        </div>
      )}

      {manifest && manifest.fields.length > 0 && (
        <div className="space-y-3">
          {groupFields(manifest.fields).map((group) => {
            const groupIds = new Set(group.fields.map((f) => f.id))
            const requiredCount = group.fields.filter((f) =>
              f.requiredFor.includes(channelKey),
            ).length
            const unsatCount = unsatisfied.filter((u) =>
              groupIds.has(u.id),
            ).length
            const filledCount = group.fields.filter(
              (f) => !isEmpty(values[f.id]),
            ).length
            return (
              <FieldGroupSection
                key={group.name}
                name={group.name}
                count={group.fields.length}
                requiredCount={requiredCount}
                unsatisfiedCount={unsatCount}
                filledCount={filledCount}
                defaultExpanded={
                  requiredCount > 0 || unsatCount > 0 || filledCount > 0
                }
                headerAction={
                  siblings.length > 1 ? (
                    <CopyFromSiblingMenu
                      label="Copy from"
                      compact
                      activeChannelKey={channelKey}
                      siblings={siblings}
                      countSiblingValues={(sourceKey) =>
                        countSiblingValues(
                          sourceKey,
                          group.fields.map((f) => f.id),
                        )
                      }
                      onPick={(sourceKey) =>
                        copyFromSibling(
                          sourceKey,
                          group.fields.map((f) => f.id),
                        )
                      }
                    />
                  ) : undefined
                }
              >
                {group.fields.map((field) => {
                  const fieldUnsatisfied = unsatisfied
                    .filter((u) => u.id === field.id)
                    .map((u) => u.channelKey)
                  const masterValue = getMasterValue(product, field.id)
                  const overrides: Record<string, Primitive | undefined> = {
                    [channelKey]: values[field.id],
                  }
                  for (const s of siblings) {
                    const k = `${s.channel}:${s.marketplace}`.toUpperCase()
                    if (k === channelKey) continue
                    const v = getListingFieldValue(s, field.id)
                    if (!isEmpty(v)) overrides[k] = v
                  }
                  return (
                    <FieldCard
                      key={field.id}
                      field={field}
                      viewMode={{ channelKey }}
                      baseValue={masterValue}
                      onBaseChange={(v) => setBase(field.id, v)}
                      onAIGenerate={
                        AI_SUPPORTED_FIELDS.has(field.id)
                          ? () => aiGenerate(field.id)
                          : undefined
                      }
                      aiBusy={aiBusyFields.has(field.id)}
                      onTranslate={onTranslate}
                      translateBusy={translateBusy}
                      onApplyToChannels={broadcastToChannels}
                      channelGroups={channelGroups}
                      allChannelKeys={allChannelKeys}
                      overrides={overrides}
                      onOverrideChange={(ck, v) => {
                        if (ck === channelKey) {
                          setBase(field.id, v as Primitive)
                        }
                      }}
                      variations={manifest.variations}
                      variantValues={Object.fromEntries(
                        manifest.variations.map((v) => [
                          v.id,
                          variantAttrs[v.id]?.[field.id],
                        ]),
                      )}
                      onVariantChange={(variationId, v) =>
                        setVariant(variationId, field.id, v)
                      }
                      variantsExpanded={expandedVariants.has(field.id)}
                      onToggleVariants={() =>
                        setExpandedVariants((prev) => {
                          const next = new Set(prev)
                          if (next.has(field.id)) next.delete(field.id)
                          else next.add(field.id)
                          return next
                        })
                      }
                      expanded={expandedFields.has(field.id)}
                      onToggleExpanded={() => toggleExpanded(field.id)}
                      unsatisfiedChannels={fieldUnsatisfied}
                    />
                  )
                })}
              </FieldGroupSection>
            )
          })}
        </div>
      )}

      {manifest && unsatisfied.length > 0 && (
        <div className="text-base text-amber-700 dark:text-amber-300">
          {unsatisfied.length} required field
          {unsatisfied.length === 1 ? '' : 's'} still unfilled
        </div>
      )}
    </div>
  )
}

function CopyFromSiblingMenu({
  label,
  compact = false,
  activeChannelKey,
  siblings,
  countSiblingValues,
  onPick,
}: {
  label: string
  compact?: boolean
  activeChannelKey: string
  siblings: SiblingListing[]
  /** Returns the count of fields the source has values for, given
   *  the implicit target field set the parent already knows about. */
  countSiblingValues: (sourceChannelKey: string) => number
  /** Returns how many fields actually got copied — the menu surfaces
   *  this as a brief flash so the user sees the action landed. */
  onPick: (sourceChannelKey: string) => number
}) {
  const [open, setOpen] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const others = useMemo(
    () =>
      siblings
        .map((s) => ({
          channelKey: `${s.channel}:${s.marketplace}`.toUpperCase(),
          listing: s,
        }))
        .filter((x) => x.channelKey !== activeChannelKey),
    [siblings, activeChannelKey],
  )
  if (others.length === 0) return null
  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        title="Copy field values from another marketplace listing"
        className={cn(
          'inline-flex items-center gap-1 border rounded text-sm font-medium',
          compact ? 'h-7 px-2' : 'h-7 px-2.5',
          flash
            ? 'border-emerald-300 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40'
            : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100',
        )}
      >
        <Copy className="w-3 h-3" />
        {flash ?? label}
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute right-0 top-full mt-1 z-20 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded shadow-md py-1 min-w-[220px] text-base">
            <div className="px-3 py-0.5 text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500">
              Copy values from
            </div>
            {others.map(({ channelKey: sourceKey }) => {
              const n = countSiblingValues(sourceKey)
              return (
                <button
                  key={sourceKey}
                  type="button"
                  disabled={n === 0}
                  onClick={() => {
                    const copied = onPick(sourceKey)
                    setOpen(false)
                    if (copied > 0) {
                      setFlash(`Copied ${copied}`)
                      window.setTimeout(() => setFlash(null), 1800)
                    }
                  }}
                  className={cn(
                    'w-full text-left px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center justify-between gap-2',
                    n === 0
                      ? 'text-slate-400 dark:text-slate-500 cursor-not-allowed'
                      : 'text-slate-700 dark:text-slate-300',
                  )}
                >
                  <span className="font-mono text-sm">{sourceKey}</span>
                  <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    {n === 0 ? 'no values' : `${n} field${n === 1 ? '' : 's'}`}
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

function SaveStatusPill({
  status,
  message,
}: {
  status: SaveStatus
  message: string | null
}) {
  if (status === 'idle') return <div />
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 text-sm px-2 py-1 rounded border',
        status === 'saving' && 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800',
        status === 'saved' && 'border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40',
        status === 'error' && 'border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40',
      )}
    >
      {status === 'saving' && <Loader2 className="w-3 h-3 animate-spin" />}
      {status === 'saved' && <CheckCircle2 className="w-3 h-3" />}
      {status === 'error' && <AlertCircle className="w-3 h-3" />}
      {status === 'saving' && 'Saving…'}
      {status === 'saved' && 'Saved'}
      {status === 'error' && (message ?? 'Save failed')}
    </div>
  )
}

function GtinStatusBanner({
  status,
}: {
  status: {
    needed: boolean
    reason: string
    identifier?: string | null
    applicationId?: string
    status?: string
  }
}) {
  if (status.reason === 'non_amazon_channel') return null
  const tone = !status.needed
    ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800'
    : status.reason === 'in_progress'
    ? 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 text-amber-800'
    : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
  const headline = (() => {
    switch (status.reason) {
      case 'has_gtin':
        return `GTIN already on the master product${
          status.identifier ? ` (${status.identifier})` : ''
        } — no exemption needed`
      case 'existing_exemption':
        return 'Brand has an approved GTIN exemption for this category'
      case 'in_progress':
        return `GTIN exemption application is ${(status.status ?? 'in progress').toLowerCase()}`
      case 'no_product_type':
        return 'Set the product type above to check GTIN exemption status'
      default:
        return 'GTIN exemption needed for this category — apply via the listing wizard'
    }
  })()
  return (
    <div
      className={cn(
        'border rounded-md px-3 py-2 text-base inline-flex items-start gap-1.5 w-full',
        tone,
      )}
    >
      {!status.needed ? (
        <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
      ) : (
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
      )}
      <span>{headline}</span>
    </div>
  )
}

function ListingSetupCard({
  productId,
  productType,
  variationTheme,
  masterProductType,
  channel,
  marketplace,
  onChange,
  initialBrowseNodes,
  initialCategoryPath,
}: {
  productId: string
  productType: string
  variationTheme: string
  masterProductType: string
  channel: string
  marketplace: string
  onChange: (key: 'productType' | 'variationTheme', value: string) => void
  initialBrowseNodes?: number[] | null
  initialCategoryPath?: string | null
}) {
  const inheriting =
    productType === '' ||
    (productType === masterProductType && masterProductType !== '')

  const pickerChannel = channel.toUpperCase() as
    | 'AMAZON'
    | 'EBAY'
    | 'SHOPIFY'
    | 'WOOCOMMERCE'
    | 'ETSY'

  const isAmazon = pickerChannel === 'AMAZON'
  const isEbay = pickerChannel === 'EBAY'
  // For eBay, the productType is a numeric category ID. A non-numeric value
  // (e.g. "OUTERWEAR" bled from the Amazon master type) is treated as unset.
  const ebayHasValidCategory = isEbay && /^\d+$/.test((productType ?? '').trim())
  const effectiveType = productType || (isEbay ? '' : masterProductType)

  // Browse nodes — seeded from the active listing, overridable via detection or manual edit
  const [_browseNodes, setBrowseNodes] = useState<number[]>(initialBrowseNodes ?? [])
  const [browseNodesInput, setBrowseNodesInput] = useState(
    (initialBrowseNodes ?? []).join(', '),
  )
  const [categoryPath, setCategoryPath] = useState<string | null>(initialCategoryPath ?? null)
  const [categoryPathLoading, setCategoryPathLoading] = useState(false)
  const [savingNodes, setSavingNodes] = useState(false)

  // Auto-fetch the category breadcrumb whenever the effective product type changes.
  // Uses GET /api/categories/browse-path which finds a known ASIN from the DB
  // and looks up its classifications — no user action required.
  useEffect(() => {
    if (!isAmazon || !effectiveType) return
    // Don't re-fetch if we already have a path for this type (from detection or prior load)
    if (categoryPath) return
    let cancelled = false
    setCategoryPathLoading(true)
    fetch(
      `${getBackendUrl()}/api/categories/browse-path?channel=AMAZON&marketplace=${marketplace}&productType=${encodeURIComponent(effectiveType)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return
        if (data?.categoryPath) {
          setCategoryPath(data.categoryPath)
          if (Array.isArray(data.browseNodes) && data.browseNodes.length > 0) {
            setBrowseNodes(data.browseNodes)
            setBrowseNodesInput(data.browseNodes.join(', '))
          }
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setCategoryPathLoading(false) })
    return () => { cancelled = true }
    // Only re-run when the effective type or marketplace changes, not on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAmazon, effectiveType, marketplace])

  // eBay: load sibling markets that already have a valid numeric category ID
  const [ebaySiblings, setEbaySiblings] = useState<{ marketplace: string; categoryId: string }[]>([])
  useEffect(() => {
    if (!isEbay) return
    fetch(`${getBackendUrl()}/api/products/${productId}/ebay-sibling-categories`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.siblings) {
          setEbaySiblings(
            (data.siblings as { marketplace: string; categoryId: string }[])
              .filter((s) => s.marketplace.toUpperCase() !== marketplace.toUpperCase()),
          )
        }
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEbay, productId])

  async function saveBrowseNodes(nodes: number[], path: string | null) {
    setSavingNodes(true)
    try {
      await fetch(
        `${getBackendUrl()}/api/products/${productId}/listings/${channel}/${marketplace}/save-browse-nodes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ browseNodes: nodes, categoryPath: path }),
        },
      )
    } catch { /* non-fatal */ } finally {
      setSavingNodes(false)
    }
  }

  // Live variation themes from the Amazon schema for this (marketplace, productType)
  const [schemaThemes, setSchemaThemes] = useState<string[]>([])
  const [themesLoading, setThemesLoading] = useState(false)

  useEffect(() => {
    if (!isAmazon || !effectiveType) {
      setSchemaThemes([])
      return
    }
    let cancelled = false
    setThemesLoading(true)
    fetch(
      `${getBackendUrl()}/api/categories/schema?channel=AMAZON&marketplace=${marketplace}&productType=${encodeURIComponent(effectiveType)}&lite=1`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return
        const themes: string[] =
          Array.isArray(data?.variationThemes?.themes)
            ? data.variationThemes.themes
            : []
        setSchemaThemes(themes)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setThemesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isAmazon, effectiveType, marketplace])

  // "Detect from Amazon" — fetches the real productType + variationTheme
  // from a live listing via getListingsItem / getCatalogItem
  const [detecting, setDetecting] = useState(false)
  const [detectMsg, setDetectMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [refAsin, setRefAsin] = useState('')

  async function detect(asin?: string) {
    setDetecting(true)
    setDetectMsg(null)
    try {
      const url = new URL(
        `${getBackendUrl()}/api/products/${productId}/listings/${channel}/${marketplace}/detect-type`,
      )
      if (asin) url.searchParams.set('asin', asin)
      const res = await fetch(url.toString())
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)

      let changed = false
      if (json.productType) {
        onChange('productType', json.productType)
        changed = true
      }
      if (json.variationTheme) {
        onChange('variationTheme', json.variationTheme)
        changed = true
      }
      if (Array.isArray(json.browseNodes) && json.browseNodes.length > 0) {
        setBrowseNodes(json.browseNodes)
        setBrowseNodesInput(json.browseNodes.join(', '))
        changed = true
        void saveBrowseNodes(json.browseNodes, json.categoryPath ?? null)
      }
      if (json.categoryPath) {
        setCategoryPath(json.categoryPath)
      }
      if (!changed) {
        setDetectMsg({ kind: 'error', text: 'Amazon returned no data for this listing. It may not be live yet.' })
      } else {
        const parts: string[] = []
        if (json.productType) parts.push(`type → ${json.productType}`)
        if (json.variationTheme) parts.push(`theme → ${json.variationTheme}`)
        if (json.browseNodes?.length) parts.push(`${json.browseNodes.length} browse node(s)`)
        setDetectMsg({ kind: 'success', text: `Detected: ${parts.join(', ')} (${json.source})` })
      }
    } catch (e) {
      setDetectMsg({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setDetecting(false)
    }
  }

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 overflow-hidden">
      {/* Card header */}
      <div className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">
          Channel Setup
        </span>
        <span className="text-xs text-slate-400 dark:text-slate-500">
          {channel} · {marketplace}
        </span>
      </div>

      <div className="px-4 py-3 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
        {/* Product type */}
        <div className="space-y-1">
          <label className="text-sm font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {isEbay ? 'eBay category' : `${channel} product type`}
          </label>
          {/* eBay: warn if no valid category is set */}
          {isEbay && !ebayHasValidCategory && (
            <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 mb-1">
              No eBay category set for {marketplace}. Search and select one below.
            </div>
          )}

          <ProductTypePicker
            channel={pickerChannel}
            marketplace={marketplace}
            value={isEbay && !ebayHasValidCategory ? '' : productType}
            onChange={(v) => {
              onChange('productType', v)
              setCategoryPath(null)
              setBrowseNodes([])
              setBrowseNodesInput('')
            }}
            placeholder={`Search eBay ${marketplace} categories…`}
          />

          {/* Copy from another eBay market */}
          {isEbay && ebaySiblings.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap pt-0.5">
              <span className="text-xs text-slate-400">Copy from:</span>
              {ebaySiblings.map((s) => (
                <button
                  key={s.marketplace}
                  type="button"
                  onClick={() => {
                    onChange('productType', s.categoryId)
                    setCategoryPath(null)
                  }}
                  className="text-xs px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 font-mono"
                >
                  eBay {s.marketplace} ({s.categoryId})
                </button>
              ))}
            </div>
          )}

          {/* Category navigation path — auto-fetched or from detection */}
          {isAmazon && (
            <div className="min-h-[1rem]">
              {categoryPathLoading ? (
                <p className="text-xs text-slate-400 italic">Fetching category…</p>
              ) : categoryPath ? (
                <p className="text-xs text-emerald-700 dark:text-emerald-400 leading-relaxed">
                  {categoryPath.split('›').map((part, i, arr) => (
                    <span key={i}>
                      <span>{part.trim()}</span>
                      {i < arr.length - 1 && <span className="mx-1 text-slate-400">›</span>}
                    </span>
                  ))}
                </p>
              ) : (
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  {inheriting ? 'Inheriting master type — detect below to see category path.' : 'Detect below to confirm the category path.'}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Variation theme */}
        <div className="space-y-1">
          <label className="text-sm font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
            Variation theme
            {themesLoading && <span className="text-slate-300 dark:text-slate-600 text-xs">(loading…)</span>}
          </label>

          {isAmazon && schemaThemes.length > 0 ? (
            <select
              value={variationTheme}
              onChange={(e) => onChange('variationTheme', e.target.value)}
              className="w-full h-8 px-2 text-md font-mono border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            >
              <option value="">— none / single variant —</option>
              {schemaThemes.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={variationTheme}
              onChange={(e) => onChange('variationTheme', e.target.value)}
              placeholder={
                isAmazon && effectiveType
                  ? 'Loading from schema…'
                  : 'e.g. SIZE, COLOR, SIZE_NAME/COLOR_NAME'
              }
              className="w-full h-8 px-2 text-md font-mono border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            />
          )}

          <p className="text-xs text-slate-400 dark:text-slate-500">
            {isAmazon && schemaThemes.length > 0
              ? `${schemaThemes.length} theme${schemaThemes.length !== 1 ? 's' : ''} supported by ${effectiveType} on Amazon ${marketplace}.`
              : 'Defines how variant axes are reported to the channel. Leave empty for single-variation listings.'}
          </p>
        </div>
      </div>

      {/* Browse nodes (Amazon only) */}
      {isAmazon && (
        <div className="border-t border-slate-100 dark:border-slate-800 pt-3 space-y-1.5">
          <label className="text-sm font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Browse nodes
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={browseNodesInput}
              onChange={(e) => setBrowseNodesInput(e.target.value)}
              placeholder="e.g. 1571280031, 12345678"
              className="flex-1 h-8 px-2 text-sm font-mono border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            />
            <button
              type="button"
              disabled={savingNodes}
              onClick={() => {
                const parsed = browseNodesInput
                  .split(/[,\s]+/)
                  .map((s) => parseInt(s.trim(), 10))
                  .filter((n) => !isNaN(n) && n > 0)
                setBrowseNodes(parsed)
                void saveBrowseNodes(parsed, categoryPath)
              }}
              className="text-xs px-2.5 py-1 h-8 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:border-blue-400 hover:text-blue-600 disabled:opacity-50 whitespace-nowrap"
            >
              {savingNodes ? 'Saving…' : 'Save nodes'}
            </button>
          </div>
          <p className="text-xs text-slate-400 dark:text-slate-500">
            Amazon category node IDs for this marketplace — comma-separated. Auto-filled by detection below.
          </p>
        </div>
      )}

      {/* Detect from Amazon */}
      {isAmazon && (
        <div className="border-t border-slate-100 dark:border-slate-800 pt-3 space-y-3">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
            Auto-detect from Amazon
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {/* My listing */}
            <div className="flex flex-col gap-1.5 p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300">My live listing</span>
              <p className="text-xs text-slate-400 dark:text-slate-500">
                Reads the product type and variation theme from your own listing on Amazon {marketplace}.
              </p>
              <button
                type="button"
                onClick={() => detect()}
                disabled={detecting}
                className="mt-auto text-xs px-3 py-1.5 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-50 transition-colors text-left"
              >
                {detecting ? 'Detecting…' : '⟳ Detect from my SKU'}
              </button>
            </div>

            {/* Competitor / reference */}
            <div className="flex flex-col gap-1.5 p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300">Competitor / reference ASIN</span>
              <p className="text-xs text-slate-400 dark:text-slate-500">
                Paste any ASIN from the same category — Nexus reads its product type and variation theme from Amazon's catalog.
              </p>
              <div className="flex items-center gap-1.5 mt-auto">
                <input
                  type="text"
                  value={refAsin}
                  onChange={(e) => setRefAsin(e.target.value.trim())}
                  placeholder="B0XXXXXXXXX"
                  className="flex-1 h-7 px-2 text-xs font-mono border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-500"
                />
                <button
                  type="button"
                  disabled={!refAsin || detecting}
                  onClick={() => detect(refAsin)}
                  className="text-xs px-2.5 py-1 h-7 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 whitespace-nowrap"
                >
                  Detect
                </button>
              </div>
            </div>
          </div>

          {detectMsg && (
            <div
              className={cn(
                'text-xs px-3 py-2 rounded',
                detectMsg.kind === 'success'
                  ? 'bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-300'
                  : 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300',
              )}
            >
              {detectMsg.text}
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  )
}

