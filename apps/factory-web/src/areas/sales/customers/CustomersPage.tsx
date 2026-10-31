'use client'

import { WithMessages } from '../../../record-panels/i18n'
import { PartiesList } from '../../parties/_shared/PartiesList'
import { CustomersImport } from './import/CustomersImport'
import { useOverdueColumns } from './money/columns'
import { useOverdueList } from './money/hooks'
import { CUSTOMER_MONEY_NAMESPACE } from './money/model'

/**
 * `/w/<company>/sales/customers` (SCR-032): the shared parties list seen from Sales, with the band's Import (B-W2a-49;
 * design pop:customers.import — the customers and suppliers importer, upload → dry run → apply): after an import wrote
 * something the list and its tiles are read again. B-W2a-81: the Overdue column (price grain, receivables.view) from one
 * read of who owes late in the company.
 */
export function CustomersPage() {
  return (
    <WithMessages namespaces={[CUSTOMER_MONEY_NAMESPACE]}>
      <Customers />
    </WithMessages>
  )
}

function Customers() {
  const columns = useOverdueColumns(useOverdueList())
  return <PartiesList side="customers" columns={columns} headActions={(reload) => <CustomersImport onApplied={reload} />} />
}
