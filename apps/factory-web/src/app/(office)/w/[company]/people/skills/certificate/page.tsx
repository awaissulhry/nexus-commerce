import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CertificateTab } from '../../../../../../../areas/people/skills/training/certificate/CertificateTab'

export const metadata: Metadata = { title: 'Training certificate · Nexus Factory' }

/** People › Skills & training › Certificate (PDF) (a new tab from a course cell or a record row): `?record=&person=&language=`. */
export default function TrainingCertificateRoute() {
  return (
    <Suspense>
      <CertificateTab />
    </Suspense>
  )
}
