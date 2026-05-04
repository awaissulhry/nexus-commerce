'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'
import ChannelGroupsManager, {
  type ChannelGroup,
} from '../components/ChannelGroupsManager'

// Mirrors UnionField on the backend (apps/api/src/services/listing-
// wizard/schema-parser.service.ts). Kept as plain interfaces here so
// the frontend doesn't have to import from the API package.
type FieldKind =
  | 'text'
  | 'longtext'
  | 'enum'
  | 'number'
  | 'boolean'
  | 'string_array'
  | 'unsupported'

/** L.2 — string_array values are stored as JSON-encoded string[]
 *  in the same `Record<string, Primitive>` shape so existing storage
 *  paths don't fork. The UI parses on read, stringifies on write. */
type Primitive = string | number | boolean

interface UnionField {
  id: string
  label: string
  description?: string
  kind: FieldKind
  required: boolean
  wrapped: boolean
  options?: Array<{ value: string; label: string }>
  defaultValue?: string | number | boolean
  examples?: string[]
  maxLength?: number
  minLength?: number
  unsupportedReason?: string
  maxItems?: number
  requiredFor: string[]
  optionalFor: string[]
  notUsedIn: string[]
  currentValue?: string | number | boolean
  overrides: Record<string, string | number | boolean>
  divergent?: boolean
  variantEligible: boolean
}

interface UnionVariation {
  id: string
  sku: string
  attributes: Record<string, string>
}

interface UnionManifest {
  channels: Array<{ platform: string; marketplace: string; productType: string }>
  schemaVersionByChannel: Record<string, string>
  fetchedAtByChannel: Record<string, string>
  fields: UnionField[]
  channelsMissingSchema: Array<{
    channelKey: string
    reason: 'no_product_type' | 'fetch_failed' | 'unsupported_channel'
    detail?: string
  }>
  variations: UnionVariation[]
  optionalFieldCount: number
  includesAllOptional: boolean
}

const SAVE_DEBOUNCE_MS = 600

/** L.2 — fields that the existing /generate-content endpoint can
 *  populate. Maps the Amazon field id to the ContentField name the
 *  endpoint expects. */
const AI_FIELD_MAP: Record<string, 'title' | 'bullets' | 'description' | 'keywords'> =
  {
    item_name: 'title',
    bullet_point: 'bullets',
    product_description: 'description',
    generic_keyword: 'keywords',
  }
const AI_SUPPORTED_FIELDS = new Set(Object.keys(AI_FIELD_MAP))

