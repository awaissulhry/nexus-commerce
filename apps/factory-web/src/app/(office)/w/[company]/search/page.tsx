import { Suspense } from 'react'
import type { Metadata } from 'next'
import { SearchPage } from '../../../../../areas/search/SearchPage'

export const metadata: Metadata = { title: 'Search · Nexus Factory' }

/**
 * All results (SCR-248; B-W2a-32; design shell.search "All results"): the full results of a search, opened from the
 * palette's "See all results" (`?q=`; a type chip `?type=`). A frame page (Top bar), no navigation row; any office
 * session may open it and sees only the records its roles open.
 */
export default function SearchResultsPage() {
  return (
    <Suspense>
      <SearchPage />
    </Suspense>
  )
}
