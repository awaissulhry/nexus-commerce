'use client'

/**
 * AI-2.3 — per-feature model selection UI.
 *
 * Renders the live model catalog (GET /api/ai/models) + the per-feature
 * prefs overview (GET /api/ai/feature-prefs) as:
 *   - a Global default selector (applies to any feature without its own
 *     pick), and
 *   - a dense per-feature table, each row a provider+model dropdown
 *     populated from the catalog, with the per-1M cost of the effective
 *     model and a reset-to-default control.
 *
 * Selecting a model PUTs the pref; choosing "Use default" DELETEs it.
 * Both endpoints return the refreshed overview, so the table reflects
 * the new effective resolution immediately. Models the providers expose
 * are discovered live, so a model that ships next month shows up here
 * after a Refresh with no code change. English-only by design (operator
 * surface).
 */

import { useCallback, useMemo, useState } from 'react'
import { Cpu, RefreshCw, Loader2, RotateCcw, KeyRound } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Listbox, type ListboxOption } from '@/design-system/components/Listbox'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'

type ProviderName = 'gemini' | 'anthropic'

interface CatalogModel {
  provider: ProviderName
  id: string
  displayName: string
  inputPer1M: number
  outputPer1M: number
  costEstimated: boolean
  isDefault: boolean
}
interface ProviderCatalog {
  provider: ProviderName
  configured: boolean
  models: CatalogModel[]
  error?: string
}
export interface ModelCatalog {
  killSwitch: boolean
  providers: ProviderCatalog[]
}
interface Pref {
  provider: string
  model: string
}
interface FeatureRow {
  key: string
  label: string
  description: string
  lockedProvider?: string | null
  override: Pref | null
  effective: { provider: string; model: string } | null
}
export interface PrefsOverview {
  killSwitch: boolean
  activeProvider: string | null
  global: Pref | null
  features: FeatureRow[]
}

const PROVIDER_LABEL: Record<string, string> = {
  gemini: 'Google Gemini',
  anthropic: 'Anthropic Claude',
}
const DEFAULT_VALUE = '__default__'
const prefValue = (p: Pref | null): string =>
  p ? `${p.provider}:${p.model}` : DEFAULT_VALUE
const fmtPrice = (m: CatalogModel): string =>
  `$${m.inputPer1M}/$${m.outputPer1M}${m.costEstimated ? ' est' : ''}`

