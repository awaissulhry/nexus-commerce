'use client'

// AC.8 — A+ Content & Brand Story card.
//
// Surfaces the MC-series A+ Content state for the active product in
// the cockpit. Today A+ docs live entirely in /marketing/content/a-plus
// and Brand Stories in /marketing/content/brand-story; the operator
// previously had to leave the editor to find out whether THIS ASIN
// had A+ attached, what status it was in, and what their brand's
// library looked like. This card collapses all of that to one tile.
//
// Sources (MC-series endpoints):
//   GET /api/aplus-content?asin=<asin>           — attached docs
//   GET /api/aplus-content?marketplace=<MP>&brand=<brand>  — library
//   GET /api/brand-stories?marketplace=<MP>&brand=<brand>  — story
//
// Write actions are deferred to AC.8.2 — attaching a new A+ from the
// library, creating a fresh A+, and submitting for approval all
// remain in /marketing/content for now. The card surfaces deep-links
// so the operator is one click away.

import { useEffect, useState } from 'react'
import {
  FileBadge,
  ExternalLink,
  Loader2,
  AlertCircle,
  Plus,
  BookOpen,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'

interface AplusContentRow {
  id: string
  name: string
  brand: string | null
  marketplace: string
  locale: string
  status: string
  updatedAt: string
  _count?: {
    modules: number
    asinAttachments: number
    localizations: number
  }
}

interface BrandStoryRow {
  id: string
  name: string
  brand: string
  marketplace: string
  locale: string
  status: string
  updatedAt: string
  _count?: { modules: number; localizations: number }
}

interface Props {
  asin: string | null
  brand: string | null
  marketplace: string
  onJumpToClassic?: () => void
}

const STATUS_TONE: Record<string, { bg: string; text: string }> = {
  DRAFT: {
    bg: 'bg-slate-100 dark:bg-slate-800',
    text: 'text-slate-700 dark:text-slate-300',
  },
  REVIEW: {
    bg: 'bg-amber-100 dark:bg-amber-950/40',
    text: 'text-amber-700 dark:text-amber-300',
  },
  SUBMITTED: {
    bg: 'bg-blue-100 dark:bg-blue-950/40',
    text: 'text-blue-700 dark:text-blue-300',
  },
  APPROVED: {
    bg: 'bg-emerald-100 dark:bg-emerald-950/40',
    text: 'text-emerald-700 dark:text-emerald-300',
  },
  PUBLISHED: {
    bg: 'bg-emerald-100 dark:bg-emerald-950/40',
    text: 'text-emerald-700 dark:text-emerald-300',
  },
  REJECTED: {
    bg: 'bg-rose-100 dark:bg-rose-950/40',
    text: 'text-rose-700 dark:text-rose-300',
  },
}

function StatusPill({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? STATUS_TONE.DRAFT
  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded text-[9.5px] font-bold uppercase tracking-wide',
        tone.bg,
        tone.text,
      )}
    >
      {status}
    </span>
  )
}

