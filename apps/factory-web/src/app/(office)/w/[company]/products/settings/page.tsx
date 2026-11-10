import { Suspense } from 'react'
import type { Metadata } from 'next'
import { ProductSettingsPage } from '../../../../../../areas/products/settings/ProductSettingsPage'

export const metadata: Metadata = { title: 'Product settings · Nexus Factory' }

/**
 * Products › Settings › Product settings (SCR-251, B-W2b-239; areas/products/nav.ts, product.styles.view). The company
 * layout above loaded the session and draws the Office shell; the page is the client container. `?scope=all` every
 * company's settings (else the address's company), `?status=ARCHIVED|ALL` the types listed, `?type=<id>|new` a product
 * type in its dialog.
 */
export default function ProductSettingsRoute() {
  return (
    <Suspense>
      <ProductSettingsPage />
    </Suspense>
  )
}
