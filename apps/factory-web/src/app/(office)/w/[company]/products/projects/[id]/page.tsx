import { Suspense } from 'react'
import type { Metadata } from 'next'
import { ProjectRecord } from '../../../../../../../areas/products/projects/record/ProjectRecord'

export const metadata: Metadata = { title: 'Project · Nexus Factory' }

/**
 * Products › Development › Projects › a project (SCR-701; B-TH-249, the generic record page grown): the thread ~2/3, the side column
 * with Details, People, Linked, news of linked records, Tasks and Files. `?details=open` keeps the side column open below 1280 px;
 * `?thread=new` and `?message=<id>` are the thread's own. `/records/Project/<id>` comes here (areas/_shared/record-summary/RecordPage.tsx).
 */
export default async function ProjectRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <ProjectRecord projectId={decodeURIComponent(id)} />
    </Suspense>
  )
}
