'use client'

/**
 * ⛔ PARKED 2026-08-20 (FB.3c) — UNMOUNTED, on operator instruction: "I think it could be done
 * better, or there is no need for it." The section wrote nothing, duplicated the grid's Ceiling
 * column and the `capped` tile, and ignored the page scope while claiming to be "in scope". Its
 * one unique reading — base-bid-at-cap — moved into the campaigns grain's Ceiling filter
 * ("Base at cap"), where it is scoped and one click from the rows. File kept per the section's
 * parking convention; register: docs/2026-08-20-ra-w-series.md (FB.3c).
 *
 * RD.P5 — guardrails & scope ceilings: the refusal made visible.
 *
 * The CPC ceiling has been refusing writes for weeks and its entire response was `logger.warn`
 * every 15 minutes — an existing refusal, invisible. This section AGGREGATES what the grid's
 * CeilingCell shows per row: on how many campaigns the ceiling (not the target) is deciding the
 * placement, and on how many the BASE BID ALONE already exceeds it — where no multiplier can
 * rescue the lane and the schedule is decorative until someone moves the bid or the cap.
 *
 * The spend-ceiling half of the operator's ask lives on Automations → Limits (one owner: the
 * values are set there, the gate enforces them everywhere) — this section says so instead of
 * growing a second editor.
 */
import Link from 'next/link'
import { AlertTriangle, ExternalLink, Ruler } from 'lucide-react'
import { useRdData } from './_rd/RdData'
import { RdSection } from './_rd/RdSection'

const eur = (c: number) => `€${(c / 100).toFixed(2)}`

export function RdCeilings() {
  const { campaigns } = useRdData()
  const withCeiling = campaigns.filter((c) => c.runtime.ceiling != null)
  if (withCeiling.length === 0) return null
  const binding = withCeiling.filter((c) => c.runtime.ceiling!.binding)
  const baseAlone = withCeiling.filter((c) => c.runtime.ceiling!.baseAlone)

  return (
    <RdSection id="p5">
      <div className="rd-p5">
        <h3><Ruler size={14} aria-hidden /> The CPC ceiling — who it is deciding for</h3>
        <p className="rd-p5-line">
          {withCeiling.length} campaign{withCeiling.length === 1 ? '' : 's'} in scope carry a ceiling ·{' '}
          <b className={binding.length > 0 ? 'warn' : ''}>{binding.length} where the ceiling, not the target, is deciding the placement</b>
          {baseAlone.length > 0 && (
            <> · <b className="bad">{baseAlone.length} where the base bid alone already exceeds it</b> — no
            multiplier can rescue that lane; the schedule is decorative there until the bid or the cap moves</>
          )}.
        </p>
        {baseAlone.length > 0 && (
          <ul className="rd-p5-list">
            {baseAlone.slice(0, 5).map((c) => (
              <li key={c.campaignId}>
                <AlertTriangle size={12} aria-hidden />
                <b>{c.campaignName}</b> — base bid {c.runtime.ceiling!.maxBaseBidCents != null ? eur(c.runtime.ceiling!.maxBaseBidCents) : '?'} against a {c.runtime.ceiling!.maxCpcCents != null ? eur(c.runtime.ceiling!.maxCpcCents) : '?'} cap
              </li>
            ))}
            {baseAlone.length > 5 && <li className="more">…and {baseAlone.length - 5} more — sort the grid by its Ceiling column.</li>}
          </ul>
        )}
        <p className="rd-p5-foot">
          Spend ceilings per market · portfolio · line · campaign are set on{' '}
          <Link href="/marketing/ads/rules-automation/automations?view=limits">Automations → Limits <ExternalLink size={11} aria-hidden /></Link>{' '}
          and refuse at the write gate account-wide — one owner, no second editor here.
        </p>
      </div>
    </RdSection>
  )
}
