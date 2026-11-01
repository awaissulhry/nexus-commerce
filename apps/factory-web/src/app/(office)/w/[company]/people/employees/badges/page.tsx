import type { Metadata } from 'next'
import { Suspense } from 'react'
import { BadgeSheet } from '../../../../../../../areas/people/employees/badges/BadgeSheet'

export const metadata: Metadata = { title: 'Badge sheet · Nexus Factory' }

/** People › Employees › Badge sheet (a new tab, `?ids=` the people: one badge face each, printed from the browser). */
export default function PeopleBadgeSheetPage() {
  return (
    <Suspense>
      <BadgeSheet />
    </Suspense>
  )
}
