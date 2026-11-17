import { Suspense } from 'react'
import type { Metadata } from 'next'
import { DeviceRecord } from '../../../../../../../areas/admin/devices/DeviceRecord'

export const metadata: Metadata = { title: 'Device · Nexus Factory' }

/** Admin › Devices & printers › a device (SCR-013 Device record; `?tab=binding|status`; the old `activity` opens Station & mode with the thread — B-TH-269). */
export default async function Page({ params }: { params: Promise<{ deviceId: string }> }) {
  const { deviceId } = await params
  return (
    <Suspense>
      <DeviceRecord deviceId={decodeURIComponent(deviceId)} />
    </Suspense>
  )
}
