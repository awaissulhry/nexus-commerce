/** AX3.12 — Live Ad Momentum page. */
import type { Metadata } from 'next'
import { MomentumClient } from './MomentumClient'

export const metadata: Metadata = { title: 'Amazon Ads · Live Ad Momentum' }
export const dynamic = 'force-dynamic'

export default function MomentumPage() {
  return (
    <div className="px-4 py-4">
      <MomentumClient />
    </div>
  )
}
