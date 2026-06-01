import type { Metadata } from 'next'
import { RankPage } from './RankPage'

export const metadata: Metadata = { title: 'Rank Control | Ads Console' }
export const dynamic = 'force-dynamic'

export default function RankControlPage() {
  return <RankPage />
}