export default function AplusCard({
  asin,
  brand,
  marketplace,
  onJumpToClassic,
}: Props) {
  const [attached, setAttached] = useState<AplusContentRow[] | null>(null)
  const [libraryCount, setLibraryCount] = useState<number | null>(null)
  const [brandStory, setBrandStory] = useState<BrandStoryRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const backend = getBackendUrl()
        const tasks: Array<Promise<void>> = []

        // Attached A+ — only fetch when we have an ASIN. Without one
        // there's nothing to attach to yet.
        if (asin) {
          tasks.push(
            fetch(
              `${backend}/api/aplus-content?asin=${encodeURIComponent(asin)}&limit=20`,
              { credentials: 'include' },
            )
              .then((r) => (r.ok ? r.json() : { items: [] }))
              .then((j: { items: AplusContentRow[] }) => {
                if (!cancelled) setAttached(j.items ?? [])
              }),
          )
        } else if (!cancelled) {
          setAttached([])
        }

        // Brand library count — filter by brand + marketplace.
        if (brand) {
          tasks.push(
            fetch(
              `${backend}/api/aplus-content?marketplace=${encodeURIComponent(marketplace)}&brand=${encodeURIComponent(brand)}&limit=500`,
              { credentials: 'include' },
            )
              .then((r) => (r.ok ? r.json() : { items: [] }))
              .then((j: { items: AplusContentRow[] }) => {
                if (!cancelled) setLibraryCount((j.items ?? []).length)
              }),
          )

          // Brand Story for this brand + marketplace. Pick the most
          // recently updated one.
          tasks.push(
            fetch(
              `${backend}/api/brand-stories?marketplace=${encodeURIComponent(marketplace)}&brand=${encodeURIComponent(brand)}&limit=1`,
              { credentials: 'include' },
            )
              .then((r) => (r.ok ? r.json() : { items: [] }))
              .then((j: { items: BrandStoryRow[] }) => {
                if (!cancelled) setBrandStory(j.items?.[0] ?? null)
              }),
          )
        } else if (!cancelled) {
          setLibraryCount(0)
          setBrandStory(null)
        }

        await Promise.all(tasks)
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [asin, brand, marketplace])

  const attachedCount = attached?.length ?? 0
  const attachedApproved =
    attached?.filter(
      (a) => a.status === 'APPROVED' || a.status === 'PUBLISHED',
    ).length ?? 0
  const aplusLibraryHref = `/marketing/aplus?brand=${encodeURIComponent(brand ?? '')}&marketplace=${encodeURIComponent(marketplace)}`
  const brandStoryHref = `/marketing/brand-story?brand=${encodeURIComponent(brand ?? '')}&marketplace=${encodeURIComponent(marketplace)}`

  return (
    <div
      data-jump-target="aplus"
      className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 space-y-2.5"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="inline-flex items-center gap-2 min-w-0">
          <FileBadge className="w-4 h-4 text-slate-500 flex-shrink-0" />
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            A+ Content & Brand Story
          </span>
          {loading && (
            <Loader2 className="w-3 h-3 animate-spin text-slate-400" />
          )}
        </div>
        <a
          href={aplusLibraryHref}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-0.5"
          title="Open the A+ Content library"
        >
          Library <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      {error && (
        <div className="inline-flex items-start gap-1.5 text-[11px] text-rose-700 dark:text-rose-400">
          <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Attached A+ */}
      <div>
        <div className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">
          Attached to this ASIN
        </div>
        {!asin ? (
          <div className="text-[11.5px] text-slate-400 italic">
            No ASIN yet — A+ can be attached only after the listing is
            published.
          </div>
        ) : attached === null ? (
          <div className="text-[11.5px] text-slate-400 italic">Loading…</div>
        ) : attached.length === 0 ? (
          <div className="rounded border border-dashed border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30 p-2 text-[11.5px] text-amber-800 dark:text-amber-300">
            No A+ modules attached.{' '}
            <a
              href={aplusLibraryHref}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-amber-900 dark:hover:text-amber-200"
            >
              Pick from {libraryCount ?? '—'} library doc
              {libraryCount === 1 ? '' : 's'}
            </a>{' '}
            or{' '}
            <a
              href="/marketing/aplus/new"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-amber-900 dark:hover:text-amber-200 inline-flex items-center gap-0.5"
            >
              <Plus className="w-2.5 h-2.5" /> create one
            </a>
            . Brand-registered listings see ~5–15 % conversion lift on
            PDPs with A+ modules.
          </div>
        ) : (
          <ul className="space-y-1">
            {attached.map((row) => (
              <li key={row.id}>
                <a
                  href={`/marketing/aplus/${row.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-blue-400 dark:hover:border-blue-500 hover:bg-blue-50/60 dark:hover:bg-blue-950/30 transition-colors p-2"
                >
                  <BookOpen className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                  <div className="min-w-0 flex-1 leading-tight">
                    <div className="text-[12px] font-medium text-slate-900 dark:text-slate-100 truncate">
                      {row.name}
                    </div>
                    <div className="text-[10.5px] text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                      <span>{row.marketplace}</span>
                      <span>·</span>
                      <span>{row.locale}</span>
                      <span>·</span>
                      <span>
                        {row._count?.modules ?? 0} module
                        {row._count?.modules === 1 ? '' : 's'}
                      </span>
                    </div>
                  </div>
                  <StatusPill status={row.status} />
                  <ExternalLink className="w-3 h-3 text-slate-400" />
                </a>
              </li>
            ))}
          </ul>
        )}
        {attachedCount > 0 && (
          <div className="mt-1.5 text-[10.5px] text-slate-500 dark:text-slate-400">
            {attachedApproved}/{attachedCount} approved or published ·{' '}
            <a
              href={aplusLibraryHref}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              Attach more
            </a>
          </div>
        )}
      </div>

      {/* Brand Story */}
      <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
        <div className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">
          Brand Story
        </div>
        {!brand ? (
          <div className="text-[11.5px] text-slate-400 italic">
            No brand set on the master — Brand Stories are brand-scoped.
          </div>
        ) : brandStory ? (
          <a
            href={`/marketing/brand-story/${brandStory.id}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-blue-400 dark:hover:border-blue-500 hover:bg-blue-50/60 dark:hover:bg-blue-950/30 transition-colors p-2"
          >
            <BookOpen className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="text-[12px] font-medium text-slate-900 dark:text-slate-100 truncate">
                {brandStory.name}
              </div>
              <div className="text-[10.5px] text-slate-500 dark:text-slate-400">
                {brandStory._count?.modules ?? 0} modules ·{' '}
                {brandStory.locale}
              </div>
            </div>
            <StatusPill status={brandStory.status} />
            <ExternalLink className="w-3 h-3 text-slate-400" />
          </a>
        ) : (
          <div className="rounded border border-dashed border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-900/40 p-2 text-[11.5px] text-slate-600 dark:text-slate-400 flex items-center justify-between gap-2 flex-wrap">
            <span>
              No Brand Story for{' '}
              <span className="font-medium text-slate-700 dark:text-slate-300">
                {brand}
              </span>{' '}
              on {marketplace}.
            </span>
            <a
              href={brandStoryHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
            >
              Create
            </a>
          </div>
        )}
      </div>

      {/* Footer hint */}
      <div className="pt-1 border-t border-slate-100 dark:border-slate-800 text-[10.5px] text-slate-400 italic flex items-center justify-between gap-2">
        <span>
          AC.8 — read + deep-link. Inline attach + approval submit land
          in AC.8.2.
        </span>
        {onJumpToClassic && (
          <button
            type="button"
            onClick={onJumpToClassic}
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            Classic editor →
          </button>
        )}
      </div>
    </div>
  )
}

