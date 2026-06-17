'use client'

// EC.4.2 — CategoryPickerModal
//
// Three picker modes in one modal:
//   1. Search        — operator types a keyword
//   2. AI suggest    — eBay's get_category_suggestions seeded with
//                      the listing's title + description (no LLM
//                      call needed; eBay's own ML is strong here)
//   3. Sibling map   — given a candidate (or already-picked) category,
//                      surface what the equivalent category looks
//                      like in each sister marketplace, so operators
//                      can pick once and confidently apply across
//                      IT/DE/FR/ES/UK
//
// All three feed a single "pendingPick" slot at the bottom. The
// operator confirms with [Apply] → PATCH /api/ebay/cockpit/category
// → modal closes and the cockpit refreshes.
//
// itemSpecifics on the ChannelListing are PRESERVED by the PATCH
// endpoint, so re-categorising never silently throws away aspect
// work the operator has done.

import { useEffect, useMemo, useState } from 'react'
import { Search, Sparkles, Globe2, X, ArrowRight, Loader2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

type Mode = 'search' | 'ai' | 'siblings'

interface CategoryHit {
  id: string
  name: string
  path: string
  matchScore: number
}

interface SiblingHit {
  marketplace: string
  hit: CategoryHit | null
}

interface Props {
  productId: string
  marketplace: string
  marketName: string
  /** Marketplaces other than the current one — drive the Siblings tab. */
  siblingMarketCodes: string[]
  /** Listing text used to seed the AI-suggest mode. */
  seedTitle: string
  seedDescription: string
  /** Current category, if any — shown at the top + drives Siblings tab. */
  current: { id: string | null; name: string | null; path: string | null }
  onClose: () => void
  /** Fires after the PATCH resolves so the cockpit can refresh. */
  onApplied: (next: { id: string; name: string | null; path: string | null }) => void
}

export default function CategoryPickerModal({
  productId,
  marketplace,
  marketName,
  siblingMarketCodes,
  seedTitle,
  seedDescription,
  current,
  onClose,
  onApplied,
}: Props) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>(current.id ? 'siblings' : 'ai')
  const [query, setQuery] = useState('')
  const [searchHits, setSearchHits] = useState<CategoryHit[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [aiHits, setAiHits] = useState<CategoryHit[]>([])
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [siblings, setSiblings] = useState<SiblingHit[]>([])
  const [siblingsLoading, setSiblingsLoading] = useState(false)
  const [pendingPick, setPendingPick] = useState<CategoryHit | null>(null)
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)

  // ESC closes the modal — but only when no pending apply is in flight.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !applying) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [applying, onClose])

  // Debounced search.
  useEffect(() => {
    if (mode !== 'search') return
    if (query.trim().length < 2) {
      setSearchHits([])
      return
    }
    let aborted = false
    setSearchLoading(true)
    const timer = window.setTimeout(async () => {
      try {
        const u = new URL(`${getBackendUrl()}/api/ebay/flat-file/category-search`)
        u.searchParams.set('q', query.trim())
        u.searchParams.set('marketplace', `EBAY_${marketplace.toUpperCase()}`)
        const res = await fetch(u.toString())
        const json = await res.json()
        if (!aborted) setSearchHits(json.categories ?? [])
      } catch {
        if (!aborted) setSearchHits([])
      } finally {
        if (!aborted) setSearchLoading(false)
      }
    }, 250)
    return () => {
      aborted = true
      window.clearTimeout(timer)
    }
  }, [mode, query, marketplace])

  // AI suggest — fires when entering the AI tab if not loaded yet.
  useEffect(() => {
    if (mode !== 'ai' || aiHits.length > 0 || aiLoading) return
    let aborted = false
    setAiLoading(true)
    setAiError(null)
    ;(async () => {
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/ebay/cockpit/suggest-categories`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              marketplace,
              title: seedTitle,
              description: seedDescription,
              limit: 8,
            }),
          },
        )
        const json = await res.json()
        if (aborted) return
        if (!res.ok) {
          setAiError(json?.error ?? `HTTP ${res.status}`)
          setAiHits([])
        } else {
          setAiHits(json.suggestions ?? [])
        }
      } catch (err) {
        if (!aborted) setAiError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!aborted) setAiLoading(false)
      }
    })()
    return () => {
      aborted = true
    }
    // mode change + once-seeded only — re-fire happens via the
    // "Refresh suggestions" button below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // Sibling map — fires when a category is picked OR when entering
  // the tab if a current category already exists.
  useEffect(() => {
    if (mode !== 'siblings') return
    const seedName = pendingPick?.name ?? current.name
    if (!seedName || siblingMarketCodes.length === 0) {
      setSiblings([])
      return
    }
    let aborted = false
    setSiblingsLoading(true)
    ;(async () => {
      try {
        const u = new URL(`${getBackendUrl()}/api/ebay/cockpit/category-map`)
        u.searchParams.set('source', marketplace)
        u.searchParams.set('categoryName', seedName)
        u.searchParams.set('targets', siblingMarketCodes.join(','))
        const res = await fetch(u.toString())
        const json = await res.json()
        if (aborted) return
        const map = (json.map ?? {}) as Record<string, CategoryHit | null>
        setSiblings(
          siblingMarketCodes.map((mp) => ({ marketplace: mp, hit: map[mp] ?? null })),
        )
      } catch {
        if (!aborted) setSiblings(siblingMarketCodes.map((mp) => ({ marketplace: mp, hit: null })))
      } finally {
        if (!aborted) setSiblingsLoading(false)
      }
    })()
    return () => {
      aborted = true
    }
  }, [mode, pendingPick, current.name, marketplace, siblingMarketCodes])

  const changes = useMemo(() => {
    if (!pendingPick) return null
    if (current.id === pendingPick.id) return null
    return { from: current, to: pendingPick }
  }, [pendingPick, current])

  async function apply() {
    if (!pendingPick) return
    setApplying(true)
    setApplyError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/ebay/cockpit/category`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId,
          marketplace,
          categoryId: pendingPick.id,
          categoryName: pendingPick.name,
          categoryPath: pendingPick.path,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)
      onApplied({ id: pendingPick.id, name: pendingPick.name, path: pendingPick.path })
      router.refresh()
      onClose()
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm"
      onClick={() => !applying && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="category-picker-title"
        className="w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col rounded-lg border border-default dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-subtle dark:border-slate-800 flex items-center justify-between">
          <div>
            <div id="category-picker-title" className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Pick eBay category — {marketName}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              {current.id
                ? <>Currently: <span className="font-mono">{current.path ?? current.name}</span></>
                : <>No category picked yet</>}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={applying}
            className="p-1 text-tertiary hover:text-slate-700 dark:hover:text-slate-200 rounded"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode tabs */}
        <div className="px-4 py-2 border-b border-subtle dark:border-slate-800 flex items-center gap-1 text-xs">
          <ModeTab active={mode === 'ai'} onClick={() => setMode('ai')} icon={<Sparkles className="w-3 h-3" />} label="AI suggest" />
          <ModeTab active={mode === 'search'} onClick={() => setMode('search')} icon={<Search className="w-3 h-3" />} label="Search" />
          <ModeTab active={mode === 'siblings'} onClick={() => setMode('siblings')} icon={<Globe2 className="w-3 h-3" />} label={`Sibling markets (${siblingMarketCodes.length})`} disabled={siblingMarketCodes.length === 0} />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {mode === 'ai' && (
            <AiPanel
              loading={aiLoading}
              error={aiError}
              hits={aiHits}
              pendingPick={pendingPick}
              onPick={setPendingPick}
              onRefresh={() => {
                setAiHits([])
                setAiError(null)
              }}
              seedTitle={seedTitle}
            />
          )}
          {mode === 'search' && (
            <SearchPanel
              query={query}
              onQuery={setQuery}
              loading={searchLoading}
              hits={searchHits}
              pendingPick={pendingPick}
              onPick={setPendingPick}
            />
          )}
          {mode === 'siblings' && (
            <SiblingsPanel
              loading={siblingsLoading}
              siblings={siblings}
              seedName={pendingPick?.name ?? current.name ?? null}
              activeMarketplace={marketplace}
            />
          )}
        </div>

        {/* Pending pick + Apply */}
        <div className="border-t border-subtle dark:border-slate-800 px-4 py-3 space-y-2">
          {pendingPick && changes && (
            <div className="text-xs flex items-center gap-2 flex-wrap">
              <span className="text-slate-500">Will switch:</span>
              <span className="font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                {changes.from.path ?? changes.from.name ?? '(none)'}
              </span>
              <ArrowRight className="w-3 h-3 text-tertiary" />
              <span className="font-mono px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300">
                {changes.to.path}
              </span>
              <span className="text-[10.5px] text-tertiary ml-auto">
                Existing aspect work is preserved.
              </span>
            </div>
          )}
          {pendingPick && !changes && (
            <div className="text-xs text-slate-500 italic">
              Pending pick matches the current category — nothing to apply.
            </div>
          )}
          {applyError && (
            <div className="text-xs px-2 py-1.5 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300">
              {applyError}
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={applying}
              className="px-3 py-1.5 text-xs font-medium rounded border border-default dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={apply}
              disabled={!pendingPick || !changes || applying}
              className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {applying ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {applying ? 'Applying…' : 'Apply category'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Mode tab ───────────────────────────────────────────────────────────
function ModeTab({
  active, onClick, icon, label, disabled,
}: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1.5 h-7 px-2.5 rounded transition-colors',
        active
          ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 ring-1 ring-blue-200 dark:ring-blue-800'
          : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

// ── AI suggest panel ───────────────────────────────────────────────────
function AiPanel({
  loading, error, hits, pendingPick, onPick, onRefresh, seedTitle,
}: {
  loading: boolean
  error: string | null
  hits: CategoryHit[]
  pendingPick: CategoryHit | null
  onPick: (h: CategoryHit) => void
  onRefresh: () => void
  seedTitle: string
}) {
  return (
    <div className="p-4 space-y-3">
      <div className="text-xs text-slate-500 flex items-center justify-between">
        <span>
          Seeded with: <span className="font-mono text-slate-700 dark:text-slate-300 truncate">
            {seedTitle ? `"${seedTitle.slice(0, 80)}"` : '(no title — try Search)'}
          </span>
        </span>
        <button type="button" onClick={onRefresh} className="text-blue-600 hover:underline">
          Refresh suggestions
        </button>
      </div>
      {loading && <LoadingRow />}
      {error && <ErrorRow text={error} />}
      {!loading && !error && hits.length === 0 && (
        <EmptyRow text="No suggestions returned. Try Search or refine the listing title." />
      )}
      <ResultsList hits={hits} pendingPick={pendingPick} onPick={onPick} />
    </div>
  )
}

// ── Search panel ───────────────────────────────────────────────────────
function SearchPanel({
  query, onQuery, loading, hits, pendingPick, onPick,
}: {
  query: string
  onQuery: (s: string) => void
  loading: boolean
  hits: CategoryHit[]
  pendingPick: CategoryHit | null
  onPick: (h: CategoryHit) => void
}) {
  return (
    <div className="p-4 space-y-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-tertiary" />
        <input
          type="text"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search categories (e.g. motorcycle helmet, jacket, gloves)…"
          autoFocus
          className="w-full pl-8 pr-3 py-2 text-sm border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
        />
      </div>
      {loading && <LoadingRow />}
      {!loading && query.trim().length >= 2 && hits.length === 0 && (
        <EmptyRow text="No matches. Try a different keyword." />
      )}
      <ResultsList hits={hits} pendingPick={pendingPick} onPick={onPick} />
    </div>
  )
}

// ── Sibling map panel ──────────────────────────────────────────────────
function SiblingsPanel({
  loading, siblings, seedName, activeMarketplace,
}: {
  loading: boolean
  siblings: SiblingHit[]
  seedName: string | null
  activeMarketplace: string
}) {
  return (
    <div className="p-4 space-y-3">
      <div className="text-xs text-slate-500">
        Searching each marketplace for{' '}
        <span className="font-mono text-slate-700 dark:text-slate-300">
          {seedName ?? '(pick a category first)'}
        </span>
        . Apply here saves the {activeMarketplace} category only — visit the
        other marketplaces&apos; cockpit tabs to apply individually.
      </div>
      {loading && <LoadingRow />}
      {!loading && siblings.length === 0 && !seedName && (
        <EmptyRow text="Pick a category in AI suggest or Search first, then this tab fills in." />
      )}
      {!loading && siblings.length > 0 && (
        <div className="space-y-1.5">
          {siblings.map((s) => (
            <div key={s.marketplace} className="flex items-center gap-2 text-xs px-2.5 py-2 rounded border border-subtle dark:border-slate-800">
              <span className="font-mono w-10 text-slate-500">{s.marketplace}</span>
              {s.hit ? (
                <>
                  <span className="font-mono text-slate-700 dark:text-slate-300 truncate flex-1">
                    {s.hit.path}
                  </span>
                  <span className="text-emerald-600 text-[10.5px]">
                    {Math.round(s.hit.matchScore)}%
                  </span>
                </>
              ) : (
                <span className="text-tertiary italic flex-1">No match found</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Shared bits ────────────────────────────────────────────────────────
function ResultsList({
  hits, pendingPick, onPick,
}: { hits: CategoryHit[]; pendingPick: CategoryHit | null; onPick: (h: CategoryHit) => void }) {
  if (hits.length === 0) return null
  return (
    <div className="space-y-1">
      {hits.map((h) => {
        const active = pendingPick?.id === h.id
        return (
          <button
            key={h.id}
            type="button"
            onClick={() => onPick(h)}
            className={cn(
              'w-full text-left px-3 py-2 rounded border transition-colors text-xs',
              active
                ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/40 text-blue-900 dark:text-blue-200'
                : 'border-subtle dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300',
            )}
          >
            <div className="font-medium font-mono truncate">{h.path}</div>
            <div className="text-[10.5px] text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-2">
              <span>id: {h.id}</span>
              <span>·</span>
              <span>{Math.round(h.matchScore)}% match</span>
              {active && <span className="text-emerald-600 ml-auto">Selected</span>}
            </div>
          </button>
        )
      })}
    </div>
  )
}

function LoadingRow() {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500">
      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
    </div>
  )
}
function EmptyRow({ text }: { text: string }) {
  return (
    <div className="text-xs text-tertiary italic px-3 py-2">{text}</div>
  )
}
function ErrorRow({ text }: { text: string }) {
  return (
    <div className="text-xs px-3 py-2 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300">
      {text}
    </div>
  )
}
