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

      {manifest && manifest.fields.length === 0 && !loading && (
        <div className="border border-slate-200 rounded-lg bg-white px-4 py-6 text-center text-[12px] text-slate-500">
          No required fields across the selected channels.
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
                baseValue={values[field.id]}
                onBaseChange={(v) => setBase(field.id, v)}
                onAIGenerate={
                  AI_SUPPORTED_FIELDS.has(field.id)
                    ? () => aiGenerate(field.id)
                    : undefined
                }
                aiBusy={aiBusyFields.has(field.id)}
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
}: {
  field: UnionField
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
}) {
  const supportsAI = AI_SUPPORTED_FIELDS.has(field.id)
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
          <span className="text-rose-600 ml-0.5">*</span>
          <span className="ml-2 text-[11px] font-mono font-normal text-slate-400">
            {field.id}
          </span>
        </label>
        <div className="flex items-center gap-1.5 flex-wrap">
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

      <FieldInput field={field} value={baseValue} onChange={onBaseChange} />

      {field.examples && field.examples.length > 0 && field.kind !== 'enum' && (
        <p className="mt-1.5 text-[11px] text-slate-400">
          Examples: {field.examples.join(', ')}
        </p>
      )}
      {field.maxLength && field.kind !== 'enum' && (
        <p className="mt-1 text-[11px] text-slate-400">
          {currentLength(baseValue)} / {field.maxLength} characters
        </p>
      )}

      {field.requiredFor.length > 1 && (
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
                {variantOverrideCount}
              </span>
            )}
            <span className="text-[10px] text-slate-400 italic">
              (variant-eligible field)
            </span>
          </button>
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
