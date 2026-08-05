/**
 * ACR.6 (Stage 6) — what is left of the Advertising workspace.
 *
 * This tree is retired: 39 of its 41 routes now 308 into /marketing/ads (see the redirect block in
 * next.config.js and the retirement map in docs/2026-08-05-ads-control-room-coverage-acr.md). The
 * grouped sidebar that used to live here went with them — it navigated to pages that no longer
 * exist, and a rail whose every entry is a redirect is worse than no rail.
 *
 * Two routes survive: `ngrams` and `funnel`. Both are interpretation surfaces that a standing
 * operator decision (2026-08-04, recorded in the Reporting client) assigns to Analytics, and
 * Analytics belongs to another workstream. They keep working at their current URLs, reachable by
 * link, until that owner takes them — at which point this directory goes too.
 */
import type { ReactNode } from 'react'

export default function AdvertisingLayout({ children }: { children: ReactNode }) {
  return <div className="min-w-0">{children}</div>
}
