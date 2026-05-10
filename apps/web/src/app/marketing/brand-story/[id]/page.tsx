// MC.9.2 — Brand Story builder page.
//
// Server-rendered fetch + hand-off to the client builder. Replaces
// the MC.9.1 placeholder.

import { notFound } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import BrandStoryBuilderClient from '../_components/BrandStoryBuilderClient'
import type { BrandStoryDetail } from '../_lib/types'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function BrandStoryBuilderPage({ params }: PageProps) {
  const { id } = await params
  const backend = getBackendUrl()
  const res = await fetch(
    `${backend}/api/brand-stories/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  )
  if (res.status === 404) notFound()
  if (!res.ok) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
        Failed to load Brand Story (status {res.status}).
      </div>
    )
  }
  const data = (await res.json()) as { story: BrandStoryDetail }
  return <BrandStoryBuilderClient initial={data.story} apiBase={backend} />
}
