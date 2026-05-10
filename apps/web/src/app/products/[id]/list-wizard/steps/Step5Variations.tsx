'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Edit2,
  Layers,
  Loader2,
  Package,
  PackageOpen,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import MatrixVariantBuilder from './_MatrixVariantBuilder'

// Mirrors backend types from variations.service.ts.
interface ThemeOption {
  id: string
  label: string
  requiredAttributes: string[]
}

interface VariationChild {
  id: string
  sku: string
  attributes: Record<string, string>
  price: number
  stock: number
  missingByChannel: Record<string, string[]>
}

interface MultiChannelVariationsPayload {
  isParent: boolean
  parentSku: string
  parentName: string
  channels: Array<{ platform: string; marketplace: string; productType: string }>
  themesByChannel: Record<string, ThemeOption[]>
  commonThemes: ThemeOption[]
  selectedThemeByChannel: Record<string, string | null>
  children: VariationChild[]
  presentAttributes: string[]
  channelsMissingThemes: Array<{
    channelKey: string
    reason: 'no_product_type' | 'unsupported_channel' | 'no_themes_in_schema'
  }>
}

// Alias so VariantsTable props match the task spec naming.
type MultiChannelVariationChild = VariationChild

interface VariationsSlice {
  /** Common-theme pick that applies to all channels by default. */
  commonTheme?: string
  /** Per-channel selected theme (overrides commonTheme for that
   *  channel). Empty/absent → falls back to commonTheme. */
  themeByChannel?: Record<string, string>
  /** Custom-theme attribute lists keyed by channel. Set when a
   *  channel uses a CUSTOM_* theme id; the live-annotation logic
   *  reads this to compute missing attributes. */
  customAttributesByChannel?: Record<string, string[]>
  includedSkus?: string[]
  /** Per-child "inherit parent name/description" toggle. */
  inheritByChildId?: Record<string, boolean>
}

interface VariantDraftEdit {
  sku: string
  price: string
  stock: string
  attrs: Record<string, string>
}

const CUSTOM_PREFIX = 'CUSTOM__'

const SAVE_DEBOUNCE_MS = 600

// AI-6.2 — recommendation shape returned by /suggest-variation-theme.
interface AiThemeRecommendation {
  themeId: string
  reason: string
  alternatives: Array<{ themeId: string; reason: string }>
}

