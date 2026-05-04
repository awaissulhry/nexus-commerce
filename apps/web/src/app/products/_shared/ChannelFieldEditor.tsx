'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import {
  AI_FIELD_MAP,
  AI_SUPPORTED_FIELDS,
  FieldCard,
  SchemaAgeIndicator,
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
}: Props) {
  const [manifest, setManifest] = useState<UnionManifest | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
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

  // Q.3 — sibling listings (every channel + marketplace this product
  // is published on). Used to render "Copy from AMAZON:DE" menus and
  // to broadcast values to other channels.
  const [siblings, setSiblings] = useState<SiblingListing[]>([])

  const [status, setStatus] = useState<SaveStatus>('idle')
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const dirtyRef = useRef<Set<string>>(new Set())
  const saveTimer = useRef<number | null>(null)

  const channelKey = `${channel}:${marketplace}`.toUpperCase()

  // ── Fetch the schema manifest ────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
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
        // Seed variantAttrs from the active listing's variants slice.
        const active = flat.find(
          (l) =>
            l.channel.toUpperCase() === channel.toUpperCase() &&
            l.marketplace.toUpperCase() === marketplace.toUpperCase(),
        )
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
  }, [productId, channel, marketplace, values, onSaved])

  const setBase = useCallback(
    (id: string, value: Primitive) => {
      setValues((prev) => ({ ...prev, [id]: value }))
      dirtyRef.current.add(id)
      setStatus('saving')
      setStatusMsg(null)
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        void flush()
      }, SAVE_DEBOUNCE_MS)
    },
    [flush],
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
      onSaved?.(updated)
    } catch (e) {
      setStatus('error')
      setStatusMsg(e instanceof Error ? e.message : String(e))
    }
  }, [productId, channel, marketplace, variantAttrs, onSaved])

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
    [flushVariants],
  )

  // Flush on unmount so a pending debounce doesn't drop the last edit.
  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      if (variantSaveTimer.current) window.clearTimeout(variantSaveTimer.current)
      if (dirtyRef.current.size > 0) void flush()
      if (dirtyVariantsRef.current.size > 0) void flushVariants()
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

  // ── AI generate (Q.9 will round this out for translate too) ──
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
          {manifest && manifest.optionalFieldCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAllOptional((s) => !s)}
              disabled={loading}
              className={cn(
                'inline-flex items-center gap-1 h-7 px-2 text-[11px] border rounded disabled:opacity-40',
                showAllOptional
                  ? 'border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100'
                  : 'border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900',
              )}
            >
              {showAllOptional
                ? 'Hide optional'
                : `Show all (${manifest.optionalFieldCount} more)`}
            </button>
          )}
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={loading}
            className="inline-flex items-center gap-1 h-7 px-2 text-[11px] text-slate-600 border border-slate-200 rounded hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40"
            title="Re-fetch the schema from cache"
          >
            {loading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            Refresh
          </button>
          <button
            type="button"
            onClick={() => {
              setForceRefresh(true)
              setReloadKey((k) => k + 1)
              window.setTimeout(() => setForceRefresh(false), 100)
            }}
            disabled={loading}
            className="inline-flex items-center gap-1 h-7 px-2 text-[11px] text-blue-700 border border-blue-200 rounded hover:bg-blue-50 disabled:opacity-40"
            title="Force-refresh from Amazon SP-API (bypasses 24h cache)"
          >
            <RefreshCw className="w-3 h-3" />
            Refresh schema
          </button>
        </div>
      </div>

      {loading && !manifest && (
        <div className="border border-slate-200 rounded-lg bg-white px-6 py-12 text-center text-[13px] text-slate-500 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading schema…
        </div>
      )}

      {error && !loading && (
        <div className="border border-rose-200 rounded-lg bg-rose-50 px-4 py-3 text-[13px] text-rose-700 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <div>{error}</div>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="mt-1 text-[12px] font-medium underline hover:no-underline"
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {manifest && (
        <SchemaAgeIndicator
          fetchedAt={manifest.fetchedAtByChannel[channelKey]}
          schemaVersion={manifest.schemaVersionByChannel[channelKey]}
          channelKey={channelKey}
        />
      )}

      {manifest && manifest.fields.length === 0 && !loading && (
        <div className="border border-slate-200 rounded-lg bg-white px-4 py-6 text-center text-[12px] text-slate-500">
          No fields surfaced for this channel yet.
        </div>
      )}

      {manifest && manifest.fields.length > 0 && (
        <div className="space-y-3">
          {manifest.fields.map((field) => {
            const fieldUnsatisfied = unsatisfied
              .filter((u) => u.id === field.id)
              .map((u) => u.channelKey)
            const masterValue = getMasterValue(product, field.id)
            // Q.3 — overrides map: this listing's current value plus
            // every sibling listing's value for the same field, so
            // OverrideMenu can show "Copy from AMAZON:DE" entries and
            // "Apply to" can target sibling channels.
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
                onApplyToChannels={broadcastToChannels}
                channelGroups={[]}
                allChannelKeys={allChannelKeys}
                overrides={overrides}
                onOverrideChange={(ck, v) => {
                  if (ck === channelKey) {
                    setBase(field.id, v as Primitive)
                  }
                  // Cross-channel writes only happen via
                  // broadcastToChannels; the menu's "Copy from X" path
                  // routes through onCopyFrom inside FieldCard which
                  // calls onOverrideChange for the active channel only.
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
        </div>
      )}

      {manifest && unsatisfied.length > 0 && (
        <div className="text-[12px] text-amber-700">
          {unsatisfied.length} required field
          {unsatisfied.length === 1 ? '' : 's'} still unfilled
        </div>
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
        'inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border',
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
    </div>
  )
}
