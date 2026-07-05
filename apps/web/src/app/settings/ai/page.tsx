'use client'

/**
 * H.7 — AI providers + spend dashboard.
 *
 * Data loads CLIENT-side: the API session cookie lives on the API origin
 * (cross-site setup), so server-side fetches can never authenticate — they
 * 401'd into empty providers/zero spend for everyone. After the initial
 * load the usage client keeps refreshing via SWR-style polling so the
 * recent-calls tail stays live as new AI calls fire.
 */

import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import AiUsageClient from './AiUsageClient'
import AiPromptsClient, { type PromptTemplateRow } from './AiPromptsClient'
import AiWizardTemplatesClient, {
  type WizardTemplateRow,
} from './AiWizardTemplatesClient'
import AiBrandVoicesClient, {
  type BrandVoiceRow,
} from './AiBrandVoicesClient'
import AiModelsClient, {
  type ModelCatalog,
  type PrefsOverview,
} from './AiModelsClient'
import AiApprovalsClient from './AiApprovalsClient'
import AiAgentsClient from './AiAgentsClient'

interface InitialData {
  providers: any[]
  killSwitch: boolean
  summary7: any
  summary30: any
  recent: any[]
  posture: any
  topWizards: any
  prompts: PromptTemplateRow[]
  wizardTemplates: WizardTemplateRow[]
  brandVoices: BrandVoiceRow[]
  modelCatalog: ModelCatalog | null
  featurePrefs: PrefsOverview | null
}

const EMPTY: InitialData = {
  providers: [],
  killSwitch: false,
  summary7: null,
  summary30: null,
  recent: [],
  posture: null,
  topWizards: null,
  prompts: [],
  wizardTemplates: [],
  brandVoices: [],
  modelCatalog: null,
  featurePrefs: null,
}

async function fetchInitialData(): Promise<InitialData> {
  const backend = getBackendUrl()

  // AI-1.7 + AI-1.8 + AI-2.5 + WT.5 — providers + budget posture +
  // per-wizard ROI + prompt templates + wizard templates round-trip
  // together. First paint renders every card without extra spinners.
  const [
    providersRes,
    summary7Res,
    summary30Res,
    recentRes,
    postureRes,
    topWizardsRes,
    promptsRes,
    wizardTemplatesRes,
    brandVoicesRes,
    modelsRes,
    featurePrefsRes,
  ] = await Promise.all([
    fetch(`${backend}/api/ai/providers`, { cache: 'no-store' }),
    fetch(`${backend}/api/ai/usage/summary?days=7`, { cache: 'no-store' }),
    fetch(`${backend}/api/ai/usage/summary?days=30`, { cache: 'no-store' }),
    fetch(`${backend}/api/ai/usage/recent?limit=50`, { cache: 'no-store' }),
    fetch(`${backend}/api/ai/usage/budget-posture`, { cache: 'no-store' }),
    fetch(`${backend}/api/ai/usage/top-wizards?days=30&limit=10`, {
      cache: 'no-store',
    }),
    fetch(`${backend}/api/ai/prompt-templates`, { cache: 'no-store' }),
    fetch(`${backend}/api/wizard-templates`, { cache: 'no-store' }),
    fetch(`${backend}/api/ai/brand-voices`, { cache: 'no-store' }),
    fetch(`${backend}/api/ai/models`, { cache: 'no-store' }),
    fetch(`${backend}/api/ai/feature-prefs`, { cache: 'no-store' }),
  ])

  const providersJson = providersRes.ok ? await providersRes.json() : null
  const providers = providersJson?.providers ?? []
  // AI-1.2 + AI-1.7 — surface the kill-switch flag returned alongside
  // providers. listProviders() now returns { killSwitch, providers }.
  const killSwitch: boolean = providersJson?.killSwitch === true
  const summary7 = summary7Res.ok ? await summary7Res.json() : null
  const summary30 = summary30Res.ok ? await summary30Res.json() : null
  const recent = recentRes.ok ? (await recentRes.json()).rows ?? [] : []
  const posture = postureRes.ok ? await postureRes.json() : null
  const topWizards = topWizardsRes.ok ? await topWizardsRes.json() : null
  const prompts: PromptTemplateRow[] = promptsRes.ok
    ? ((await promptsRes.json()).rows ?? [])
    : []
  const wizardTemplates: WizardTemplateRow[] = wizardTemplatesRes.ok
    ? ((await wizardTemplatesRes.json()).rows ?? [])
    : []
  const brandVoices: BrandVoiceRow[] = brandVoicesRes.ok
    ? ((await brandVoicesRes.json()).rows ?? [])
    : []
  const modelCatalog: ModelCatalog | null = modelsRes.ok
    ? await modelsRes.json()
    : null
  const featurePrefs: PrefsOverview | null = featurePrefsRes.ok
    ? await featurePrefsRes.json()
    : null

  return {
    providers,
    killSwitch,
    summary7,
    summary30,
    recent,
    posture,
    topWizards,
    prompts,
    wizardTemplates,
    brandVoices,
    modelCatalog,
    featurePrefs,
  }
}

export default function AiSettingsPage() {
  const [data, setData] = useState<InitialData | null>(null)

  useEffect(() => {
    let alive = true
    fetchInitialData()
      .catch(() => EMPTY) // network failure → same empties as per-response !ok fallbacks
      .then((d) => {
        if (alive) setData(d)
      })
    return () => { alive = false }
  }, [])

  if (!data) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-600" />
            AI providers + spend
          </h1>
          <p className="text-base text-slate-500 dark:text-slate-400 mt-1 max-w-2xl">
            Per-provider configuration and token + cost telemetry across
            every server-side AI call.
          </p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
          ))}
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-48 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <AiUsageClient
        providers={data.providers}
        killSwitch={data.killSwitch}
        summary7={data.summary7}
        summary30={data.summary30}
        recent={data.recent}
        posture={data.posture}
        topWizards={data.topWizards}
      />
      <AiModelsClient
        initialCatalog={data.modelCatalog}
        initialPrefs={data.featurePrefs}
      />
      <AiApprovalsClient />
      <AiAgentsClient />
      <AiPromptsClient initialRows={data.prompts} />
      <AiBrandVoicesClient initialRows={data.brandVoices} />
      <AiWizardTemplatesClient initialRows={data.wizardTemplates} />
    </div>
  )
}
