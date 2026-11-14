import { Suspense } from 'react'
import type { Metadata } from 'next'
import { FieldsPage } from '../../../../../../areas/admin/fields/FieldsPage'

export const metadata: Metadata = { title: 'Fields & lists · Nexus Factory' }

/**
 * Admin › Platform › Fields & lists (SCR-164, B-W2b-431; areas/admin/nav.ts, fields.view): the record types that take
 * custom fields, `?type=ORDER` the one shown, `?tab=picklists&list=<id>` the lists, `?field=<id>|new` the field dialog,
 * `?archived=1` archived fields too.
 */
export default function Page() {
  return (
    <Suspense>
      <FieldsPage />
    </Suspense>
  )
}