export default function Step5Variations({
  wizardState,
  updateWizardState,
  wizardId,
  channels,
  product,
  reportValidity,
  setJumpToBlocker,
}: StepProps) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const slice = (wizardState.variations ?? {}) as VariationsSlice

  // AI-6.2 — variation theme suggester state. Click "AI: pick a
  // theme" → POST /suggest-variation-theme with available common
  // themes + presentAttributes from the loaded payload. Backend
  // returns one primary + up to 3 alternatives.
  const [aiThemeBusy, setAiThemeBusy] = useState(false)
  const [aiThemeError, setAiThemeError] = useState<string | null>(null)
  const [aiThemeRec, setAiThemeRec] = useState<AiThemeRecommendation | null>(
    null,
  )

  const [payload, setPayload] = useState<MultiChannelVariationsPayload | null>(
    null,
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // VV — single-product setup writes (link-to-parent, promote-to-parent,
  // add-variants) refetch the variations payload via this counter.
  const [refetchKey, setRefetchKey] = useState(0)

  const [commonTheme, setCommonTheme] = useState<string | null>(
    slice.commonTheme ?? null,
  )
  const [themeByChannel, setThemeByChannel] = useState<Record<string, string>>(
    slice.themeByChannel ?? {},
  )
  const [customAttrsByChannel, setCustomAttrsByChannel] = useState<
    Record<string, string[]>
  >(slice.customAttributesByChannel ?? {})
  const [includedSkus, setIncludedSkus] = useState<Set<string>>(
    new Set(slice.includedSkus ?? []),
  )
  // N.1 — per-marketplace themes always visible. The expandable
  // collapse is gone; the grid below renders inline so the seller
  // can see what each channel will publish under at a glance.
  const [customDraft, setCustomDraft] = useState<Record<string, string>>({})

  // Live Amazon SP-API themes. Fetched after the payload loads for
  // Amazon channels. Merged over commonThemes/themesByChannel (live
  // wins). liveThemesKey bumps when user clicks the refresh button.
  const [liveThemes, setLiveThemes] = useState<ThemeOption[]>([])
  const [liveThemesBusy, setLiveThemesBusy] = useState(false)
  const [liveThemesKey, setLiveThemesKey] = useState(0)

  // Matrix builder expand/collapse.
  const [showMatrix, setShowMatrix] = useState(false)
  // Add-variant inline form.
  const [showAddRow, setShowAddRow] = useState(false)

  // Fetch payload. Re-fetch when channels or selection changes so the
  // server-side `missingByChannel` annotations track the user's
  // current picks.
  useEffect(() => {
    if (channels.length === 0) {
      setLoading(false)
      setError('Pick channels in Step 1 first.')
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${getBackendUrl()}/api/listing-wizard/${wizardId}/variations`)
      .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json() }))
      .then(({ ok, status: code, json }) => {
        if (cancelled) return
        if (!ok) {
          setError(json?.error ?? `HTTP ${code}`)
          return
        }
        const p = json as MultiChannelVariationsPayload
        setPayload(p)
        // First-render seed: include every child by default.
        if (includedSkus.size === 0 && p.children.length > 0) {
          setIncludedSkus(new Set(p.children.map((c) => c.sku)))
        }
        // Default-pick a common theme if one isn't set yet AND there
        // are common themes available.
        if (!commonTheme && p.commonThemes.length > 0) {
          const best = pickDefaultCommonTheme(
            p.commonThemes,
            p.presentAttributes,
          )
          if (best) setCommonTheme(best.id)
        }
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
    // includedSkus / commonTheme intentionally omitted: only seeded on
    // first load. refetchKey is included so single-product setup
    // (link / promote) can pull the updated payload without reloading
    // the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizardId, channels.length, refetchKey])

  const onToggleSku = useCallback((sku: string) => {
    setIncludedSkus((prev) => {
      const next = new Set(prev)
      if (next.has(sku)) next.delete(sku)
      else next.add(sku)
      return next
    })
  }, [])

  // Fetch live Amazon SP-API themes when payload is available and an
  // Amazon channel is selected. liveThemesKey bumps on manual refresh.
  useEffect(() => {
    if (!payload) return
    const amazonChannel = payload.channels.find(
      (ch) => ch.platform.toLowerCase() === 'amazon',
    )
    if (!amazonChannel) return
    const channelKey = `${amazonChannel.platform}:${amazonChannel.marketplace}`
    const productTypeVal =
      (wizardState?.channelStates as Record<string, Record<string, unknown>> | undefined)?.[channelKey]?.productType as
        | { productType?: string }
        | undefined
    const productType = productTypeVal?.productType
    if (!productType) return
    let cancelled = false
    setLiveThemesBusy(true)
    const url = new URL(
      `${getBackendUrl()}/api/listing-wizard/${wizardId}/variation-themes`,
    )
    url.searchParams.set('marketplace', amazonChannel.marketplace)
    url.searchParams.set('productType', productType)
    fetch(url.toString())
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return
        const themes = (json?.themes ?? json ?? []) as ThemeOption[]
        if (Array.isArray(themes)) setLiveThemes(themes)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLiveThemesBusy(false)
      })
    return () => {
      cancelled = true
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, wizardId, liveThemesKey])

  // Persist selection to wizardState (state.variations) and per-
  // channel theme to channelStates[key].variations.theme. Debounced
  // so toggling chips doesn't fire one PATCH per click.
  useEffect(() => {
    if (loading || !payload) return
    const t = window.setTimeout(() => {
      void persistThemes(wizardId, {
        commonTheme,
        themeByChannel,
        customAttrsByChannel,
        includedSkus: Array.from(includedSkus),
        channelKeys: Object.keys(payload.themesByChannel),
      })
    }, SAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commonTheme, themeByChannel, customAttrsByChannel, includedSkus, loading, payload])

  // Effective theme per channel: per-channel override → commonTheme.
  const effectiveTheme = useCallback(
    (channelKey: string): string | null => {
      return themeByChannel[channelKey] || commonTheme || null
    },
    [themeByChannel, commonTheme],
  )

  const channelKeys = useMemo(() => {
    return payload ? Object.keys(payload.themesByChannel) : []
  }, [payload])

  // Merge live themes into commonThemes / themesByChannel (live wins).
  const effectivePayload = useMemo(() => {
    if (!payload || liveThemes.length === 0) return payload
    const liveIds = new Set(liveThemes.map((t) => t.id))
    const mergedCommon = [
      ...liveThemes,
      ...payload.commonThemes.filter((t) => !liveIds.has(t.id)),
    ]
    const mergedByChannel: Record<string, ThemeOption[]> = {}
    for (const [k, v] of Object.entries(payload.themesByChannel)) {
      mergedByChannel[k] = [
        ...liveThemes,
        ...v.filter((t) => !liveIds.has(t.id)),
      ]
    }
    return { ...payload, commonThemes: mergedCommon, themesByChannel: mergedByChannel }
  }, [payload, liveThemes])

  const selectedTheme = useMemo<ThemeOption | null>(() => {
    if (!effectivePayload || !commonTheme) return null
    return effectivePayload.commonThemes.find((t) => t.id === commonTheme) ?? null
  }, [effectivePayload, commonTheme])

  const inheritByChildId = useMemo<Record<string, boolean>>(
    () => (slice.inheritByChildId ?? {}) as Record<string, boolean>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slice.inheritByChildId],
  )

  const onInheritChange = useCallback(
    (childId: string, value: boolean) => {
      const current = (slice.inheritByChildId ?? {}) as Record<string, boolean>
      updateWizardState({
        variations: {
          ...(wizardState.variations as object | undefined ?? {}),
          inheritByChildId: { ...current, [childId]: value },
        },
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slice.inheritByChildId, wizardState.variations, updateWizardState],
  )

  // Re-annotate missingByChannel client-side based on current picks
  // — the server's annotation is computed from the persisted state,
  // which lags by SAVE_DEBOUNCE_MS. Doing this in the UI keeps the
  // chips in sync with what the user just clicked.
  const childrenWithLiveAnnotations = useMemo(() => {
    if (!effectivePayload) return []
    return effectivePayload.children.map((c) => {
      const missingByChannel: Record<string, string[]> = {}
      for (const channelKey of Object.keys(effectivePayload.themesByChannel)) {
        const themeId = effectiveTheme(channelKey)
        if (!themeId) {
          missingByChannel[channelKey] = []
          continue
        }
        // Custom theme — required attrs from the user's typed list.
        if (themeId.startsWith(CUSTOM_PREFIX)) {
          const customAttrs = customAttrsByChannel[channelKey] ?? []
          missingByChannel[channelKey] = customAttrs.filter(
            (k) => !c.attributes[k] || c.attributes[k]!.trim() === '',
          )
          continue
        }
        const theme = (effectivePayload.themesByChannel[channelKey] ?? []).find(
          (t) => t.id === themeId,
        )
        if (!theme) {
          missingByChannel[channelKey] = []
          continue
        }
        missingByChannel[channelKey] = theme.requiredAttributes.filter(
          (k) => !c.attributes[k] || c.attributes[k]!.trim() === '',
        )
      }
      return { ...c, missingByChannel }
    })
  }, [effectivePayload, effectiveTheme, customAttrsByChannel])

  const includedChildren = useMemo(() => {
    return childrenWithLiveAnnotations.filter((c) =>
      includedSkus.has(c.sku),
    )
  }, [childrenWithLiveAnnotations, includedSkus])

  const blockingChildren = useMemo(() => {
    return includedChildren.filter((c) =>
      Object.values(c.missingByChannel).some((arr) => arr.length > 0),
    )
  }, [includedChildren])

  // C.0 / A1 — register a jump-to-blocker callback. Scrolls to the
  // first row tagged with data-blocker-row="true" within this step.
  // If no row is tagged (e.g., the blocker is "no theme picked")
  // we scroll the step container itself to the top so the theme
  // picker is in view.
  useEffect(() => {
    setJumpToBlocker(() => {
      const row = document.querySelector<HTMLElement>(
        '[data-blocker-row="true"]',
      )
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' })
        const cb = row.querySelector<HTMLInputElement>(
          'input[type="checkbox"]',
        )
        cb?.focus({ preventScroll: true })
        return
      }
      // Fall back: scroll the page to top — the theme picker lives
      // there.
      window.scrollTo({ top: 0, behavior: 'smooth' })
    })
    return () => setJumpToBlocker(null)
  }, [setJumpToBlocker])

  // C.0 — derive validity for the global Continue gate. Standalone
  // (non-parent) products are always valid here; parents must have
  // an effective theme on at least one channel, ≥1 included child,
  // and no children with unfilled required attributes.
  useEffect(() => {
    if (loading) {
      reportValidity({
        valid: false,
        blockers: 1,
        reasons: ['Loading variations…'],
      })
      return
    }
    if (error) {
      reportValidity({ valid: false, blockers: 1, reasons: [error] })
      return
    }
    if (!effectivePayload || !effectivePayload.isParent) {
      reportValidity({ valid: true, blockers: 0 })
      return
    }
    const reasons: string[] = []
    let blockers = 0
    const anyThemeSet = Object.keys(effectivePayload.themesByChannel).some(
      (ch) => effectiveTheme(ch) !== null,
    )
    if (!anyThemeSet) {
      reasons.push('Pick a variation theme')
      blockers += 1
    }
    if (includedChildren.length === 0) {
      reasons.push('Include at least one variation')
      blockers += 1
    }
    if (blockingChildren.length > 0) {
      const top = blockingChildren
        .slice(0, 3)
        .map((c) => `${c.sku} missing required`)
      reasons.push(...top)
      blockers += blockingChildren.length
    }
    reportValidity({ valid: blockers === 0, blockers, reasons })
  }, [
    loading,
    error,
    payload,
    includedChildren.length,
    blockingChildren,
    effectiveTheme,
    reportValidity,
  ])

  const onContinue = useCallback(async () => {
    if (!effectivePayload) return
    if (effectivePayload.isParent && includedChildren.length === 0) return
    if (blockingChildren.length > 0) return
    // Persist before advance — bypass debounce.
    await persistThemes(wizardId, {
      commonTheme,
      themeByChannel,
      customAttrsByChannel,
      includedSkus: Array.from(includedSkus),
      channelKeys,
    })
    await updateWizardState({}, { advance: true })
  }, [
    blockingChildren.length,
    channelKeys,
    commonTheme,
    customAttrsByChannel,
    effectivePayload,
    includedChildren.length,
    includedSkus,
    themeByChannel,
    updateWizardState,
    wizardId,
  ])

  // VV — single-product (non-parent, no children) branch. Now offers
  // three paths: standalone (skip), link as variant of an existing
  // parent, or promote this product to a parent and add variants.
  // After link/promote, the payload refetches and the user falls
  // through to the standard theme picker UI below.
  if (payload && !payload.isParent && payload.children.length === 0) {
    return (
      <SingleProductSetup
        productSku={payload.parentSku}
        productName={payload.parentName}
        payload={payload}
        wizardId={wizardId}
        onAdvance={() =>
          updateWizardState({}, { advance: true }).catch(() => {})
        }
        onMutated={() => setRefetchKey((k) => k + 1)}
      />
    )
  }

  return (
    <div className="max-w-3xl mx-auto py-4 md:py-10 px-3 md:px-6">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Variations</h2>
        <p className="text-md text-slate-600 dark:text-slate-400 mt-1">
          Pick a theme that applies across every selected channel, or
          override per channel when their schemas diverge.
        </p>
      </div>

      {loading && !payload && (
        <div
          className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 px-6 py-6 space-y-3"
          aria-busy="true"
          aria-label="Loading variations"
        >
          <Skeleton variant="text" lines={2} />
          <Skeleton variant="block" height={48} />
          <Skeleton variant="block" height={48} />
          <Skeleton variant="block" height={48} />
        </div>
      )}

      {error && !loading && (
        <div className="border border-rose-200 dark:border-rose-900 rounded-lg bg-rose-50 dark:bg-rose-950/40 px-4 py-3 text-md text-rose-700 dark:text-rose-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {effectivePayload && (
        <>
          {/* Channel-with-missing-themes warning */}
          {effectivePayload.channelsMissingThemes.length > 0 && (
            <div className="mb-4 border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 rounded-md px-3 py-2 text-base text-amber-800">
              <div className="font-medium mb-1">
                Themes unavailable for some channels
              </div>
              <ul className="space-y-0.5 text-sm">
                {effectivePayload.channelsMissingThemes.map((m) => (
                  <li key={m.channelKey}>
                    <span className="font-mono">{m.channelKey}</span> —{' '}
                    <span className="text-amber-700 dark:text-amber-300">{m.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Common theme picker */}
          <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 px-4 py-3 mb-4">
            <div className="flex items-baseline justify-between gap-2 mb-2">
              <label className="text-base font-medium text-slate-700 dark:text-slate-300">
                Common theme (applies to every selected channel)
              </label>
              <div className="flex items-center gap-2">
                {liveThemes.length > 0 && (
                  <span className="text-xs bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded font-medium">
                    Live from Amazon SP-API
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setLiveThemesKey((k) => k + 1)}
                  disabled={liveThemesBusy}
                  title="Refresh live themes from Amazon SP-API"
                  className="inline-flex items-center gap-1 h-6 px-2 text-xs rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                >
                  <RefreshCw className={cn('w-3 h-3', liveThemesBusy && 'animate-spin')} />
                  Refresh
                </button>
                {effectivePayload.commonThemes.length === 0 && (
                  <span className="text-xs uppercase tracking-wide text-amber-700 dark:text-amber-300">
                    No theme common to all channels
                  </span>
                )}
                {/* AI-6.2 — variation theme suggester. Disabled when
                    no themes are available (nothing to recommend) or
                    when an AI call is already in flight. */}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    if (effectivePayload.commonThemes.length === 0) return
                    setAiThemeBusy(true)
                    setAiThemeError(null)
                    setAiThemeRec(null)
                    try {
                      const res = await fetch(
                        `${getBackendUrl()}/api/listing-wizard/${wizardId}/suggest-variation-theme`,
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            presentAttributes: effectivePayload.presentAttributes,
                            availableThemes: effectivePayload.commonThemes.map((th) => ({
                              id: th.id,
                              label: th.label,
                              requiredAttributes: th.requiredAttributes,
                            })),
                          }),
                        },
                      )
                      const json = await res.json()
                      if (!res.ok) {
                        throw new Error(json?.error ?? `HTTP ${res.status}`)
                      }
                      const r = json?.recommendation as
                        | AiThemeRecommendation
                        | undefined
                      if (!r) throw new Error('Empty recommendation')
                      setAiThemeRec(r)
                    } catch (err) {
                      setAiThemeError(
                        err instanceof Error ? err.message : String(err),
                      )
                    } finally {
                      setAiThemeBusy(false)
                    }
                  }}
                  disabled={
                    aiThemeBusy || effectivePayload.commonThemes.length === 0
                  }
                  className="inline-flex items-center gap-1.5"
                >
                  {aiThemeBusy ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                  )}
                  {t('listWizard.aiSuggestTheme.button')}
                </Button>
              </div>
            </div>
            {/* AI-6.2 — recommendation banner. Apply sets commonTheme
                to the AI's pick; alternatives render as quick-toggle
                links so the operator can compare without firing a
                second AI call. */}
            {(aiThemeRec || aiThemeError) && (
              <div className="mb-2 border border-purple-200 dark:border-purple-900 bg-purple-50/60 dark:bg-purple-950/20 rounded-md px-3 py-2">
                {aiThemeError ? (
                  <div className="flex items-start gap-2 text-base text-rose-700 dark:text-rose-300">
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <div>
                      <div className="font-medium">
                        {t('listWizard.aiSuggestTheme.error')}
                      </div>
                      <div className="text-sm opacity-90 mt-0.5">
                        {aiThemeError}
                      </div>
                    </div>
                  </div>
                ) : aiThemeRec ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Sparkles className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400 flex-shrink-0" />
                      <span className="text-sm text-purple-700 dark:text-purple-300">
                        {t('listWizard.aiSuggestTheme.recommends')}
                      </span>
                      <span className="font-mono text-sm font-medium text-slate-900 dark:text-slate-100">
                        {effectivePayload.commonThemes.find(
                          (th) => th.id === aiThemeRec.themeId,
                        )?.label ?? aiThemeRec.themeId}
                      </span>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => {
                          setCommonTheme(aiThemeRec.themeId)
                          toast({
                            tone: 'success',
                            title: t('listWizard.aiSuggestTheme.applied', {
                              theme: aiThemeRec.themeId,
                            }),
                            durationMs: 2400,
                          })
                        }}
                        disabled={commonTheme === aiThemeRec.themeId}
                      >
                        {commonTheme === aiThemeRec.themeId
                          ? t('listWizard.aiSuggestTheme.appliedShort')
                          : t('listWizard.aiSuggestTheme.applyButton')}
                      </Button>
                    </div>
                    <p className="text-sm text-slate-700 dark:text-slate-300 leading-snug">
                      {aiThemeRec.reason}
                    </p>
                    {aiThemeRec.alternatives.length > 0 && (
                      <div className="text-sm text-slate-500 dark:text-slate-400">
                        {t('listWizard.aiSuggestTheme.alternativesLabel')}{' '}
                        {aiThemeRec.alternatives.map((alt, i) => (
                          <span key={alt.themeId}>
                            {i > 0 && ' · '}
                            <button
                              type="button"
                              onClick={() => {
                                setCommonTheme(alt.themeId)
                                toast({
                                  tone: 'success',
                                  title: t('listWizard.aiSuggestTheme.applied', {
                                    theme: alt.themeId,
                                  }),
                                  durationMs: 2400,
                                })
                              }}
                              className="underline hover:text-slate-700 dark:hover:text-slate-300 font-mono"
                              title={alt.reason}
                            >
                              {alt.themeId}
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}
            <select
              value={commonTheme ?? ''}
              onChange={(e) => setCommonTheme(e.target.value || null)}
              className="w-full h-8 px-2 text-md border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900"
              disabled={effectivePayload.commonThemes.length === 0}
            >
              {effectivePayload.commonThemes.length === 0 ? (
                <option value="">— No common themes —</option>
              ) : (
                <>
                  <option value="">— Select common theme —</option>
                  {effectivePayload.commonThemes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label} ({t.id})
                    </option>
                  ))}
                </>
              )}
            </select>
            {commonTheme && (
              <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
                Required per variation:{' '}
                <span className="font-mono">
                  {effectivePayload.commonThemes
                    .find((t) => t.id === commonTheme)
                    ?.requiredAttributes.join(', ') ?? '—'}
                </span>
              </p>
            )}
          </div>

          {/* N.1 — per-channel theme grid, always visible. Each row
              shows the channel's resolved theme (override or inherits
              common) plus a "Same as" / custom path. */}
          {channelKeys.length > 0 && (
            <div className="mb-4 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900">
              <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between text-base">
                <span className="font-medium text-slate-700 dark:text-slate-300">
                  Per-marketplace themes
                </span>
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  {Object.keys(themeByChannel).length > 0
                    ? `${Object.keys(themeByChannel).length} override${
                        Object.keys(themeByChannel).length === 1 ? '' : 's'
                      }`
                    : 'all inherit common'}
                </span>
              </div>
              <div className="border-t border-slate-100 dark:border-slate-800 px-4 py-3 space-y-2">
                {channelKeys.map((channelKey) => {
                    const themes = effectivePayload.themesByChannel[channelKey] ?? []
                    const overrideValue = themeByChannel[channelKey] ?? ''
                    const inherits = !overrideValue
                    const isCustom = overrideValue.startsWith(CUSTOM_PREFIX)
                    const otherChannels = channelKeys.filter(
                      (k) => k !== channelKey,
                    )
                    return (
                      <div
                        key={channelKey}
                        className="flex flex-col gap-1.5"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-mono text-slate-600 dark:text-slate-400 w-24 flex-shrink-0">
                            {channelKey}
                          </span>
                          <select
                            value={overrideValue}
                            onChange={(e) => {
                              const v = e.target.value
                              if (v === '__CUSTOM_NEW__') {
                                // Open the custom input on the next render;
                                // theme stays unset until the user types.
                                setCustomDraft((prev) => ({
                                  ...prev,
                                  [channelKey]: '',
                                }))
                                setThemeByChannel((prev) => {
                                  const next = { ...prev }
                                  delete next[channelKey]
                                  return next
                                })
                                return
                              }
                              if (v.startsWith('__MIRROR__')) {
                                const sourceKey = v.slice('__MIRROR__'.length)
                                const sourceTheme =
                                  themeByChannel[sourceKey] || commonTheme
                                if (!sourceTheme) return
                                setThemeByChannel((prev) => ({
                                  ...prev,
                                  [channelKey]: sourceTheme,
                                }))
                                // If the source has custom attrs, mirror those too.
                                if (
                                  sourceTheme.startsWith(CUSTOM_PREFIX) &&
                                  customAttrsByChannel[sourceKey]
                                ) {
                                  setCustomAttrsByChannel((prev) => ({
                                    ...prev,
                                    [channelKey]:
                                      customAttrsByChannel[sourceKey] ?? [],
                                  }))
                                }
                                return
                              }
                              setThemeByChannel((prev) => {
                                const next = { ...prev }
                                if (!v) delete next[channelKey]
                                else next[channelKey] = v
                                return next
                              })
                              // Clear custom attrs if switching away from custom.
                              if (!v.startsWith(CUSTOM_PREFIX)) {
                                setCustomAttrsByChannel((prev) => {
                                  const next = { ...prev }
                                  delete next[channelKey]
                                  return next
                                })
                              }
                            }}
                            className="flex-1 h-7 px-2 text-base border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900"
                          >
                            <option value="">
                              {inherits && commonTheme
                                ? `Inherits common: ${commonTheme}`
                                : '— No override —'}
                            </option>
                            {themes.length > 0 && (
                              <optgroup label="Schema themes">
                                {themes.map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {t.label} ({t.id})
                                  </option>
                                ))}
                              </optgroup>
                            )}
                            {otherChannels.length > 0 && (
                              <optgroup label="Mirror from">
                                {otherChannels.map((k) => (
                                  <option key={k} value={`__MIRROR__${k}`}>
                                    Same as {k}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                            {isCustom && (
                              <optgroup label="Current">
                                <option value={overrideValue}>
                                  {overrideValue.replace(CUSTOM_PREFIX, '')} (custom)
                                </option>
                              </optgroup>
                            )}
                            <optgroup label="Custom">
                              <option value="__CUSTOM_NEW__">
                                Custom theme…
                              </option>
                            </optgroup>
                          </select>
                        </div>
                        {/* Custom theme inline editor */}
                        {(isCustom || customDraft[channelKey] !== undefined) && (
                          <div className="ml-[6.5rem] flex items-center gap-2">
                            <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 flex-shrink-0">
                              Attrs:
                            </span>
                            <input
                              type="text"
                              value={
                                customDraft[channelKey] !== undefined
                                  ? customDraft[channelKey] ?? ''
                                  : (customAttrsByChannel[channelKey] ?? []).join(', ')
                              }
                              onChange={(e) =>
                                setCustomDraft((prev) => ({
                                  ...prev,
                                  [channelKey]: e.target.value,
                                }))
                              }
                              onBlur={() => {
                                const raw = customDraft[channelKey]
                                if (raw === undefined) return
                                const parts = raw
                                  .split(/[,\s]+/)
                                  .map((s) => s.trim().toLowerCase())
                                  .filter((s) => s.length > 0)
                                if (parts.length === 0) {
                                  // User cleared the input — drop the custom
                                  // theme entirely.
                                  setThemeByChannel((prev) => {
                                    const next = { ...prev }
                                    delete next[channelKey]
                                    return next
                                  })
                                  setCustomAttrsByChannel((prev) => {
                                    const next = { ...prev }
                                    delete next[channelKey]
                                    return next
                                  })
                                  setCustomDraft((prev) => {
                                    const next = { ...prev }
                                    delete next[channelKey]
                                    return next
                                  })
                                  return
                                }
                                const themeId =
                                  CUSTOM_PREFIX +
                                  parts.map((p) => p.toUpperCase()).join('_')
                                setThemeByChannel((prev) => ({
                                  ...prev,
                                  [channelKey]: themeId,
                                }))
                                setCustomAttrsByChannel((prev) => ({
                                  ...prev,
                                  [channelKey]: parts,
                                }))
                                setCustomDraft((prev) => {
                                  const next = { ...prev }
                                  delete next[channelKey]
                                  return next
                                })
                              }}
                              placeholder="size, color, material"
                              className="flex-1 h-7 px-2 text-base font-mono border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                            />
                          </div>
                        )}
                      </div>
                    )
                  })}
              </div>
            </div>
          )}

          {/* Variants table with CRUD */}
          {effectivePayload.children.length > 0 && (
            <div className="mb-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowMatrix((v) => !v)}
                className={cn(
                  'h-7 px-3 text-sm rounded-md border inline-flex items-center gap-1.5',
                  showMatrix
                    ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800',
                )}
              >
                <Layers className="w-3.5 h-3.5" />
                Matrix builder
              </button>
            </div>
          )}

          {showMatrix && effectivePayload.children.length > 0 && (
            <div className="mb-4">
              <MatrixVariantBuilder
                payload={effectivePayload}
                onCreated={() => setRefetchKey((k) => k + 1)}
                wizardId={wizardId}
              />
            </div>
          )}

          <VariantsTable
            children={childrenWithLiveAnnotations}
            parentId={product.id}
            wizardId={wizardId}
            selectedTheme={selectedTheme}
            includedSkus={includedSkus}
            inheritByChildId={inheritByChildId}
            onToggleSku={onToggleSku}
            onRefetch={() => setRefetchKey((k) => k + 1)}
            onInheritChange={onInheritChange}
          />

          {showAddRow && (
            <AddVariantRow
              parentId={product.id}
              selectedTheme={selectedTheme}
              onDone={() => {
                setShowAddRow(false)
                setRefetchKey((k) => k + 1)
              }}
              onCancel={() => setShowAddRow(false)}
            />
          )}

          {!showAddRow && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowAddRow(true)}
                className="h-7 px-3 text-sm rounded-md border border-dashed border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-400"
              >
                <Plus className="w-3.5 h-3.5" />
                Add variant
              </button>
            </div>
          )}

          <div className="mt-6 flex items-center justify-between gap-3">
            <ContinueStatus
              commonTheme={commonTheme}
              channelKeys={channelKeys}
              includedCount={includedChildren.length}
              blockingCount={blockingChildren.length}
              hasChildren={effectivePayload.children.length > 0}
            />
            <Button
              variant="primary"
              size="sm"
              onClick={onContinue}
              disabled={
                !effectivePayload ||
                (effectivePayload.children.length > 0 &&
                  (includedChildren.length === 0 ||
                    blockingChildren.length > 0))
              }
            >
              Continue
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function VariantsTable({
  children,
  parentId,
  selectedTheme,
  includedSkus,
  inheritByChildId,
  onToggleSku,
  onRefetch,
  onInheritChange,
}: {
  children: MultiChannelVariationChild[]
  parentId: string
  wizardId: string
  selectedTheme: ThemeOption | null
  includedSkus: Set<string>
  inheritByChildId: Record<string, boolean>
  onToggleSku: (sku: string) => void
  onRefetch: () => void
  onInheritChange: (childId: string, value: boolean) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<VariantDraftEdit | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const attrCols = selectedTheme?.requiredAttributes ?? []

  const startEdit = useCallback((child: MultiChannelVariationChild) => {
    setEditingId(child.id)
    setSaveError(null)
    setEditDraft({
      sku: child.sku,
      price: child.price.toString(),
      stock: child.stock.toString(),
      attrs: { ...child.attributes },
    })
  }, [])

  const cancelEdit = useCallback(() => {
    setEditingId(null)
    setEditDraft(null)
    setSaveError(null)
  }, [])

  const commitEdit = useCallback(
    async (child: MultiChannelVariationChild) => {
      if (!editDraft) return
      setSaving(true)
      setSaveError(null)
      try {
        const basicRes = await fetch(
          `${getBackendUrl()}/api/products/${encodeURIComponent(parentId)}/children/${encodeURIComponent(child.id)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sku: editDraft.sku,
              basePrice: editDraft.price ? Number(editDraft.price) : undefined,
              totalStock: editDraft.stock ? Number(editDraft.stock) : undefined,
            }),
          },
        )
        if (!basicRes.ok) {
          const j = await basicRes.json().catch(() => ({}))
          throw new Error(j?.error ?? `HTTP ${basicRes.status}`)
        }
        const attrRes = await fetch(
          `${getBackendUrl()}/api/catalog/products/${encodeURIComponent(child.id)}/variant-attributes`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(editDraft.attrs),
          },
        )
        if (!attrRes.ok) {
          const j = await attrRes.json().catch(() => ({}))
          throw new Error(j?.error ?? `HTTP ${attrRes.status}`)
        }
        setEditingId(null)
        setEditDraft(null)
        onRefetch()
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : String(err))
      } finally {
        setSaving(false)
      }
    },
    [editDraft, parentId, onRefetch],
  )

  const handleDelete = useCallback(
    async (child: MultiChannelVariationChild) => {
      if (!confirm(`Delete variant ${child.sku}?`)) return
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/catalog/products/${encodeURIComponent(child.id)}`,
          { method: 'DELETE' },
        )
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          alert(j?.error ?? `Delete failed (HTTP ${res.status})`)
          return
        }
        onRefetch()
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err))
      }
    },
    [onRefetch],
  )

  if (children.length === 0) {
    return (
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 px-3 py-6 text-base text-slate-500 dark:text-slate-400 text-center">
        No children found. Add a variant below.
      </div>
    )
  }

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60">
            <th className="w-8 px-2 py-2 text-center">
              <span className="sr-only">Include</span>
            </th>
            <th className="px-2 py-2 text-left font-medium text-slate-600 dark:text-slate-400">SKU</th>
            {attrCols.map((attr) => (
              <th key={attr} className="px-2 py-2 text-left font-medium text-slate-600 dark:text-slate-400 capitalize">
                {attr}
              </th>
            ))}
            <th className="px-2 py-2 text-right font-medium text-slate-600 dark:text-slate-400">Price</th>
            <th className="px-2 py-2 text-right font-medium text-slate-600 dark:text-slate-400">Stock</th>
            <th className="px-2 py-2 text-right font-medium text-slate-600 dark:text-slate-400">Actions</th>
          </tr>
        </thead>
        <tbody>
          {children.map((child) => {
            const isEditing = editingId === child.id
            const included = includedSkus.has(child.sku)
            const blockingChannels = Object.entries(child.missingByChannel)
              .filter(([, m]) => m.length > 0)
              .map(([k, m]) => ({ k, m }))
            const hasBlocking = included && blockingChannels.length > 0
            const inherits = inheritByChildId[child.id] ?? false

            return (
              <tr
                key={child.id}
                data-blocker-row={hasBlocking ? 'true' : undefined}
                className={cn(
                  'border-b border-slate-100 dark:border-slate-800 last:border-b-0 scroll-mt-24',
                  hasBlocking && 'bg-amber-50/40 dark:bg-amber-950/10',
                  isEditing && 'bg-blue-50/30 dark:bg-blue-950/10',
                )}
              >
                <td className="px-2 py-1.5 text-center">
                  <input
                    type="checkbox"
                    checked={included}
                    onChange={() => onToggleSku(child.sku)}
                    className="w-4 h-4 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500"
                  />
                </td>
                <td className="px-2 py-1.5">
                  {isEditing ? (
                    <input
                      type="text"
                      value={editDraft!.sku}
                      onChange={(e) => setEditDraft((d) => d ? { ...d, sku: e.target.value } : d)}
                      className="w-full h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900 font-mono"
                    />
                  ) : (
                    <div>
                      <div className="font-mono text-slate-900 dark:text-slate-100">{child.sku}</div>
                      {inherits && (
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Parent details inherited</div>
                      )}
                    </div>
                  )}
                </td>
                {attrCols.map((attr) => (
                  <td key={attr} className="px-2 py-1.5">
                    {isEditing ? (
                      <input
                        type="text"
                        value={editDraft!.attrs[attr] ?? ''}
                        onChange={(e) =>
                          setEditDraft((d) =>
                            d ? { ...d, attrs: { ...d.attrs, [attr]: e.target.value } } : d,
                          )
                        }
                        placeholder={`${attr} (empty = remove)`}
                        className="w-full h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900"
                      />
                    ) : (
                      <span className="text-slate-700 dark:text-slate-300">
                        {child.attributes[attr] ?? <span className="text-slate-400 dark:text-slate-600 italic">—</span>}
                      </span>
                    )}
                  </td>
                ))}
                <td className="px-2 py-1.5 text-right">
                  {isEditing ? (
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={editDraft!.price}
                      onChange={(e) => setEditDraft((d) => d ? { ...d, price: e.target.value } : d)}
                      className="w-20 h-7 px-2 text-sm text-right border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900"
                    />
                  ) : (
                    <span className="tabular-nums text-slate-700 dark:text-slate-300">€{child.price.toFixed(2)}</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right">
                  {isEditing ? (
                    <input
                      type="number"
                      min="0"
                      value={editDraft!.stock}
                      onChange={(e) => setEditDraft((d) => d ? { ...d, stock: e.target.value } : d)}
                      className="w-16 h-7 px-2 text-sm text-right border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900"
                    />
                  ) : (
                    <span className="tabular-nums text-slate-700 dark:text-slate-300">{child.stock}</span>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex items-center justify-end gap-1.5">
                    {isEditing ? (
                      <>
                        <div className="flex flex-col gap-1 items-end mr-1">
                          <label className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap cursor-pointer">
                            <input
                              type="checkbox"
                              checked={inheritByChildId[child.id] ?? false}
                              onChange={(e) => onInheritChange(child.id, e.target.checked)}
                              className="w-3 h-3 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500"
                            />
                            Inherit parent name/desc
                          </label>
                          {saveError && (
                            <span className="text-xs text-rose-600 dark:text-rose-400 max-w-[160px] text-right">{saveError}</span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => void commitEdit(child)}
                          disabled={saving}
                          title="Save"
                          className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 disabled:opacity-50"
                        >
                          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          title="Cancel"
                          className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => startEdit(child)}
                          title="Edit"
                          className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(child)}
                          title="Delete"
                          className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-200 dark:border-slate-700 text-rose-500 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:border-rose-200 dark:hover:border-rose-800"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function AddVariantRow({
  parentId,
  selectedTheme,
  onDone,
  onCancel,
}: {
  parentId: string
  selectedTheme: ThemeOption | null
  onDone: () => void
  onCancel: () => void
}) {
  const attrCols = selectedTheme?.requiredAttributes ?? []
  const [sku, setSku] = useState('')
  const [price, setPrice] = useState('')
  const [stock, setStock] = useState('')
  const [attrs, setAttrs] = useState<Record<string, string>>(() =>
    Object.fromEntries(attrCols.map((a) => [a, ''])),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleAdd = useCallback(async () => {
    if (!sku.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/catalog/products/${encodeURIComponent(parentId)}/children`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sku: sku.trim(),
            name: sku.trim(),
            basePrice: price ? Number(price) : undefined,
            totalStock: stock ? Number(stock) : undefined,
          }),
        },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(json?.error ?? `HTTP ${res.status}`)
      }
      const newId = json?.data?.id ?? json?.id
      if (newId && Object.values(attrs).some((v) => v.trim())) {
        await fetch(
          `${getBackendUrl()}/api/catalog/products/${encodeURIComponent(newId)}/variant-attributes`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(attrs),
          },
        )
      }
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [sku, price, stock, attrs, parentId, onDone])

  return (
    <div className="mt-2 border border-blue-200 dark:border-blue-800 rounded-lg bg-blue-50/40 dark:bg-blue-950/10 px-3 py-3">
      <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium mb-2">New variant</div>
      <div className="flex flex-wrap gap-2 mb-2">
        <input
          type="text"
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          placeholder="SKU *"
          className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900 font-mono w-36"
        />
        {attrCols.map((attr) => (
          <input
            key={attr}
            type="text"
            value={attrs[attr] ?? ''}
            onChange={(e) => setAttrs((a) => ({ ...a, [attr]: e.target.value }))}
            placeholder={attr}
            className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900 w-24"
          />
        ))}
        <input
          type="number"
          min="0"
          step="0.01"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="Price"
          className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900 w-20"
        />
        <input
          type="number"
          min="0"
          value={stock}
          onChange={(e) => setStock(e.target.value)}
          placeholder="Stock"
          className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900 w-16"
        />
      </div>
      {error && (
        <div className="mb-2 text-xs text-rose-600 dark:text-rose-400 inline-flex items-center gap-1">
          <AlertCircle className="w-3 h-3 flex-shrink-0" />
          {error}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={busy || !sku.trim()}
          className="h-7 px-3 text-sm rounded-md border border-blue-300 dark:border-blue-700 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          {busy && <Loader2 className="w-3 h-3 animate-spin" />}
          Add
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-7 px-3 text-sm rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function ContinueStatus({
  commonTheme,
  channelKeys,
  includedCount,
  blockingCount,
  hasChildren,
}: {
  commonTheme: string | null
  channelKeys: string[]
  includedCount: number
  blockingCount: number
  hasChildren: boolean
}) {
  if (!hasChildren) {
    return <span className="text-base text-slate-500 dark:text-slate-400">No variations</span>
  }
  if (includedCount === 0) {
    return (
      <span className="text-base text-amber-700 dark:text-amber-300">
        Pick at least one variation
      </span>
    )
  }
  if (blockingCount > 0) {
    return (
      <span className="text-base text-amber-700 dark:text-amber-300">
        {blockingCount} variation{blockingCount === 1 ? '' : 's'} missing
        attributes for the selected theme
      </span>
    )
  }
  if (!commonTheme && channelKeys.length > 0) {
    return (
      <span className="text-base text-slate-500 dark:text-slate-400">
        {includedCount} included — pick a theme to continue
      </span>
    )
  }
  return (
    <span className="text-base text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1.5">
      <CheckCircle2 className="w-3.5 h-3.5" />
      {includedCount} variation{includedCount === 1 ? '' : 's'} ready
    </span>
  )
}

function pickDefaultCommonTheme(
  themes: ThemeOption[],
  present: string[],
): ThemeOption | null {
  if (themes.length === 0) return null
  const presentSet = new Set(present)
  const exact = themes.find((t) =>
    t.requiredAttributes.every((a) => presentSet.has(a)),
  )
  return exact ?? themes[0] ?? null
}

async function persistThemes(
  wizardId: string,
  args: {
    commonTheme: string | null
    themeByChannel: Record<string, string>
    customAttrsByChannel: Record<string, string[]>
    includedSkus: string[]
    channelKeys: string[]
  },
): Promise<void> {
  // Base slice: commonTheme + themeByChannel + customAttributes +
  // includedSkus.
  const basePatch = {
    state: {
      variations: {
        commonTheme: args.commonTheme,
        themeByChannel: args.themeByChannel,
        customAttributesByChannel: args.customAttrsByChannel,
        includedSkus: args.includedSkus,
      },
    },
  }
  // Per-channel slice: theme that should be used for that channel
  // (override or inherited common). Stored under
  // channelStates[key].variations.theme so submission services can
  // read a single field per channel without reconciling. Custom
  // themes carry the attribute list alongside.
  const channelStates: Record<string, Record<string, unknown>> = {}
  for (const channelKey of args.channelKeys) {
    const effective =
      args.themeByChannel[channelKey] || args.commonTheme || null
    if (effective) {
      const slice: Record<string, unknown> = { theme: effective }
      if (
        effective.startsWith(CUSTOM_PREFIX) &&
        args.customAttrsByChannel[channelKey]
      ) {
        slice.customAttributes = args.customAttrsByChannel[channelKey]
      }
      channelStates[channelKey] = { variations: slice }
    }
  }
  try {
    await fetch(`${getBackendUrl()}/api/listing-wizard/${wizardId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...basePatch, channelStates }),
    })
  } catch {
    /* swallow — caller's debounce will retry */
  }
}

// ── VV — single-product setup ───────────────────────────────────────
//
// Renders three options for products that are neither parents nor
// linked to one. After a successful Link or Promote+AddVariants
// action we call onMutated() so the parent component refetches the
// variations payload and the user falls through to the standard
// theme picker UI.

interface ParentHit {
  id: string
  sku: string
  name: string
}

interface VariantDraft {
  id: string // local-only react key
  sku: string
  name: string
  attrs: Record<string, string>
  price: string
  stock: string
}

type SetupMode = 'standalone' | 'link' | 'promote'

function SingleProductSetup({
  productSku,
  productName,
  payload,
  wizardId,
  onAdvance,
  onMutated,
}: {
  productSku: string
  productName: string
  payload: MultiChannelVariationsPayload
  wizardId: string
  onAdvance: () => void
  onMutated: () => void
}) {
  const [mode, setMode] = useState<SetupMode>('standalone')
  // LWV.1 — within the "promote" mode, default to the matrix builder.
  // The legacy row-by-row builder stays available behind a "manual"
  // toggle for operators who want pre-named variants without using
  // axes (rare, but keeps the prior workflow alive).
  const [promoteMode, setPromoteMode] = useState<'matrix' | 'manual'>('matrix')

  return (
    <div className="max-w-3xl mx-auto py-4 md:py-10 px-3 md:px-6">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Variations</h2>
        <p className="text-md text-slate-600 dark:text-slate-400 mt-1">
          <span className="font-mono">{productSku}</span> — {productName}.
          Pick how this product fits into your catalog.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <ModeCard
          icon={PackageOpen}
          title="Standalone"
          subtitle="No size / color / etc. — single SKU. Skip this step."
          active={mode === 'standalone'}
          onClick={() => setMode('standalone')}
        />
        <ModeCard
          icon={Layers}
          title="Variant of existing parent"
          subtitle="Link this SKU under an existing parent. Inherits the parent's variation theme."
          active={mode === 'link'}
          onClick={() => setMode('link')}
        />
        <ModeCard
          icon={Package}
          title="Has variants"
          subtitle="Promote to parent and add child SKUs (size, color, …)."
          active={mode === 'promote'}
          onClick={() => setMode('promote')}
        />
      </div>

      {mode === 'standalone' && (
        <StandalonePanel onAdvance={onAdvance} sku={productSku} />
      )}
      {mode === 'link' && <LinkParentPanel onLinked={onMutated} />}
      {mode === 'promote' && (
        <div className="space-y-3">
          <div className="flex items-center justify-end gap-2 text-sm">
            <span className="text-slate-500 dark:text-slate-400">
              Builder:
            </span>
            <button
              type="button"
              onClick={() => setPromoteMode('matrix')}
              className={cn(
                'px-2 py-0.5 rounded-md border text-sm',
                promoteMode === 'matrix'
                  ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800',
              )}
            >
              Matrix (axes × axes)
            </button>
            <button
              type="button"
              onClick={() => setPromoteMode('manual')}
              className={cn(
                'px-2 py-0.5 rounded-md border text-sm',
                promoteMode === 'manual'
                  ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800',
              )}
            >
              Manual (one-by-one)
            </button>
          </div>
          {promoteMode === 'matrix' ? (
            <MatrixVariantBuilder payload={payload} onCreated={onMutated} wizardId={wizardId} />
          ) : (
            <PromotePanel onPromoted={onMutated} />
          )}
        </div>
      )}
    </div>
  )
}

function ModeCard({
  icon: Icon,
  title,
  subtitle,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  subtitle: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'text-left border rounded-lg p-3 transition-colors',
        active
          ? 'border-blue-300 bg-blue-50 dark:bg-blue-950/40'
          : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-600',
      )}
    >
      <Icon
        className={cn(
          'w-5 h-5 mb-2',
          active ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400',
        )}
      />
      <div className="text-md font-semibold text-slate-900 dark:text-slate-100 mb-1">{title}</div>
      <div className="text-sm text-slate-600 dark:text-slate-400 leading-snug">{subtitle}</div>
    </button>
  )
}

function StandalonePanel({
  onAdvance,
  sku,
}: {
  onAdvance: () => void
  sku: string
}) {
  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 px-5 py-4">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
        <div className="text-base text-slate-700 dark:text-slate-300">
          <span className="font-mono">{sku}</span> ships as a single SKU.
          Click Continue to move on to attributes.
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end">
        <Button variant="primary" size="sm" onClick={onAdvance}>
          Continue
        </Button>
      </div>
    </div>
  )
}

function LinkParentPanel({ onLinked }: { onLinked: () => void }) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<ParentHit[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<ParentHit | null>(null)
  const [parentVariants, setParentVariants] = useState<
    Array<{ sku: string; attrs: Record<string, string> }>
  >([])
  const [variantsLoading, setVariantsLoading] = useState(false)
  const [linking, setLinking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastTermRef = useRef('')

  // Debounced parent search.
  useEffect(() => {
    const term = search.trim()
    if (term.length < 2) {
      setResults([])
      return
    }
    lastTermRef.current = term
    const t = window.setTimeout(async () => {
      setSearching(true)
      try {
        const url = new URL(`${getBackendUrl()}/api/products/bulk-fetch`)
        url.searchParams.set('search', term)
        url.searchParams.set('limit', '10')
        const res = await fetch(url.toString())
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (lastTermRef.current !== term) return
        const candidates: ParentHit[] = (json?.products ?? [])
          .filter((p: { isParent?: boolean; id?: string }) => p.isParent && p.id)
          .map((p: { id: string; sku: string; name: string }) => ({
            id: p.id,
            sku: p.sku,
            name: p.name,
          }))
        setResults(candidates)
      } catch (err) {
        console.warn('[Step5] parent search failed', err)
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 250)
    return () => window.clearTimeout(t)
  }, [search])

  // Fetch existing variants for the selected parent so the user can
  // see the family they're joining.
  useEffect(() => {
    if (!selected) {
      setParentVariants([])
      return
    }
    let cancelled = false
    setVariantsLoading(true)
    fetch(
      `${getBackendUrl()}/api/catalog/products/${encodeURIComponent(
        selected.id,
      )}`,
    )
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return
        const variants =
          json?.data?.variations?.map(
            (v: {
              sku: string
              variationAttributes?: Record<string, unknown>
            }) => ({
              sku: v.sku,
              attrs: Object.fromEntries(
                Object.entries(v.variationAttributes ?? {}).map(([k, val]) => [
                  k,
                  String(val ?? ''),
                ]),
              ),
            }),
          ) ?? []
        setParentVariants(variants)
      })
      .catch(() => setParentVariants([]))
      .finally(() => {
        if (!cancelled) setVariantsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  const handleLink = async () => {
    if (!selected) return
    setLinking(true)
    setError(null)
    try {
      // Get the current product id from the URL — the wizard's product
      // is the one we're linking. We don't have direct access to the
      // product id in StepProps, but the URL path /products/<id>/...
      // is consistent.
      const productId = window.location.pathname.split('/')[2]
      if (!productId) {
        setError('Could not resolve current product id from URL.')
        return
      }
      const res = await fetch(`${getBackendUrl()}/api/products/bulk`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [
            { id: productId, field: 'parentId', value: selected.id },
            { id: productId, field: 'isParent', value: false },
          ],
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json?.success === false) {
        setError(
          json?.errors?.[0]?.error ??
            json?.error ??
            `Couldn't link to parent (HTTP ${res.status}).`,
        )
        return
      }
      onLinked()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLinking(false)
    }
  }

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900">
      <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <Search className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search parent SKU or name (min 2 chars)"
            className="flex-1 h-8 text-base border-0 focus:outline-none bg-transparent"
            autoFocus
          />
          {searching && (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400 dark:text-slate-500" />
          )}
        </div>
      </div>

      {!selected && (
        <div className="max-h-[260px] overflow-y-auto">
          {results.length === 0 && search.trim().length >= 2 && !searching && (
            <div className="px-5 py-4 text-base text-slate-500 dark:text-slate-400 text-center">
              No parent products match.
            </div>
          )}
          {results.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelected(p)}
              className="w-full text-left px-5 py-2.5 text-base hover:bg-slate-50 dark:hover:bg-slate-800 border-b border-slate-100 dark:border-slate-800 last:border-b-0"
            >
              <div className="font-mono text-slate-900 dark:text-slate-100">{p.sku}</div>
              <div className="text-sm text-slate-500 dark:text-slate-400 truncate">{p.name}</div>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="px-5 py-4">
          <div className="flex items-start justify-between gap-3 mb-3 pb-3 border-b border-slate-100 dark:border-slate-800">
            <div>
              <div className="text-base text-slate-500 dark:text-slate-400">Linking under:</div>
              <div className="font-mono text-lg text-slate-900 dark:text-slate-100 mt-0.5">
                {selected.sku}
              </div>
              <div className="text-base text-slate-600 dark:text-slate-400">{selected.name}</div>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
              aria-label="Pick a different parent"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="mb-4">
            <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Existing variants under this parent
            </div>
            {variantsLoading ? (
              <div className="text-sm text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                Fetching variants…
              </div>
            ) : parentVariants.length === 0 ? (
              <div className="text-sm text-slate-500 dark:text-slate-400 italic">
                No variants yet — yours will be the first child.
              </div>
            ) : (
              <ul className="space-y-1 max-h-[140px] overflow-y-auto">
                {parentVariants.map((v) => (
                  <li
                    key={v.sku}
                    className="text-sm flex items-center gap-2"
                  >
                    <span className="font-mono text-slate-700 dark:text-slate-300">{v.sku}</span>
                    <span className="text-slate-500 dark:text-slate-400">
                      {Object.entries(v.attrs)
                        .map(([k, val]) => `${k}=${val}`)
                        .join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {error && (
            <div className="mb-3 px-3 py-2 border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded-md text-sm text-rose-700 dark:text-rose-300 inline-flex items-start gap-1.5">
              <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end">
            <Button
              variant="primary"
              size="sm"
              onClick={handleLink}
              disabled={linking}
            >
              {linking && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Link as variant
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function PromotePanel({ onPromoted }: { onPromoted: () => void }) {
  const [variants, setVariants] = useState<VariantDraft[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addRow = () =>
    setVariants((vs) => [
      ...vs,
      {
        id: `v_${Date.now()}_${vs.length}`,
        sku: '',
        name: '',
        attrs: {},
        price: '',
        stock: '',
      },
    ])
  const removeRow = (id: string) =>
    setVariants((vs) => vs.filter((v) => v.id !== id))
  const update = (id: string, patch: Partial<VariantDraft>) =>
    setVariants((vs) => vs.map((v) => (v.id === id ? { ...v, ...patch } : v)))

  const valid =
    variants.length > 0 &&
    variants.every((v) => v.sku.trim().length > 0 && v.name.trim().length > 0)

  const handlePromote = async () => {
    if (!valid) return
    setSubmitting(true)
    setError(null)
    try {
      const productId = window.location.pathname.split('/')[2]
      if (!productId) {
        setError('Could not resolve current product id from URL.')
        return
      }
      // Promote: flip isParent=true on this product.
      const promoteRes = await fetch(`${getBackendUrl()}/api/products/bulk`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [{ id: productId, field: 'isParent', value: true }],
        }),
      })
      const promoteJson = await promoteRes.json().catch(() => ({}))
      if (!promoteRes.ok || promoteJson?.success === false) {
        setError(
          promoteJson?.errors?.[0]?.error ??
            promoteJson?.error ??
            `Couldn't promote to parent (HTTP ${promoteRes.status}).`,
        )
        return
      }
      // Add each variant via the catalog children endpoint. We
      // serialize the calls so a partial failure leaves the UI
      // pointing at the SKU that errored.
      for (const v of variants) {
        const childRes = await fetch(
          `${getBackendUrl()}/api/catalog/products/${productId}/children`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sku: v.sku.trim(),
              name: v.name.trim(),
              basePrice: v.price.trim() ? Number(v.price) : 0,
              totalStock: v.stock.trim() ? Number(v.stock) : 0,
            }),
          },
        )
        if (!childRes.ok) {
          const j = await childRes.json().catch(() => ({}))
          setError(
            `Variant ${v.sku} failed: ${
              j?.error?.message ?? j?.error ?? `HTTP ${childRes.status}`
            }`,
          )
          return
        }
      }
      onPromoted()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900">
      <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
        <div className="text-base text-slate-700 dark:text-slate-300">
          Add at least one variant. After save, this product becomes the
          parent and the wizard refreshes to let you pick variation themes
          per channel.
        </div>
      </div>
      <div className="px-5 py-4 space-y-3">
        {variants.length === 0 ? (
          <div className="text-center py-6 border border-dashed border-slate-200 dark:border-slate-700 rounded-lg">
            <p className="text-base text-slate-500 dark:text-slate-400 mb-3">
              No variants yet.
            </p>
            <button
              type="button"
              onClick={addRow}
              className="h-7 px-3 text-sm rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1"
            >
              <Plus className="w-3 h-3" />
              Add variant
            </button>
          </div>
        ) : (
          <>
            {variants.map((v, idx) => (
              <PromoteVariantRow
                key={v.id}
                row={v}
                index={idx}
                onChange={(patch) => update(v.id, patch)}
                onRemove={() => removeRow(v.id)}
              />
            ))}
            <button
              type="button"
              onClick={addRow}
              className="w-full h-7 text-sm rounded-md border border-dashed border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center justify-center gap-1"
            >
              <Plus className="w-3 h-3" />
              Add another variant
            </button>
          </>
        )}

        {error && (
          <div className="px-3 py-2 border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded-md text-sm text-rose-700 dark:text-rose-300 inline-flex items-start gap-1.5">
            <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end pt-1">
          <Button
            variant="primary"
            size="sm"
            onClick={handlePromote}
            disabled={!valid || submitting}
          >
            {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Promote to parent &amp; add {variants.length || 0} variant
            {variants.length === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function PromoteVariantRow({
  row,
  index,
  onChange,
  onRemove,
}: {
  row: VariantDraft
  index: number
  onChange: (patch: Partial<VariantDraft>) => void
  onRemove: () => void
}) {
  const [attrKeyDraft, setAttrKeyDraft] = useState('')
  const [attrValDraft, setAttrValDraft] = useState('')
  const addAttr = () => {
    const k = attrKeyDraft.trim()
    const v = attrValDraft.trim()
    if (!k || !v) return
    onChange({ attrs: { ...row.attrs, [k]: v } })
    setAttrKeyDraft('')
    setAttrValDraft('')
  }
  const removeAttr = (k: string) => {
    const { [k]: _gone, ...rest } = row.attrs
    onChange({ attrs: rest })
  }
  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-md p-3 bg-slate-50/50">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium">
          Variant #{index + 1}
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="text-rose-500 hover:text-rose-700 dark:hover:text-rose-300"
          aria-label="Remove variant"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <input
          type="text"
          value={row.sku}
          onChange={(e) => onChange({ sku: e.target.value })}
          placeholder="Variant SKU"
          className="h-7 px-2 text-base border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900"
        />
        <input
          type="text"
          value={row.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Variant name"
          className="h-7 px-2 text-base border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900"
        />
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <input
          type="number"
          min="0"
          step="0.01"
          value={row.price}
          onChange={(e) => onChange({ price: e.target.value })}
          placeholder="Price (opt)"
          className="h-7 px-2 text-base border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900"
        />
        <input
          type="number"
          min="0"
          value={row.stock}
          onChange={(e) => onChange({ stock: e.target.value })}
          placeholder="Stock (opt)"
          className="h-7 px-2 text-base border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900"
        />
      </div>
      {Object.entries(row.attrs).length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {Object.entries(row.attrs).map(([k, val]) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs"
            >
              <span className="font-mono">{k}</span>: {val}
              <button
                type="button"
                onClick={() => removeAttr(k)}
                className="text-slate-500 dark:text-slate-400 hover:text-rose-700 dark:hover:text-rose-300"
                aria-label={`Remove ${k}`}
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={attrKeyDraft}
          onChange={(e) => setAttrKeyDraft(e.target.value)}
          placeholder="key (color)"
          className="flex-1 h-6 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900"
        />
        <input
          type="text"
          value={attrValDraft}
          onChange={(e) => setAttrValDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addAttr()
            }
          }}
          placeholder="value (red)"
          className="flex-1 h-6 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white dark:bg-slate-900"
        />
        <button
          type="button"
          onClick={addAttr}
          disabled={!attrKeyDraft.trim() || !attrValDraft.trim()}
          className="h-6 px-2 text-sm rounded-md border border-slate-200 dark:border-slate-700 hover:bg-white disabled:opacity-40 bg-white dark:bg-slate-900"
        >
          Add
        </button>
      </div>
    </div>
  )
}
