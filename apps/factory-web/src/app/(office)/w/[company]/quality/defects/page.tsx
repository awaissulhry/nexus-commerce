import { Suspense } from 'react'
import type { Metadata } from 'next'
import { DefectsPage } from '../../../../../../areas/quality/defects/DefectsPage'

export const metadata: Metadata = { title: 'Defects & dispositions · Nexus Factory' }

/**
 * Quality › Settings › Defects & dispositions (SCR-079; areas/quality/nav.ts, quality.defects.view). The company layout
 * above loaded the session and draws the Office shell; the page is the client container. `?tab=defects|dispositions`,
 * `?view=all|active|retired` and `?q=` the library's rows, `?open=<id>` a code in its drawer, `?new=1` the tab's Add dialog.
 */
export default function DefectsRoute() {
  return (
    <Suspense>
      <DefectsPage />
    </Suspense>
  )
}
