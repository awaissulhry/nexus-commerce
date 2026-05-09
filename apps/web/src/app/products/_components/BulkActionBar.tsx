'use client'

/**
 * P.1g — extracted from ProductsWorkspace.tsx as part of the
 * file-decomposition sweep. The bottom-rising Gmail-style bulk
 * action bar (E.4 originally), operating across the workspace's
 * selectedIds set.
 *
 * Owns its own UI state (busy / status string / dropdown opens /
 * compare modal / AI modal) and fetches against the bulk
 * endpoints (/api/products/bulk-status, bulk-duplicate, bulk-tag,
 * /api/listings? + /api/listings/bulk-action). Emits
 * product.updated / product.created / listing.updated /
 * bulk-job.completed invalidations on success — same contract as
 * before.
 *
 * Receives:
 *   - selectedIds: which products are selected
 *   - allTags: tag list for the bulk-tag menu
 *   - onClear: clear selection (close the bar)
 *   - onComplete: refetch + clear selection on the workspace
 *   - productLookup: the workspace's current page so Compare
 *     modal can avoid an extra fetch
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import {
  CheckCircle2,
  EyeOff,
  XCircle,
  Tag as TagIcon,
  ChevronDown,
  Eye,
  Copy,
  GitCompare,
  Sparkles,
  ExternalLink,
  X,
  Trash2,
  RotateCcw,
  Calendar,
  Pencil,
  Folder,
  GitBranch,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useToast } from '@/components/ui/Toast'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { getBackendUrl } from '@/lib/backend-url'
import { COUNTRY_NAMES } from '@/lib/country-names'

// E.3 — lazy modals stay lazy in this file too. Initial bundle
// for the bulk bar stays small; the heavy AI / Compare modal
// chunks only load when the operator opens them.
const AiBulkGenerateModal = dynamic(
  () => import('../_modals/AiBulkGenerateModal'),
  { ssr: false },
)
const CompareProductsModal = dynamic(
  () => import('../_modals/CompareProductsModal'),
  { ssr: false },
)
// F.3.b — bulk-schedule modal. Lazy because the datetime picker +
// kind/payload form is unused on a typical page load.
const ScheduleChangeModal = dynamic(
  () => import('../_modals/ScheduleChangeModal'),
  { ssr: false },
)
// U.28 — bulk "Set field" modal. Closes the loop the HygieneStrip
// opens — operator filters → selects → applies one field set across
// N products via the bulk-set-field endpoint.
const SetFieldModal = dynamic(() => import('../_modals/SetFieldModal'), {
  ssr: false,
})
// W2.13 — bulk attach-family modal. Lazy because the family list +
// detach/attach form is unused on a typical /products page load
// (most operators don't reach for it on every visit).
const AttachFamilyModal = dynamic(
  () => import('../_modals/AttachFamilyModal'),
  { ssr: false },
)
// W3.8 — bulk move-workflow-stage modal. Same lazy rationale as the
// family modal; pulls workflow + stage list at modal-open time.
const MoveWorkflowStageModal = dynamic(
  () => import('../_modals/MoveWorkflowStageModal'),
  { ssr: false },
)

interface Tag {
  id: string
  name: string
  color: string | null
  productCount?: number
}

interface BulkActionProduct {
  id: string
  sku: string
  name: string
}

export function BulkActionBar({
  selectedIds,
  allTags,
  onClear,
  onComplete,
  productLookup,
  showDeleted = false,
}: {
  selectedIds: string[]
  allTags: Tag[]
  onClear: () => void
  onComplete: () => void
  productLookup: BulkActionProduct[]
  /**
   * F.1 — when the workspace is in the recycle-bin lens (?deleted=true),
   * the bar renders a Restore action instead of the Activate/Draft/
   * Inactive/Tag/Publish/AI fill row. Compare stays available so
   * operators can verify which row to restore. Soft-delete is hidden
   * because the rows are already deleted.
   */
  showDeleted?: boolean
}) {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [tagMenuOpen, setTagMenuOpen] = useState(false)
  const [publishMenuOpen, setPublishMenuOpen] = useState(false)
  const [aiModalOpen, setAiModalOpen] = useState(false)
  // P.17 — compare-products modal state. Visible when 2-4 products
  // are in the selection; uses productLookup so no extra fetch.
  const [compareModalOpen, setCompareModalOpen] = useState(false)
  // F.3.b — bulk-schedule modal state. Always available (any
  // selection ≥ 1) in the active scope; hidden in the recycle bin.
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false)
  const [attachFamilyModalOpen, setAttachFamilyModalOpen] = useState(false)
  const [moveStageModalOpen, setMoveStageModalOpen] = useState(false)
  // U.28 — bulk-set-field modal state. Active scope only.
  const [setFieldModalOpen, setSetFieldModalOpen] = useState(false)
  const compareEligible = selectedIds.length >= 2 && selectedIds.length <= 4
  const compareSubjects = useMemo(() => {
    if (!compareEligible) return []
    const byId = new Map(productLookup.map((p) => [p.id, p]))
    return selectedIds
      .map((id) => byId.get(id))
      .filter((p): p is BulkActionProduct => !!p)
  }, [compareEligible, selectedIds, productLookup])
  const tagMenuRef = useRef<HTMLDivElement>(null)
  const pubMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (tagMenuRef.current && !tagMenuRef.current.contains(e.target as Node))
        setTagMenuOpen(false)
      if (pubMenuRef.current && !pubMenuRef.current.contains(e.target as Node))
        setPublishMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  // U.4 — toast feedback for bulk operations. Was a setStatus()
  // string + inline banner that sat in the bulk action bar and
  // auto-cleared after 1.5/3.5s. Replaced with toast() so errors
  // stack instead of overwriting, persist beyond the bar's
  // lifecycle (operator can clear selection + still see the toast),
  // and get aria-live announcement for free.
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true)
    setStatus(label)
    try {
      await fn()
      setStatus(null)
      toast({ tone: 'success', title: label.replace(/…$/, ' done') })
      onComplete()
    } catch (e: unknown) {
      setStatus(null)
      toast({
        tone: 'error',
        title: 'Action failed',
        description: e instanceof Error ? e.message : 'failed',
      })
    } finally {
      setBusy(false)
    }
  }

  const setStatusBulk = async (s: 'ACTIVE' | 'DRAFT' | 'INACTIVE') =>
    run(`Setting ${s}…`, async () => {
      const res = await fetch(`${getBackendUrl()}/api/products/bulk-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: selectedIds, status: s }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      // Phase 10 — broadcast so other open pages refresh.
      emitInvalidation({
        type: 'product.updated',
        meta: { productIds: selectedIds, source: 'bulk-status', status: s },
      })
    })

  // F.1 — soft-delete + restore. Both hit AuditLog server-side so the
  // recycle bin has a who-deleted-when trail. We emit product.updated
  // (not deleted) so the grid simply refetches with its current
  // ?deleted= scope and the rows naturally migrate between views.
  const softDeleteBulk = async () =>
    run('Moving to recycle bin…', async () => {
      const res = await fetch(
        `${getBackendUrl()}/api/products/bulk-soft-delete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productIds: selectedIds }),
        },
      )
      if (!res.ok) throw new Error((await res.json()).error)
      emitInvalidation({
        type: 'product.updated',
        meta: { productIds: selectedIds, source: 'bulk-soft-delete' },
      })
    })

  const restoreBulk = async () =>
    run('Restoring…', async () => {
      const res = await fetch(
        `${getBackendUrl()}/api/products/bulk-restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productIds: selectedIds }),
        },
      )
      if (!res.ok) throw new Error((await res.json()).error)
      emitInvalidation({
        type: 'product.updated',
        meta: { productIds: selectedIds, source: 'bulk-restore' },
      })
    })

  const duplicate = async () =>
    run('Duplicating…', async () => {
      const res = await fetch(`${getBackendUrl()}/api/products/bulk-duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: selectedIds }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      emitInvalidation({
        type: 'product.created',
        meta: { sourceProductIds: selectedIds, source: 'bulk-duplicate' },
      })
    })

  const tagBulk = async (mode: 'add' | 'remove', tagIds: string[]) =>
    run(`${mode === 'add' ? 'Tagging' : 'Untagging'}…`, async () => {
      const res = await fetch(`${getBackendUrl()}/api/products/bulk-tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: selectedIds, tagIds, mode }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      emitInvalidation({
        type: 'product.updated',
        meta: { productIds: selectedIds, source: 'bulk-tag', mode },
      })
    })

  // Publish: enqueue per-channel via /api/listings/bulk-action.
  // For products without an existing ChannelListing on the target channel,
  // user is redirected to the listing-wizard to set it up first.
  const publish = async (channel: string, marketplace: string) =>
    run(`Queuing publish to ${channel} ${marketplace}…`, async () => {
      // Step 1: resolve productIds → listingIds for this channel/marketplace
      const params = new URLSearchParams({
        channel,
        marketplace,
        includeCoverage: 'false',
      })
      // Commit 0 — was `.then((r) => r.json())` with no res.ok check, so
      // a 500 from /api/listings would crash here with an opaque "no
      // existing listings" message (the API error JSON has no
      // `.listings` key, so `(found.listings ?? []).filter(...)` ran on
      // []). Now we surface the real error so the user knows to retry.
      const foundRes = await fetch(
        `${getBackendUrl()}/api/listings?${params.toString()}&pageSize=500`,
      )
      if (!foundRes.ok) {
        const body = await foundRes.json().catch(() => ({}))
        throw new Error(
          body?.error ?? `Failed to load listings (${foundRes.status})`,
        )
      }
      const found = await foundRes.json()
      const ids = (found.listings ?? [])
        .filter((l: { productId: string }) =>
          selectedIds.includes(l.productId),
        )
        .map((l: { id: string }) => l.id)
      if (ids.length === 0)
        throw new Error(
          'No existing listings on this channel — use the listing wizard to create them first',
        )
      const res = await fetch(`${getBackendUrl()}/api/listings/bulk-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'publish', listingIds: ids }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      emitInvalidation({
        type: 'listing.updated',
        meta: {
          listingIds: ids,
          source: 'products-publish',
          channel,
          marketplace,
        },
      })
      emitInvalidation({
        type: 'bulk-job.completed',
        meta: { action: 'publish', listingIds: ids },
      })
    })

  // U.22 — permanent sticky toolbar instead of bottom-rising bar.
  // E.4 floated this at `fixed bottom-4` and only rendered when the
  // selection was non-empty. That hid the affordance until the
  // operator selected rows AND pulled focus to the bottom of the
  // viewport.
  //
  // Salesforce/Airtable pattern: a permanent strip above the rows
  // it acts on. Always visible, always at the same place, count +
  // disabled buttons when nothing selected so the operator sees
  // what's possible before they click. Sticks to the top when the
  // grid scrolls so the actions stay reachable on long lists.
  const hasSelection = selectedIds.length > 0
  const countLabel = hasSelection ? (
    <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-blue-600 text-white text-sm font-semibold tabular-nums">
      <CheckCircle2 size={12} />
      {selectedIds.length}
      <span className="font-normal opacity-90">selected</span>
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-slate-100 text-slate-500 text-sm font-medium tabular-nums dark:bg-slate-800 dark:text-slate-400">
      <CheckCircle2 size={12} className="opacity-50" />
      0 <span className="font-normal opacity-80">selected</span>
      <span className="hidden sm:inline text-slate-400 dark:text-slate-500">
        — tick rows to bulk-edit
      </span>
    </span>
  )

  return (
    <div className="sticky top-0 z-30 -mx-2 px-2 py-1.5 bg-white/95 backdrop-blur border-b border-slate-200 dark:bg-slate-900/95 dark:border-slate-800">
      <div className="flex items-center gap-2 flex-wrap">
        {countLabel}
        <div className="h-4 w-px bg-slate-200 dark:bg-slate-700" />

          {showDeleted ? (
            // F.1 — recycle-bin view. Restore is the only mutation;
            // Compare stays so operators can verify which row to
            // restore. Soft-delete + status flips + tag + publish +
            // AI fill are hidden because they don't make sense for
            // already-deleted rows.
            <Button
              size="sm"
              onClick={restoreBulk}
              disabled={busy || !hasSelection}
              className="bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800 dark:hover:bg-emerald-900/40"
              icon={<RotateCcw size={12} />}
            >
              Restore
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                onClick={() => setStatusBulk('ACTIVE')}
                disabled={busy || !hasSelection}
                className="bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800 dark:hover:bg-emerald-900/40"
                icon={<CheckCircle2 size={12} />}
              >
                Activate
              </Button>
              <Button
                size="sm"
                onClick={() => setStatusBulk('DRAFT')}
                disabled={busy || !hasSelection}
                className="bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-800 dark:hover:bg-slate-700"
                icon={<EyeOff size={12} />}
              >
                Draft
              </Button>
              <Button
                size="sm"
                onClick={() => setStatusBulk('INACTIVE')}
                disabled={busy || !hasSelection}
                className="bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800 dark:hover:bg-rose-900/40"
                icon={<XCircle size={12} />}
              >
                Inactive
              </Button>
              <Button
                size="sm"
                onClick={softDeleteBulk}
                disabled={busy || !hasSelection}
                className="bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800 dark:hover:bg-rose-900/40"
                icon={<Trash2 size={12} />}
                title="Move selected products to the recycle bin (restorable)"
              >
                Delete
              </Button>
            </>
          )}

          {!showDeleted && (
            <>
          <div className="h-4 w-px bg-slate-200 dark:bg-slate-700" />

          <div className="relative" ref={tagMenuRef}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setTagMenuOpen(!tagMenuOpen)}
              disabled={busy || !hasSelection}
              icon={<TagIcon size={12} />}
            >
              Tag <ChevronDown size={10} />
            </Button>
            {tagMenuOpen && (
              <div className="absolute left-0 top-full mt-1 w-64 bg-white border border-slate-200 rounded-md shadow-lg z-30 p-2 max-h-72 overflow-y-auto dark:bg-slate-900 dark:border-slate-800">
                {allTags.length === 0 ? (
                  <div className="text-base text-slate-400 dark:text-slate-500 text-center py-3">
                    No tags yet — create one from a product detail.
                  </div>
                ) : (
                  allTags.map((t) => (
                    <div
                      key={t.id}
                      className="flex items-center justify-between px-2 py-1 hover:bg-slate-50 rounded dark:hover:bg-slate-800"
                    >
                      <span className="text-base text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5">
                        {t.color && (
                          <span
                            className="w-2 h-2 rounded-full"
                            style={{ background: t.color }}
                          />
                        )}
                        {t.name}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => tagBulk('add', [t.id])}
                          className="text-xs text-emerald-600 hover:underline dark:text-emerald-400"
                        >
                          add
                        </button>
                        <button
                          onClick={() => tagBulk('remove', [t.id])}
                          className="text-xs text-rose-600 hover:underline dark:text-rose-400"
                        >
                          remove
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="relative" ref={pubMenuRef}>
            <Button
              size="sm"
              onClick={() => setPublishMenuOpen(!publishMenuOpen)}
              disabled={busy || !hasSelection}
              className="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800 dark:hover:bg-blue-900/40"
              icon={<Eye size={12} />}
            >
              Publish <ChevronDown size={10} />
            </Button>
            {publishMenuOpen && (
              <div className="absolute left-0 top-full mt-1 w-72 bg-white border border-slate-200 rounded-md shadow-lg z-30 p-2 max-h-96 overflow-y-auto dark:bg-slate-900 dark:border-slate-800">
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 px-2 py-1">
                  Amazon EU
                </div>
                {['IT', 'DE', 'FR', 'ES', 'UK'].map((m) => (
                  <button
                    key={`amz-${m}`}
                    onClick={() => {
                      publish('AMAZON', m)
                      setPublishMenuOpen(false)
                    }}
                    className="w-full text-left px-2 py-1 text-base text-slate-700 hover:bg-slate-50 rounded dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    Amazon {m} ({COUNTRY_NAMES[m] ?? m})
                  </button>
                ))}
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 px-2 py-1 mt-2">
                  eBay EU
                </div>
                {['IT', 'DE', 'FR', 'ES', 'UK'].map((m) => (
                  <button
                    key={`ebay-${m}`}
                    onClick={() => {
                      publish('EBAY', m)
                      setPublishMenuOpen(false)
                    }}
                    className="w-full text-left px-2 py-1 text-base text-slate-700 hover:bg-slate-50 rounded dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    eBay {m} ({COUNTRY_NAMES[m] ?? m})
                  </button>
                ))}
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 px-2 py-1 mt-2">
                  Single-store
                </div>
                {['SHOPIFY', 'WOOCOMMERCE', 'ETSY'].map((c) => (
                  <button
                    key={c}
                    onClick={() => {
                      publish(c, 'GLOBAL')
                      setPublishMenuOpen(false)
                    }}
                    className="w-full text-left px-2 py-1 text-base text-slate-700 hover:bg-slate-50 rounded dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    {c.charAt(0) + c.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            )}
          </div>

          <Button
            size="sm"
            variant="secondary"
            onClick={duplicate}
            disabled={busy || !hasSelection}
            icon={<Copy size={12} />}
          >
            Duplicate
          </Button>

          <Button
            size="sm"
            onClick={() => setAiModalOpen(true)}
            disabled={busy || !hasSelection}
            className="bg-purple-50 text-purple-700 border-purple-200 hover:bg-purple-100 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800 dark:hover:bg-purple-900/40"
            title="Generate descriptions / bullets / keywords with AI"
            icon={<Sparkles size={12} />}
          >
            AI fill
          </Button>

          {/* U.28 — set a single field (brand / productType / etc.)
              across all selected products. Closes the loop the
              HygieneStrip opens. */}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setSetFieldModalOpen(true)}
            disabled={busy || !hasSelection}
            title="Set brand / productType / description / fulfillment / threshold / cost / margin across selected products"
            icon={<Pencil size={12} />}
          >
            Set field
          </Button>

          {/* F.3.b — schedule a status flip or price change for a
              future moment. The cron worker applies the change at
              the chosen time via the same master*Service path as a
              live edit. */}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setScheduleModalOpen(true)}
            disabled={busy || !hasSelection}
            title="Defer a status flip or price change to a future timestamp"
            icon={<Calendar size={12} />}
          >
            Schedule
          </Button>

          {/* W2.13 — bulk attach a PIM family (Akeneo-style template).
              Opens a modal that lists existing families + a "Detach"
              option. Hits POST /products/bulk-attach-family which runs
              one $transaction with one AuditLog row per change. */}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAttachFamilyModalOpen(true)}
            disabled={busy || !hasSelection}
            title="Attach or detach a PIM family on selected products"
            icon={<Folder size={12} />}
          >
            Family
          </Button>

          {/* W3.8 — bulk move workflow stage. Opens a modal that lists
              every stage across every workflow (grouped). Server
              rejects cross-workflow moves per-product; the toast
              surfaces partial-failure counts. */}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setMoveStageModalOpen(true)}
            disabled={busy || !hasSelection}
            title="Move selected products to a workflow stage"
            icon={<GitBranch size={12} />}
          >
            Move stage
          </Button>

          {hasSelection ? (
            <Link
              href={`/bulk-operations?productIds=${selectedIds.join(',')}`}
              // U.33 — match Button primitive's size="sm" exactly so
              // the Link sits flush with the surrounding action
              // buttons. Was px-3 + gap-1.5; primitive uses px-2.5 +
              // gap-1.
              className="h-7 px-2.5 text-base bg-violet-50 text-violet-700 border border-violet-200 rounded hover:bg-violet-100 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-800 dark:hover:bg-violet-900/40 inline-flex items-center gap-1"
            >
              <ExternalLink size={12} /> Power edit
            </Link>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled
              title="Select rows first"
              icon={<ExternalLink size={12} />}
            >
              Power edit
            </Button>
          )}
            </>
          )}

          {/* F.1 — Compare stays visible in both views so operators
              can verify which row to delete or restore. */}
          {compareEligible && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setCompareModalOpen(true)}
              disabled={busy || compareSubjects.length < 2}
              title="Side-by-side comparison of selected products"
              icon={<GitCompare size={12} />}
            >
              Compare
            </Button>
          )}

          {status && (
            <span className="text-sm text-slate-500 dark:text-slate-400 ml-2">{status}</span>
          )}
          <IconButton
            aria-label="Clear selection"
            onClick={onClear}
            disabled={busy || !hasSelection}
            size="md"
            className="ml-auto min-h-11 min-w-11 sm:min-h-0 sm:min-w-0"
          >
            <X size={14} />
          </IconButton>
        </div>
      {aiModalOpen && (
        <AiBulkGenerateModal
          productIds={selectedIds}
          productLookup={productLookup}
          onClose={() => setAiModalOpen(false)}
          onComplete={() => {
            setAiModalOpen(false)
            onComplete()
          }}
        />
      )}
      {compareModalOpen && compareSubjects.length >= 2 && (
        <CompareProductsModal
          products={compareSubjects}
          onClose={() => setCompareModalOpen(false)}
        />
      )}
      {scheduleModalOpen && (
        <ScheduleChangeModal
          productIds={selectedIds}
          onClose={() => setScheduleModalOpen(false)}
          onComplete={() => {
            setScheduleModalOpen(false)
            onComplete()
          }}
        />
      )}
      {setFieldModalOpen && (
        <SetFieldModal
          productIds={selectedIds}
          onClose={() => setSetFieldModalOpen(false)}
          onComplete={() => {
            setSetFieldModalOpen(false)
            onComplete()
          }}
        />
      )}
      {attachFamilyModalOpen && (
        <AttachFamilyModal
          productIds={selectedIds}
          onClose={() => setAttachFamilyModalOpen(false)}
          onComplete={() => {
            setAttachFamilyModalOpen(false)
            onComplete()
          }}
        />
      )}
      {moveStageModalOpen && (
        <MoveWorkflowStageModal
          productIds={selectedIds}
          onClose={() => setMoveStageModalOpen(false)}
          onComplete={() => {
            setMoveStageModalOpen(false)
            onComplete()
          }}
        />
      )}
    </div>
  )
}
