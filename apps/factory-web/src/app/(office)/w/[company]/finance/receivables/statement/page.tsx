import type { Metadata } from 'next'
import { Suspense } from 'react'
import { StatementPdf } from '../../../../../../../areas/finance/receivables/statement/StatementPdf'

export const metadata: Metadata = { title: 'Statement · Nexus Factory' }

/** Finance › Receivables › Statement (PDF) (SCR-151 tab:statement-pdf), opened in a new tab from a statement or By customer. */
export default function FinanceStatementPdfPage() {
  return (
    <Suspense>
      <StatementPdf />
    </Suspense>
  )
}
