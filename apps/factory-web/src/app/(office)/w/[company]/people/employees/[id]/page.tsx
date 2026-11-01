import type { Metadata } from 'next'
import { Suspense } from 'react'
import { EmployeeRecord } from '../../../../../../../areas/people/employees/record/EmployeeRecord'

export const metadata: Metadata = { title: 'Employee · Nexus Factory' }

/** People › an employee (SCR-085; `?tab=profile|job|documents|activity`). The company layout above loaded the shell. */
export default async function PeopleEmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <EmployeeRecord employeeId={id} />
    </Suspense>
  )
}
