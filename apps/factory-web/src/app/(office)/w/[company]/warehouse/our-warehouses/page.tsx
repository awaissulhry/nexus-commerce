import type { Metadata } from 'next'
import { Suspense } from 'react'
import { OurWarehousesPage } from '../../../../../../areas/warehouse/our-warehouses/OurWarehousesPage'

export const metadata: Metadata = { title: 'Our warehouses · Nexus Factory' }

/**
 * Warehouse › Outbound › Our warehouses (owb- order workflow; areas/warehouse/nav.ts, permission shipping.view): one section per warehouse
 * of the company — At our warehouse (customer, orders, pieces, since, the customer's label) with Send on to the customer, and On the way
 * with It arrived at the warehouse (owb-ss3 step 3.4, design plan § 7). Its address joins OFFICE_PAGES at the lead's nav flip
 * (shell/nav/office-nav.ts: DECLARED_PAGES → OFFICE_PAGES), so until then no row shows it.
 */
export default function WarehouseOurWarehousesPage() {
  return (
    <Suspense>
      <OurWarehousesPage />
    </Suspense>
  )
}
