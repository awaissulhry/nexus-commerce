import type { Metadata } from 'next'
import { Suspense } from 'react'
import { StatusPrint } from '../../../../../../../areas/compliance/status/print/StatusPrint'

export const metadata: Metadata = { title: 'Compliance status board (print) · Nexus Factory' }

/** Compliance › Status board (print) (SCR-314, a new tab, design tab:cs-print): the board's filters in the address. */
export default function ComplianceStatusPrintPage() {
  return (
    <Suspense>
      <StatusPrint />
    </Suspense>
  )
}
