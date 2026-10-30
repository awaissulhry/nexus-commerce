import type { Metadata } from 'next'
import { Suspense } from 'react'
import { BoardPage } from '../../../../../../areas/planning/board/BoardPage'

export const metadata: Metadata = { title: 'Planning board · Nexus Factory' }

/**
 * Planning › Planning board (SCR-122; areas/planning/nav.ts, permission planning.view). The company layout above loaded
 * the session and draws the Office shell; the page is the client container (`?site=` `?view=` `?zoom=` `?from=` `?q=`
 * `?lane=` `?style=` `?status=` `?material=` `?hl=` `?wo=`). The design opens it in a window of its own (⌘-click).
 */
export default function PlanningBoardPage() {
  return (
    <Suspense>
      <BoardPage />
    </Suspense>
  )
}
