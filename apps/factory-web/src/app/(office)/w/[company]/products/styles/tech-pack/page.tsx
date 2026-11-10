import type { Metadata } from 'next'
import { Suspense } from 'react'
import { TechPackWindow } from '../../../../../../../areas/products/styles/techpack/window/TechPackWindow'

export const metadata: Metadata = { title: 'Tech pack PDF · Nexus Factory' }

/**
 * Products › Styles › Tech pack PDF (SCR-306, a window page: WINDOW_PAGES; design tab:styles.techpack): a stored version of a
 * style revision's tech pack (`?style=&rev=&version=`), or the page a scanned QR names (`?scan=<code>`, from `/tech-pack/<code>`).
 */
export default function Page() {
  return (
    <Suspense>
      <TechPackWindow />
    </Suspense>
  )
}
