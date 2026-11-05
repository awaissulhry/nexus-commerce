import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ChemicalsPage } from '../../../../../../areas/plant/chemicals/ChemicalsPage'

export const metadata: Metadata = { title: 'Chemicals & waste · Nexus Factory' }

/**
 * Plant › Health & safety › Chemicals & waste (SCR-213; areas/plant/nav.ts, permission safety.view): the chemical register,
 * the safety data sheet library and the cabinet QR. The client container reads `?tile=`, `?status=`, `?use=`, `?cabinet=`,
 * `?q=`, `?open=`, `?do=`, `?sheet=`, `?new=`, `?qr=`.
 */
export default function ChemicalsRoute() {
  return (
    <Suspense>
      <ChemicalsPage />
    </Suspense>
  )
}
