import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RecordPage } from '../../../../../../../record-panels/RecordPage'

export const metadata: Metadata = { title: 'Record · Nexus Factory' }

/**
 * Any record's panels (SCR-006: thread, files, history), until its area builds the record's own page: Today and the
 * lists open a record here (lib/records/record-links.ts). The company layout above loaded the session and the shell.
 */
export default function RecordPanelsPage() {
  return (
    <Suspense>
      <RecordPage />
    </Suspense>
  )
}
