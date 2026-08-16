/**
 * Bid — the Rules & Automation tab for bid rules.
 *
 * U1 (2026-08-16) — this route now mounts `BidRulesClient`: page header · tab bar · ONE rules card,
 * which is what Helium 10's Bid tab is (study `docs/2026-08-16-ra-h10-reference-study.md` §3.2).
 *
 * `BidClient` — the fifteen-block page this replaced (bidder band, census strip, targets/campaigns
 * grid, bounds, activity, staged tray, target drawer, goal dialog) — is PARKED, not deleted: the
 * files sit untouched beside this one, each with a PARKED header, and the manifest
 * `docs/2026-08-16-ra-parked-sections.md` names where each section is headed (Analytics ·
 * Suggestions · Ad Manager). Re-mounting any of them is one import.
 *
 * Suspense stays: the client reads `useSearchParams`.
 */
import { Suspense } from 'react'
import { BidRulesClient } from './BidRulesClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <BidRulesClient />
    </Suspense>
  )
}
