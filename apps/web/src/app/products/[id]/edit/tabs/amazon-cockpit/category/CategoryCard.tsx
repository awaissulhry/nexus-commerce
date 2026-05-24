'use client'

// AC.7 — Category & Browse Node card.
//
// Replaces the AC.1 Category placeholder with a real card that reads
// the product's current category state (productType + breadcrumb +
// browse node) and offers two AI-assisted actions:
//
//   • "Detect from Amazon" → GET /api/categories/browse-path. Uses
//     cached detections on existing ChannelListings first, falls back
//     to SP-API searchCatalogItems via a stored ASIN. No keyword
//     required — works against the product's existing productType.
//
//   • "Search alternatives…" → GET /api/categories/suggestions with
//     a keyword. Returns up to 12 (productType, displayName,
//     breadcrumb, browse nodes) suggestions, scored by DB presence
//     and alphabetical tie-break.
//
// AC.7 is intentionally READ + DETECT only. Persisting a chosen
// productType / browseNode still happens through the classic field
// editor (AG-series ChannelFieldEditor) — clicking "Apply" copies the
// value to the clipboard, pushes it to the draft bus for cockpit
// preview re-rendering, and scrolls the operator to the classic
// pane. Direct write-through lands in AC.7.2 follow-up alongside the
// productType setter wiring.

