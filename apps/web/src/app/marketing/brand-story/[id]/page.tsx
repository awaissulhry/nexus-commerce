// MC.9.1 — Brand Story detail placeholder.
//
// Stub so the list-page click-through doesn't 404. Real builder
// (mirroring AplusBuilderClient with the 4 Brand Story module types)
// lands in MC.9.2.

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, BookOpen } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

export const dynamic = 'force-dynamic'

interface DetailStory {
  id: string
  name: string
  brand: string
  marketplace: string
  locale: string
  status: string
  notes: string | null
  createdAt: string
  updatedAt: string
  modules: Array<{ id: string; type: string; position: number }>
}

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function BrandStoryDetailPage({ params }: PageProps) {
  const { id } = await params
  const backend = getBackendUrl()
  const res = await fetch(
    `${backend}/api/brand-stories/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  )
  if (res.status === 404) notFound()
  if (!res.ok) {
    return (
      <div className="space-y-4">
        <Link
          href="/marketing/brand-story"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
        >
          <ArrowLeft className="w-4 h-4" /> Back to list
        </Link>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          Failed to load Brand Story (status {res.status}).
        </div>
      </div>
    )
  }
  const data = (await res.json()) as { story: DetailStory }
  const s = data.story

  return (
    <div className="space-y-4">
      <Link
        href="/marketing/brand-story"
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <ArrowLeft className="w-4 h-4" /> Back to list
      </Link>

      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-start gap-3">
          <BookOpen className="w-6 h-6 text-blue-500 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
              {s.name}
            </h1>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              {s.brand} · {s.marketplace} · {s.locale} · {s.status}
            </p>
          </div>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Modules
            </dt>
            <dd className="mt-0.5 text-slate-900 dark:text-slate-100">
              {s.modules.length}
            </dd>
          </div>
        </dl>

        {s.notes && (
          <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm text-slate-700 dark:bg-slate-800/50 dark:text-slate-300">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Notes
            </p>
            <p className="mt-1 whitespace-pre-wrap">{s.notes}</p>
          </div>
        )}
      </div>

      <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
        The Brand Story builder ships in MC.9.2. Today this page only
        shows the document's top-level metadata; module editing,
        localization, validation, and Amazon submission land in the
        next commits in this wave.
      </div>
    </div>
  )
}
