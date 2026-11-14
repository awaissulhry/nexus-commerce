import type { Metadata } from 'next'
import { Suspense } from 'react'
import { MappingPage } from '../../../../../../../areas/finance/accounting/mapping/MappingPage'

export const metadata: Metadata = { title: 'Account mapping · Nexus Factory' }

/**
 * Finance › Close › Accounting export › Account mapping (SCR-480, B-W2b-426; the export's ⋯ Account mapping, a check's
 * fix `?open=KIND/KEY`): what Nexus posts → the accountant's accounts, one place per company, and the journals switch.
 * The company layout above loaded the session and draws the Office shell; the page is the client container.
 */
export default function AccountMappingPage() {
  return (
    <Suspense>
      <MappingPage />
    </Suspense>
  )
}
