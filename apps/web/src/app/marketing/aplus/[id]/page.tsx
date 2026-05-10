// MC.8.2 — A+ Content detail placeholder.
//
// Stub page so the list-page click-through doesn't 404. The real
// drag-drop builder lands in MC.8.3 against /api/aplus-content/:id
// and /api/aplus-modules. For now we surface the basic metadata
// already saved + a link back to the list.

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, BadgeCheck } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

export const dynamic = 'force-dynamic'

interface DetailContent {
  id: string
  name: string
  brand: string | null
  marketplace: string
  locale: string
  status: string
  notes: string | null
  createdAt: string
  updatedAt: string
  modules: Array<{ id: string; type: string; position: number }>
  asinAttachments: Array<{
    asin: string
    product: { id: string; sku: string; name: string } | null
  }>
}

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function AplusDetailPage({ params }: PageProps) {
  const { id } = await params
  const backend = getBackendUrl()
  const res = await fetch(
    `${backend}/api/aplus-content/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  )
  if (res.status === 404) notFound()
  if (!res.ok) {
    return (
      <div className="space-y-4">
        <Link
          href="/marketing/aplus"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
        >
          <ArrowLeft className="w-4 h-4" /> Back to list
        </Link>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          Failed to load A+ Content (status {res.status}).
        </div>
      </div>
    )
  }
  const data = (await res.json()) as { content: DetailContent }
  const c = data.content

  return (
    <div className="space-y-4">
      <Link
        href="/marketing/aplus"
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <ArrowLeft className="w-4 h-4" /> Back to list
      </Link>

      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-start gap-3">
          <BadgeCheck className="w-6 h-6 text-blue-500 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
              {c.name}
            </h1>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              {c.marketplace} · {c.locale} · {c.status}
              {c.brand ? ` · ${c.brand}` : ''}
            </p>
          </div>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Modules
            </dt>
            <dd className="mt-0.5 text-slate-900 dark:text-slate-100">
              {c.modules.length}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
              ASINs attached
            </dt>
            <dd className="mt-0.5 text-slate-900 dark:text-slate-100">
              {c.asinAttachments.length}
            </dd>
          </div>
        </dl>

        {c.notes && (
          <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm text-slate-700 dark:bg-slate-800/50 dark:text-slate-300">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Notes
            </p>
            <p className="mt-1 whitespace-pre-wrap">{c.notes}</p>
          </div>
        )}
      </div>

      <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
        The drag-drop A+ Content builder ships in MC.8.3. Today this
        page only shows the document's top-level metadata; module
        editing, ASIN picker, localization siblings, validation, and
        Amazon SP-API submission land in the next commits in this wave.
      </div>
    </div>
  )
}