export default function AiModelsClient({
  initialCatalog,
  initialPrefs,
}: {
  initialCatalog: ModelCatalog | null
  initialPrefs: PrefsOverview | null
}) {
  const backend = getBackendUrl()
  const [catalog, setCatalog] = useState<ModelCatalog | null>(initialCatalog)
  const [prefs, setPrefs] = useState<PrefsOverview | null>(initialPrefs)
  const [refreshing, setRefreshing] = useState(false)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const configured = useMemo(
    () => (catalog?.providers ?? []).filter((p) => p.configured && p.models.length),
    [catalog],
  )
  // provider:id → model, for cost lookups of the effective pick.
  const byId = useMemo(() => {
    const m = new Map<string, CatalogModel>()
    for (const p of catalog?.providers ?? [])
      for (const mod of p.models) m.set(`${mod.provider}:${mod.id}`, mod)
    return m
  }, [catalog])

  const refreshModels = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const r = await fetch(`${backend}/api/ai/models?refresh=1`, {
        cache: 'no-store',
      })
      if (r.ok) setCatalog((await r.json()) as ModelCatalog)
      else setError('Could not refresh the model list.')
    } catch {
      setError('Could not refresh the model list.')
    } finally {
      setRefreshing(false)
    }
  }, [backend])

  const setPref = useCallback(
    async (featureKey: string, value: string) => {
      setSavingKey(featureKey)
      setError(null)
      try {
        let res: Response
        if (value === DEFAULT_VALUE) {
          res = await fetch(`${backend}/api/ai/feature-prefs/${featureKey}`, {
            method: 'DELETE',
          })
        } else {
          const idx = value.indexOf(':')
          const provider = value.slice(0, idx)
          const model = value.slice(idx + 1)
          res = await fetch(`${backend}/api/ai/feature-prefs/${featureKey}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider, model }),
          })
        }
        const json = await res.json().catch(() => null)
        if (!res.ok) {
          setError(json?.error ?? 'Could not save the selection.')
          return
        }
        setPrefs(json as PrefsOverview)
      } catch {
        setError('Could not save the selection.')
      } finally {
        setSavingKey(null)
      }
    },
    [backend],
  )

  const killSwitch = prefs?.killSwitch || catalog?.killSwitch
  const anthropicMissing = (catalog?.providers ?? []).some(
    (p) => p.provider === 'anthropic' && !p.configured,
  )

  return (
    <section className="space-y-2">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-md font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider inline-flex items-center gap-1.5">
            <Cpu className="w-3 h-3" />
            Model selection
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-2xl">
            Choose which model each AI feature uses. Resolution is{' '}
            <span className="font-medium">per-feature</span> →{' '}
            <span className="font-medium">global default</span> →{' '}
            <span className="font-medium">provider default</span>. Models are
            discovered live from each provider — Refresh to pick up new ones.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshModels()}
          disabled={refreshing}
          className="h-8 px-3 text-base border border-default dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 disabled:opacity-50 flex-shrink-0"
        >
          {refreshing ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          Refresh models
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-800 dark:text-rose-200"
        >
          {error}
        </div>
      )}

      {anthropicMissing && (
        <div className="border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 rounded-md px-3 py-2 text-sm text-amber-800 dark:text-amber-200 inline-flex items-center gap-1.5">
          <KeyRound className="w-3.5 h-3.5 flex-shrink-0" />
          Set <span className="font-mono">ANTHROPIC_API_KEY</span> on the API
          host to make Claude models selectable here.
        </div>
      )}

      {configured.length === 0 ? (
        <div className="border border-default dark:border-slate-700 rounded-md p-4 bg-white dark:bg-slate-900 text-base text-slate-500 dark:text-slate-400">
          No AI providers are configured. Set{' '}
          <span className="font-mono">GEMINI_API_KEY</span> or{' '}
          <span className="font-mono">ANTHROPIC_API_KEY</span> on the API host,
          then Refresh.
        </div>
      ) : (
        <>
          {/* Global default */}
          <div className="border border-default dark:border-slate-700 rounded-md p-3 bg-slate-50/60 dark:bg-slate-900">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-lg font-medium text-slate-900 dark:text-slate-100">
                  Global default
                </div>
                <div className="text-sm text-slate-500 dark:text-slate-400">
                  Used by every feature without its own selection below.
                </div>
              </div>
              <ModelSelect
                ariaLabel="Global default model"
                value={prefValue(prefs?.global ?? null)}
                providers={configured}
                disabled={savingKey === '__global__'}
                onChange={(v) => void setPref('__global__', v)}
              />
            </div>
          </div>

          {/* Per-feature table */}
          <div className="border border-default dark:border-slate-700 rounded-md overflow-hidden bg-white dark:bg-slate-900">
            <table className="w-full text-base">
              <thead>
                <tr className="border-b border-default dark:border-slate-700 text-sm text-slate-500 dark:text-slate-400 text-left">
                  <th className="px-3 py-2 font-medium">Feature</th>
                  <th className="px-3 py-2 font-medium">Model</th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">
                    Cost / 1M
                  </th>
                  <th className="px-3 py-2 font-medium w-8" />
                </tr>
              </thead>
              <tbody>
                {(prefs?.features ?? []).map((f) => {
                  const effModel = f.effective
                    ? byId.get(`${f.effective.provider}:${f.effective.model}`)
                    : undefined
                  const overridden = f.override != null
                  return (
                    <tr
                      key={f.key}
                      className="border-b border-subtle dark:border-slate-800 last:border-0 align-top"
                    >
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-900 dark:text-slate-100">
                          {f.label}
                        </div>
                        <div className="text-sm text-slate-500 dark:text-slate-400 max-w-md">
                          {f.description}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {f.lockedProvider ? (
                          <div className="text-sm text-slate-500 dark:text-slate-400 flex items-center gap-2 flex-wrap">
                            <span className="inline-flex items-center gap-1 border border-default dark:border-slate-700 rounded px-1.5 py-0.5">
                              {PROVIDER_LABEL[f.lockedProvider] ?? f.lockedProvider} only
                            </span>
                            {f.effective && (
                              <span className="font-mono">{f.effective.model}</span>
                            )}
                          </div>
                        ) : (
                          <>
                            <ModelSelect
                              ariaLabel={`Model for ${f.label}`}
                              value={prefValue(f.override)}
                              providers={configured}
                              extraModel={
                                // keep a stored override visible even if the
                                // provider/model fell out of the live catalog
                                overridden && !byId.has(prefValue(f.override))
                                  ? f.override
                                  : null
                              }
                              disabled={savingKey === f.key}
                              onChange={(v) => void setPref(f.key, v)}
                            />
                            {!overridden && f.effective && (
                              <div className="text-sm text-tertiary dark:text-slate-500 mt-1 font-mono">
                                → {f.effective.model}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-slate-300">
                        {effModel ? (
                          <span className="font-mono text-sm">
                            {fmtPrice(effModel)}
                          </span>
                        ) : (
                          <span className="text-tertiary">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {savingKey === f.key ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-tertiary inline" />
                        ) : overridden ? (
                          <button
                            type="button"
                            title="Reset to default"
                            aria-label={`Reset ${f.label} to default`}
                            onClick={() => void setPref(f.key, DEFAULT_VALUE)}
                            className="text-tertiary hover:text-slate-700 dark:hover:text-slate-200"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {killSwitch && (
            <div className="text-sm text-amber-700 dark:text-amber-300">
              Note: the AI kill switch is on, so these selections won&apos;t run
              until it&apos;s cleared — but you can configure them now.
            </div>
          )}
        </>
      )}
    </section>
  )
}

function ModelSelect({
  value,
  providers,
  onChange,
  disabled,
  ariaLabel,
  extraModel,
}: {
  value: string
  providers: ProviderCatalog[]
  onChange: (value: string) => void
  disabled?: boolean
  ariaLabel: string
  extraModel?: Pref | null
}) {
  // Native <optgroup> flattened for Listbox: each provider group becomes a
  // disabled (non-selectable) header row followed by its models, preserving
  // the original order.
  const options: ListboxOption[] = [
    { value: DEFAULT_VALUE, label: 'Use default' },
    ...(extraModel
      ? [
          {
            value: `${extraModel.provider}:${extraModel.model}`,
            label: `${extraModel.model} (unavailable)`,
          },
        ]
      : []),
    ...providers.flatMap((p) => [
      {
        value: `__group:${p.provider}`,
        label: PROVIDER_LABEL[p.provider] ?? p.provider,
        disabled: true,
      },
      ...p.models.map((m) => ({
        value: `${m.provider}:${m.id}`,
        label: `${m.displayName} · ${fmtPrice(m)}${m.isDefault ? ' · default' : ''}`,
      })),
    ]),
  ]
  return (
    <Listbox
      ariaLabel={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={onChange}
      options={options}
      className="max-w-xs w-full"
    />
  )
}
