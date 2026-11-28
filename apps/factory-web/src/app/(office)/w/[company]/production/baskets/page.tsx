import type { Metadata } from 'next'
import { BasketsBoardPage } from '../../../../../../areas/production/baskets/BasketsBoardPage'

export const metadata: Metadata = { title: 'Baskets board · Nexus Factory' }

/**
 * Production › Baskets board (owb-fl9; design § 2, § 6; areas/production/nav.ts, permission workorders.view): one column per department
 * in use and Ready to ship, every basket as a card, filters team / department / order; a card opens the basket window. Its address
 * is in OFFICE_PAGES since the land (shell/nav/office-nav.ts: the lead flipped it from DECLARED_PAGES).
 */
export default function ProductionBasketsPage() {
  return <BasketsBoardPage />
}
