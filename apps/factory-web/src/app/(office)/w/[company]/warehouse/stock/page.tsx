import type { Metadata } from 'next'
import { Suspense } from 'react'
import { StockPage } from '../../../../../../areas/warehouse/stock/StockPage'

export const metadata: Metadata = { title: 'Stock · Nexus Factory' }

/**
 * Warehouse › Main › Stock (SCR-060; areas/warehouse/nav.ts, permission inventory.stock.view). The company layout above
 * loaded the session and draws the Office shell; the page is the client container (`?site=&view=&tile=&q=`).
 */
export default function WarehouseStockPage() {
  return (
    <Suspense>
      <StockPage />
    </Suspense>
  )
}
