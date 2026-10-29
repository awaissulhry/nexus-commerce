import type { Metadata } from 'next'
import { Suspense } from 'react'
import { TodayPrint } from '../../../../../../../areas/home/today/TodayPrint'

export const metadata: Metadata = { title: 'My list · Nexus Factory' }

/** Home › Today › Print my list (opened in a new tab from Today's overflow menu). */
export default function TodayPrintPage() {
  return (
    <Suspense>
      <TodayPrint />
    </Suspense>
  )
}
