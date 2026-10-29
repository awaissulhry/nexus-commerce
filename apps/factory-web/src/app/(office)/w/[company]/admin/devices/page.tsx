import { Suspense } from 'react'
import type { Metadata } from 'next'
import { DevicesPage } from '../../../../../../areas/admin/devices/DevicesPage'

export const metadata: Metadata = { title: 'Devices & printers · Nexus Factory' }

/** Admin › Devices & printers (SCR-013; areas/admin/nav.ts, devices.view). `?mode=printers`, `?enrol=1`. */
export default function Page() {
  return (
    <Suspense>
      <DevicesPage />
    </Suspense>
  )
}
