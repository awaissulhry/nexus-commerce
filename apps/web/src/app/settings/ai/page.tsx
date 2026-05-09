/**
 * H.7 — AI providers + spend dashboard.
 *
 * Server-fetched first paint (no spinner on the rollups), then the
 * client refreshes via SWR-style polling so the recent-calls tail
 * stays live as new AI calls fire.
 */

import { getBackendUrl } from '@/lib/backend-url'
import AiUsageClient from './AiUsageClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function AiSettingsPage() {
  const backend = getBackendUrl()

  // AI-1.7 — budget posture round-trip ships alongside the existing
  // providers + usage summary fetches so the first paint already
  // shows the kill-switch banner + budget-posture card without any
  // client-side spinner.
  const [providersRes, summary7Res, summary30Res, recentRes, postureRes] =
    await Promise.all([
      fetch(`${backend}/api/ai/providers`, { cache: 'no-store' }),
      fetch(`${backend}/api/ai/usage/summary?days=7`, { cache: 'no-store' }),
      fetch(`${backend}/api/ai/usage/summary?days=30`, { cache: 'no-store' }),
      fetch(`${backend}/api/ai/usage/recent?limit=50`, { cache: 'no-store' }),
      fetch(`${backend}/api/ai/usage/budget-posture`, { cache: 'no-store' }),
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

  return (
    <AiUsageClient
      providers={providers}
      killSwitch={killSwitch}
      summary7={summary7}
      summary30={summary30}
      recent={recent}
      posture={posture}
    />
  )
}
