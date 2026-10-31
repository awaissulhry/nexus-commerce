'use client'

import { usePathname } from 'next/navigation'
import { WithMessages } from '../../../../record-panels/i18n'
import { PartyRecord } from '../../../parties/_shared/PartyRecord'
import { useCustomerMoney } from '../money/hooks'
import { CUSTOMER_MONEY_NAMESPACE } from '../money/model'
import { useCustomerOverview } from '../money/overview'
import { CommercialTerms } from '../terms/CommercialTerms'

/**
 * `/w/<company>/sales/customers/<id>` (SCR-033): the shared party record seen from Sales, with the customer's Commercial
 * terms card on Tax & terms (B-W2a-49; SAL-012): it reads and saves the terms itself and has the record read the party
 * again after a save (the terms are the party's columns: its version moved). B-W2a-81: the Overview's Overdue and
 * Returns this year tiles and the open returns and claims under Now (money/: three reads beside the party, each with
 * its permission).
 */
export function CustomerRecord({ partyId }: { partyId: string }) {
  return (
    <WithMessages namespaces={[CUSTOMER_MONEY_NAMESPACE]}>
      <Customer partyId={partyId} />
    </WithMessages>
  )
}

function Customer({ partyId }: { partyId: string }) {
  const pathname = usePathname()
  const prefix = pathname.replace(/\/sales\/customers\/.*$/, '')
  const overview = useCustomerOverview(useCustomerMoney(partyId, prefix))
  return <PartyRecord side="customers" partyId={partyId} overview={overview} terms={(party, reload) => <CommercialTerms party={party} onChanged={reload} />} />
}
