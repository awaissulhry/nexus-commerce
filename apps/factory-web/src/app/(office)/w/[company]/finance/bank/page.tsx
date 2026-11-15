import type { Metadata } from 'next'
import { Suspense } from 'react'
import { BankPage } from '../../../../../../areas/finance/bank/BankPage'

export const metadata: Metadata = { title: 'Bank · Nexus Factory' }

/**
 * Finance › Payables & bank › Bank (SCR-152; areas/finance/nav.ts, permission payments.bank.view): the statements imported
 * and their lines matched with how sure and why, and a customer's own figures against ours (`?view=`, `?line=`,
 * `?statement=`, `?import=1`, `?figures=new|<id>&correct=1`).
 */
export default function FinanceBankPage() {
  return (
    <Suspense>
      <BankPage />
    </Suspense>
  )
}
