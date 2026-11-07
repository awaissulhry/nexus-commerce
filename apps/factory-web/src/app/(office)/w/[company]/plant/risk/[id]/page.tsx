import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RiskRecord } from '../../../../../../../areas/plant/risk/record/RiskRecord'

export const metadata: Metadata = { title: 'Risk assessment · Nexus Factory' }

/** Plant › one risk assessment (SCR-209-record; `?tab=roles|plan|versions` and its dialogs). The company layout above loaded the shell. */
export default function RiskRecordRoute() {
  return (
    <Suspense>
      <RiskRecord />
    </Suspense>
  )
}
