import { Suspense } from 'react'
import type { Metadata } from 'next'
import { AccidentLogPage } from '../../../../../../../areas/compliance/register/accidents/log/AccidentLogPage'

export const metadata: Metadata = { title: 'Accident log · Nexus Factory' }

/** Compliance › PPE register › the accident log (SCR-422, B-W2b-357; design compliance.register page.h "Accident log (W2b)"). */
export default function AccidentLogRoute() {
  return (
    <Suspense>
      <AccidentLogPage />
    </Suspense>
  )
}
