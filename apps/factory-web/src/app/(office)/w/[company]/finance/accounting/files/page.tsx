import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ExportFiles } from '../../../../../../../areas/finance/accounting/files/ExportFiles'

export const metadata: Metadata = { title: 'Export files · Nexus Factory' }

/** Finance › Close › Accounting export › Export files (opened in a new tab: `?export=<id>`, several `?exports=a,b`). */
export default function AccountingExportFilesPage() {
  return (
    <Suspense>
      <ExportFiles />
    </Suspense>
  )
}
