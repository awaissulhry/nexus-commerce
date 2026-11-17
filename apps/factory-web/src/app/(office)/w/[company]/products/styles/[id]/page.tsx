import type { Metadata } from 'next'
import { Suspense } from 'react'
import { StyleRecord } from '../../../../../../../areas/products/styles/record/StyleRecord'

export const metadata: Metadata = { title: 'Style · Nexus Factory' }

/**
 * Products › Styles › a style (SCR-041 … SCR-045; `?tab=overview|sizes|bom|routing|cost|techpack|compliance|patterns|versions` and
 * `?rev=<revision id>`, the revision in view). B-TH-261: the old `?tab=variants|files|activity` still open (Overview & variants,
 * Patterns, the overview with the thread open).
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <StyleRecord styleId={decodeURIComponent(id)} />
    </Suspense>
  )
}
