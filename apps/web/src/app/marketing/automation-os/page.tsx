/**
 * UM-series (P6) — Unified Marketing OS · Automation studio.
 *
 * Cross-channel campaign automation rules (domain=marketing) on the shared
 * AutomationRule engine. Create rules, toggle enabled/dry-run, test a rule
 * (forced dry-run preview), and run the evaluator on demand. Live-with-
 * guardrails: rules default to dryRun=true; the operator graduates each to
 * live, with per-rule caps + the channel write gate as the safety net.
 *
 * Mounted at /marketing/automation-os (the legacy /marketing/automation is
 * the MC content-automation surface — kept separate until P14 retirement).
 */

import type { Metadata } from 'next'
import { AutomationStudioClient, type MarketingRule } from './AutomationStudioClient'
import { getBackendUrl } from '@/lib/backend-url'

export const metadata: Metadata = { title: 'Marketing · Automation' }
export const dynamic = 'force-dynamic'

export default async function MarketingAutomationPage() {
  let rules: MarketingRule[] = []
  try {
    const res = await fetch(`${getBackendUrl()}/api/marketing/os/rules`, { cache: 'no-store' })
    if (res.ok) rules = (await res.json()).items ?? []
  } catch {
    // empty
  }
  return <AutomationStudioClient initialRules={rules} />
}
