import { Suspense } from 'react'
import type { Metadata } from 'next'
import { OptionsPage } from '../../../../../../areas/products/options/OptionsPage'

export const metadata: Metadata = { title: 'Options & rules · Nexus Factory' }

/**
 * Products › Libraries › Options & rules (SCR-114, B-W2b-242; areas/products/nav.ts, product.styles.view): the option
 * groups a style offers to the configurator, their rules and effects. The filters are in the address
 * (`?view=&q=&kind=&outside=1&style=`); `?new=1` opens New option group; `?style=<id>` is the Style studio's link.
 */
export default function Page() {
  return (
    <Suspense>
      <OptionsPage />
    </Suspense>
  )
}
