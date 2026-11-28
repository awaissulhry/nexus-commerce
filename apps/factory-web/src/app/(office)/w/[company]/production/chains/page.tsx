import type { Metadata } from 'next'
import { ChainsPage } from '../../../../../../areas/production/chains/ChainsPage'

export const metadata: Metadata = { title: 'Chains · Nexus Factory' }

/**
 * Production › Chains (owb-fl9; design § 4.8; areas/production/nav.ts, permission workorders.view): every model and size of a chain at
 * every step, the slowest step in red with its number and word. Its address joins OFFICE_PAGES at the land (the lead's flip).
 */
export default function ProductionChainsPage() {
  return <ChainsPage />
}
