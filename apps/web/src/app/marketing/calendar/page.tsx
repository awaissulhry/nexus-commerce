/**
 * UM-series (P4) — Unified Marketing OS · Marketing calendar.
 *
 * Month view over CalendarEntry (operator-authored plans) + scheduled
 * MarketingCampaigns + RetailEvent background bands (demand anchors with
 * expectedLift). Click a day to plan an entry; entries reschedule via
 * PATCH. Live SSE refresh. Reads /api/marketing/os/calendar.
 */

import type { Metadata } from 'next'
import { MarketingCalendarClient, type CalendarData } from './MarketingCalendarClient'
import { getBackendUrl } from '@/lib/backend-url'

export const metadata: Metadata = { title: 'Marketing · Calendar' }
export const dynamic = 'force-dynamic'

export default async function MarketingCalendarPage() {
  let initial: CalendarData = { from: '', to: '', entries: [], retailEvents: [], campaigns: [] }
  try {
    const res = await fetch(`${getBackendUrl()}/api/marketing/os/calendar`, { cache: 'no-store' })
    if (res.ok) initial = (await res.json()) as CalendarData
  } catch {
    // fall through to empty calendar
  }
  return <MarketingCalendarClient initial={initial} />
}
