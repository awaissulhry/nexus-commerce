import type { Metadata } from 'next'
import { NotBuiltYet } from '../../../../../../shell/office/NotBuiltYet'

export const metadata: Metadata = { title: 'Our warehouses · Nexus Factory' }

/**
 * Warehouse › Outbound › Our warehouses (owb- order workflow, base settle 7; areas/warehouse/nav.ts, permission shipping.view): a DECLARED page — its route, its nav row
 * and its place in the approved tree are placed by the base; S3 (ss3) replaces this file with the page. Its address joins
 * OFFICE_PAGES at that land (shell/nav/office-nav.ts: DECLARED_PAGES → OFFICE_PAGES), so until then no row shows it.
 */
export default function WarehouseOurWarehousesPage() {
  return <NotBuiltYet />
}
