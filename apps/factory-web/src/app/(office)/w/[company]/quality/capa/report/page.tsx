import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CapaReport } from '../../../../../../../areas/quality/capa/report/CapaReport'

export const metadata: Metadata = { title: '8D report · Nexus Factory' }

/** Quality › Corrective actions › 8D report (PDF) (a new tab, design tab:capa-pdf; `?capa=<id>&language=it|en`). */
export default function CapaReportPage() {
  return (
    <Suspense>
      <CapaReport />
    </Suspense>
  )
}
