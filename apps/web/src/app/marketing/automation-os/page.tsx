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
 *
 * Rules load client-side in AutomationStudioLoader — the cross-site API
 * session cookie means server fetches can never authenticate. page.tsx
 * stays a server component for the metadata export.
 */

import type { Metadata } from 'next'
import { AutomationStudioLoader } from './AutomationStudioLoader'

export const metadata: Metadata = { title: 'Marketing · Automation' }

export default function MarketingAutomationPage() {
  return <AutomationStudioLoader />
}
