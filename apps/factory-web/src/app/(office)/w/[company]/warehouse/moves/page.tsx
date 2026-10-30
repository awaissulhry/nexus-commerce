import type { Metadata } from 'next'
import { Suspense } from 'react'
import { MovesPage } from '../../../../../../areas/warehouse/moves/MovesPage'

export const metadata: Metadata = { title: 'Movements · Nexus Factory' }

/**
 * Warehouse › Main › Movements (SCR-064; areas/warehouse/nav.ts, permission inventory.stock.view): the append-only stock
 * ledger as one long grid. The page is the client container (`?site=&item=&colour=&lot=&hide=&location=&reasons=
 * &period=&note=&reversed=&open=`).
 */
export default function WarehouseMovesPage() {
  return (
    <Suspense>
      <MovesPage />
    </Suspense>
  )
}
