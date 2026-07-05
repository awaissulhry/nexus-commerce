/**
 * UM-series (P7) — Unified Marketing OS · Budget command center.
 *
 * Cross-channel budget pools on CampaignBudget. Create pools, allocate
 * campaigns (any channel), preview a rebalance (current → proposed diff,
 * FX-normalized), and apply it through the guarded mutation path. Guardrails
 * (strategy, cooldown, max-shift %, dry-run) are first-class.
 *
 * Pools load client-side in BudgetsLoader — the cross-site API session
 * cookie means server fetches can never authenticate. page.tsx stays a
 * server component for the metadata export.
 */

import type { Metadata } from 'next'
import { BudgetsLoader } from './BudgetsLoader'

export const metadata: Metadata = { title: 'Marketing · Budgets' }

export default function MarketingBudgetsPage() {
  return <BudgetsLoader />
}
