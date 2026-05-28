/**
 * UM-series (P3) — Unified Marketing OS · Campaign roster.
 *
 * The cross-channel cockpit's flagship surface. Server-renders the
 * roster + summary KPIs from /api/marketing/os/* (the new
 * MarketingCampaign tables, populated by the P2 shadow backfill) and
 * hands off to the client for filtering, lens tabs, sorting, and live
 * SSE refresh. Read-only in P3 — inline mutations land in P5.
 *
 * In P3 only Amazon campaigns exist (shadowed from the legacy Trading
 * Desk); eBay / Shopify / external populate as their adapters ship
 * (P9 / P11 / P12-13).
 */

import type { Metadata } from 'next'
import { MarketingCampaignsClient, type RosterCampaign, type RosterSummary } from './MarketingCampaignsClient'
import { getBackendUrl } from '@/lib/backend-url'

export const metadata: Metadata = { title: 'Marketing · Campaigns' }
export const dynamic = 'force-dynamic'

async function fetchJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`${getBackendUrl()}${path}`, { cache: 'no-store' })
    if (!res.ok) return fallback
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

export default async function MarketingCampaignsPage() {
  const [roster, summary] = await Promise.all([
    fetchJson<{ items: RosterCampaign[]; count: number; capped: boolean }>(
      '/api/marketing/os/campaigns',
      { items: [], count: 0, capped: false },
    ),
    fetchJson<RosterSummary>('/api/marketing/os/summary', {
      total: 0,
      byChannel: {},
      byStatus: {},
      spendCents: 0,
      salesCents: 0,
    }),
  ])

  return (
    <MarketingCampaignsClient
      initialCampaigns={roster.items}
      initialSummary={summary}
      initialCapped={roster.capped}
    />
  )
}
