/**
 * H.7 — AI providers + spend dashboard.
 *
 * Server-fetched first paint (no spinner on the rollups), then the
 * client refreshes via SWR-style polling so the recent-calls tail
 * stays live as new AI calls fire.
 */

import { getBackendUrl } from '@/lib/backend-url'
import AiUsageClient from './AiUsageClient'
import AiPromptsClient, { type PromptTemplateRow } from './AiPromptsClient'
import AiWizardTemplatesClient, {
  type WizardTemplateRow,
} from './AiWizardTemplatesClient'
import AiBrandVoicesClient, {
  type BrandVoiceRow,
} from './AiBrandVoicesClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function AiSettingsPage() {
  const backend = getBackendUrl()

  // AI-1.7 + AI-1.8 + AI-2.5 + WT.5 — providers + budget posture +
  // per-wizard ROI + prompt templates + wizard templates round-trip
  // together. First paint renders every card without a client spinner.
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

  return (
    <div className="space-y-6">
      <AiUsageClient
        providers={providers}
        killSwitch={killSwitch}
        summary7={summary7}
        summary30={summary30}
        recent={recent}
        posture={posture}
        topWizards={topWizards}
      />
      <AiPromptsClient initialRows={prompts} />
      <AiBrandVoicesClient initialRows={brandVoices} />
      <AiWizardTemplatesClient initialRows={wizardTemplates} />
    </div>
  )
}
