import type { Metadata } from 'next'
import { NotBuiltYet } from '../../../../../../shell/office/NotBuiltYet'

export const metadata: Metadata = { title: 'Baskets board · Nexus Factory' }

/**
 * Production › Baskets board (owb- order workflow, base settle 7; areas/production/nav.ts, permission workorders.view): a DECLARED page — its route, its nav row
 * and its place in the approved tree are placed by the base; S5 (fl9) replaces this file with the page. Its address joins
 * OFFICE_PAGES at that land (shell/nav/office-nav.ts: DECLARED_PAGES → OFFICE_PAGES), so until then no row shows it.
 */
export default function ProductionBasketsPage() {
  return <NotBuiltYet />
}
