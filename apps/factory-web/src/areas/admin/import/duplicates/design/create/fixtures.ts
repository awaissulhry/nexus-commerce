import { createElement } from 'react'
import { Card } from '@nexus/ui/components'
import { defineDesignScreen } from '../../../../../../lib/design/design-screen'
import { inShell } from '../../../../shared/fixtures'
import type { DuplicateCandidate } from '../../api'
import { BIANCHI, NAPPA, NAPPA_OLD, PREFIX, ROSSI, ROSSI_VAT } from '../../demo'
import { DuplicateWarning } from '../../view/parts'

/**
 * SCR-623 — The duplicate warning on create (B-W2b-427; design customers.new and materials.new "Duplicate warning"):
 * what New customer, New supplier and New material show under the fields as they are typed. A same VAT number is said as
 * what it is (the create is refused: one record per business partner). Made-up records.
 */

interface CreateCase {
  readonly recordType: 'PARTY' | 'MATERIAL'
  readonly candidates: readonly DuplicateCandidate[] | null
}

function CreateDesign({ model }: { model: CreateCase }) {
  return inShell(model.recordType === 'PARTY' ? '/sales/customers' : '/products/materials', createElement(Card, { padded: true }, createElement(DuplicateWarning, { candidates: model.candidates, prefix: PREFIX, recordType: model.recordType })))
}

export const designScreen = defineDesignScreen<CreateCase>({
  screen: 'SCR-623',
  title: 'Duplicate warning on create',
  view: CreateDesign,
  cases: [
    { id: 'party-name', label: 'New customer: the same name and mail domain', model: { recordType: 'PARTY', candidates: [ROSSI, BIANCHI] }, note: 'Each record opens in a new tab (the draft stays); the hint says a second record splits orders and credit, and that a merge is possible later.' },
    { id: 'party-vat', label: 'New customer: the VAT number belongs to a party', model: { recordType: 'PARTY', candidates: [ROSSI_VAT] }, note: 'The create would be refused: open that party and give it the role it lacks.' },
    { id: 'material', label: 'New material: the same code and supplier code', model: { recordType: 'MATERIAL', candidates: [NAPPA, NAPPA_OLD] } },
    { id: 'none', label: 'Nothing looks alike (the warning is absent)', model: { recordType: 'PARTY', candidates: [] } },
  ],
})
