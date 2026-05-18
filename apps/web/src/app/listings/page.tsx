import type { Metadata } from 'next'
import ListingsWorkspace from './ListingsWorkspace'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const metadata: Metadata = { title: 'All Listings' }

export default function ListingsPage() {
  return <ListingsWorkspace />
}
