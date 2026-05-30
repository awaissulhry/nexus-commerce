'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useReviewEventsRefresh } from '@/hooks/use-review-events-refresh'
import {
  Sparkles,
  Loader2,
  Send,
  CheckCircle2,
  Star,
  AlertTriangle,
  User,
} from 'lucide-react'

export interface DeskStats {
  counts: Record<string, number>
  open: number
  total: number
}

export interface DeskReview {
  id: string
  channel: string
  marketplace: string | null
  rating: number | null
  title: string | null
  body: string
  authorName: string | null
  verifiedPurchase: boolean
  postedAt: string
  externalReviewId: string
  triageStatus: string | null
  assignee: string | null
  triageTags: string[]
  triageNote: string | null
  sentiment: { label: string; score: string; categories: string[] } | null
  product: { id: string; sku: string; name: string; productType: string | null } | null
  _count?: { responses: number }
}

const STATUSES: { key: string; label: string }[] = [
  { key: 'NEW', label: 'New' },
  { key: 'IN_PROGRESS', label: 'In progress' },
  { key: 'RESPONDED', label: 'Responded' },
  { key: 'RESOLVED', label: 'Resolved' },
  { key: 'IGNORED', label: 'Ignored' },
]

const LABEL_TONE: Record<string, string> = {
  POSITIVE: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900',
  NEUTRAL: 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700',
  NEGATIVE: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900',
}

export function DeskClient({
  initialStats,
  initialReviews,
}: {
  initialStats: DeskStats
  initialReviews: DeskReview[]
}) {
  const [stats, setStats] = useState<DeskStats>(initialStats)
  const [status, setStatus] = useState('NEW')
  const [channel, setChannel] = useState('')
  const [reviews, setReviews] = useState<DeskReview[]>(initialReviews)
  const [loading, setLoading] = useState(false)

  const refreshStats = useCallback(async () => {
    try {
      const res = await fetch('/api/reviews/desk/stats', { cache: 'no-store' })
      if (res.ok) setStats(await res.json())
    } catch {
      /* non-fatal */
    }
  }, [])

  const load = useCallback(async (st: string, ch: string) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ triageStatus: st, limit: '100' })
      if (ch) params.set('channel', ch)
      const res = await fetch(`/api/reviews?${params.toString()}`, { cache: 'no-store' })
      const json = await res.json()
      setReviews(json.items ?? [])
    } catch {
      setReviews([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(status, channel)
  }, [status, channel, load])

  // RX.3 — live-refresh the queue + counters as reviews land / are answered.
  useReviewEventsRefresh(
    useCallback(() => {
      load(status, channel)
      refreshStats()
    }, [load, status, channel, refreshStats]),
    { debounceMs: 1500 },
  )

  // When a card finishes an action that changes its bucket, drop it from
  // the current list and refresh the counters.
  const onCardResolved = useCallback(
    (reviewId: string) => {
      setReviews((prev) => prev.filter((r) => r.id !== reviewId))
      refreshStats()
    },
    [refreshStats],
  )

  return (
    <div className="space-y-4">
      {/* Status tabs */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {STATUSES.map((s) => {
          const active = status === s.key
          const count = stats.counts[s.key] ?? 0
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setStatus(s.key)}
              className={`inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md ring-1 ring-inset ${
                active
                  ? 'bg-slate-900 text-white ring-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:ring-slate-100'
                  : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700'
              }`}
            >
              {s.label}
              <span className={`tabular-nums text-xs ${active ? 'opacity-80' : 'text-slate-400'}`}>
                {count}
              </span>
            </button>
          )
        })}
        <div className="ml-auto">
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="text-sm rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5"
          >
            <option value="">All channels</option>
            <option value="AMAZON">Amazon</option>
            <option value="EBAY">eBay</option>
            <option value="SHOPIFY">Shopify</option>
          </select>
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : reviews.length === 0 ? (
        <div className="text-center py-12 text-sm text-slate-500 dark:text-slate-400">
          Nothing in “{STATUSES.find((s) => s.key === status)?.label}”. 🎉
        </div>
      ) : (
        <div className="space-y-3">
          {reviews.map((r) => (
            <ReviewDeskCard key={r.id} review={r} onResolved={onCardResolved} onAnyChange={refreshStats} />
          ))}
        </div>
      )}
    </div>
  )
}

