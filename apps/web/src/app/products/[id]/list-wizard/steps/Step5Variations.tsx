'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  PackageOpen,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'

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

interface VariationsSlice {
  /** Common-theme pick that applies to all channels by default. */
  commonTheme?: string
  /** Per-channel selected theme (overrides commonTheme for that
   *  channel). Empty/absent → falls back to commonTheme. */
  themeByChannel?: Record<string, string>
  includedSkus?: string[]
}

const SAVE_DEBOUNCE_MS = 600

export default function Step5Variations({
  wizardState,
  updateWizardState,
  wizardId,
  channels,
}: StepProps) {
  const slice = (wizardState.variations ?? {}) as VariationsSlice

  const [payload, setPayload] = useState<MultiChannelVariationsPayload | null>(
    null,
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [commonTheme, setCommonTheme] = useState<string | null>(
    slice.commonTheme ?? null,
  )
  const [themeByChannel, setThemeByChannel] = useState<Record<string, string>>(
    slice.themeByChannel ?? {},
  )
  const [includedSkus, setIncludedSkus] = useState<Set<string>>(
    new Set(slice.includedSkus ?? []),
  )
  const [overridesExpanded, setOverridesExpanded] = useState(false)

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
    // first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizardId, channels.length])

  const onToggleSku = useCallback((sku: string) => {
    setIncludedSkus((prev) => {
      const next = new Set(prev)
      if (next.has(sku)) next.delete(sku)
      else next.add(sku)
      return next
    })
  }, [])

  const onSelectAll = useCallback(() => {
    if (!payload) return
    setIncludedSkus(new Set(payload.children.map((c) => c.sku)))
  }, [payload])

  const onSelectNone = useCallback(() => {
    setIncludedSkus(new Set())
  }, [])

  // Persist selection to wizardState (state.variations) and per-
  // channel theme to channelStates[key].variations.theme. Debounced
  // so toggling chips doesn't fire one PATCH per click.
  useEffect(() => {
    if (loading || !payload) return
    const t = window.setTimeout(() => {
      void persistThemes(wizardId, {
        commonTheme,
        themeByChannel,
        includedSkus: Array.from(includedSkus),
        channelKeys: Object.keys(payload.themesByChannel),
      })
    }, SAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commonTheme, themeByChannel, includedSkus, loading, payload])

  // Effective theme per channel: per-channel override → commonTheme.
  const effectiveTheme = useCallback(
    (channelKey: string): string | null => {
      return themeByChannel[channelKey] || commonTheme || null
    },
    [themeByChannel, commonTheme],
  )

  // Re-annotate missingByChannel client-side based on current picks
  // — the server's annotation is computed from the persisted state,
  // which lags by SAVE_DEBOUNCE_MS. Doing this in the UI keeps the
  // chips in sync with what the user just clicked.
  const childrenWithLiveAnnotations = useMemo(() => {
    if (!payload) return []
    return payload.children.map((c) => {
      const missingByChannel: Record<string, string[]> = {}
      for (const channelKey of Object.keys(payload.themesByChannel)) {
        const themeId = effectiveTheme(channelKey)
        if (!themeId) {
          missingByChannel[channelKey] = []
          continue
        }
        const theme = (payload.themesByChannel[channelKey] ?? []).find(
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
  }, [payload, effectiveTheme])

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

  const channelKeys = useMemo(() => {
    return payload ? Object.keys(payload.themesByChannel) : []
  }, [payload])

  const onContinue = useCallback(async () => {
    if (!payload) return
    if (payload.isParent && includedChildren.length === 0) return
    if (blockingChildren.length > 0) return
    // Persist before advance — bypass debounce.
    await persistThemes(wizardId, {
      commonTheme,
      themeByChannel,
      includedSkus: Array.from(includedSkus),
      channelKeys,
    })
    await updateWizardState({}, { advance: true })
  }, [
    blockingChildren.length,
    channelKeys,
    commonTheme,
    includedChildren.length,
    includedSkus,
    payload,
    themeByChannel,
    updateWizardState,
    wizardId,
  ])

  // Single-product (non-parent) short-circuit.
  if (payload && !payload.isParent && payload.children.length === 0) {
    return (
      <div className="max-w-2xl mx-auto py-12 px-6">
        <div className="border border-slate-200 rounded-lg bg-white px-6 py-8">
          <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 rounded-full bg-slate-100 text-slate-500">
            <PackageOpen className="w-6 h-6" />
          </div>
          <h2 className="text-[18px] font-semibold text-slate-900 text-center">
            No variations to configure
          </h2>
          <p className="mt-2 text-[13px] text-slate-600 text-center">
            <span className="font-mono">{payload.parentSku}</span> is a single
            product without size/color/etc. children. Click Continue to skip
            this step.
          </p>
        </div>
        <div className="mt-6 flex items-center justify-end">
          <button
            type="button"
            onClick={() =>
              updateWizardState({}, { advance: true }).catch(() => {})
            }
            className="h-8 px-4 rounded-md bg-blue-600 text-white text-[13px] font-medium hover:bg-blue-700"
          >
            Continue
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto py-10 px-6">
      <div className="mb-6">
        <h2 className="text-[20px] font-semibold text-slate-900">Variations</h2>
        <p className="text-[13px] text-slate-600 mt-1">
          Pick a theme that applies across every selected channel, or
          override per channel when their schemas diverge.
        </p>
      </div>

      {loading && !payload && (
        <div className="border border-slate-200 rounded-lg bg-white px-6 py-12 text-center text-[13px] text-slate-500 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading variations…
        </div>
      )}

      {error && !loading && (
        <div className="border border-rose-200 rounded-lg bg-rose-50 px-4 py-3 text-[13px] text-rose-700 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {payload && (
        <>
          {/* Channel-with-missing-themes warning */}
          {payload.channelsMissingThemes.length > 0 && (
            <div className="mb-4 border border-amber-200 bg-amber-50 rounded-md px-3 py-2 text-[12px] text-amber-800">
              <div className="font-medium mb-1">
                Themes unavailable for some channels
              </div>
              <ul className="space-y-0.5 text-[11px]">
                {payload.channelsMissingThemes.map((m) => (
                  <li key={m.channelKey}>
                    <span className="font-mono">{m.channelKey}</span> —{' '}
                    <span className="text-amber-700">{m.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Common theme picker */}
          <div className="border border-slate-200 rounded-lg bg-white px-4 py-3 mb-4">
            <div className="flex items-baseline justify-between gap-2 mb-2">
              <label className="text-[12px] font-medium text-slate-700">
                Common theme (applies to every selected channel)
              </label>
              {payload.commonThemes.length === 0 && (
                <span className="text-[10px] uppercase tracking-wide text-amber-700">
                  No theme common to all channels
                </span>
              )}
            </div>
            <select
              value={commonTheme ?? ''}
              onChange={(e) => setCommonTheme(e.target.value || null)}
              className="w-full h-8 px-2 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
              disabled={payload.commonThemes.length === 0}
            >
              {payload.commonThemes.length === 0 ? (
                <option value="">— No common themes —</option>
              ) : (
                <>
                  <option value="">— Select common theme —</option>
                  {payload.commonThemes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label} ({t.id})
                    </option>
                  ))}
                </>
              )}
            </select>
            {commonTheme && (
              <p className="mt-1.5 text-[11px] text-slate-500">
                Required per variation:{' '}
                <span className="font-mono">
                  {payload.commonThemes
                    .find((t) => t.id === commonTheme)
                    ?.requiredAttributes.join(', ') ?? '—'}
                </span>
              </p>
            )}
          </div>

          {/* Per-channel overrides */}
          {channelKeys.length > 1 && (
            <div className="mb-4 border border-slate-200 rounded-lg bg-white">
              <button
                type="button"
                onClick={() => setOverridesExpanded((s) => !s)}
                className="w-full flex items-center justify-between gap-2 px-4 py-2 text-[12px] text-slate-700 hover:bg-slate-50"
              >
                <span className="inline-flex items-center gap-1.5">
                  {overridesExpanded ? (
                    <ChevronDown className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5" />
                  )}
                  <span className="font-medium">
                    Override theme per channel
                  </span>
                  {Object.keys(themeByChannel).length > 0 && (
                    <span className="text-[10px] font-medium text-blue-700 bg-blue-50 px-1 py-0.5 rounded">
                      {Object.keys(themeByChannel).length}
                    </span>
                  )}
                </span>
                <span className="text-[11px] text-slate-400">
                  {channelKeys.length} channels
                </span>
              </button>
              {overridesExpanded && (
                <div className="border-t border-slate-100 px-4 py-3 space-y-2">
                  {channelKeys.map((channelKey) => {
                    const themes = payload.themesByChannel[channelKey] ?? []
                    const overrideValue = themeByChannel[channelKey] ?? ''
                    const inherits = !overrideValue
                    return (
                      <div
                        key={channelKey}
                        className="flex items-center gap-2"
                      >
                        <span className="text-[11px] font-mono text-slate-600 w-24 flex-shrink-0">
                          {channelKey}
                        </span>
                        <select
                          value={overrideValue}
                          onChange={(e) => {
                            const v = e.target.value
                            setThemeByChannel((prev) => {
                              const next = { ...prev }
                              if (!v) delete next[channelKey]
                              else next[channelKey] = v
                              return next
                            })
                          }}
                          disabled={themes.length === 0}
                          className="flex-1 h-7 px-2 text-[12px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
                        >
                          <option value="">
                            {inherits && commonTheme
                              ? `Inherits common: ${commonTheme}`
                              : '— No override —'}
                          </option>
                          {themes.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.label} ({t.id})
                            </option>
                          ))}
                        </select>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Children list */}
          <div className="border border-slate-200 rounded-lg bg-white">
            <div className="px-3 py-2 border-b border-slate-200 flex items-center justify-between text-[12px]">
              <span className="text-slate-700">
                <span className="font-medium">{includedSkus.size}</span> of{' '}
                {payload.children.length} variations included
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={onSelectAll}
                  className="text-blue-600 hover:underline"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={onSelectNone}
                  className="text-slate-500 hover:text-slate-700 hover:underline"
                >
                  Select none
                </button>
              </div>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              {childrenWithLiveAnnotations.length === 0 ? (
                <div className="px-3 py-6 text-[12px] text-slate-500 text-center">
                  No children found. Add variations on the master product
                  before listing.
                </div>
              ) : (
                childrenWithLiveAnnotations.map((c) => {
                  const included = includedSkus.has(c.sku)
                  const blockingChannels = Object.entries(c.missingByChannel)
                    .filter(([, missing]) => missing.length > 0)
                    .map(([channelKey, missing]) => ({ channelKey, missing }))
                  const hasBlocking = included && blockingChannels.length > 0
                  return (
                    <label
                      key={c.id}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2 border-b border-slate-100 last:border-b-0 cursor-pointer hover:bg-slate-50',
                        hasBlocking && 'bg-amber-50/40 hover:bg-amber-50/70',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={included}
                        onChange={() => onToggleSku(c.sku)}
                        className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-[12px] text-slate-900 truncate">
                          {c.sku}
                        </div>
                        <div className="text-[11px] text-slate-500 truncate">
                          {Object.keys(c.attributes).length === 0
                            ? '(no attributes set)'
                            : Object.entries(c.attributes)
                                .map(([k, v]) => `${k}: ${v}`)
                                .join(' · ')}
                        </div>
                      </div>
                      <div className="text-[11px] text-slate-500 tabular-nums whitespace-nowrap">
                        €{c.price.toFixed(2)} · {c.stock}
                      </div>
                      {hasBlocking && (
                        <div className="flex flex-col gap-0.5 items-end">
                          {blockingChannels.slice(0, 2).map((b) => (
                            <span
                              key={b.channelKey}
                              className="text-[10px] font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded font-mono"
                              title={`Missing for ${b.channelKey}: ${b.missing.join(', ')}`}
                            >
                              {b.channelKey}: −{b.missing.length}
                            </span>
                          ))}
                          {blockingChannels.length > 2 && (
                            <span className="text-[10px] text-amber-600">
                              +{blockingChannels.length - 2} more
                            </span>
                          )}
                        </div>
                      )}
                    </label>
                  )
                })
              )}
            </div>
          </div>

          <div className="mt-6 flex items-center justify-between gap-3">
            <ContinueStatus
              commonTheme={commonTheme}
              channelKeys={channelKeys}
              includedCount={includedChildren.length}
              blockingCount={blockingChildren.length}
              hasChildren={payload.children.length > 0}
            />
            <button
              type="button"
              onClick={onContinue}
              disabled={
                !payload ||
                (payload.children.length > 0 &&
                  (includedChildren.length === 0 ||
                    blockingChildren.length > 0))
              }
              className={cn(
                'h-8 px-4 rounded-md text-[13px] font-medium',
                !payload ||
                  (payload.children.length > 0 &&
                    (includedChildren.length === 0 ||
                      blockingChildren.length > 0))
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  : 'bg-blue-600 text-white hover:bg-blue-700',
              )}
            >
              Continue
            </button>
          </div>
        </>
      )}
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
    return <span className="text-[12px] text-slate-500">No variations</span>
  }
  if (includedCount === 0) {
    return (
      <span className="text-[12px] text-amber-700">
        Pick at least one variation
      </span>
    )
  }
  if (blockingCount > 0) {
    return (
      <span className="text-[12px] text-amber-700">
        {blockingCount} variation{blockingCount === 1 ? '' : 's'} missing
        attributes for the selected theme
      </span>
    )
  }
  if (!commonTheme && channelKeys.length > 0) {
    return (
      <span className="text-[12px] text-slate-500">
        {includedCount} included — pick a theme to continue
      </span>
    )
  }
  return (
    <span className="text-[12px] text-emerald-700 inline-flex items-center gap-1.5">
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
    includedSkus: string[]
    channelKeys: string[]
  },
): Promise<void> {
  // Base slice: commonTheme + themeByChannel + includedSkus.
  const basePatch = {
    state: {
      variations: {
        commonTheme: args.commonTheme,
        themeByChannel: args.themeByChannel,
        includedSkus: args.includedSkus,
      },
    },
  }
  // Per-channel slice: theme that should be used for that channel
  // (override or inherited common). Stored under
  // channelStates[key].variations.theme so submission services can
  // read a single field per channel without reconciling.
  const channelStates: Record<string, Record<string, unknown>> = {}
  for (const channelKey of args.channelKeys) {
    const effective = args.themeByChannel[channelKey] || args.commonTheme || null
    if (effective) {
      channelStates[channelKey] = {
        variations: { theme: effective },
      }
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
