// MC.8.3 — A+ Content visual builder.
//
// Server-rendered shell that fetches the document + modules + ASIN
// attachments, then hands off to AplusBuilderClient for the actual
// drag-drop interaction.

import { notFound } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import AplusBuilderClient from '../_components/AplusBuilderClient'
import type { AplusDetail } from '../_lib/types'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function AplusBuilderPage({ params }: PageProps) {
  const { id } = await params
  const backend = getBackendUrl()
  const res = await fetch(
    `${backend}/api/aplus-content/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  )
  if (res.status === 404) notFound()
  if (!res.ok) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
        Failed to load A+ Content (status {res.status}). Try again in a moment.
      </div>
    )
  }
  const data = (await res.json()) as { content: AplusDetail }
  return (
    <AplusBuilderClient initial={data.content} apiBase={backend} />
  )
}
