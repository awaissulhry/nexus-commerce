import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ExportFile } from '../../../../../../../../areas/people/payroll/file/ExportFile'

export const metadata: Metadata = { title: 'Export file · Nexus Factory' }

/** A file's new tab (SCR-159-file): `?kind=summary` the export summary PDF, `?kind=data` the export file. Each opening is recorded. */
export default async function PeopleExportFilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <ExportFile exportId={id} />
    </Suspense>
  )
}
