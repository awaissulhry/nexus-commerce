'use client'

/**
 * "Select a Rule Type" modal — opened by the "+ Rule" button. 7 radio options
 * (verbatim H10 copy); Next routes to the builder for the chosen type. Shared so the
 * Keyword-Harvest session opens the same modal.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import { RULE_TYPES } from './ruleTypes'

export function RuleTypeModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [sel, setSel] = useState(RULE_TYPES[0].slug)
  const next = () => router.push(`/marketing/ads/rules-automation/builder/${sel}`)
  return (
    <div className="h10-rtm-back" onClick={onClose}>
      <div className="h10-rtm" role="dialog" aria-label="Select a Rule Type" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="h10-rtm-h">
          <b>Select a Rule Type</b>
          <button type="button" className="x" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="h10-rtm-b">
          {RULE_TYPES.map((rt) => (
            <label className={`h10-rtm-opt ${sel === rt.slug ? 'on' : ''}`} key={rt.slug}>
              <input type="radio" name="ruletype" checked={sel === rt.slug} onChange={() => setSel(rt.slug)} />
              <span className="b"><span className="t">{rt.label}</span><span className="d">{rt.desc}</span></span>
            </label>
          ))}
        </div>
        <div className="h10-rtm-f">
          <button type="button" className="cancel" onClick={onClose}>Cancel</button>
          <span className="grow" />
          <button type="button" className="next" onClick={next}>Next</button>
        </div>
      </div>
    </div>
  )
}
