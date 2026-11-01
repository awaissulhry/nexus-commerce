import type { Metadata } from 'next'
import { Suspense } from 'react'
import { StaffPrint } from '../../../../../../../areas/people/employees/print/StaffPrint'

export const metadata: Metadata = { title: 'Staff list · Nexus Factory' }

/** People › Employees › Staff list print (a new tab: the list's view with its filters written on top; the band's Print). */
export default function PeopleStaffPrintPage() {
  return (
    <Suspense>
      <StaffPrint />
    </Suspense>
  )
}
