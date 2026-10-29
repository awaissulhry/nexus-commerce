import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ShippingSettingsPage } from '../../../../../../areas/warehouse/shipping/ShippingSettingsPage'

export const metadata: Metadata = { title: 'Carriers & shipping · Nexus Factory' }

/** Warehouse › Settings › Carriers & shipping (SCR-068; permission shipping.settings.view; `?site=<site id>`). */
export default function WarehouseShippingPage() {
  return (
    <Suspense>
      <ShippingSettingsPage />
    </Suspense>
  )
}
