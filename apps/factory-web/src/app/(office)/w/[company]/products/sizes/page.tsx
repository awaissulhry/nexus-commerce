import { Suspense } from 'react'
import type { Metadata } from 'next'
import { SizesPage } from '../../../../../../areas/products/sizes/SizesPage'

export const metadata: Metadata = { title: 'Sizes & measurements · Nexus Factory' }

/**
 * Products › Libraries › Sizes & measurements (SCR-049; product.styles.view): the size scales and their sizes' body
 * measures. `?q=&view=` in the address; `?new=1` opens New size scale.
 */
export default function Page() {
  return (
    <Suspense>
      <SizesPage />
    </Suspense>
  )
}
