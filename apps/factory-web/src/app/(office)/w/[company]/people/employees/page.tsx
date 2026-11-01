import type { Metadata } from 'next'
import { Suspense } from 'react'
import { EmployeesPage } from '../../../../../../areas/people/employees/EmployeesPage'

export const metadata: Metadata = { title: 'Employees · Nexus Factory' }

/**
 * People › Employees (SCR-084; areas/people/nav.ts, permission people.view): the HR register, teams with today's loans,
 * leavers in progress. The client container reads `?tile=`, `?rows=`, `?q=`, `?view=teams`, `?line=`, `?team=`,
 * `?new=1` and `?import=1`; the site is the top bar's.
 */
export default function PeopleEmployeesPage() {
  return (
    <Suspense>
      <EmployeesPage />
    </Suspense>
  )
}
