'use client'

import { PartiesList } from '../../parties/_shared/PartiesList'
import { CustomersImport } from './import/CustomersImport'

/**
 * `/w/<company>/sales/customers` (SCR-032): the shared parties list seen from Sales, with the band's Import (B-W2a-49;
 * design pop:customers.import — the customers and suppliers importer, upload → dry run → apply): after an import wrote
 * something the list and its tiles are read again.
 */
export function CustomersPage() {
  return <PartiesList side="customers" headActions={(reload) => <CustomersImport onApplied={reload} />} />
}
