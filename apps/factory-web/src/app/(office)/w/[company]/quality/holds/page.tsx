import { Suspense } from 'react'
import type { Metadata } from 'next'
import { HoldsPage } from '../../../../../../areas/quality/holds/HoldsPage'

export const metadata: Metadata = { title: 'Holds · Nexus Factory' }

/**
 * Quality › Holds (SCR-078; areas/quality/nav.ts, quality.holds.view). The company layout above loaded the session and
 * draws the Office shell; the page is the client container. `?view=` names the list (`open` default, `mine`, `overdue`,
 * `system`, `quarantine`, `released`, `closed`, `all`; the API's own `?status=`, `?overdue=true`, `?system=true`,
 * `?quarantine=ASKED`, `?ownerId=me` are read too), `?subjectType=` / `?subjectId=` narrow it to a kind or one record's
 * holds, `?open=<id>&tab=hold|decision|activity` opens a hold in its DetailModal, `?new=1` opens Place hold
 * (`&kind=WorkOrder&ids=<id,…>&source=Inspection:<id>` prefilled).
 */
export default function HoldsRoute() {
  return (
    <Suspense>
      <HoldsPage />
    </Suspense>
  )
}