function ReviewDeskCard({
  review,
  onResolved,
  onAnyChange,
}: {
  review: DeskReview
  onResolved: (id: string) => void
  onAnyChange: () => void
}) {
  const [assignee, setAssignee] = useState(review.assignee ?? '')
  const [tags, setTags] = useState((review.triageTags ?? []).join(', '))
  const [note, setNote] = useState(review.triageNote ?? '')
  const [savingTriage, setSavingTriage] = useState(false)

  const [locale, setLocale] = useState('')
  const [tone, setTone] = useState('auto')
  const [replyText, setReplyText] = useState('')
  const [responseId, setResponseId] = useState<string | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [sending, setSending] = useState(false)
  const [aiBadge, setAiBadge] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const isEbay = review.channel === 'EBAY'

  const patchTriage = useCallback(
    async (body: Record<string, unknown>, opts?: { resolves?: boolean }) => {
      const res = await fetch(`/api/reviews/${review.id}/triage`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setErr('Failed to update')
        return
      }
      if (opts?.resolves) onResolved(review.id)
      else onAnyChange()
    },
    [review.id, onResolved, onAnyChange],
  )

  const saveTriage = async () => {
    setSavingTriage(true)
    setErr(null)
    await patchTriage({
      assignee: assignee.trim() || null,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      note: note.trim() || null,
    })
    setSavingTriage(false)
  }

  const draft = async () => {
    setDrafting(true)
    setErr(null)
    try {
      const res = await fetch(`/api/reviews/${review.id}/reply/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: locale || undefined, tone }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.message || 'Draft failed')
      setReplyText(json.response.body)
      setResponseId(json.response.id)
      setAiBadge(json.usedAi ? 'AI draft' : 'template')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setDrafting(false)
    }
  }

  const send = async () => {
    if (!replyText.trim()) return
    setSending(true)
    setErr(null)
    try {
      const res = await fetch(`/api/reviews/${review.id}/reply/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: replyText, responseId: responseId ?? undefined }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        throw new Error(json.error || json.message || `Send failed (${json.code ?? '?'})`)
      }
      onResolved(review.id) // moved to RESPONDED
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md p-3">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-4">
        {/* Review content */}
        <div>
          <div className="flex items-center gap-2 flex-wrap mb-1">
            {review.rating != null && (
              <span className="inline-flex items-center gap-0.5 text-amber-500">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star
                    key={i}
                    className={`h-3.5 w-3.5 ${i < review.rating! ? 'fill-amber-400 text-amber-400' : 'text-slate-300 dark:text-slate-700'}`}
                  />
                ))}
              </span>
            )}
            {review.sentiment && (
              <span
                className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset ${LABEL_TONE[review.sentiment.label] ?? LABEL_TONE.NEUTRAL}`}
              >
                {review.sentiment.label}
              </span>
            )}
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700 font-mono">
              {review.channel}
              {review.marketplace ? ` · ${review.marketplace}` : ''}
            </span>
            {review.verifiedPurchase && (
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400">Verified</span>
            )}
            <span className="text-[10px] text-slate-400 ml-auto">
              {new Date(review.postedAt).toLocaleDateString()}
            </span>
          </div>
          {review.product && (
            <Link
              href={`/products/${review.product.id}`}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              {review.product.sku} · {review.product.name}
            </Link>
          )}
          {review.title && (
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100 mt-1">
              {review.title}
            </div>
          )}
          <p className="text-sm text-slate-700 dark:text-slate-300 mt-0.5 whitespace-pre-wrap">
            {review.body}
          </p>
          {review.authorName && (
            <div className="text-[11px] italic text-slate-400 mt-1">— {review.authorName}</div>
          )}
          {review.sentiment && review.sentiment.categories.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap mt-1.5">
              {review.sentiment.categories.map((c) => (
                <span
                  key={c}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                >
                  {c}
                </span>
              ))}
            </div>
          )}

          {/* Triage row */}
          <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
            <div className="flex items-center gap-2">
              <User className="h-3.5 w-3.5 text-slate-400" />
              <input
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                placeholder="Assignee"
                className="flex-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1"
              />
              <input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="tags, comma-separated"
                className="flex-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1"
              />
            </div>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Internal note"
              className="w-full text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1"
            />
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={saveTriage}
                disabled={savingTriage}
                className="text-xs px-2 py-1 rounded ring-1 ring-inset bg-slate-50 text-slate-700 ring-slate-200 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700 disabled:opacity-40"
              >
                {savingTriage ? 'Saving…' : 'Save triage'}
              </button>
              <span className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1" />
              {review.triageStatus !== 'IN_PROGRESS' && (
                <button
                  type="button"
                  onClick={() => patchTriage({ status: 'IN_PROGRESS' }, { resolves: true })}
                  className="text-xs px-2 py-1 rounded ring-1 ring-inset bg-amber-50 text-amber-700 ring-amber-200 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900"
                >
                  In progress
                </button>
              )}
              <button
                type="button"
                onClick={() => patchTriage({ status: 'RESOLVED' }, { resolves: true })}
                className="text-xs px-2 py-1 rounded ring-1 ring-inset bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900"
              >
                Resolve
              </button>
              <button
                type="button"
                onClick={() => patchTriage({ status: 'IGNORED' }, { resolves: true })}
                className="text-xs px-2 py-1 rounded ring-1 ring-inset bg-slate-50 text-slate-500 ring-slate-200 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700"
              >
                Ignore
              </button>
            </div>
          </div>
        </div>

        {/* Reply panel */}
        <div className="lg:border-l lg:border-slate-100 lg:dark:border-slate-800 lg:pl-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Reply
            </span>
            {aiBadge && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:ring-violet-900">
                {aiBadge}
              </span>
            )}
            {(review._count?.responses ?? 0) > 0 && (
              <span className="text-[10px] text-slate-400">
                {review._count!.responses} prior
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mb-2">
            <select
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
              className="text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-1"
            >
              <option value="">auto-lang</option>
              <option value="it">IT</option>
              <option value="de">DE</option>
              <option value="fr">FR</option>
              <option value="es">ES</option>
              <option value="en">EN</option>
            </select>
            <select
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              className="text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-1"
            >
              <option value="auto">auto-tone</option>
              <option value="apologetic">apologetic</option>
              <option value="appreciative">appreciative</option>
              <option value="neutral">neutral</option>
            </select>
            <button
              type="button"
              onClick={draft}
              disabled={drafting}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded ring-1 ring-inset bg-violet-50 text-violet-700 ring-violet-200 hover:bg-violet-100 dark:bg-violet-950/40 dark:text-violet-300 dark:ring-violet-900 disabled:opacity-40"
            >
              {drafting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              Draft with AI
            </button>
          </div>
          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder={isEbay ? 'Reply will post to eBay…' : 'Write a reply, then post it on-platform and mark responded…'}
            rows={5}
            className="w-full text-sm rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5"
          />
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={send}
              disabled={sending || !replyText.trim()}
              className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md ring-1 ring-inset bg-emerald-600 text-white ring-emerald-600 hover:bg-emerald-700 disabled:opacity-40"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isEbay ? (
                <Send className="h-4 w-4" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              {isEbay ? 'Post reply to eBay' : 'Mark as responded'}
            </button>
            {!isEbay && (
              <span className="text-[10px] text-slate-400">
                {review.channel} has no public reply API — copy & post manually.
              </span>
            )}
          </div>
          {err && (
            <div className="flex items-start gap-1.5 text-xs text-rose-600 dark:text-rose-400 mt-2">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              {err}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