export default function Step4Attributes({
  wizardState,
  updateWizardState,
  wizardId,
  channels,
}: StepProps) {
  const [manifest, setManifest] = useState<UnionManifest | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const initialBase = (wizardState.attributes ?? {}) as Record<string, Primitive>
  const initialOverrides = useMemo(() => {
    // Pull per-channel overrides out of channelStates if the parent
    // exposes them (Phase B+ stores them under
    // wizardState.channelStates_local — but in the common case the
    // server-side manifest already has them). The local mirror here
    // is for optimistic updates only; the server returns canonical
    // values on the next refresh.
    return {} as Record<string, Record<string, Primitive>>
  }, [])

  const [values, setValues] = useState<Record<string, Primitive>>(initialBase)
  const [overrides, setOverrides] = useState<
    Record<string, Record<string, Primitive>>
  >(initialOverrides)
  const [expandedFields, setExpandedFields] = useState<Set<string>>(
    new Set(),
  )
  // K.4: per-variant attribute overrides keyed by variationId →
  // fieldId → value. Applies to every channel by default; per-channel
  // variant overrides are deferred to v2 (users can still override
  // entire fields per channel via the existing per-channel section).
  const [variantAttrs, setVariantAttrs] = useState<
    Record<string, Record<string, Primitive>>
  >(
    (wizardState.variantAttributes ?? {}) as Record<
      string,
      Record<string, Primitive>
    >,
  )
  const [expandedVariants, setExpandedVariants] = useState<Set<string>>(
    new Set(),
  )
  const [showAllOptional, setShowAllOptional] = useState(false)
  const [aiBusyFields, setAiBusyFields] = useState<Set<string>>(new Set())
  // M.1 — tabbed view. activeTab is either 'base' (Shared base
  // editor) or a channel key like "AMAZON:IT". Marketplace sub-tabs
  // are derived from the active platform on render.
  const [activeTab, setActiveTab] = useState<string>('base')

  const channelGroups = (wizardState.channelGroups ?? []) as ChannelGroup[]
  const onChannelGroupsChange = useCallback(
    (next: ChannelGroup[]) => {
      void updateWizardState({ channelGroups: next })
    },
    [updateWizardState],
  )
  // L.4 — translate-busy keys are "<fieldId>:<channelKey>" so per-
  // channel translate buttons can spin independently.
  const [translateBusy, setTranslateBusy] = useState<Set<string>>(new Set())

  const onTranslate = useCallback(
    async (fieldId: string, channelKey: string) => {
      const aiKind = AI_FIELD_MAP[fieldId]
      if (!aiKind) return
      const busyKey = `${fieldId}:${channelKey}`
      setTranslateBusy((prev) => {
        const next = new Set(prev)
        next.add(busyKey)
        return next
      })
      try {
        // Generate-content already groups channels by language:platform
        // server-side; we ask for ALL fields of this kind, then pick
        // the result whose group covers the requested channelKey.
        const res = await fetch(
          `${getBackendUrl()}/api/listing-wizard/${wizardId}/generate-content`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: [aiKind], variant: 0 }),
          },
        )
        const json = await res.json()
        if (!res.ok) return
        const matchedGroup = (json?.groups ?? []).find((g: any) =>
          Array.isArray(g.channelKeys) && g.channelKeys.includes(channelKey),
        )
        if (!matchedGroup?.result) return
        let value: string | undefined
        if (aiKind === 'title') {
          value = matchedGroup.result.title?.content
        } else if (aiKind === 'description') {
          value = matchedGroup.result.description?.content
        } else if (aiKind === 'keywords') {
          value = matchedGroup.result.keywords?.content
        } else if (aiKind === 'bullets') {
          const bullets = matchedGroup.result.bullets?.content
          if (Array.isArray(bullets)) {
            value = JSON.stringify(
              bullets.filter(
                (b: unknown) => typeof b === 'string' && b.trim().length > 0,
              ),
            )
          }
        }
        if (typeof value === 'string' && value.length > 0) {
          setOverride(channelKey, fieldId, value as Primitive)
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
    // setOverride is stable from useCallback above
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wizardId],
  )

  // L.2 — fire /generate-content for a single field, take the first
  // selected channel's group, and write the value into state.attributes
  // (base) so the user can then per-channel override if they need to.
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
          `${getBackendUrl()}/api/listing-wizard/${wizardId}/generate-content`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: [aiKind], variant: 0 }),
          },
        )
        const json = await res.json()
        if (!res.ok) {
          throw new Error(json?.error ?? `HTTP ${res.status}`)
        }
        // Pick the first group's result — any group is fine, the AI
        // call gave us one suggestion per (lang, platform). The user
        // can per-channel override afterward.
        const firstGroup = json?.groups?.[0]?.result
        if (!firstGroup) return
        let value: string | undefined
        if (aiKind === 'title') {
          value = firstGroup.title?.content
        } else if (aiKind === 'description') {
          value = firstGroup.description?.content
        } else if (aiKind === 'keywords') {
          value = firstGroup.keywords?.content
        } else if (aiKind === 'bullets') {
          // string_array storage: JSON-encoded string[].
          const bullets = firstGroup.bullets?.content
          if (Array.isArray(bullets)) {
            value = JSON.stringify(
              bullets.filter(
                (b: unknown) => typeof b === 'string' && b.trim().length > 0,
              ),
            )
          }
        }
        if (typeof value === 'string' && value.length > 0) {
          setValues((prev) => ({ ...prev, [fieldId]: value as Primitive }))
        }
      } catch {
        /* swallow — UI shows no error toast for now; user can retry */
      } finally {
        setAiBusyFields((prev) => {
          const next = new Set(prev)
          next.delete(fieldId)
          return next
        })
      }
    },
    [wizardId],
  )

  // Debounced persist of `values` (base) + variantAttrs →
  // wizardState.{attributes,variantAttributes}.
  const saveTimer = useRef<number | null>(null)
  useEffect(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void updateWizardState({
        attributes: values,
        variantAttributes: variantAttrs,
      })
    }, SAVE_DEBOUNCE_MS)
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, variantAttrs])

  // Per-channel override saves use a separate timer so writes to
  // overrides don't race with base writes.
  const overrideSaveTimer = useRef<number | null>(null)
  useEffect(() => {
    if (overrideSaveTimer.current) window.clearTimeout(overrideSaveTimer.current)
    overrideSaveTimer.current = window.setTimeout(() => {
      // Patch each channel's attributes slice via channelStates.
      const channelStates: Record<string, Record<string, unknown>> = {}
      for (const [chKey, slice] of Object.entries(overrides)) {
        if (Object.keys(slice).length > 0) {
          channelStates[chKey] = { attributes: slice }
        }
      }
      if (Object.keys(channelStates).length > 0) {
        void fetchPatch(wizardId, { channelStates })
      }
    }, SAVE_DEBOUNCE_MS)
    return () => {
      if (overrideSaveTimer.current)
        window.clearTimeout(overrideSaveTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides])

  // Fetch the union manifest.
  useEffect(() => {
    if (channels.length === 0) {
      setLoading(false)
      setError('Pick channels in Step 1 first.')
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    const url = new URL(
      `${getBackendUrl()}/api/listing-wizard/${wizardId}/required-fields`,
    )
    if (showAllOptional) url.searchParams.set('all', '1')
    fetch(url.toString())
      .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json() }))
      .then(({ ok, status, json }) => {
        if (cancelled) return
        if (!ok) {
          setError(json?.error ?? `HTTP ${status}`)
          setManifest(null)
          return
        }
        const m = json as UnionManifest
        setManifest(m)
        // Seed inputs:
        //   - base values: existing wizardState.attributes wins, then
        //     server defaults from product master fill the rest
        //   - per-channel overrides: server merges from channelStates,
        //     so trust m.fields[].overrides as the canonical source
        setValues((prev) => {
          const next = { ...prev }
          for (const f of m.fields) {
            if (next[f.id] === undefined && f.defaultValue !== undefined) {
              next[f.id] = f.defaultValue as Primitive
            }
          }
          return next
        })
        const seededOverrides: Record<string, Record<string, Primitive>> = {}
        for (const f of m.fields) {
          for (const [chKey, val] of Object.entries(f.overrides)) {
            if (!seededOverrides[chKey]) seededOverrides[chKey] = {}
            seededOverrides[chKey][f.id] = val
          }
        }
        setOverrides(seededOverrides)
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
  }, [channels, wizardId, reloadKey, showAllOptional])

  const setBase = useCallback((id: string, value: Primitive) => {
    setValues((prev) => ({ ...prev, [id]: value }))
  }, [])

  const setOverride = useCallback(
    (channelKey: string, id: string, value: Primitive | undefined) => {
      setOverrides((prev) => {
        const next = { ...prev }
        const slice = { ...(next[channelKey] ?? {}) }
        if (value === undefined || value === '' || value === null) {
          delete slice[id]
        } else {
          slice[id] = value
        }
        next[channelKey] = slice
        return next
      })
    },
    [],
  )

  // N.2 — broadcast a field value from one channel to a target list.
  // Used by OverrideMenu's "Apply to..." section. Empty source values
  // are no-ops (we don't want to broadcast nothing).
  const onApplyToChannels = useCallback(
    (fieldId: string, sourceChannelKey: string, targetKeys: string[]) => {
      const sourceValue = overrides[sourceChannelKey]?.[fieldId]
      if (isEmpty(sourceValue)) return
      setOverrides((prev) => {
        const next = { ...prev }
        for (const target of targetKeys) {
          if (target === sourceChannelKey) continue
          const slice = { ...(next[target] ?? {}) }
          slice[fieldId] = sourceValue as Primitive
          next[target] = slice
        }
        return next
      })
    },
    [overrides],
  )

  const allChannelKeys = useMemo(
    () => channels.map((c) => `${c.platform}:${c.marketplace}`),
    [channels],
  )

  const toggleExpanded = useCallback((id: string) => {
    setExpandedFields((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const unsatisfied = useMemo(() => {
    if (!manifest) return [] as Array<{ id: string; channelKey: string }>
    const out: Array<{ id: string; channelKey: string }> = []
    for (const f of manifest.fields) {
      if (f.kind === 'unsupported') continue
      for (const channelKey of f.requiredFor) {
        const ovr = overrides[channelKey]?.[f.id]
        if (!isEmpty(ovr)) continue
        if (!isEmpty(values[f.id])) continue
        out.push({ id: f.id, channelKey })
      }
    }
    return out
  }, [manifest, values, overrides])

  const onContinue = useCallback(async () => {
    if (unsatisfied.length > 0) return
    await updateWizardState({ attributes: values }, { advance: true })
  }, [unsatisfied.length, updateWizardState, values])

  if (channels.length === 0) {
    return (
      <div className="max-w-2xl mx-auto py-12 px-6 text-center">
        <p className="text-[13px] text-slate-600">
          Pick channels in Step 1 before configuring attributes.
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto py-10 px-6">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold text-slate-900">
            Required Attributes
          </h2>
          <p className="text-[13px] text-slate-600 mt-1">
            Union of every required field across the selected channels.
            Smart defaults come from the master product; click "Override
            per channel" on any field that should differ between markets.
          </p>
        </div>
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
              title={
                showAllOptional
                  ? 'Hide the long-tail optional fields'
                  : 'Show every optional field for the selected categories'
              }
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
            title="Re-fetch the required-fields manifest"
          >
            {loading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            Refresh
          </button>
        </div>
      </div>

      {loading && !manifest && (
        <div className="border border-slate-200 rounded-lg bg-white px-6 py-12 text-center text-[13px] text-slate-500 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading required fields…
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

      {manifest && manifest.channelsMissingSchema.length > 0 && (
        <div className="mb-4 border border-amber-200 bg-amber-50 rounded-md px-3 py-2 text-[12px] text-amber-800">
          <div className="font-medium mb-1">
            Schema unavailable for some channels — union may be incomplete
          </div>
          <ul className="space-y-0.5 text-[11px]">
            {manifest.channelsMissingSchema.map((m) => (
              <li key={m.channelKey}>
                <span className="font-mono">{m.channelKey}</span> —{' '}
                <span className="text-amber-700">{m.reason}</span>
                {m.detail && <span className="text-amber-600"> · {m.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* M.3 — variant span warning. When the master's children have
          attribute keys that span very different shapes (e.g. one
          variant has size+color, another has material+gender), it
          usually means the seller has two distinct products that
          should be split into separate listings rather than variants
          of one. Amazon would reject the submission. */}
      {manifest && (() => {
        const span = computeVariantSpan(manifest.variations)
        if (!span.suspicious) return null
        return (
          <div className="mb-4 border border-amber-200 bg-amber-50 rounded-md px-3 py-2 text-[12px] text-amber-800">
            <div className="font-medium mb-1">
              Variants span very different attribute shapes
            </div>
            <p className="text-[11px] text-amber-700 mb-1.5">
              The master product has {manifest.variations.length} variants
              with {span.uniqueKeyCount} distinct attribute keys across
              them. Amazon's listing model expects every variant under a
              parent to share the same attribute axes (e.g. all
              size+color, or all size+material). Mixing shapes usually
              means these are separate products that should be split into
              their own listings — submission may be rejected otherwise.
            </p>
            <details className="text-[11px] text-amber-700">
              <summary className="cursor-pointer font-medium">
                Show per-variant attribute keys
              </summary>
              <ul className="mt-1 space-y-0.5 ml-3">
                {manifest.variations.map((v) => (
                  <li key={v.id} className="font-mono">
                    {v.sku}: {Object.keys(v.attributes).join(', ') || '—'}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )
      })()}

      {manifest && manifest.fields.length === 0 && !loading && (
        <div className="border border-slate-200 rounded-lg bg-white px-4 py-6 text-center text-[12px] text-slate-500">
          No required fields across the selected channels.
        </div>
      )}

      {/* N.2 — channel groups manager (manual, shared with Steps 7/9).
          Lets the seller define named channel buckets for the bulk
          broadcast actions in OverrideMenu / per-variant grid. */}
      {manifest && channels.length > 0 && (
        <div className="mb-3">
          <ChannelGroupsManager
            groups={channelGroups}
            availableChannels={channels}
            onChange={onChannelGroupsChange}
            defaultCollapsed
          />
        </div>
      )}

      {/* M.1 — tab navigation: Shared base + per-platform tabs */}
      {manifest && manifest.fields.length > 0 && (
        <AttributesTabStrip
          channels={channels}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          unsatisfied={unsatisfied}
        />
      )}

      {manifest && manifest.fields.length > 0 && (
        <div className="space-y-3 mt-3">
          {manifest.fields
            .filter((field) =>
              activeTab === 'base'
                ? true
                : field.requiredFor.includes(activeTab) ||
                  field.optionalFor.includes(activeTab),
            )
            .map((field) => {
              const fieldUnsatisfied = unsatisfied
                .filter((u) => u.id === field.id)
                .map((u) => u.channelKey)
              return (
                <FieldCard
                  key={field.id}
                  field={field}
                  viewMode={activeTab === 'base' ? 'base' : { channelKey: activeTab }}
                  baseValue={values[field.id]}
                  onBaseChange={(v) => setBase(field.id, v)}
                  onAIGenerate={
                    AI_SUPPORTED_FIELDS.has(field.id)
                      ? () => aiGenerate(field.id)
                      : undefined
                  }
                  aiBusy={aiBusyFields.has(field.id)}
                  onTranslate={onTranslate}
                  translateBusy={translateBusy}
                  channelGroups={channelGroups}
                  allChannelKeys={allChannelKeys}
                  onApplyToChannels={onApplyToChannels}
                  overrides={Object.fromEntries(
                    Object.entries(overrides).map(([k, slice]) => [
                      k,
                      slice[field.id],
                    ]),
                  )}
                  onOverrideChange={(channelKey, v) =>
                    setOverride(channelKey, field.id, v)
                  }
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

      <div className="mt-8 flex items-center justify-between gap-3">
        <div className="text-[12px]">
          {unsatisfied.length === 0 && manifest ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-700">
              <CheckCircle2 className="w-3.5 h-3.5" />
              All required fields satisfied across selected channels.
            </span>
          ) : (
            <span className="text-amber-700">
              {unsatisfied.length} field × channel pair
              {unsatisfied.length === 1 ? '' : 's'} unsatisfied
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onContinue}
          disabled={!manifest || unsatisfied.length > 0}
          className={cn(
            'h-8 px-4 rounded-md text-[13px] font-medium',
            !manifest || unsatisfied.length > 0
              ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
              : 'bg-blue-600 text-white hover:bg-blue-700',
          )}
        >
          Continue
        </button>
      </div>
    </div>
  )
}

// ── Field row ───────────────────────────────────────────────────

function FieldCard({
  field,
  viewMode,
  baseValue,
  onBaseChange,
  overrides,
  onOverrideChange,
  variations,
  variantValues,
  onVariantChange,
  variantsExpanded,
  onToggleVariants,
  expanded,
  onToggleExpanded,
  unsatisfiedChannels,
  onAIGenerate,
  aiBusy,
  onTranslate,
  translateBusy,
  channelGroups,
  allChannelKeys,
  onApplyToChannels,
}: {
  field: UnionField
  viewMode: 'base' | { channelKey: string }
  baseValue: Primitive | undefined
  onBaseChange: (v: Primitive) => void
  overrides: Record<string, Primitive | undefined>
  onOverrideChange: (channelKey: string, v: Primitive | undefined) => void
  variations: UnionVariation[]
  variantValues: Record<string, Primitive | undefined>
  onVariantChange: (variationId: string, v: Primitive | undefined) => void
  variantsExpanded: boolean
  onToggleVariants: () => void
  expanded: boolean
  onToggleExpanded: () => void
  unsatisfiedChannels: string[]
  onAIGenerate?: () => void
  aiBusy?: boolean
  onTranslate?: (fieldId: string, channelKey: string) => void
  translateBusy?: Set<string>
  channelGroups?: ChannelGroup[]
  allChannelKeys?: string[]
  onApplyToChannels?: (
    fieldId: string,
    sourceChannelKey: string,
    targetKeys: string[],
  ) => void
}) {
  const supportsAI = AI_SUPPORTED_FIELDS.has(field.id)
  const isChannelView = typeof viewMode === 'object'
  const activeChannelKey = isChannelView ? viewMode.channelKey : null
  const isRequiredHere =
    activeChannelKey !== null && field.requiredFor.includes(activeChannelKey)
  const isOptionalHere =
    activeChannelKey !== null && field.optionalFor.includes(activeChannelKey)
  const channelOverrideValue = activeChannelKey
    ? overrides[activeChannelKey]
    : undefined
  const channelInherits =
    isChannelView && isEmpty(channelOverrideValue) && !isEmpty(baseValue)
  const hasUnsatisfied = unsatisfiedChannels.length > 0
  const overrideCount = Object.values(overrides).filter(
    (v) => !isEmpty(v),
  ).length
  const variantOverrideCount = Object.values(variantValues).filter(
    (v) => !isEmpty(v),
  ).length
  const showVariantSection =
    field.variantEligible && variations.length > 0

  return (
    <div
      className={cn(
        'border rounded-lg bg-white px-4 py-3',
        hasUnsatisfied ? 'border-amber-200' : 'border-slate-200',
      )}
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-3 flex-wrap">
        <label className="text-[13px] font-medium text-slate-900">
          {field.label}
          {(viewMode === 'base'
            ? field.requiredFor.length > 0
            : isRequiredHere) && <span className="text-rose-600 ml-0.5">*</span>}
          <span className="ml-2 text-[11px] font-mono font-normal text-slate-400">
            {field.id}
          </span>
        </label>
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* In Shared base view, show all channel chips so the user
              sees the full surface. In a per-channel view, show only a
              single status badge for the active channel. */}
          {viewMode === 'base' ? (
            <>
              {field.requiredFor.length > 0 && (
                <ChannelTagGroup
                  tone="required"
                  channels={field.requiredFor}
                />
              )}
              {field.optionalFor.length > 0 && (
                <ChannelTagGroup
                  tone="optional"
                  channels={field.optionalFor}
                />
              )}
            </>
          ) : (
            <span
              className={cn(
                'text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 border rounded',
                isRequiredHere
                  ? 'bg-blue-50 text-blue-700 border-blue-200'
                  : isOptionalHere
                  ? 'bg-slate-50 text-slate-600 border-slate-200'
                  : 'bg-slate-50 text-slate-400 border-slate-200',
              )}
            >
              {isRequiredHere
                ? 'Required'
                : isOptionalHere
                ? 'Optional'
                : 'Not used'}
            </span>
          )}
        </div>
      </div>
      {field.description && (
        <p className="text-[12px] text-slate-500 mb-2">{field.description}</p>
      )}
      {field.divergent && (
        <p className="text-[11px] text-amber-700 mb-2">
          Heads-up: this field's metadata differs across channels (different
          enum values or length limits). Use overrides per channel if the
          merged shape doesn't fit one of them.
        </p>
      )}

      {supportsAI && onAIGenerate && (
        <div className="mb-2 flex items-center justify-end">
          <button
            type="button"
            onClick={onAIGenerate}
            disabled={aiBusy}
            className="inline-flex items-center gap-1 h-6 px-2 text-[11px] font-medium text-blue-700 border border-blue-200 rounded hover:bg-blue-50 disabled:opacity-40"
            title={`Generate ${field.label} with AI for the first selected channel`}
          >
            {aiBusy ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Sparkles className="w-3 h-3" />
            )}
            AI generate
          </button>
        </div>
      )}

      {viewMode === 'base' ? (
        <FieldInput field={field} value={baseValue} onChange={onBaseChange} />
      ) : (
        // M.1 — channel-tab view: render the channel's override
        // value as the primary input. Empty falls through to the
        // base value (placeholder shows the inheritance source).
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <FieldInput
              field={field}
              value={channelOverrideValue}
              onChange={(v) =>
                onOverrideChange(activeChannelKey!, v)
              }
              placeholder={
                channelInherits
                  ? `Inherits base: ${formatValue(baseValue)}`
                  : '— (leave empty to use base)'
              }
            />
          </div>
          <OverrideMenu
            channelKey={activeChannelKey!}
            hasBase={!isEmpty(baseValue)}
            otherChannels={Object.entries(overrides)
              .filter(([k, v]) => k !== activeChannelKey && !isEmpty(v))
              .map(([k]) => k)}
            otherValues={Object.fromEntries(
              Object.entries(overrides)
                .filter(([k, v]) => k !== activeChannelKey && !isEmpty(v))
                .map(([k, v]) => [k, v as Primitive]),
            )}
            hasValue={!isEmpty(channelOverrideValue)}
            currentValue={channelOverrideValue}
            channelGroups={channelGroups ?? []}
            allChannelKeys={allChannelKeys ?? []}
            supportsTranslate={
              AI_SUPPORTED_FIELDS.has(field.id) && !isEmpty(baseValue)
            }
            translateBusy={
              translateBusy?.has(`${field.id}:${activeChannelKey}`) ?? false
            }
            onCopyFromBase={() => {
              if (!isEmpty(baseValue)) {
                onOverrideChange(activeChannelKey!, baseValue as Primitive)
              }
            }}
            onCopyFrom={(sourceKey) => {
              const v = overrides[sourceKey]
              if (!isEmpty(v)) {
                onOverrideChange(activeChannelKey!, v as Primitive)
              }
            }}
            onApplyToChannels={(targetKeys) =>
              onApplyToChannels?.(field.id, activeChannelKey!, targetKeys)
            }
            onTranslate={() =>
              onTranslate?.(field.id, activeChannelKey!)
            }
            onClear={() =>
              onOverrideChange(activeChannelKey!, undefined)
            }
          />
        </div>
      )}

      {field.examples && field.examples.length > 0 && field.kind !== 'enum' && (
        <p className="mt-1.5 text-[11px] text-slate-400">
          Examples: {field.examples.join(', ')}
        </p>
      )}
      {field.maxLength && field.kind !== 'enum' && (
        <p className="mt-1 text-[11px] text-slate-400">
          {currentLength(
            viewMode === 'base' ? baseValue : channelOverrideValue,
          )}{' '}
          / {field.maxLength} characters
        </p>
      )}

      {/* "Override per channel" expandable only relevant in Shared
          base view — channel-specific tabs already focus the user on
          one channel. */}
      {viewMode === 'base' && field.requiredFor.length > 1 && (
        <div className="mt-3 border-t border-slate-100 pt-2">
          <button
            type="button"
            onClick={onToggleExpanded}
            className="text-[12px] text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
          >
            {expanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            Override per channel
            {overrideCount > 0 && (
              <span className="text-[10px] font-medium text-blue-700 bg-blue-50 px-1 py-0.5 rounded">
                {overrideCount}
              </span>
            )}
          </button>
          {expanded && (
            <div className="mt-2 space-y-2">
              {field.requiredFor.map((channelKey) => {
                const ov = overrides[channelKey]
                const isUnsatisfied =
                  unsatisfiedChannels.includes(channelKey)
                const otherFilled = Object.entries(overrides)
                  .filter(([k, v]) => k !== channelKey && !isEmpty(v))
                  .map(([k]) => k)
                return (
                  <div
                    key={channelKey}
                    className={cn(
                      'flex items-center gap-2',
                      isUnsatisfied && 'bg-amber-50/40 -mx-2 px-2 rounded',
                    )}
                  >
                    <span className="text-[11px] font-mono text-slate-600 w-24 flex-shrink-0">
                      {channelKey}
                    </span>
                    <FieldInput
                      field={field}
                      value={ov}
                      onChange={(v) => onOverrideChange(channelKey, v)}
                      placeholder={
                        isEmpty(baseValue)
                          ? '— (leave empty to use base)'
                          : `Inherits: ${formatValue(baseValue)}`
                      }
                      compact
                    />
                    <OverrideMenu
                      channelKey={channelKey}
                      hasBase={!isEmpty(baseValue)}
                      otherChannels={otherFilled}
                      otherValues={Object.fromEntries(
                        otherFilled.map((k) => [k, overrides[k] as Primitive]),
                      )}
                      hasValue={!isEmpty(ov)}
                      currentValue={ov}
                      channelGroups={channelGroups ?? []}
                      allChannelKeys={allChannelKeys ?? []}
                      supportsTranslate={
                        AI_SUPPORTED_FIELDS.has(field.id) &&
                        !isEmpty(baseValue)
                      }
                      translateBusy={
                        translateBusy?.has(`${field.id}:${channelKey}`) ?? false
                      }
                      onCopyFromBase={() => {
                        if (!isEmpty(baseValue)) {
                          onOverrideChange(channelKey, baseValue as Primitive)
                        }
                      }}
                      onCopyFrom={(sourceKey) => {
                        const v = overrides[sourceKey]
                        if (!isEmpty(v)) {
                          onOverrideChange(channelKey, v as Primitive)
                        }
                      }}
                      onApplyToChannels={(targetKeys) =>
                        onApplyToChannels?.(field.id, channelKey, targetKeys)
                      }
                      onTranslate={() =>
                        onTranslate?.(field.id, channelKey)
                      }
                      onClear={() =>
                        onOverrideChange(channelKey, undefined)
                      }
                    />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* K.4: per-variant override grid for variant-eligible fields */}
      {showVariantSection && (
        <div className="mt-3 border-t border-slate-100 pt-2">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={onToggleVariants}
              className="text-[12px] text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
            >
              {variantsExpanded ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              Override per variation
              {variantOverrideCount > 0 && (
                <span className="text-[10px] font-medium text-purple-700 bg-purple-50 px-1 py-0.5 rounded">
                  {variantOverrideCount} of {variations.length}
                </span>
              )}
              <span className="text-[10px] text-slate-400 italic">
                (variant-eligible field)
              </span>
            </button>
            {variantsExpanded && (
              <div className="flex items-center gap-2">
                {/* M.2 — pull each variant's master attribute value
                    into its override slot. Skips slots that already
                    have an explicit override and skips variants with
                    no master value. One-click bulk fill. */}
                <button
                  type="button"
                  onClick={() => {
                    for (const v of variations) {
                      const master = v.attributes[field.id.toLowerCase()]
                      if (
                        master &&
                        master.length > 0 &&
                        isEmpty(variantValues[v.id])
                      ) {
                        onVariantChange(v.id, master as Primitive)
                      }
                    }
                  }}
                  title="Fill empty variant slots with each variant's master attribute value"
                  className="text-[11px] text-blue-600 hover:underline"
                >
                  Pull master values
                </button>
                {variantOverrideCount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      for (const v of variations) {
                        if (!isEmpty(variantValues[v.id])) {
                          onVariantChange(v.id, undefined)
                        }
                      }
                    }}
                    title="Clear every per-variant override for this field"
                    className="text-[11px] text-slate-500 hover:text-slate-900 hover:underline"
                  >
                    Clear all
                  </button>
                )}
              </div>
            )}
          </div>
          {variantsExpanded && (
            <div className="mt-2 space-y-1.5">
              {variations.map((v) => {
                const seedFromMaster = v.attributes[field.id.toLowerCase()]
                const value = variantValues[v.id]
                return (
                  <div key={v.id} className="flex items-center gap-2">
                    <div className="w-32 flex-shrink-0 min-w-0">
                      <div className="font-mono text-[11px] text-slate-700 truncate">
                        {v.sku}
                      </div>
                      <div className="text-[10px] text-slate-500 truncate">
                        {Object.entries(v.attributes)
                          .map(([k, val]) => `${k}: ${val}`)
                          .join(' · ') || '—'}
                      </div>
                    </div>
                    <FieldInput
                      field={field}
                      value={value}
                      onChange={(val) => onVariantChange(v.id, val)}
                      placeholder={
                        seedFromMaster
                          ? `Master: ${seedFromMaster}`
                          : isEmpty(baseValue)
                          ? '— (leave empty to use base)'
                          : `Inherits: ${formatValue(baseValue)}`
                      }
                      compact
                    />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function FieldInput({
  field,
  value,
  onChange,
  placeholder,
  compact = false,
}: {
  field: UnionField
  value: Primitive | undefined
  onChange: (v: Primitive) => void
  placeholder?: string
  compact?: boolean
}) {
  if (field.kind === 'unsupported') {
    return (
      <div className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
        Can't render this field automatically yet.
        {field.unsupportedReason ? ` (${field.unsupportedReason})` : ''}
      </div>
    )
  }

  if (field.kind === 'enum') {
    const v = (value ?? '') as string
    return (
      <select
        value={v}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'w-full px-2 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white',
          compact ? 'h-7' : 'h-8',
        )}
      >
        <option value="">— Select —</option>
        {(field.options ?? []).map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    )
  }

  if (field.kind === 'boolean') {
    const v = Boolean(value)
    return (
      <label className="flex items-center gap-2 text-[13px] text-slate-700">
        <input
          type="checkbox"
          checked={v}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
        />
        {v ? 'Yes' : 'No'}
      </label>
    )
  }

  // L.2 — string_array: N labelled inputs (bullet_point uses 5).
  if (field.kind === 'string_array') {
    const arr = parseStringArray(value as string | undefined)
    const max = Math.max(field.maxItems ?? 5, 1)
    const slots: string[] = []
    for (let i = 0; i < max; i++) slots.push(arr[i] ?? '')
    return (
      <div className="space-y-1.5">
        {slots.map((slot, idx) => (
          <div key={idx} className="flex items-start gap-2">
            <span className="text-[10px] font-mono text-slate-400 mt-2 flex-shrink-0">
              {idx + 1}.
            </span>
            <textarea
              value={slot}
              maxLength={field.maxLength}
              rows={compact ? 1 : 2}
              placeholder={
                idx === 0 && placeholder ? placeholder : `Entry ${idx + 1}`
              }
              onChange={(e) => {
                const next = slots.slice()
                next[idx] = e.target.value
                // Trim trailing empty entries before serialising — keeps
                // the persisted JSON tidy without losing intermediate
                // gaps the user might still be filling.
                while (next.length > 0 && next[next.length - 1] === '') {
                  next.pop()
                }
                onChange(next.length === 0 ? '' : JSON.stringify(next))
              }}
              className="flex-1 px-2 py-1 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
            {field.maxLength && (
              <span className="text-[10px] font-mono text-slate-400 mt-2 tabular-nums w-12 text-right flex-shrink-0">
                {slot.length}/{field.maxLength}
              </span>
            )}
          </div>
        ))}
      </div>
    )
  }

  if (field.kind === 'number') {
    const v = value === undefined ? '' : String(value)
    return (
      <input
        type="number"
        value={v}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value
          if (raw === '') onChange('')
          else {
            const n = Number(raw)
            if (!Number.isNaN(n)) onChange(n)
          }
        }}
        className={cn(
          'w-full px-2 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500',
          compact ? 'h-7' : 'h-8',
        )}
      />
    )
  }

  if (field.kind === 'longtext') {
    const v = (value ?? '') as string
    return (
      <textarea
        value={v}
        onChange={(e) => onChange(e.target.value)}
        rows={compact ? 2 : 4}
        maxLength={field.maxLength}
        placeholder={placeholder}
        className="w-full px-2 py-1.5 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
      />
    )
  }

  // text
  const v = (value ?? '') as string
  return (
    <input
      type="text"
      value={v}
      onChange={(e) => onChange(e.target.value)}
      maxLength={field.maxLength}
      placeholder={placeholder}
      className={cn(
        'w-full px-2 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500',
        compact ? 'h-7' : 'h-8',
      )}
    />
  )
}

function ChannelTagGroup({
  tone,
  channels,
}: {
  tone: 'required' | 'optional'
  channels: string[]
}) {
  const toneClass =
    tone === 'required'
      ? 'bg-blue-50 text-blue-700 border-blue-200'
      : 'bg-slate-50 text-slate-600 border-slate-200'
  const label = tone === 'required' ? 'Required' : 'Optional'
  return (
    <div className="inline-flex items-center gap-1 flex-wrap">
      <span className="text-[10px] uppercase tracking-wide text-slate-500 font-medium">
        {label}:
      </span>
      {channels.map((c) => (
        <span
          key={c}
          className={cn(
            'inline-flex items-center text-[10px] font-mono font-medium px-1.5 py-0.5 border rounded',
            toneClass,
          )}
        >
          {c}
        </span>
      ))}
    </div>
  )
}

// ── helpers ─────────────────────────────────────────────────────

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (typeof v === 'number') return Number.isNaN(v)
  return false
}

function currentLength(v: unknown): number {
  if (typeof v === 'string') return v.length
  return 0
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

async function fetchPatch(
  wizardId: string,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch(`${getBackendUrl()}/api/listing-wizard/${wizardId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    /* swallow — caller's debounce will retry on next change */
  }
}

// M.1 — platform tabs at top, marketplace sub-tabs below.
function AttributesTabStrip({
  channels,
  activeTab,
  onTabChange,
  unsatisfied,
}: {
  channels: Array<{ platform: string; marketplace: string }>
  activeTab: string
  onTabChange: (tab: string) => void
  unsatisfied: Array<{ id: string; channelKey: string }>
}) {
  // Group channels by platform → list of marketplaces.
  const byPlatform = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const c of channels) {
      const arr = m.get(c.platform) ?? []
      arr.push(c.marketplace)
      m.set(c.platform, arr)
    }
    return Array.from(m.entries())
  }, [channels])

  const unsatisfiedByChannel = useMemo(() => {
    const counts = new Map<string, number>()
    for (const u of unsatisfied) {
      counts.set(u.channelKey, (counts.get(u.channelKey) ?? 0) + 1)
    }
    return counts
  }, [unsatisfied])

  // Active platform — derived from active tab when it's a channel key.
  const activePlatform = activeTab === 'base'
    ? null
    : activeTab.split(':')[0]

  return (
    <div className="border-b border-slate-200">
      {/* Top row — Shared base + one tab per platform */}
      <div className="flex items-end gap-1 overflow-x-auto">
        <TabButton
          label="Shared base"
          active={activeTab === 'base'}
          onClick={() => onTabChange('base')}
        />
        {byPlatform.map(([platform, marketplaces]) => {
          const isActive =
            activeTab !== 'base' && activeTab.startsWith(`${platform}:`)
          // Total unsatisfied across this platform's channels.
          const total = marketplaces.reduce(
            (sum, m) =>
              sum + (unsatisfiedByChannel.get(`${platform}:${m}`) ?? 0),
            0,
          )
          return (
            <TabButton
              key={platform}
              label={platform}
              active={isActive}
              badge={total > 0 ? String(total) : undefined}
              onClick={() => {
                // Activate this platform's first marketplace by
                // default. If the user was already on this platform's
                // tab, leave the active sub-tab as-is.
                if (!isActive) {
                  const first = marketplaces[0]
                  if (first) onTabChange(`${platform}:${first}`)
                }
              }}
            />
          )
        })}
      </div>

      {/* Sub-row — marketplaces for the active platform */}
      {activePlatform && (
        <div className="flex items-center gap-1 px-2 py-1.5 bg-slate-50 border-t border-slate-100 overflow-x-auto">
          {byPlatform
            .find(([p]) => p === activePlatform)?.[1]
            .map((m) => {
              const channelKey = `${activePlatform}:${m}`
              const isActive = activeTab === channelKey
              const count = unsatisfiedByChannel.get(channelKey) ?? 0
              return (
                <SubTabButton
                  key={m}
                  label={m}
                  active={isActive}
                  badge={count > 0 ? String(count) : undefined}
                  onClick={() => onTabChange(channelKey)}
                />
              )
            })}
        </div>
      )}
    </div>
  )
}

function TabButton({
  label,
  active,
  badge,
  onClick,
}: {
  label: string
  active: boolean
  badge?: string
  onClick: () => void
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
      {label}
      {badge && (
        <span
          className={cn(
            'text-[10px] font-mono px-1 rounded',
            active
              ? 'bg-amber-100 text-amber-700'
              : 'bg-amber-50 text-amber-600',
          )}
          title={`${badge} required field${badge === '1' ? '' : 's'} unsatisfied`}
        >
          {badge}
        </span>
      )}
    </button>
  )
}

function SubTabButton({
  label,
  active,
  badge,
  onClick,
}: {
  label: string
  active: boolean
  badge?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-7 px-2 text-[11px] font-mono font-medium rounded inline-flex items-center gap-1.5 transition-colors flex-shrink-0',
        active
          ? 'bg-blue-100 text-blue-800'
          : 'bg-white border border-slate-200 text-slate-600 hover:text-slate-900',
      )}
    >
      {label}
      {badge && (
        <span className="text-[10px] bg-amber-100 text-amber-700 px-1 rounded">
          {badge}
        </span>
      )}
    </button>
  )
}

function OverrideMenu({
  channelKey,
  hasBase,
  otherChannels,
  otherValues,
  hasValue,
  currentValue,
  channelGroups,
  allChannelKeys,
  supportsTranslate,
  translateBusy,
  onCopyFromBase,
  onCopyFrom,
  onApplyToChannels,
  onTranslate,
  onClear,
}: {
  channelKey: string
  hasBase: boolean
  otherChannels: string[]
  otherValues: Record<string, Primitive>
  hasValue: boolean
  currentValue?: Primitive
  channelGroups: ChannelGroup[]
  allChannelKeys: string[]
  supportsTranslate: boolean
  translateBusy: boolean
  onCopyFromBase: () => void
  onCopyFrom: (sourceKey: string) => void
  onApplyToChannels: (targetKeys: string[]) => void
  onTranslate: () => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        title="Copy or translate"
        className="h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded"
      >
        {translateBusy ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <span className="text-[14px] leading-none">⋯</span>
        )}
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute right-0 top-full mt-1 z-20 bg-white border border-slate-200 rounded shadow-md py-1 min-w-[200px] text-[12px]">
            {hasBase && (
              <button
                type="button"
                onClick={() => {
                  onCopyFromBase()
                  setOpen(false)
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700"
              >
                Copy from base
              </button>
            )}
            {otherChannels.length > 0 && (
              <>
                <div className="px-3 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                  Copy from
                </div>
                {otherChannels.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      onCopyFrom(k)
                      setOpen(false)
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700"
                  >
                    <span className="font-mono text-[11px]">{k}</span>
                    <span className="block text-[10px] text-slate-500 truncate">
                      {String(otherValues[k]).slice(0, 40)}
                    </span>
                  </button>
                ))}
              </>
            )}
            {supportsTranslate && (
              <button
                type="button"
                onClick={() => {
                  onTranslate()
                  setOpen(false)
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-blue-700 inline-flex items-center gap-1.5"
              >
                <Sparkles className="w-3 h-3" />
                Translate from base for {channelKey.split(':')[1]}
              </button>
            )}
            {/* N.2 — apply this channel's value outward to other
                channels. Only shown when there's a value worth
                broadcasting. */}
            {!isEmpty(currentValue) && (
              <>
                <div className="border-t border-slate-100 my-1" />
                <div className="px-3 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                  Apply this value to
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onApplyToChannels(
                      allChannelKeys.filter((k) => k !== channelKey),
                    )
                    setOpen(false)
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700"
                >
                  All other channels{' '}
                  <span className="text-[10px] text-slate-500">
                    ({allChannelKeys.length - 1})
                  </span>
                </button>
                {/* Same platform, every other marketplace. */}
                {(() => {
                  const platform = channelKey.split(':')[0]
                  const samePlatform = allChannelKeys.filter(
                    (k) =>
                      k !== channelKey && k.startsWith(`${platform}:`),
                  )
                  if (samePlatform.length === 0) return null
                  return (
                    <button
                      type="button"
                      onClick={() => {
                        onApplyToChannels(samePlatform)
                        setOpen(false)
                      }}
                      className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700"
                    >
                      Other {platform} marketplaces{' '}
                      <span className="text-[10px] text-slate-500">
                        ({samePlatform.length})
                      </span>
                    </button>
                  )
                })()}
                {channelGroups
                  .filter(
                    (g) =>
                      g.channelKeys.length > 0 &&
                      // Skip groups that ONLY contain this channel.
                      g.channelKeys.some((k) => k !== channelKey),
                  )
                  .map((g) => {
                    const targets = g.channelKeys.filter(
                      (k) => k !== channelKey,
                    )
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => {
                          onApplyToChannels(targets)
                          setOpen(false)
                        }}
                        className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700"
                      >
                        Group: {g.name}{' '}
                        <span className="text-[10px] text-slate-500">
                          ({targets.length})
                        </span>
                      </button>
                    )
                  })}
              </>
            )}
            {hasValue && (
              <button
                type="button"
                onClick={() => {
                  onClear()
                  setOpen(false)
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-rose-700 border-t border-slate-100 mt-1"
              >
                Clear override
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** M.3 — flag a master product whose variants don't share the same
 *  attribute axes. Triggers when EITHER:
 *    (a) the union of attribute keys across all variants > 4
 *    (Amazon's variation themes max out around 3-4 axes), OR
 *    (b) at least two variants have non-overlapping key sets, i.e.
 *    a variant carries keys that another variant doesn't and vice
 *    versa.
 *  Empty / single-variant masters are always considered consistent. */
function computeVariantSpan(
  variations: UnionVariation[],
): { suspicious: boolean; uniqueKeyCount: number } {
  if (variations.length < 2) {
    return { suspicious: false, uniqueKeyCount: 0 }
  }
  const allKeys = new Set<string>()
  const keysPerVariant: string[][] = []
  for (const v of variations) {
    const keys = Object.keys(v.attributes).filter(
      (k) => v.attributes[k]!.length > 0,
    )
    keysPerVariant.push(keys)
    for (const k of keys) allKeys.add(k)
  }
  const uniqueKeyCount = allKeys.size

  // (a) — too many axes overall.
  if (uniqueKeyCount > 4) {
    return { suspicious: true, uniqueKeyCount }
  }

  // (b) — non-overlapping pairs. For every pair (i, j), check if
  // there's a key that's present in i but not j AND a key present
  // in j but not i. Asymmetric mismatch (i ⊂ j) is fine — that's
  // just a partial spec, not a structural break.
  for (let i = 0; i < keysPerVariant.length; i++) {
    const ki = new Set(keysPerVariant[i])
    for (let j = i + 1; j < keysPerVariant.length; j++) {
      const kj = new Set(keysPerVariant[j])
      const inIonly = [...ki].some((k) => !kj.has(k))
      const inJonly = [...kj].some((k) => !ki.has(k))
      if (inIonly && inJonly) {
        return { suspicious: true, uniqueKeyCount }
      }
    }
  }
  return { suspicious: false, uniqueKeyCount }
}

function parseStringArray(value: string | undefined): string[] {
  if (typeof value !== 'string' || value.length === 0) return []
  // L.2 storage convention: JSON-encoded string[]. Tolerant of older
  // single-string values (treat as a one-entry array) so wizards
  // saved before this commit still render.
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) {
      return parsed.filter((s) => typeof s === 'string') as string[]
    }
  } catch {
    /* fall through */
  }
  return [value]
}
