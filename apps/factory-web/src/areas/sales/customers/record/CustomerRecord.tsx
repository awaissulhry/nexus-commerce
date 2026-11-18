'use client'

import { usePathname } from 'next/navigation'
import { WithMessages } from '../../../../record-panels/i18n'
import { usePartyRecord } from '../../../parties/_shared/PartyRecord'
import { useCustomerMoney } from '../money/hooks'
import { CUSTOMER_MONEY_NAMESPACE } from '../money/model'
import type { CustomerMoneyModel } from '../money/overview'
import { PortalAccess } from '../portal/PortalAccess'
import { CommercialTerms } from '../terms/CommercialTerms'
// B-W2b-324: Customer 360 and customers in depth (the glance, requirements, the hold, PO number, consent and personal data).
import { CustomerDepthProvider, customerDepthSlot } from '../depth/CustomerDepth'
import { CustomerRecordView } from './view/CustomerRecordView'

/**
 * `/w/<company>/sales/customers/<id>` (SCR-033): the customer's record. F-SA-270: its own view (./view/CustomerRecordView), split
 * from the supplier's; the reads, writes, live stream and docked thread are the shared hook's (areas/parties/_shared/PartyRecord.tsx
 * usePartyRecord), with the customer's Commercial terms card on Terms & requirements (B-W2a-49; SAL-012): it reads and saves the
 * terms itself and has the record read the party again after a save (the terms are the party's columns: its version moved).
 * B-W2a-81: the Overview's Overdue and Returns this year tiles and the open returns and claims under Now (money/: three reads beside
 * the party, each with its permission). B-W2b-324: the customer in depth through the record's `depth` slot (depth/): the glance on
 * the Overview (free credit, promises, samples in progress, measurement profiles, riders, repairs, the hold and its reason, a rider's
 * team, the requirements in force), Terms & requirements (B-TH-260: `?tab=terms`, the old Tax & terms and Requirements) › Hold and
 * Customer PO number required, and the contacts' consent, lawful basis and personal-data actions on Addresses & contacts.
 */
export function CustomerRecord({ partyId }: { partyId: string }) {
  return (
    <WithMessages namespaces={['parties', CUSTOMER_MONEY_NAMESPACE]}>
      <Customer partyId={partyId} />
    </WithMessages>
  )
}

function Customer({ partyId }: { partyId: string }) {
  const pathname = usePathname()
  const prefix = pathname.replace(/\/sales\/customers\/.*$/, '')
  const money = useCustomerMoney(partyId, prefix)
  return (
    <CustomerDepthProvider partyId={partyId}>
      <CustomerPage partyId={partyId} prefix={prefix} money={money} />
    </CustomerDepthProvider>
  )
}

/** Inside the depth provider (its slot reads it). */
function CustomerPage({ partyId, prefix, money }: { partyId: string; prefix: string; money: CustomerMoneyModel }) {
  const record = usePartyRecord('customers', partyId, {
    terms: (party, reload) => <CommercialTerms party={party} onChanged={reload} />,
    // B-W2b-180: Portal access (`?tab=portal`).
    portal: (party) => <PortalAccess side="customers" party={{ id: party.id, name: party.tradeName ?? party.legalName, companyId: party.companyId }} />,
    depth: (party, reload) => customerDepthSlot(party, reload, prefix),
  })
  return <CustomerRecordView model={record.model} actions={record.actions} thread={record.thread} printThread={record.printThread} fields={record.fields} terms={record.terms} portal={record.portal} money={money} depth={record.depth} />
}
