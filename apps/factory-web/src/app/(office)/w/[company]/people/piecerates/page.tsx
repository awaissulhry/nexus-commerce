import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PieceRatesPage } from '../../../../../../areas/people/piecerates/PieceRatesPage'

export const metadata: Metadata = { title: 'Piece rates · Nexus Factory' }

/**
 * People › Piece rates (SCR-158; areas/people/nav.ts, permission people.piecerates.view): the legal switch first; rates, the
 * scheme; once piece pay has been on, pay periods, the ledger and held scans. The site is the top bar's.
 */
export default function PeoplePieceRatesPage() {
  return (
    <Suspense>
      <PieceRatesPage />
    </Suspense>
  )
}
