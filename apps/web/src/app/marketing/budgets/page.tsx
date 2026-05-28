/**
 * UM-series (P7) — Unified Marketing OS · Budget command center.
 *
 * Cross-channel budget pools on CampaignBudget. Create pools, allocate
 * campaigns (any channel), preview a rebalance (current → proposed diff,
 * FX-normalized), and apply it through the guarded mutation path. Guardrails
 * (strategy, cooldown, max-shift %, dry-run) are first-class.
 */

import type { Metadata } from 'next'
import { BudgetCenterClient, type BudgetPool } from './BudgetCenterClient'
import { getBackendUrl } from '@/lib/backend-url'

export const metadata: Metadata = { title: 'Marketing · Budgets' }
export const dynamic = 'force-dynamic'

export default async function MarketingBudgetsPage() {
  let pools: BudgetPool[] = []
  try {
    const res = await fetch(`${getBackendUrl()}/api/marketing/os/budgets`, { cache: 'no-store' })
    if (res.ok) pools = (await res.json()).items ?? []
  } catch {
    // empty
  }
  return <BudgetCenterClient initialPools={pools} />
}
