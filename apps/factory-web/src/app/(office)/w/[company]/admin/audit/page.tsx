import { Suspense } from 'react'
import type { Metadata } from 'next'
import { AuditPage } from '../../../../../../areas/admin/audit/AuditPage'

export const metadata: Metadata = { title: 'Audit log · Nexus Factory' }

/**
 * Admin › Audit log (SCR-018; areas/admin/nav.ts, audit.read). The address holds the filters and the open entry:
 * `?view=&who=&surface=&type=&record=&area=&company=&period=&mode=table&open=<id>`.
 */
export default function Page() {
  return (
    <Suspense>
      <AuditPage />
    </Suspense>
  )
}
