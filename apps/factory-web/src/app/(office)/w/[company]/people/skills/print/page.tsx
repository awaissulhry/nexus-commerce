import type { Metadata } from 'next'
import { Suspense } from 'react'
import { MatrixPrint } from '../../../../../../../areas/people/skills/print/MatrixPrint'

export const metadata: Metadata = { title: 'Skills matrix · Nexus Factory' }

/** People › Skills & training › Matrix print (a new tab: one A3 sheet for the line's notice board, its filters on top). */
export default function PeopleSkillsPrintPage() {
  return (
    <Suspense>
      <MatrixPrint />
    </Suspense>
  )
}
