/** Advertising workspace shell — collapsible grouped left sidebar + content. */
import type { ReactNode } from 'react'
import { AdvertisingSidebar } from './_shared/AdvertisingSidebar'

export default function AdvertisingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex">
      <AdvertisingSidebar />
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}
