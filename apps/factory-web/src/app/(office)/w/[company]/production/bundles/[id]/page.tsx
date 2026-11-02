import type { Metadata } from 'next'
import { Suspense } from 'react'
import { BundleRecord } from '../../../../../../../areas/production/bundles/record/BundleRecord'

export const metadata: Metadata = { title: 'Bundle · Nexus Factory' }

/** The Bundle record (SCR-259-record): `?tab=progress|scans|quality|ticket`. */
export default async function ProductionBundlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <BundleRecord bundleId={id} />
    </Suspense>
  )
}
