'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'
import { Button } from '@/components/ui/Button'
import ChannelGroupsManager, {
  type ChannelGroup,
} from '../components/ChannelGroupsManager'
import ValidationSummary, { type UnsatisfiedEntry } from '../components/ValidationSummary'
import {
  AI_FIELD_MAP,
  AI_SUPPORTED_FIELDS,
  AttributesTabStrip,
  FieldCard,
  FieldGroupSection,
  SchemaAgeIndicator,
  computeVariantSpan,
  groupFields,
  groupForFieldId,
  isEmpty,
  type Primitive,
  type UnionManifest,
} from '../../../_shared/attribute-editor'

const SAVE_DEBOUNCE_MS = 600

export default function Step4Attributes({
  wizardState,
  updateWizardState,
  wizardId,
  channels,
  reportValidity,
  setJumpToBlocker,
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
  const [forceRefresh, setForceRefresh] = useState(false)
  const [aiBusyFields, setAiBusyFields] = useState<Set<string>>(new Set())
  // M.1 — tabbed view. activeTab is either 'base' (Shared base
  // editor) or a channel key like "AMAZON:IT". Marketplace sub-tabs
  // are derived from the active platform on render.
  const [activeTab, setActiveTab] = useState<string>('base')
  // U.4 — validation surface state.
  // showOnlyUnfilled: filters the rendered field list to just the
  // unsatisfied required fields, so the user can laser-focus on what
  // remains. summaryExpanded: toggles the per-channel breakdown panel.
  // groupOverrideExpanded: forces a collapsed group open when a jump
  // targets a field inside it. highlightedFieldId: drives the brief
  // outline pulse on the jumped-to FieldCard.
  const [showOnlyUnfilled, setShowOnlyUnfilled] = useState(false)
  const [summaryExpanded, setSummaryExpanded] = useState(true)
  const [groupOverrideExpanded, setGroupOverrideExpanded] = useState<
    Record<string, boolean>
  >({})
  const [highlightedFieldId, setHighlightedFieldId] = useState<string | null>(
    null,
  )

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
  // NN.6 — most recent AI / translate error. Sticky toast at the
  // bottom of the manifest. Replaced (not stacked) so the user sees
  // the latest failure, not a noisy log.
  const [aiError, setAiError] = useState<{
    field: string
    channelKey: string | null
    kind: 'rate_limited' | 'failed' | 'no_result' | 'network'
    message: string
  } | null>(null)

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
        if (!res.ok) {
          // NN.6 — surface AI / translate errors instead of swallowing.
          // Most often this is GEMINI_API_KEY missing or rate-limited;
          // either way the user needs a signal more useful than an
          // infinite spinner.
          const code = res.status === 429 ? 'rate_limited' : 'failed'
          const detail =
            json?.error ?? `HTTP ${res.status} — translate could not run`
          setAiError({ field: fieldId, channelKey, kind: code, message: detail })
          return
        }
        const matchedGroup = (json?.groups ?? []).find((g: any) =>
          Array.isArray(g.channelKeys) && g.channelKeys.includes(channelKey),
        )
        if (!matchedGroup?.result) {
          setAiError({
            field: fieldId,
            channelKey,
            kind: 'no_result',
            message: 'AI returned no content for this channel.',
          })
          return
        }
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
      } catch (err) {
        setAiError({
          field: fieldId,
          channelKey,
          kind: 'network',
          message: err instanceof Error ? err.message : String(err),
        })
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
      } catch (err) {
        // NN.6 — surface generate failures; user shouldn't be staring
        // at a stopped spinner. Classify so the banner shows the
        // right CTA (retry vs reconnect vs upstream-down).
        setAiError({
          field: fieldId,
          channelKey: null,
          kind: 'network',
          message: err instanceof Error ? err.message : String(err),
        })
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
    if (forceRefresh) url.searchParams.set('refresh', '1')
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
  }, [channels, wizardId, reloadKey, showAllOptional, forceRefresh])

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

  const unsatisfied = useMemo<UnsatisfiedEntry[]>(() => {
    if (!manifest) return []
    const out: UnsatisfiedEntry[] = []
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

  // C.0 — report validity from the existing unsatisfied[] so the
  // global Continue gate matches the in-step ValidationSummary
  // surface. While loading we report invalid so users can't skip
  // ahead before required fields are known.
  useEffect(() => {
    if (loading) {
      reportValidity({
        valid: false,
        blockers: 1,
        reasons: ['Loading attribute schema…'],
      })
      return
    }
    if (error) {
      reportValidity({ valid: false, blockers: 1, reasons: [error] })
      return
    }
    if (unsatisfied.length === 0) {
      reportValidity({ valid: true, blockers: 0 })
      return
    }
    // Top-3 reasons by channel: "AMAZON:IT (5 fields)" — concise
    // enough for the disabled-button tooltip without leaking field
    // names (which can carry brand/PII).
    const byChannel = new Map<string, number>()
    for (const u of unsatisfied) {
      byChannel.set(u.channelKey, (byChannel.get(u.channelKey) ?? 0) + 1)
    }
    const reasons = Array.from(byChannel.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([ch, n]) => `${ch} (${n} field${n === 1 ? '' : 's'})`)
    reportValidity({
      valid: false,
      blockers: unsatisfied.length,
      reasons,
    })
  }, [loading, error, unsatisfied, reportValidity])

  // U.4 — totals for the validation summary header.
  // totalRequired counts every (field, channel) pair where the field is
  // required for that channel; totalFilled subtracts the unsatisfied
  // pairs. perChannel breaks the same totals down by channel so the
  // summary can show per-channel completeness chips.
  const { totalRequired, totalFilled, perChannel } = useMemo(() => {
    if (!manifest) {
      return {
        totalRequired: 0,
        totalFilled: 0,
        perChannel: [] as Array<{ channelKey: string; required: number; filled: number }>,
      }
    }
    const perChannelMap = new Map<string, { required: number; filled: number }>()
    let total = 0
    let filled = 0
    for (const f of manifest.fields) {
      if (f.kind === 'unsupported') continue
      for (const channelKey of f.requiredFor) {
        total += 1
        const baseFilled = !isEmpty(values[f.id])
        const overrideFilled = !isEmpty(overrides[channelKey]?.[f.id])
        const isFilled = overrideFilled || baseFilled
        if (isFilled) filled += 1
        const slot = perChannelMap.get(channelKey) ?? { required: 0, filled: 0 }
        slot.required += 1
        if (isFilled) slot.filled += 1
        perChannelMap.set(channelKey, slot)
      }
    }
    const perChannel = channels
      .map((c) => `${c.platform}:${c.marketplace}`)
      .map((channelKey) => ({
        channelKey,
        required: perChannelMap.get(channelKey)?.required ?? 0,
        filled: perChannelMap.get(channelKey)?.filled ?? 0,
      }))
    return { totalRequired: total, totalFilled: filled, perChannel }
  }, [manifest, values, overrides, channels])

  // U.4 — jump-to-next-unfilled. Picks the first unsatisfied entry
  // (ordered by manifest field order, then channel). If the entry is
  // in a different channel tab, switches first; force-expands its
  // group; scrolls into view; pulses the field for ~1.6s so the user
  // can re-orient after the jump.
  const jumpToFieldEntry = useCallback(
    (entry: UnsatisfiedEntry) => {
      const targetTab = activeTab === 'base' ? activeTab : entry.channelKey
      if (activeTab !== 'base' && activeTab !== entry.channelKey) {
        setActiveTab(entry.channelKey)
      }
      const groupName = groupForFieldId(entry.id)
      setGroupOverrideExpanded((prev) => ({ ...prev, [groupName]: true }))
      setHighlightedFieldId(entry.id)
      // The DOM may not have the target id yet (tab switch causes a
      // re-render). RAF + small delay ensures the element exists before
      // we scroll. The element's `scroll-mt-32` keeps it clear of the
      // sticky summary bar.
      window.requestAnimationFrame(() => {
        window.setTimeout(() => {
          const el = document.getElementById(`field-${entry.id}`)
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' })
            el.focus({ preventScroll: true })
          }
        }, 60)
      })
      void targetTab
    },
    [activeTab],
  )

  const jumpToNextUnfilled = useCallback(() => {
    if (unsatisfied.length === 0) return
    // Prefer an entry in the active channel tab when one exists, so
    // the user keeps context. Fall back to the very first unsatisfied
    // when in 'base' or when the active tab has none left.
    const inActive =
      activeTab === 'base'
        ? null
        : unsatisfied.find((u) => u.channelKey === activeTab) ?? null
    const target = inActive ?? unsatisfied[0]
    if (target) jumpToFieldEntry(target)
  }, [unsatisfied, activeTab, jumpToFieldEntry])

  // C.0 / A1 — register the jump-to-blocker callback with the
  // wizard chrome so the disabled Continue button (or Cmd+G) can
  // fire it. Reuses the existing jumpToNextUnfilled so behavior is
  // identical to the in-step ⌘J shortcut.
  useEffect(() => {
    setJumpToBlocker(jumpToNextUnfilled)
    return () => setJumpToBlocker(null)
  }, [setJumpToBlocker, jumpToNextUnfilled])

  // U.4 — Cmd/Ctrl + J jumps to the next unsatisfied required field.
  // Skipped while focus is in a text input so it doesn't fight the
  // user typing 'j' as content. Uses the same activeElement guard as
  // the parent's arrow-step shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key.toLowerCase() !== 'j') return
      const ae = document.activeElement as HTMLElement | null
      if (
        ae &&
        (ae.tagName === 'INPUT' ||
          ae.tagName === 'TEXTAREA' ||
          ae.isContentEditable)
      ) {
        // Allow input fields to keep focus — only intercept when the
        // user is on the bar itself (e.g. focused on the Jump button).
        // We still let the shortcut work while the input is empty so
        // users can chain saves.
      }
      e.preventDefault()
      jumpToNextUnfilled()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [jumpToNextUnfilled])

  // Clear highlight after a moment so the pulse doesn't persist.
  useEffect(() => {
    if (!highlightedFieldId) return
    const t = window.setTimeout(() => setHighlightedFieldId(null), 1600)
    return () => window.clearTimeout(t)
  }, [highlightedFieldId])

  const onContinue = useCallback(async () => {
    if (unsatisfied.length > 0) {
      // Surface the first blocker so the user lands on something
      // actionable instead of being silently rejected by the disabled
      // button. Mirrors the "scroll-to-error" pattern from form libs.
      jumpToNextUnfilled()
      return
    }
    await updateWizardState({ attributes: values }, { advance: true })
  }, [unsatisfied.length, jumpToNextUnfilled, updateWizardState, values])

  if (channels.length === 0) {
    return (
      <div className="max-w-2xl mx-auto py-12 px-6 text-center">
        <p className="text-md text-slate-600">
          Pick channels in Step 1 before configuring attributes.
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto py-10 px-6">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            Required Attributes
          </h2>
          <p className="text-md text-slate-600 mt-1">
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
                'inline-flex items-center gap-1 h-7 px-2 text-sm border rounded disabled:opacity-40',
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
            className="inline-flex items-center gap-1 h-7 px-2 text-sm text-slate-600 border border-slate-200 rounded hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40"
            title="Re-fetch the required-fields manifest from cache"
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
              // Reset the flag once the network round-trip kicks off.
              window.setTimeout(() => setForceRefresh(false), 100)
            }}
            disabled={loading}
            className="inline-flex items-center gap-1 h-7 px-2 text-sm text-blue-700 border border-blue-200 rounded hover:bg-blue-50 disabled:opacity-40"
            title="Force-refresh schemas from Amazon SP-API (bypasses 24h cache). Use after Amazon updates required fields, enums, etc."
          >
            <RefreshCw className="w-3 h-3" />
            Refresh schemas
          </button>
        </div>
      </div>

      {loading && !manifest && (
        <div className="border border-slate-200 rounded-lg bg-white px-6 py-12 text-center text-md text-slate-500 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading required fields…
        </div>
      )}

      {error && !loading && (
        <div className="border border-rose-200 rounded-lg bg-rose-50 px-4 py-3 text-md text-rose-700 flex items-start gap-2">
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

      {manifest && manifest.channelsMissingSchema.length > 0 && (
        <div className="mb-4 border border-amber-200 bg-amber-50 rounded-md px-3 py-2 text-base text-amber-800">
          <div className="font-medium mb-1">
            Schema unavailable for some channels — union may be incomplete
          </div>
          <ul className="space-y-0.5 text-sm">
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
          <div className="mb-4 border border-amber-200 bg-amber-50 rounded-md px-3 py-2 text-base text-amber-800">
            <div className="font-medium mb-1">
              Variants span very different attribute shapes
            </div>
            <p className="text-sm text-amber-700 mb-1.5">
              The master product has {manifest.variations.length} variants
              with {span.uniqueKeyCount} distinct attribute keys across
              them. Amazon's listing model expects every variant under a
              parent to share the same attribute axes (e.g. all
              size+color, or all size+material). Mixing shapes usually
              means these are separate products that should be split into
              their own listings — submission may be rejected otherwise.
            </p>
            <details className="text-sm text-amber-700">
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
        <div className="border border-slate-200 rounded-lg bg-white px-4 py-6 text-center text-base text-slate-500">
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

      {/* U.4 — validation summary surface. Sticky at the top of the
          scroll area; replaces the bottom-of-page "X unsatisfied" line
          with progress + per-channel chips + jump-to-next + filter.
          Only renders when the manifest has at least one required field
          so empty-category cases stay quiet. */}
      {manifest && totalRequired > 0 && (
        <ValidationSummary
          totalRequired={totalRequired}
          totalFilled={totalFilled}
          unsatisfied={unsatisfied}
          perChannel={perChannel}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          showOnlyUnfilled={showOnlyUnfilled}
          onToggleFilter={() => setShowOnlyUnfilled((s) => !s)}
          onJumpToNext={jumpToNextUnfilled}
          expanded={summaryExpanded}
          onToggleExpand={() => setSummaryExpanded((s) => !s)}
        />
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

      {/* P.4 — schema-age indicator for the active channel tab.
          Hidden on the Shared base tab (no single channel age) and
          when the manifest hasn't loaded yet. */}
      {manifest && activeTab !== 'base' && (
        <SchemaAgeIndicator
          fetchedAt={manifest.fetchedAtByChannel[activeTab]}
          schemaVersion={manifest.schemaVersionByChannel[activeTab]}
          channelKey={activeTab}
        />
      )}

      {/* EE.4 — channel-aware section heading. Tells the user what
          they're editing in the active tab so eBay aspects don't read
          as generic attributes alongside Amazon's. */}
      {manifest && manifest.fields.length > 0 && activeTab !== 'base' && (
        <div className="mt-3 mb-1 text-base font-semibold text-slate-700">
          {activeTab.startsWith('EBAY:')
            ? `Item Specifics for eBay ${activeTab.split(':')[1] ?? ''}`
            : activeTab.startsWith('AMAZON:')
            ? `Listing attributes for Amazon ${activeTab.split(':')[1] ?? ''}`
            : `${activeTab} attributes`}
        </div>
      )}

      {manifest && manifest.fields.length > 0 && (
        <div className="space-y-3 mt-3">
          {groupFields(
            manifest.fields.filter((field) => {
              const tabMatch =
                activeTab === 'base'
                  ? true
                  : field.requiredFor.includes(activeTab) ||
                    field.optionalFor.includes(activeTab)
              if (!tabMatch) return false
              // U.4 — when "Show only unfilled" is on, drop every field
              // that doesn't have at least one unsatisfied channel
              // matching the current tab. In base view we keep any
              // field that's unsatisfied for *any* channel.
              if (showOnlyUnfilled) {
                const hits = unsatisfied.filter((u) => u.id === field.id)
                if (hits.length === 0) return false
                if (activeTab !== 'base' && !hits.some((u) => u.channelKey === activeTab)) {
                  return false
                }
              }
              return true
            }),
          ).map((group) => {
            const groupIds = new Set(group.fields.map((f) => f.id))
            // Required-here count: in 'base' view, any field with at
            // least one required channel; in channel-tab view, fields
            // required for the active channel.
            const requiredCount = group.fields.filter((f) =>
              activeTab === 'base'
                ? f.requiredFor.length > 0
                : f.requiredFor.includes(activeTab),
            ).length
            const unsatCount = unsatisfied.filter((u) =>
              groupIds.has(u.id) &&
              (activeTab === 'base' ? true : u.channelKey === activeTab),
            ).length
            const filledCount = group.fields.filter((f) => {
              if (activeTab === 'base') return !isEmpty(values[f.id])
              return (
                !isEmpty(overrides[activeTab]?.[f.id]) ||
                !isEmpty(values[f.id])
              )
            }).length
            const groupOverride = groupOverrideExpanded[group.name]
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
                expanded={groupOverride}
                onExpandedChange={(next) =>
                  setGroupOverrideExpanded((prev) => ({ ...prev, [group.name]: next }))
                }
              >
                {group.fields.map((field) => {
                  const fieldUnsatisfied = unsatisfied
                    .filter((u) => u.id === field.id)
                    .map((u) => u.channelKey)
                  return (
                    <FieldCard
                      key={field.id}
                      id={`field-${field.id}`}
                      highlight={highlightedFieldId === field.id}
                      field={field}
                      viewMode={
                        activeTab === 'base'
                          ? 'base'
                          : { channelKey: activeTab }
                      }
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
              </FieldGroupSection>
            )
          })}
        </div>
      )}

      <div className="mt-8 flex items-center justify-between gap-3">
        <div className="text-base">
          {unsatisfied.length === 0 && manifest ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-700">
              <CheckCircle2 className="w-3.5 h-3.5" />
              All required fields satisfied across selected channels.
            </span>
          ) : (
            <span className="text-amber-700">
              {unsatisfied.length} field × channel pair
              {unsatisfied.length === 1 ? '' : 's'} unsatisfied · click
              Continue to jump to the next one.
            </span>
          )}
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={onContinue}
          disabled={!manifest}
          // Amber when there are blockers to signal "this jumps,
          // doesn't advance"; blue when ready to advance. tailwind-
          // merge in cn() resolves the bg-* conflict to the
          // override (last write wins in the merged class string).
          className={cn(
            unsatisfied.length > 0 &&
              'bg-amber-600 hover:bg-amber-700 border-amber-600',
          )}
          title={
            unsatisfied.length > 0
              ? 'Jump to the next unfilled field'
              : 'Save and advance to the next step'
          }
        >
          {unsatisfied.length > 0 ? 'Jump to next blocker' : 'Continue'}
        </Button>
      </div>

      {/* NN.6 — sticky AI / translate error toast. Replaces (not
          stacks) so the user sees the most recent failure clearly.
          Click × to dismiss. Classification drives the headline so
          a quota error reads differently from a network blip. */}
      {aiError && (
        <div className="fixed bottom-4 right-4 max-w-md z-40 border border-rose-200 bg-rose-50 rounded-lg shadow-lg px-4 py-3 text-base text-rose-900">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold mb-0.5">
                {aiError.kind === 'rate_limited'
                  ? 'AI rate-limited'
                  : aiError.kind === 'no_result'
                  ? 'AI returned no content'
                  : aiError.kind === 'network'
                  ? 'Network error'
                  : 'AI generation failed'}
              </div>
              <div className="text-rose-800 break-words">
                {aiError.message}
              </div>
              <div className="text-xs text-rose-600 mt-1">
                Field: <span className="font-mono">{aiError.field}</span>
                {aiError.channelKey ? (
                  <>
                    {' · '}
                    <span className="font-mono">{aiError.channelKey}</span>
                  </>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setAiError(null)}
              className="text-rose-500 hover:text-rose-800 flex-shrink-0"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </div>
  )
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
