'use client'

/**
 * UM-series — client-side data loader for the campaign detail page.
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so server-side fetches 401'd and the
 * page notFound()'d for every campaign. Data MUST load client-side where
 * the fetch patch adds credentials.
 */

import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import { CampaignDetailClient, type CampaignDetail, type ActionsBundle } from './CampaignDetailClient'
import { getBackendUrl } from '@/lib/backend-url'

export function CampaignDetailLoader({ id }: { id: string }) {
  const [state, setState] = useState<{ campaign: CampaignDetail | null; actions: ActionsBundle } | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      const base = getBackendUrl()
      let campaign: CampaignDetail | null = null
      let actions: ActionsBundle = { actions: [], metrics: [] }
      try {
        const [cRes, aRes] = await Promise.all([
          fetch(`${base}/api/marketing/os/campaigns/${id}`, { cache: 'no-store' }),
          fetch(`${base}/api/marketing/os/campaigns/${id}/actions`, { cache: 'no-store' }),
        ])
        if (cRes.ok) campaign = await cRes.json()
        if (aRes.ok) actions = await aRes.json()
      } catch {
        // fall through
      }
      if (alive) setState({ campaign, actions })
    }
    void load()
    return () => { alive = false }
  }, [id])

  if (!state) {
    return (
      <div className="p-4 sm:p-6 max-w-[1100px] mx-auto" aria-busy="true">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Campaign</h1>
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 rounded-lg border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
          ))}
        </div>
      </div>
    )
  }
  if (!state.campaign) notFound()
  return <CampaignDetailClient campaign={state.campaign} initialActions={state.actions} />
}
