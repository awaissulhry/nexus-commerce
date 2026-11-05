import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RegisterPrint } from '../../../../../../../areas/plant/preventive/print/RegisterPrint'

export const metadata: Metadata = { title: 'Check register print · Nexus Factory' }

/** Plant › Maintenance › Preventive & statutory checks › Check register (a new tab, for an inspector): `?from=&to=&ids=`. */
export default function CheckRegisterPrintRoute() {
  return (
    <Suspense>
      <RegisterPrint />
    </Suspense>
  )
}
