/**
 * Phase A — Amazon Advertising endpoint probe console.
 *
 * Operator-only diagnostic surface. Lists every connected profile,
 * fires 12+ probes against Amazon for the selected profile, and
 * renders a pass/fail report so we can determine the right migration
 * path (v3 direct list vs Exports v1) before writing production code.
 *
 * Manual-trigger only. Server-rendered profile picker + client probe runner.
 */

import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { ProbeRunnerClient } from './ProbeRunnerClient'
import { getBackendUrl } from '@/lib/backend-url'
import { Stethoscope } from 'lucide-react'

export const metadata: Metadata = { title: 'Amazon Ads · Debug Console' }
export const dynamic = 'force-dynamic'

interface ProfileRow {
  profileId: string
  marketplace: string
  region: string
  accountLabel: string | null
  mode: string
  isActive: boolean
}

async function fetchProfiles(): Promise<ProfileRow[]> {
  try {
    const res = await fetch(
      `${getBackendUrl()}/api/advertising/debug/probe-endpoints/profiles`,
      { cache: 'no-store' },
    )
    if (!res.ok) return []
    const data = (await res.json()) as { items: ProfileRow[] }
    return data.items
  } catch {
    return []
  }
}

export default async function ProbeConsolePage() {
  const profiles = await fetchProfiles()
  return (
    <div className="px-4 py-4">
      <div className="mb-3">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
          <Stethoscope className="h-5 w-5 text-purple-500" aria-hidden />
          Endpoint Probe Console
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Phase A diagnostic. Pick a profile, fire the 12-variant probe suite,
          and inspect which Amazon endpoint shape the LWA token can actually
          access. No DB writes; each run costs ~12 Amazon requests.
        </p>
      </div>
      <AdvertisingNav />

      <Suspense fallback={<div className="text-sm text-tertiary">Loading…</div>}>
        <ProbeRunnerClient profiles={profiles} backendUrl={getBackendUrl()} />
      </Suspense>
    </div>
  )
}
