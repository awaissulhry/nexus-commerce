import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CabinetTab } from '../../../../../../../areas/plant/chemicals/cabinet/CabinetTab'

export const metadata: Metadata = { title: 'Cabinet sheet · Nexus Factory' }

/** Plant › Health & safety › Chemicals & waste › Cabinet sheet (a new tab, for the wall): `?site=&code=`. */
export default function CabinetRoute() {
  return (
    <Suspense>
      <CabinetTab />
    </Suspense>
  )
}