import { useEffect, useRef, useState } from 'react'
import {
  Tag,
  Search,
  Wand2,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Copy,
  ExternalLink,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { setDraftField } from '../../../_shared/draft-bus/useProductDraftBus'

interface BrowsePathResult {
  categoryPath: string | null
  browseNodes: number[] | null
}

interface CategorySuggestion {
  productType: string
  displayName: string
  pathParts: string[]
  browseNodes: number[]
  count: number
}

interface Props {
  productId: string
  productType: string | null
  browseNodeId: string | null
  /** Optional pre-computed breadcrumb from listing.platformAttributes
   *  .detectedCategoryPath. The Detect action overwrites this in
   *  local state when called. */
  categoryPath?: string | null
  marketplace: string
  /** Click-to-jump back to the classic field editor (AG-series).
   *  AC.7 scrolls the operator here after Apply since direct write-
   *  through lands in AC.7.2. */
  onJumpToClassic?: () => void
}

export default function CategoryCard({
  productId,
  productType,
  browseNodeId,
  categoryPath,
  marketplace,
  onJumpToClassic,
}: Props) {
  // Detection state — refreshable via the Detect button.
  const [detected, setDetected] = useState<BrowsePathResult | null>(
    categoryPath || browseNodeId
      ? {
          categoryPath: categoryPath ?? null,
          browseNodes: browseNodeId ? [Number(browseNodeId)].filter(Number.isFinite) : null,
        }
      : null,
  )
  const [detectBusy, setDetectBusy] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)

  // Keyword-search state.
  const [searchOpen, setSearchOpen] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<CategorySuggestion[]>([])

  // Inline toast for "applied" feedback.
  const [appliedFlash, setAppliedFlash] = useState<string | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    }
  }, [])
  function showFlash(msg: string) {
    setAppliedFlash(msg)
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => setAppliedFlash(null), 2200)
  }

  async function handleDetect() {
    if (!productType) {
      setDetectError(
        'Product type is missing — set one in Master / classic first, then re-detect.',
      )
      return
    }
    setDetectBusy(true)
    setDetectError(null)
    try {
      const url = `${getBackendUrl()}/api/categories/browse-path?channel=AMAZON&marketplace=${encodeURIComponent(marketplace)}&productType=${encodeURIComponent(productType)}`
      const res = await fetch(url, { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as BrowsePathResult
      setDetected(json)
      if (!json.categoryPath && (!json.browseNodes || json.browseNodes.length === 0)) {
        setDetectError(
          'Amazon returned no classification for this product type yet — try the keyword search below.',
        )
      }
    } catch (e) {
      setDetectError(e instanceof Error ? e.message : String(e))
    } finally {
      setDetectBusy(false)
    }
  }

  async function handleSearch(e?: React.FormEvent) {
    e?.preventDefault()
    const kw = keyword.trim()
    if (!kw) {
      setSearchError('Type a keyword (e.g. "leather jacket", "helmet").')
      return
    }
    setSearchBusy(true)
    setSearchError(null)
    setSuggestions([])
    try {
      const url = `${getBackendUrl()}/api/categories/suggestions?channel=AMAZON&marketplace=${encodeURIComponent(marketplace)}&keyword=${encodeURIComponent(kw)}`
      const res = await fetch(url, { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { suggestions?: CategorySuggestion[] }
      setSuggestions(json.suggestions ?? [])
      if ((json.suggestions ?? []).length === 0) {
        setSearchError(
          'No matches — try a broader keyword or a different language.',
        )
      }
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e))
    } finally {
      setSearchBusy(false)
    }
  }

  function applySuggestion(s: CategorySuggestion) {
    // Push to the draft bus so the cockpit preview + health card
    // overlay the suggested values immediately. AC.7.2 wires this to
    // a real PATCH; for now the operator finalises by saving in the
    // classic field editor.
    setDraftField(productId, 'productType', s.productType)
    if (s.browseNodes[0] != null) {
      setDraftField(productId, 'browseNodeId', String(s.browseNodes[0]))
    }
    setDetected({
      categoryPath: s.pathParts.join(' › '),
      browseNodes: s.browseNodes,
    })
    void navigator.clipboard
      .writeText(s.productType)
      .catch(() => {})
    showFlash(
      `Applied "${s.displayName}". Type ID copied — save via the classic editor below.`,
    )
    onJumpToClassic?.()
  }

  function applyDetected() {
    if (!detected) return
    if (detected.browseNodes && detected.browseNodes.length > 0) {
      setDraftField(productId, 'browseNodeId', String(detected.browseNodes[0]))
    }
    void navigator.clipboard
      .writeText(detected.browseNodes?.[0]?.toString() ?? '')
      .catch(() => {})
    showFlash(
      'Browse node copied — save via the classic editor below.',
    )
    onJumpToClassic?.()
  }

  return (
    <div
      data-jump-target="category"
      className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 space-y-2.5"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="inline-flex items-center gap-2 min-w-0">
          <Tag className="w-4 h-4 text-slate-500 flex-shrink-0" />
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Category & Browse Node
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Button
            size="sm"
            variant="secondary"
            icon={detectBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
            disabled={detectBusy}
            onClick={handleDetect}
            title="Run Amazon's classifier against this product type"
          >
            {detectBusy ? 'Detecting…' : 'Detect'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Search className="w-3 h-3" />}
            onClick={() => setSearchOpen((o) => !o)}
            title="Search Amazon's product type list by keyword"
          >
            Search…
          </Button>
        </div>
      </div>

      {/* Current state */}
      <div className="rounded border border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 p-2 space-y-1.5">
        <RowMono
          label="Product type"
          value={productType ?? null}
          emptyHint="Pick a product type in the classic editor"
        />
        <RowMono
          label="Browse node"
          value={
            (detected?.browseNodes && detected.browseNodes[0] != null
              ? String(detected.browseNodes[0])
              : null) ??
            browseNodeId ??
            null
          }
          emptyHint="Run Detect to fetch from Amazon"
          extraNodes={
            detected?.browseNodes && detected.browseNodes.length > 1 ? (
              <span className="text-[10.5px] text-slate-500 dark:text-slate-400">
                + {detected.browseNodes.length - 1} more
              </span>
            ) : null
          }
        />
        <RowMono
          label="Category path"
          value={detected?.categoryPath ?? categoryPath ?? null}
          mono={false}
          emptyHint="Set after Detect or AI suggest"
        />
        {detected && (detected.categoryPath || (detected.browseNodes ?? []).length > 0) && (
          <div className="flex items-center gap-2 pt-1 mt-1 border-t border-slate-100 dark:border-slate-800">
            <CheckCircle2 className="w-3 h-3 text-emerald-500" />
            <span className="text-[10.5px] text-emerald-700 dark:text-emerald-400 flex-1">
              Detection ready — apply via the classic editor.
            </span>
            <button
              type="button"
              onClick={applyDetected}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 text-[10.5px] font-medium hover:bg-blue-100 dark:hover:bg-blue-950/60"
            >
              <Copy className="w-3 h-3" /> Copy & jump
            </button>
          </div>
        )}
      </div>

      {/* Detect error */}
      {detectError && (
        <div className="inline-flex items-start gap-1.5 text-[11px] text-rose-700 dark:text-rose-400">
          <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>{detectError}</span>
        </div>
      )}

      {/* Keyword search panel */}
      {searchOpen && (
        <div className="rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/60 p-2 space-y-2">
          <form onSubmit={handleSearch} className="flex items-center gap-1.5">
            <Input
              placeholder="e.g. leather jacket, helmet, gloves…"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              className="text-sm"
              autoFocus
            />
            <Button
              type="submit"
              size="sm"
              icon={searchBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
              disabled={searchBusy || !keyword.trim()}
            >
              {searchBusy ? 'Searching…' : 'Search'}
            </Button>
          </form>

          {searchError && (
            <div className="inline-flex items-start gap-1.5 text-[11px] text-rose-700 dark:text-rose-400">
              <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
              <span>{searchError}</span>
            </div>
          )}

          {suggestions.length > 0 && (
            <ul className="space-y-1">
              {suggestions.map((s) => (
                <li key={s.productType}>
                  <button
                    type="button"
                    onClick={() => applySuggestion(s)}
                    className="w-full text-left rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-blue-400 dark:hover:border-blue-500 hover:bg-blue-50/60 dark:hover:bg-blue-950/30 transition-colors p-2"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {s.displayName}
                      </span>
                      <span className="text-[10.5px] font-mono text-slate-400">
                        {s.productType}
                      </span>
                    </div>
                    {s.pathParts.length > 0 && (
                      <div className="text-[10.5px] text-slate-600 dark:text-slate-400 mt-0.5">
                        {s.pathParts.join(' › ')}
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-1 text-[10px]">
                      {s.browseNodes.length > 0 && (
                        <span className="text-slate-500 dark:text-slate-400">
                          Browse: {s.browseNodes.slice(0, 3).join(', ')}
                          {s.browseNodes.length > 3 ? '…' : ''}
                        </span>
                      )}
                      {s.count >= 2 && (
                        <span className="px-1 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 text-[9px] font-medium uppercase tracking-wide">
                          In your catalog
                        </span>
                      )}
                      <span className="ml-auto text-blue-600 dark:text-blue-400 inline-flex items-center gap-0.5">
                        Apply <ExternalLink className="w-2.5 h-2.5" />
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Flash bar */}
      {appliedFlash && (
        <div className="text-[10.5px] text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded px-2 py-1">
          {appliedFlash}
        </div>
      )}

      <div className="text-[10.5px] text-slate-400 italic">
        AC.7 — direct write-through (productType + browse node setters) lands in AC.7.2; for now Apply copies + jumps.
      </div>
    </div>
  )
}

// ── Small helper row ───────────────────────────────────────────────────
function RowMono({
  label,
  value,
  emptyHint,
  mono = true,
  extraNodes,
}: {
  label: string
  value: string | null
  emptyHint?: string
  mono?: boolean
  extraNodes?: React.ReactNode
}) {
  return (
    <div className="flex items-baseline gap-2 text-[11.5px]">
      <span className="text-slate-500 dark:text-slate-400 w-[88px] flex-shrink-0">
        {label}
      </span>
      <span
        className={cn(
          'flex-1 min-w-0 truncate',
          value
            ? mono
              ? 'font-mono text-slate-900 dark:text-slate-100'
              : 'text-slate-900 dark:text-slate-100'
            : 'text-slate-400 italic',
        )}
        title={value ?? undefined}
      >
        {value || emptyHint}
      </span>
      {extraNodes}
    </div>
  )
}
