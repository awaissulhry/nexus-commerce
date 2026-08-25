'use client'

/**
 * "Select a Rule Type" modal — opened by the "+ Rule" button. 7 radio options
 * (verbatim H10 copy); Next routes to the builder for the chosen type. Shared so the
 * Keyword-Harvest session opens the same modal.
 *
 * B1 (2026-08-20) — `initial` seeds which radio is selected on open, nothing else. Every rule-type
 * tab's "+ Rule" now opens THIS modal rather than jumping straight to the builder (operator study
 * of H10's Bid tab: "+ Rule launches the Rule Creation Modal; from the dropdown you select Bid"),
 * and a tab that opens it already knows which type it is about. An unknown or absent slug falls
 * back to the first option, which is the behaviour every existing caller had.
 */
import { useState } from 'react'
import { Button, RadioCard, ToolbarButton } from '@/design-system/primitives'
import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import { RULE_TYPES } from './ruleTypes'

export function RuleTypeModal({ onClose, initial }: { onClose: () => void; initial?: string }) {
  const router = useRouter()
  const [sel, setSel] = useState(
    RULE_TYPES.some((rt) => rt.slug === initial) ? (initial as string) : RULE_TYPES[0].slug,
  )
  const next = () => router.push(`/marketing/ads/rules-automation/builder/${sel}`)
  return (
    <div className="h10-rtm-back" onClick={onClose}>
      <div className="h10-rtm" role="dialog" aria-label="Select a Rule Type" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="h10-rtm-h">
          <b>Select a Rule Type</b>
          <ToolbarButton icon={<X size={18} />} label="Close" tooltip={false} onClick={onClose} />
        </div>
        <div className="h10-rtm-b">
          {RULE_TYPES.map((rt) => (
            <RadioCard
              key={rt.slug} variant="row" className="h10-rtm-opt"
              name="ruletype" checked={sel === rt.slug} selected={sel === rt.slug}
              onChange={() => setSel(rt.slug)}
              title={rt.label} description={rt.desc}
            />
          ))}
        </div>
        <div className="h10-rtm-f">
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <span className="grow" />
          <Button variant="primary" onClick={next}>Next</Button>
        </div>
      </div>
    </div>
  )
}
