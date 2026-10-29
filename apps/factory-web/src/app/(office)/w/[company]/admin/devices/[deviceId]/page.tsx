import { Suspense } from 'react'
import type { Metadata } from 'next'
import { DeviceRecord } from '../../../../../../../areas/admin/devices/DeviceRecord'

export const metadata: Metadata = { title: 'Device · Nexus Factory' }

/** Admin › Devices & printers › a device (SCR-013 Device record; `?tab=binding|status|activity`). */
export default async function Page({ params }: { params: Promise<{ deviceId: string }> }) {
  const { deviceId } = await params
  return (
    <Suspense>
      <DeviceRecord deviceId={decodeURIComponent(deviceId)} />
    </Suspense>
  )
}
