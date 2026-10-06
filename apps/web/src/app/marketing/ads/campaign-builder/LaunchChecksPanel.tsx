'use client'

/**
 * W2-B (CC-13, CC-14, CC-21) — the review step's checks, shown before Launch on every builder.
 *
 * Refusals (danger): Amazon would refuse the launch, or it could not work — Launch stays off until they are fixed.
 * Warnings (warning): his own settings (bid policies, spend ceilings) and Nexus's per-write cap — they never stop it.
 */
import { Banner } from '@/design-system/components'
import type { LaunchChecks } from './launchChecks'
import './builder-ds.css'

export function LaunchChecksPanel({ checks, checking }: { checks: LaunchChecks | null; checking?: boolean }) {
  if (!checks) return checking ? <p className="cb-checks-wait" role="status">Checking the launch…</p> : null
  if (!checks.refusals.length && !checks.warnings.length) return null
  return (
    <div className="cb-checks">
      {checks.refusals.length > 0 && (
        <Banner tone="danger" title="Fix this before launching">
          <ul>{checks.refusals.map((r) => <li key={r}>{r}</li>)}</ul>
        </Banner>
      )}
      {checks.warnings.length > 0 && (
        <Banner tone="warning" title="Your settings — you can still launch">
          <ul>{checks.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </Banner>
      )}
    </div>
  )
}
