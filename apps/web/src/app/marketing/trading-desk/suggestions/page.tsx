/**
 * Trading Desk — Suggestions (P3), native in the hub. Server-fetches the ranked
 * recommendation feed + the AI brief, hands off to the client inbox.
 */
import type { Metadata } from 'next'
import { getBackendUrl } from '@/lib/backend-url'
import { SuggestionsInbox } from './SuggestionsInbox'

export const metadata: Metadata = { title: 'Suggestions · Trading Desk' }
export const dynamic = 'force-dynamic'

async function getJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`${getBackendUrl()}${path}`, { cache: 'no-store' })
    if (!res.ok) return fallback
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

export default async function TradingDeskSuggestionsPage() {
  const [recs, brief] = await Promise.all([
    getJson('/api/advertising/recommendations?windowDays=30', { recommendations: [], potentialMonthlyImpactCents: 0 }),
    getJson('/api/advertising/recommendations/brief?windowDays=30', { tldr: '', modelUsed: '' }),
  ])
  return <SuggestionsInbox initial={recs} brief={brief} />
}
