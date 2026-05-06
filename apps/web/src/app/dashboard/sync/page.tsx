/**
 * H.13 — sync health dashboard.
 *
 * Server fetches the consolidated rollup so first paint is fully
 * populated; the client polls every 30s for live counts.
 *
 * Distinct from /dashboard/health (which covers marketplace vitals +
 * conflict resolution). This page is operationally tighter: queue
 * depth, per-channel sync status, recent errors. Use it when
 * something feels off and you need to triage in one screen.
 */

import { getBackendUrl } from '@/lib/backend-url'
import SyncHealthClient from './SyncHealthClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function SyncHealthPage() {
  const res = await fetch(`${getBackendUrl()}/api/dashboard/health`, {
    cache: 'no-store',
  })
  const initial = res.ok ? await res.json() : null
  return <SyncHealthClient initial={initial} />
}
