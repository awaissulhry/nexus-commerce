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

interface Props {
  productId: string
  channel: string
  marketplace: string
  /** Called after a successful save so the parent can refresh other
   *  bits of state (status bar, etc.) that depend on the listing
   *  having a row. */
  onSaved?: (listing: any) => void
}

/** Q.2 — schema-driven editor for one (product, channel, marketplace).
 *  Reuses the same FieldCard tree as the wizard's Step 5 so the edit
 *  page sees every field Amazon's productType requires (or that the
 *  curated common-optional set surfaces). All field values write to
 *  ChannelListing via PUT — known fields land in their own columns
 *  (title, description, bulletPointsOverride) and the rest goes into
 *  platformAttributes.attributes.  */
export default function ChannelFieldEditor({
  productId,
  channel,
  marketplace,
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
  const [variantAttrs, setVariantAttrs] = useState<
    Record<string, Record<string, Primitive>>
  >({})
  const [aiBusyFields, setAiBusyFields] = useState<Set<string>>(new Set())

  const [status, setStatus] = useState<SaveStatus>('idle')
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  // Track which field ids changed since the last successful flush so
  // we only PUT what's different.
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
        // Seed values from the manifest's currentValue (which the
        // backend populates from baseAttributes — i.e. the existing
        // listing).
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

  const setBase = useCallback((id: string, value: Primitive) => {
    setValues((prev) => ({ ...prev, [id]: value }))
    dirtyRef.current.add(id)
    setStatus('saving')
    setStatusMsg(null)
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void flush()
    }, SAVE_DEBOUNCE_MS)
  }, [flush])

  // Flush on unmount so a pending debounce doesn't drop the last edit.
  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      if (dirtyRef.current.size > 0) void flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        // Endpoint shape mirrors wizard generate-content: { groups: [{ result: { title, bullets, ... } }] }
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
        /* swallow — user can retry */
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
            return (
              <FieldCard
                key={field.id}
                field={field}
                viewMode={{ channelKey }}
                baseValue={values[field.id]}
                onBaseChange={(v) => setBase(field.id, v)}
                onAIGenerate={
                  AI_SUPPORTED_FIELDS.has(field.id)
                    ? () => aiGenerate(field.id)
                    : undefined
                }
                aiBusy={aiBusyFields.has(field.id)}
                channelGroups={[]}
                allChannelKeys={[channelKey]}
                overrides={{ [channelKey]: values[field.id] }}
                onOverrideChange={(_ck, v) => setBase(field.id, v as Primitive)}
                variations={manifest.variations}
                variantValues={Object.fromEntries(
                  manifest.variations.map((v) => [
                    v.id,
                    variantAttrs[v.id]?.[field.id],
                  ]),
                )}
                onVariantChange={(variationId, v) => {
                  setVariantAttrs((prev) => {
                    const slice = { ...(prev[variationId] ?? {}) }
                    if (v === undefined || v === '' || v === null) {
                      delete slice[field.id]
                    } else {
                      slice[field.id] = v
                    }
                    return { ...prev, [variationId]: slice }
                  })
                }}
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
