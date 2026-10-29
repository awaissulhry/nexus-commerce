import type { Metadata } from 'next'
import { Suspense } from 'react'
import { StylesPage } from '../../../../../../areas/products/styles/list/StylesPage'

export const metadata: Metadata = { title: 'Styles · Nexus Factory' }

/**
 * Products › Styles (SCR-040; areas/products/nav.ts, permission product.styles.view). The company layout above loaded
 * the session and draws the Office shell; the page is the client container (filters in the address: `?view=&q=`,
 * `?new=1` opens New style).
 */
export default function Page() {
  return (
    <Suspense>
      <StylesPage />
    </Suspense>
  )
}
