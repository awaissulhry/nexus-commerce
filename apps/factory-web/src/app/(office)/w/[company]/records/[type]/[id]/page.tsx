import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RecordPage } from '../../../../../../../record-panels/RecordPage'

export const metadata: Metadata = { title: 'Record · Nexus Factory' }

/**
 * The generic record page (SCR-006-generic; B-TH-272, PL5): any record whose area has not built its own page yet — a summary
 * (type, number, state, the record it belongs to) and its full-page thread. Today and the lists open a record here
 * (lib/records/record-links.ts). The company layout above loaded the session and the shell.
 */
export default function GenericRecordRoute() {
  return (
    <Suspense>
      <RecordPage />
    </Suspense>
  )
}
