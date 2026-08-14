'use client'

/**
 * Bare /builder (no type) — the "Select a Rule Type" chooser as its own page.
 *
 * It used to redirect to the section index, whose "+ Rule" button opened this modal; the index
 * now 308s to /apply-rules (landing decision, 2026-08-15), so the chooser lives at the URL every
 * "Rule" button already links to. Close lands on Automations — the rule catalogue — rather than
 * `router.back()`, which is a no-op on a direct load with no history.
 */
import { useRouter } from 'next/navigation'
import { RuleTypeModal } from '../_shared/RuleTypeModal'

export default function Page() {
  const router = useRouter()
  return <RuleTypeModal onClose={() => router.push('/marketing/ads/rules-automation/automations')} />
}
