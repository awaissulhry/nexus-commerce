import { Suspense } from 'react'
import type { Metadata } from 'next'
import { ProjectsPage } from '../../../../../../areas/products/projects/ProjectsPage'

export const metadata: Metadata = { title: 'Projects · Nexus Factory' }

/**
 * Products › Development › Projects (SCR-700, B-TH-248; areas/products/nav.ts, threads.read). The company layout above loaded the
 * session and draws the Office shell; the page is the client container. `?view=mine|active|party|onHold|closed` (My projects by
 * default), `?party=` / `?office=1`, `?lead=`, `?season=`, `?target=OVERDUE|THIS_MONTH`, `?q=`; New project `?new=1` (with
 * `&party=<id>` for a company, `&link=<Type>:<id>` from a record).
 */
export default function ProjectsRoute() {
  return (
    <Suspense>
      <ProjectsPage />
    </Suspense>
  )
}
