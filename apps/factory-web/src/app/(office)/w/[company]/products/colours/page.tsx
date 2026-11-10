import { Suspense } from 'react'
import type { Metadata } from 'next'
import { ColoursPage } from '../../../../../../areas/products/colours/ColoursPage'

export const metadata: Metadata = { title: 'Colours & artwork · Nexus Factory' }

/**
 * Products › Libraries › Colours & artwork (SCR-118, B-W2b-247; areas/products/nav.ts, product.styles.view): the colour
 * library and the private-label brands' branding sets. The filters are in the address (`?view=&q=&system=&family=&sets=`);
 * `?open=<set>` opens a branding set, `?new=colour|set` New colour or New branding set.
 */
export default function Page() {
  return (
    <Suspense>
      <ColoursPage />
    </Suspense>
  )
}
