'use client'

/**
 * P.4 — extracted from ProductsWorkspace.tsx (was lines 1346-1897).
 *
 * F4 — bulk AI content generation modal.
 *
 * Opens from the bulk-action bar's "AI fill" with one or more
 * selected products. Phase machine:
 *
 *   configure → (previewFirst?) → preview → applying → done
 *                            \→ applying → done   (skip preview)
 *
 * Configure: marketplace + which fields + previewFirst toggle.
 * Preview: dry-run results per product (description / bullets /
 *   keywords / title) with per-row checkboxes. Default-accepts every
 *   successful row so a user can one-click apply if they like
 *   everything. Failures show inline; you can apply only the
 *   successes.
 * Applying: spinner while the second call (dryRun=false) runs over
 *   the accepted ids only.
 * Done: aggregate counts + per-product errors. Successful writes
 *   emit product.updated so other pages refresh.
 *
 * The dryRun flag is on POST /api/products/ai/bulk-generate; we
 * route through the same endpoint twice rather than holding state
 * server-side. Re-running on accepted ids re-pays the AI cost — but
 * Gemini is cheap and the user explicitly opted in.
 */

import { useMemo, useState } from 'react'
import { Sparkles, X, Loader2, AlertCircle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'

type AiPhase = 'configure' | 'preview' | 'applying' | 'done'

interface AiPreviewResult {
  productId: string
  ok: boolean
  error?: string
  generated?: {
    title?: { content: string }
    bullets?: { content: string[] }
    description?: { content: string }
    keywords?: { content: string }
    /** P.13 — provider added so the per-card footer can show
     *  "anthropic · claude-3-5-sonnet" instead of just the model
     *  name. The bulk-generate response already populated this. */
    metadata?: { language?: string; model?: string; provider?: string }
  }
}

/**
 * Subset of ProductRow this modal needs — id + label fields. Defined
 * locally so the modal doesn't need to know about the full grid row
 * type.
 */
export interface AiTargetProduct {
  id: string
  name?: string | null
  sku?: string | null
}

export default function AiBulkGenerateModal({
  productIds,
  productLookup,
  onClose,
  onComplete,
}: {
  productIds: string[]
  /**
   * Currently-loaded grid rows; used to label preview cards with
   * the product's name+sku rather than a raw uuid. Selected ids
   * not present in the lookup (e.g., paginated off-screen) fall
   * back to the truncated id.
   */
  productLookup: AiTargetProduct[]
  onClose: () => void
  onComplete: () => void
}) {
  const lookupById = useMemo(() => {
    const m = new Map<string, AiTargetProduct>()
    for (const p of productLookup) m.set(p.id, p)
    return m
  }, [productLookup])
  const [phase, setPhase] = useState<AiPhase>('configure')
  const [marketplace, setMarketplace] = useState('IT')
  const [fields, setFields] = useState<Set<string>>(
    new Set(['description', 'bullets']),
  )
  // F4 follow-through — preview-first is the safe default. Toggle off
  // for the v1 flow (write immediately, no review).
  const [previewFirst, setPreviewFirst] = useState(true)
  const [busy, setBusy] = useState(false)
  const [previewResults, setPreviewResults] = useState<AiPreviewResult[]>([])
  // Per-product accept set — only checked products' generated content
  // gets applied in the second-pass write.
  const [acceptedIds, setAcceptedIds] = useState<Set<string>>(new Set())
  const [results, setResults] = useState<
    Array<{ productId: string; ok: boolean; error?: string }> | null
  >(null)
  // P.13 — surface per-batch cost so the operator sees what they
  // spent. The summary is populated by the bulk-generate response on
  // both the dry-run and apply legs, so we can show "spent $0.04 on
  // 8 previews" before the operator commits + the final spend on
  // done.
  const [summary, setSummary] = useState<{
    totalCostUSD?: number
    totalInputTokens?: number
    totalOutputTokens?: number
    providersUsed?: string[]
    modelsUsed?: string[]
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const toggleField = (f: string) =>
    setFields((s) => {
      const next = new Set(s)
      if (next.has(f)) next.delete(f)
      else next.add(f)
      return next
    })

  const toggleAccept = (id: string) =>
    setAcceptedIds((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const callBackend = async (ids: string[], dryRun: boolean) => {
    const res = await fetch(
      `${getBackendUrl()}/api/products/ai/bulk-generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productIds: ids,
          marketplace: marketplace.toUpperCase(),
          fields: Array.from(fields),
          dryRun,
        }),
      },
    )
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error ?? `HTTP ${res.status}`)
    }
    return (await res.json()) as {
      results: AiPreviewResult[]
      summary?: {
        totalCostUSD?: number
        totalInputTokens?: number
        totalOutputTokens?: number
        providersUsed?: string[]
        modelsUsed?: string[]
      }
    }
  }

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      if (previewFirst) {
        const json = await callBackend(productIds, true)
        setPreviewResults(json.results ?? [])
        setSummary(json.summary ?? null)
        setAcceptedIds(
          new Set(
            (json.results ?? [])
              .filter((r) => r.ok)
              .map((r) => r.productId),
          ),
        )
        setPhase('preview')
      } else {
        const json = await callBackend(productIds, false)
        setResults(json.results ?? [])
        setSummary(json.summary ?? null)
        const succeeded = (json.results ?? []).filter((r) => r.ok)
        if (succeeded.length > 0) {
          emitInvalidation({
            type: 'product.updated',
            meta: {
              productIds: succeeded.map((r) => r.productId),
              source: 'ai-bulk-generate',
              marketplace,
              fields: Array.from(fields),
            },
          })
        }
        setPhase('done')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    if (acceptedIds.size === 0) {
      setError('Select at least one product to apply.')
      return
    }
    setBusy(true)
    setError(null)
    setPhase('applying')
    try {
      const json = await callBackend(Array.from(acceptedIds), false)
      setResults(json.results ?? [])
      setSummary(json.summary ?? null)
      const succeeded = (json.results ?? []).filter((r) => r.ok)
      if (succeeded.length > 0) {
        emitInvalidation({
          type: 'product.updated',
          meta: {
            productIds: succeeded.map((r) => r.productId),
            source: 'ai-bulk-apply',
            marketplace,
            fields: Array.from(fields),
          },
        })
      }
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('preview')
    } finally {
      setBusy(false)
    }
  }

  const succeededCount = results?.filter((r) => r.ok).length ?? 0
  const failedCount = results?.filter((r) => !r.ok).length ?? 0
  const fieldOptions: Array<{ id: string; label: string; help: string }> = [
    { id: 'description', label: 'Description', help: 'Long-form product copy' },
    { id: 'bullets', label: 'Bullet points', help: '5 marketing bullets' },
    { id: 'keywords', label: 'Keywords', help: 'SEO / backend keywords' },
    { id: 'title', label: 'Title (overwrites name)', help: 'Use cautiously' },
  ]

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 flex items-start justify-center pt-[12vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-lg shadow-2xl w-[560px] max-w-[92vw] overflow-hidden border border-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-600" />
            <h2 className="text-lg font-semibold text-slate-900">
              AI generate content
            </h2>
            <span className="text-sm text-slate-500">
              {productIds.length} product{productIds.length === 1 ? '' : 's'}
            </span>
          </div>
          <IconButton
            onClick={onClose}
            aria-label="Close"
            size="md"
            className="text-slate-400 hover:text-slate-600"
          >
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        {phase === 'configure' && (
          <div className="p-5 space-y-4">
            <div>
              <label className="text-sm font-semibold text-slate-700 uppercase tracking-wider block mb-1">
                Marketplace
              </label>
              <input
                type="text"
                value={marketplace}
                onChange={(e) => setMarketplace(e.target.value.toUpperCase())}
                placeholder="IT"
                className="w-32 h-8 px-2 text-base border border-slate-200 rounded-md bg-white focus:outline-none focus:border-blue-300 uppercase"
              />
              <p className="text-sm text-slate-500 mt-1">
                Drives the language + per-marketplace terminology (IT, DE,
                FR, ES, UK, US, NL, SE, PL, CA, MX).
              </p>
            </div>

            <div>
              <label className="text-sm font-semibold text-slate-700 uppercase tracking-wider block mb-1">
                Generate which fields?
              </label>
              <div className="space-y-1.5 mt-1">
                {fieldOptions.map((opt) => (
                  <label
                    key={opt.id}
                    className="flex items-start gap-2 text-base text-slate-700 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={fields.has(opt.id)}
                      onChange={() => toggleField(opt.id)}
                      className="mt-0.5"
                    />
                    <div>
                      <div>{opt.label}</div>
                      <div className="text-sm text-slate-500">{opt.help}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <label className="flex items-start gap-2 text-base text-slate-700 cursor-pointer pt-1 border-t border-slate-100">
              <input
                type="checkbox"
                checked={previewFirst}
                onChange={() => setPreviewFirst((v) => !v)}
                className="mt-0.5"
              />
              <div>
                <div>Preview before applying (recommended)</div>
                <div className="text-sm text-slate-500">
                  Show the AI output for every product first; you pick which
                  ones to write. Off = write immediately, no review.
                </div>
              </div>
            </label>

            {error && (
              <div className="border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800 flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
              <span className="text-sm text-slate-500">
                {previewFirst
                  ? `Will generate previews for ${productIds.length} product${productIds.length === 1 ? '' : 's'} — no writes yet.`
                  : 'Writes immediately — overwrites any existing content in the selected fields.'}
              </span>
              <Button
                onClick={run}
                disabled={busy || fields.size === 0 || !marketplace}
                loading={busy}
                className="bg-purple-600 text-white border-purple-600 hover:bg-purple-700"
                icon={<Sparkles className="w-3 h-3" />}
              >
                {busy
                  ? previewFirst
                    ? 'Generating preview…'
                    : 'Generating…'
                  : previewFirst
                    ? 'Generate preview'
                    : 'Generate & apply'}
              </Button>
            </div>
          </div>
        )}

        {phase === 'preview' && (
          <div className="flex flex-col max-h-[70vh]">
            <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between gap-3 flex-shrink-0">
              <div className="text-base text-slate-700">
                <span className="font-medium">
                  {previewResults.filter((r) => r.ok).length} preview
                  {previewResults.filter((r) => r.ok).length === 1 ? '' : 's'}
                </span>{' '}
                generated
                {previewResults.filter((r) => !r.ok).length > 0 && (
                  <>
                    ,{' '}
                    <span className="text-rose-700">
                      {previewResults.filter((r) => !r.ok).length} failed
                    </span>
                  </>
                )}
                . Pick what to apply.
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setAcceptedIds(
                      new Set(
                        previewResults.filter((r) => r.ok).map((r) => r.productId),
                      ),
                    )
                  }
                >
                  Select all
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setAcceptedIds(new Set())}
                >
                  Clear
                </Button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              {previewResults.map((r) => {
                const product = lookupById.get(r.productId)
                const label = product
                  ? `${product.name ?? '—'} · ${product.sku ?? r.productId.slice(0, 8)}`
                  : r.productId.slice(0, 12)
                if (!r.ok) {
                  return (
                    <div
                      key={r.productId}
                      className="border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800 flex items-start gap-2"
                    >
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                      <div className="min-w-0">
                        <div className="font-medium truncate">{label}</div>
                        <div className="text-sm">{r.error}</div>
                      </div>
                    </div>
                  )
                }
                const accepted = acceptedIds.has(r.productId)
                const g = r.generated
                return (
                  <div
                    key={r.productId}
                    className={`border rounded-md ${
                      accepted
                        ? 'border-purple-300 bg-purple-50/40'
                        : 'border-slate-200 bg-white'
                    }`}
                  >
                    <label className="flex items-start gap-2 px-3 py-2 cursor-pointer border-b border-slate-100">
                      <input
                        type="checkbox"
                        checked={accepted}
                        onChange={() => toggleAccept(r.productId)}
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-base font-medium text-slate-900 truncate">
                          {label}
                        </div>
                        {g?.metadata?.language && (
                          <div className="text-xs text-slate-500">
                            {g.metadata.language}
                            {g.metadata.provider ? ` · ${g.metadata.provider}` : ''}
                            {g.metadata.model ? ` · ${g.metadata.model}` : ''}
                          </div>
                        )}
                      </div>
                    </label>
                    <div className="px-3 py-2 space-y-2 text-base text-slate-700">
                      {g?.title && (
                        <div>
                          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-0.5">
                            Title
                          </div>
                          <div className="whitespace-pre-wrap">
                            {g.title.content}
                          </div>
                        </div>
                      )}
                      {g?.description && (
                        <div>
                          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-0.5">
                            Description
                          </div>
                          <div className="whitespace-pre-wrap line-clamp-6">
                            {g.description.content}
                          </div>
                        </div>
                      )}
                      {g?.bullets && g.bullets.content.length > 0 && (
                        <div>
                          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-0.5">
                            Bullets
                          </div>
                          <ul className="list-disc pl-4 space-y-0.5">
                            {g.bullets.content.map((b, i) => (
                              <li key={i}>{b}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {g?.keywords && (
                        <div>
                          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-0.5">
                            Keywords
                          </div>
                          <div className="text-slate-600">
                            {g.keywords.content}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {error && (
              <div className="mx-5 mb-3 border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800 flex items-start gap-2 flex-shrink-0">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between gap-3 flex-shrink-0">
              <Button
                variant="ghost"
                onClick={() => {
                  setPhase('configure')
                  setPreviewResults([])
                  setAcceptedIds(new Set())
                  setError(null)
                }}
              >
                Back
              </Button>
              <Button
                onClick={apply}
                disabled={busy || acceptedIds.size === 0}
                className="bg-purple-600 text-white border-purple-600 hover:bg-purple-700"
                icon={<Sparkles className="w-3 h-3" />}
              >
                Apply {acceptedIds.size} selected
              </Button>
            </div>
          </div>
        )}

        {phase === 'applying' && (
          <div className="p-8 flex flex-col items-center justify-center gap-2 text-base text-slate-700">
            <Loader2 className="w-5 h-5 animate-spin text-purple-600" />
            <div>
              Writing {acceptedIds.size} product
              {acceptedIds.size === 1 ? '' : 's'}…
            </div>
          </div>
        )}

        {phase === 'done' && results && (
          <div className="p-5 space-y-3">
            <div className="text-base text-slate-700">
              {succeededCount} succeeded
              {failedCount > 0 && (
                <span className="text-rose-700">, {failedCount} failed</span>
              )}
              .
            </div>
            {/* P.13 — cost + provider visibility. AiUsageLog already
                records every call server-side; this surfaces the
                same numbers in-modal so operators see what each
                bulk run cost without leaving for /settings/ai. */}
            {summary && (
              <div className="border border-slate-200 bg-slate-50 rounded-md p-2 text-sm text-slate-700 space-y-0.5">
                {typeof summary.totalCostUSD === 'number' && (
                  <div>
                    Spent{' '}
                    <span className="font-semibold tabular-nums">
                      ${summary.totalCostUSD.toFixed(4)}
                    </span>
                    {typeof summary.totalInputTokens === 'number' &&
                      typeof summary.totalOutputTokens === 'number' && (
                        <span className="text-slate-500">
                          {' '}
                          ({summary.totalInputTokens.toLocaleString()} in /{' '}
                          {summary.totalOutputTokens.toLocaleString()} out tokens)
                        </span>
                      )}
                  </div>
                )}
                {summary.providersUsed && summary.providersUsed.length > 0 && (
                  <div className="text-slate-500">
                    via{' '}
                    {summary.providersUsed.join(', ')}
                    {summary.modelsUsed && summary.modelsUsed.length > 0 && (
                      <> · {summary.modelsUsed.join(', ')}</>
                    )}
                  </div>
                )}
              </div>
            )}
            {failedCount > 0 && (
              <ul className="border border-rose-200 bg-rose-50 rounded-md p-2 max-h-48 overflow-y-auto text-sm text-rose-800 space-y-1">
                {results
                  .filter((r) => !r.ok)
                  .map((r) => (
                    <li key={r.productId}>
                      <span className="font-mono">{r.productId.slice(0, 12)}</span>{' '}
                      — {r.error}
                    </li>
                  ))}
              </ul>
            )}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={onComplete}
                className="h-8 px-3 text-base bg-slate-900 text-white rounded-md hover:bg-slate-800"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
