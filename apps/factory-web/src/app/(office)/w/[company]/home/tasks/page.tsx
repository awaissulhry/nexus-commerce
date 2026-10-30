import { Suspense } from 'react'
import type { Metadata } from 'next'
import { Tasks } from '../../../../../../areas/home/tasks/Tasks'

export const metadata: Metadata = { title: 'My tasks · Nexus Factory' }

/** Home › My tasks (SCR-233, B-W2a-40; `?scope=MINE|CREATED`, `?tile=`, `?q=`, `?open=<task id>`, `?new=1`). */
export default function Page() {
  return (
    <Suspense>
      <Tasks />
    </Suspense>
  )
}
