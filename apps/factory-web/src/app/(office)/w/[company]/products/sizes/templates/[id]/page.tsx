import { Suspense } from 'react'
import type { Metadata } from 'next'
import { TemplateRecord } from '../../../../../../../../areas/products/sizes/templates/record/TemplateRecord'

export const metadata: Metadata = { title: 'Measurement template · Nexus Factory' }

/**
 * Products › Libraries › Sizes & measurements › a measurement template (SCR-049-template, B-W2b-362; `?tab=points|mtm|whereused`):
 * its points in measuring order, made-to-measure (built OFF per template: the Owner's switch) and where it is used.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <TemplateRecord templateId={decodeURIComponent(id)} />
    </Suspense>
  )
}
