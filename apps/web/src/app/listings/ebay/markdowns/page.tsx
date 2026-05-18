import type { Metadata } from 'next'
import EbayMarkdownsClient from './EbayMarkdownsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const metadata: Metadata = { title: 'eBay Markdowns · Sale Events' }

export default function EbayMarkdownsPage() {
  return <EbayMarkdownsClient />
}
