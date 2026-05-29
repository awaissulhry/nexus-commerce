/** AX3.3 — Amazon DSP (Performance+ / Brand+) page. */
import type { Metadata } from 'next'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { DspClient } from './DspClient'

export const metadata: Metadata = { title: 'Amazon Ads · DSP' }
export const dynamic = 'force-dynamic'

export default function DspPage() {
  return (
    <div className="px-4 py-4">
      <AdvertisingNav />
      <DspClient />
    </div>
  )
}
