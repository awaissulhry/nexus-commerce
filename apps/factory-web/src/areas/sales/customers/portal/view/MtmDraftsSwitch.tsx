'use client'

import { Toggle } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'

/**
 * F-CP-155 (customer page plan C5; review F1; lead pick D15: made-to-measure drafts ON for every customer; the API's B-CP-078
 * `PortalSettings.mtmDraftsOn`) — "Made-to-measure drafts" on a customer's Portal card, beside "Portal on": the customer's people may
 * keep made-to-measure lines in their portal drafts (accepted, such a draft becomes a quote first: GATE-MTM). On by default; the office
 * may switch one customer off. It rides the Portal card's own Save (POST /partners/:id/settings with the stored version and a fresh
 * code, as every portal switch): no second save path. Held in words as the card's other switches are. Draws only (no fetch).
 */
export function MtmDraftsSwitch(props: { checked: boolean; held: string | null; customer: string; onChange: (next: boolean) => void }) {
  return (
    <WithMessages namespaces={['parties']}>
      <Switch {...props} />
    </WithMessages>
  )
}

function Switch({ checked, held, customer, onChange }: { checked: boolean; held: string | null; customer: string; onChange: (next: boolean) => void }) {
  const p = useT('parties')
  return (
    <div className="fw-pa-switch">
      <Toggle checked={checked} onChange={onChange} disabled={held !== null} aria-label={p('customers.designer.mtm.label')} aria-describedby="fw-pa-mtm-hint" />
      <div className="fw-pa-switch-text">
        <span className="fw-pa-strong">{p('customers.designer.mtm.label')}</span>
        <span id="fw-pa-mtm-hint" className="fw-pa-hint">
          {held ?? p(checked ? 'customers.designer.mtm.onHint' : 'customers.designer.mtm.offHint', { customer })}
        </span>
      </div>
    </div>
  )
}
