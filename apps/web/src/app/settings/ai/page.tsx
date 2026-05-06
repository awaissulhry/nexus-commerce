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

  const [providersRes, summary7Res, summary30Res, recentRes] =
    await Promise.all([
      fetch(`${backend}/api/ai/providers`, { cache: 'no-store' }),
      fetch(`${backend}/api/ai/usage/summary?days=7`, { cache: 'no-store' }),
      fetch(`${backend}/api/ai/usage/summary?days=30`, { cache: 'no-store' }),
      fetch(`${backend}/api/ai/usage/recent?limit=50`, { cache: 'no-store' }),
    ])

  const providers = providersRes.ok
    ? (await providersRes.json()).providers ?? []
    : []
  const summary7 = summary7Res.ok ? await summary7Res.json() : null
  const summary30 = summary30Res.ok ? await summary30Res.json() : null
  const recent = recentRes.ok ? (await recentRes.json()).rows ?? [] : []

  return (
    <AiUsageClient
      providers={providers}
      summary7={summary7}
      summary30={summary30}
      recent={recent}
    />
  )
}
