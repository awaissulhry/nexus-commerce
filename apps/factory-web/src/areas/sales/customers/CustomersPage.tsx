'use client'

import { LAST_MESSAGE_NS } from '../../../lib/last-message-cell/view/LastMessageCell'
import { WithMessages } from '../../../record-panels/i18n'
import { PartiesList } from '../../parties/_shared/PartiesList'
import { CustomersImport } from './import/CustomersImport'
import { CUSTOMERS_LIST_NS } from './list/model'
import { useCustomersDepth } from './list/use-customers-depth'
import { CUSTOMER_MONEY_NAMESPACE } from './money/model'

/**
 * `/w/<company>/sales/customers` (SCR-032): the shared parties list seen from Sales, with the band's Import (B-W2a-49;
 * design pop:customers.import — the customers and suppliers importer, upload → dry run → apply): after an import wrote
 * something the list is read again. B-W2a-81: the Overdue column (price grain, receivables.view) from one read of who owes
 * late in the company. F-CL-102 (customers list plan §1): the customers' own parts — the Customer cell, New messages, the
 * identity columns hidden at first, the phone card (list/use-customers-depth.tsx). F-CL-104: the bar's Add task to N customers… and
 * Set production supervisor for N…, the row's doors; their windows mount beside the list.
 */
export function CustomersPage() {
  return (
    <WithMessages namespaces={[CUSTOMER_MONEY_NAMESPACE, CUSTOMERS_LIST_NS, LAST_MESSAGE_NS, 'records']}>
      <Customers />
    </WithMessages>
  )
}

function Customers() {
  const { depth, windows } = useCustomersDepth()
  return (
    <>
      <PartiesList side="customers" depth={depth} headActions={(reload) => <CustomersImport onApplied={reload} />} />
      {windows}
    </>
  )
}
