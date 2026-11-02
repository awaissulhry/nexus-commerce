import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PayrollPage } from '../../../../../../areas/people/payroll/PayrollPage'

export const metadata: Metadata = { title: 'Payroll export · Nexus Factory' }

/**
 * People › Skills & pay › Payroll export (SCR-159; areas/people/nav.ts, permission people.payroll.view): the Exports and the
 * five-step wizard. The client container reads `?new=1`, `?month=`, `?step=`, `?layout=`, `?year=`.
 */
export default function PeoplePayrollPage() {
  return (
    <Suspense>
      <PayrollPage />
    </Suspense>
  )
}
