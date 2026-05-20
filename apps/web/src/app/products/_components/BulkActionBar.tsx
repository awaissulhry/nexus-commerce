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
  Globe,
  Sparkles,
  ExternalLink,
  X,
  Trash2,
  AlertTriangle,
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
import { useTranslations } from '@/lib/i18n/use-translations'

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
  const { t } = useTranslations()
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
  const [availabilityModalOpen, setAvailabilityModalOpen] = useState(false)
  // F.1 — hard-delete confirm. Two-step so a stray click in the
  // recycle bin can't wipe rows.
  const [hardDeleteConfirmOpen, setHardDeleteConfirmOpen] = useState(false)
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
    // W5.17 — keyboard equivalent of the outside-click dismiss. Without
    // this Escape didn't close the menu for screen-reader / keyboard
    // users (WCAG 2.1.2 No Keyboard Trap edge case + 2.4.3 Focus
    // Order). Refocusing the trigger button keeps the user oriented.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (tagMenuOpen) {
        setTagMenuOpen(false)
        ;(tagMenuRef.current?.querySelector('button') as HTMLButtonElement | null)?.focus()
      }
      if (publishMenuOpen) {
        setPublishMenuOpen(false)
        ;(pubMenuRef.current?.querySelector('button') as HTMLButtonElement | null)?.focus()
      }
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [tagMenuOpen, publishMenuOpen])

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

  // D.5 — Restore copy explicitly calls out that soft-delete never
  // touched the channel side, so the products are still live on
  // Amazon/eBay/Shopify exactly as they were. (Hard-delete with
  // channelAction=unpublish/delete is the path that touches channels,
  // and that's irreversible by design — no restore possible.)
  const restoreBulk = async () => {
    setBusy(true)
    setStatus(t('products.hardDelete.restoring'))
    try {
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
      setStatus(null)
      toast({
        tone: 'success',
        title: t(
          selectedIds.length === 1
            ? 'products.restore.title.one'
            : 'products.restore.title.other',
          { count: selectedIds.length },
        ),
        description: t('products.restore.body'),
      })
      onComplete()
    } catch (e: unknown) {
      setStatus(null)
      toast({
        tone: 'error',
        title: t('products.hardDelete.restoreFailed'),
        description: e instanceof Error ? e.message : 'failed',
      })
    } finally {
      setBusy(false)
    }
  }

  // F.1 — permanent hard-delete from the recycle bin. API enforces
  // deletedAt != null, so this only fires once rows are already
  // soft-deleted. Emits product.deleted so other open pages (PDP,
  // related pickers, replenishment) drop the rows without a refetch.
  const hardDeleteBulk = async (channelAction: 'none' | 'unpublish' | 'delete' = 'none') =>
    run('Permanently deleting…', async () => {
      const res = await fetch(
        `${getBackendUrl()}/api/products/bulk-hard-delete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productIds: selectedIds, channelAction }),
        },
      )
      if (!res.ok) throw new Error((await res.json()).error)
      emitInvalidation({
        type: 'product.deleted',
        meta: { productIds: selectedIds, source: 'bulk-hard-delete', channelAction },
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
    <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-slate-100 text-slate-700 text-sm font-medium tabular-nums dark:bg-slate-800 dark:text-slate-300">
      <CheckCircle2 size={12} className="opacity-60" />
      0 <span className="font-normal opacity-80">selected</span>
      <span className="hidden sm:inline text-slate-500 dark:text-slate-400">
        — tick rows to bulk-edit
      </span>
    </span>
  )

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="sticky top-0 z-30 -mx-2 px-2 py-1.5 bg-white/95 backdrop-blur border-b border-slate-200 dark:bg-slate-900/95 dark:border-slate-800"
    >
      <div className="flex items-center gap-2 flex-wrap">
        {countLabel}
        <div className="h-4 w-px bg-slate-200 dark:bg-slate-700" />

          {showDeleted ? (
            // F.1 — recycle-bin view. Restore + permanent delete are
            // the only mutations; Compare stays so operators can
            // verify which row to act on. Status flips + tag +
            // publish + AI fill are hidden because they don't make
            // sense for already-deleted rows.
            <>
              <Button
                size="sm"
                onClick={restoreBulk}
                disabled={busy || !hasSelection}
                className="bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800 dark:hover:bg-emerald-900/40"
                icon={<RotateCcw size={12} />}
              >
                Restore
              </Button>
              <Button
                size="sm"
                onClick={() => setHardDeleteConfirmOpen(true)}
                disabled={busy || !hasSelection}
                className="bg-rose-600 text-white border-rose-600 hover:bg-rose-700 dark:bg-rose-700 dark:border-rose-700 dark:hover:bg-rose-800"
                icon={<Trash2 size={12} />}
                title="Permanently delete selected products and all dependent data — cannot be undone"
              >
                Delete permanently
              </Button>
            </>
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
              aria-haspopup="menu"
              aria-expanded={tagMenuOpen}
            >
              Tag <ChevronDown size={10} />
            </Button>
            {tagMenuOpen && (
              <div
                role="menu"
                aria-label="Tag actions"
                className="absolute left-0 top-full mt-1 w-64 bg-white border border-slate-200 rounded-md shadow-lg z-30 p-2 max-h-72 overflow-y-auto dark:bg-slate-900 dark:border-slate-800"
              >
                {allTags.length === 0 ? (
                  <div className="text-base text-slate-500 dark:text-slate-400 text-center py-3">
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
                          role="menuitem"
                          onClick={() => tagBulk('add', [t.id])}
                          aria-label={`Add tag ${t.name} to selected products`}
                          className="text-xs text-emerald-700 hover:underline dark:text-emerald-300"
                        >
                          add
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => tagBulk('remove', [t.id])}
                          aria-label={`Remove tag ${t.name} from selected products`}
                          className="text-xs text-rose-700 hover:underline dark:text-rose-300"
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
              aria-haspopup="menu"
              aria-expanded={publishMenuOpen}
            >
              Publish <ChevronDown size={10} />
            </Button>
            {publishMenuOpen && (
              <div
                role="menu"
                aria-label="Publish destinations"
                className="absolute left-0 top-full mt-1 w-72 bg-white border border-slate-200 rounded-md shadow-lg z-30 p-2 max-h-96 overflow-y-auto dark:bg-slate-900 dark:border-slate-800"
              >
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 px-2 py-1">
                  Amazon EU
                </div>
                {['IT', 'DE', 'FR', 'ES', 'UK'].map((m) => (
                  <button
                    key={`amz-${m}`}
                    role="menuitem"
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
                    role="menuitem"
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
                    role="menuitem"
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

          {/* MA.1 — bulk offer availability: pause or activate offers
              across selected products for specific channel+market combos */}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAvailabilityModalOpen(true)}
            disabled={busy || !hasSelection}
            title="Pause or activate offers on specific channels and markets for all selected products"
            icon={<Globe size={12} />}
          >
            Availability
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
      {availabilityModalOpen && (
        <BulkAvailabilityModal
          productIds={selectedIds}
          onClose={() => setAvailabilityModalOpen(false)}
          onComplete={() => { setAvailabilityModalOpen(false); onComplete() }}
        />
      )}
      {hardDeleteConfirmOpen && (
        <HardDeleteConfirmModal
          count={selectedIds.length}
          productIds={selectedIds}
          productLookup={productLookup.filter((p) => selectedIds.includes(p.id))}
          busy={busy}
          onCancel={() => setHardDeleteConfirmOpen(false)}
          onConfirm={async (channelAction) => {
            setHardDeleteConfirmOpen(false)
            await hardDeleteBulk(channelAction)
          }}
        />
      )}
    </div>
  )
}

interface PreflightWarnings {
  channelListings: Array<{ productId: string; channel: string; marketplace: string | null; externalListingId: string }>
  openOrders: Array<{ productId: string; orderId: string; channelOrderId: string; channel: string; status: string }>
  activeBundles: Array<{ productId: string; bundleId: string; role: 'master' | 'component' }>
  fbaInventory: Array<{ productId: string; marketplaceId: string; fulfillmentCenterId: string; quantity: number; condition: string }>
}

// D.4 — hard-delete confirm. Three-channelAction radio (Local-only /
// Unpublish / Delete-on-channel), pre-flight warnings panel (channel
// listings + open orders + active bundles + FBA stranded inventory),
// and a typed-DELETE confirmation. The radio defaults to 'unpublish'
// when any channel listing exists, 'none' otherwise (no listings to
// touch). All paths still walk the same backend cascade — only the
// payload differs.
function HardDeleteConfirmModal({
  count,
  productIds,
  productLookup,
  busy,
  onCancel,
  onConfirm,
}: {
  count: number
  productIds: string[]
  productLookup: BulkActionProduct[]
  busy: boolean
  onCancel: () => void
  onConfirm: (channelAction: 'none' | 'unpublish' | 'delete') => void
}) {
  const { t } = useTranslations()
  const [typed, setTyped] = useState('')
  const [preflight, setPreflight] = useState<PreflightWarnings | null>(null)
  const [preflightLoading, setPreflightLoading] = useState(true)
  const [preflightError, setPreflightError] = useState<string | null>(null)
  const [channelAction, setChannelAction] = useState<'none' | 'unpublish' | 'delete'>('unpublish')

  useEffect(() => {
    let cancelled = false
    setPreflightLoading(true)
    setPreflightError(null)
    fetch(
      `${getBackendUrl()}/api/products/hard-delete-preflight?ids=${productIds.join(',')}`,
      { cache: 'no-store' },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `${res.status} ${res.statusText}`)
        return res.json()
      })
      .then((data: PreflightWarnings) => {
        if (cancelled) return
        setPreflight(data)
        // Sensible default: if there are no channel listings, "Local-only"
        // is the right choice; if there are listings, "Unpublish" is the
        // safer non-destructive default.
        setChannelAction(data.channelListings.length === 0 ? 'none' : 'unpublish')
      })
      .catch((e) => {
        if (cancelled) return
        setPreflightError(e?.message ?? 'Failed to load preflight')
      })
      .finally(() => {
        if (!cancelled) setPreflightLoading(false)
      })
    return () => { cancelled = true }
  }, [productIds.join(',')])

  const armed = typed.trim().toUpperCase() === 'DELETE'
  const preview = productLookup.slice(0, 8)
  const overflow = Math.max(0, count - preview.length)

  // Group channel listings by channel for compact summary.
  const channelSummary = (preflight?.channelListings ?? []).reduce<Record<string, number>>(
    (acc, l) => {
      const key = `${l.channel}${l.marketplace ? ` · ${l.marketplace}` : ''}`
      acc[key] = (acc[key] ?? 0) + 1
      return acc
    },
    {},
  )

  const hasListings = (preflight?.channelListings.length ?? 0) > 0
  const hasOpenOrders = (preflight?.openOrders.length ?? 0) > 0
  const hasBundles = (preflight?.activeBundles.length ?? 0) > 0
  const hasFba = (preflight?.fbaInventory.length ?? 0) > 0

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={busy ? undefined : onCancel}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hard-delete-title"
        className="relative bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-rose-200 dark:border-rose-900 w-full max-w-2xl max-h-[90vh] flex flex-col"
      >
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
          <h2
            id="hard-delete-title"
            className="text-lg font-semibold text-rose-700 dark:text-rose-300 inline-flex items-center gap-2"
          >
            <Trash2 size={16} />
            {t(
              count === 1
                ? 'products.hardDelete.title.one'
                : 'products.hardDelete.title.other',
              { count },
            )}
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            {t('products.hardDelete.body')}
          </p>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1">
          {/* Affected SKUs */}
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">
              {t('products.hardDelete.affectedSkus')}
            </div>
            <div className="max-h-32 overflow-y-auto rounded border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-800">
              {preview.map((p) => (
                <div
                  key={p.id}
                  className="px-3 py-1.5 text-sm flex items-center justify-between gap-2"
                >
                  <span className="font-mono text-slate-700 dark:text-slate-300 shrink-0">{p.sku}</span>
                  <span className="text-slate-500 dark:text-slate-400 truncate">{p.name}</span>
                </div>
              ))}
              {overflow > 0 && (
                <div className="px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400">{t('products.hardDelete.andNMore', { count: overflow })}</div>
              )}
            </div>
          </div>

          {/* Pre-flight warnings */}
          {preflightLoading && (
            <div className="text-sm text-slate-500 dark:text-slate-400">{t('products.hardDelete.preflightLoading')}</div>
          )}
          {preflightError && (
            <div className="rounded border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
              {t('products.hardDelete.preflightError', { error: preflightError })}
            </div>
          )}
          {!preflightLoading && preflight && (
            <div className="space-y-2">
              {hasListings && (
                <div className="rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 px-3 py-2">
                  <div className="text-sm font-medium text-blue-900 dark:text-blue-200">
                    {t(
                      preflight!.channelListings.length === 1
                        ? 'products.hardDelete.warning.listings.one'
                        : 'products.hardDelete.warning.listings.other',
                      { count: preflight!.channelListings.length },
                    )}
                  </div>
                  <ul className="mt-1 text-xs text-blue-900 dark:text-blue-200 space-y-0.5">
                    {Object.entries(channelSummary).map(([key, n]) => (
                      <li key={key}>
                        <span className="font-mono">{key}</span> · {t(
                          n === 1
                            ? 'products.hardDelete.warning.skusSuffix.one'
                            : 'products.hardDelete.warning.skusSuffix.other',
                          { count: n },
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {hasOpenOrders && (
                <div className="rounded border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 px-3 py-2">
                  <div className="text-sm font-medium text-rose-900 dark:text-rose-200 inline-flex items-center gap-1.5">
                    <AlertTriangle size={13} />
                    {t(
                      preflight!.openOrders.length === 1
                        ? 'products.hardDelete.warning.openOrders.one'
                        : 'products.hardDelete.warning.openOrders.other',
                      { count: preflight!.openOrders.length },
                    )}
                  </div>
                  <p className="mt-1 text-xs text-rose-900 dark:text-rose-200">
                    {t('products.hardDelete.warning.openOrdersBody')}
                  </p>
                </div>
              )}
              {hasBundles && (
                <div className="rounded border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2">
                  <div className="text-sm font-medium text-amber-900 dark:text-amber-200 inline-flex items-center gap-1.5">
                    <AlertTriangle size={13} />
                    {t(
                      preflight!.activeBundles.length === 1
                        ? 'products.hardDelete.warning.bundles.one'
                        : 'products.hardDelete.warning.bundles.other',
                      { count: preflight!.activeBundles.length },
                    )}
                  </div>
                  <p className="mt-1 text-xs text-amber-900 dark:text-amber-200">
                    {t('products.hardDelete.warning.bundlesBody')}
                  </p>
                </div>
              )}
              {hasFba && (
                <div className="rounded border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2">
                  <div className="text-sm font-medium text-amber-900 dark:text-amber-200 inline-flex items-center gap-1.5">
                    <AlertTriangle size={13} />
                    {t('products.hardDelete.warning.fba')}
                  </div>
                  <p className="mt-1 text-xs text-amber-900 dark:text-amber-200">
                    {t('products.hardDelete.warning.fbaBody')}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Channel-action radio */}
          {hasListings && (
            <fieldset className="space-y-2">
              <legend className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                {t('products.hardDelete.channelAction.legend')}
              </legend>
              <label className={`flex items-start gap-2 rounded border p-2 cursor-pointer ${channelAction === 'unpublish' ? 'border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/40' : 'border-slate-200 dark:border-slate-700'}`}>
                <input
                  type="radio"
                  name="channelAction"
                  value="unpublish"
                  checked={channelAction === 'unpublish'}
                  onChange={() => setChannelAction('unpublish')}
                  className="mt-0.5"
                  disabled={busy}
                />
                <span>
                  <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('products.hardDelete.channelAction.unpublish.label')}</span>
                  <span className="block text-xs text-slate-600 dark:text-slate-400">{t('products.hardDelete.channelAction.unpublish.body')}</span>
                </span>
              </label>
              <label className={`flex items-start gap-2 rounded border p-2 cursor-pointer ${channelAction === 'delete' ? 'border-rose-300 bg-rose-50 dark:border-rose-700 dark:bg-rose-950/40' : 'border-slate-200 dark:border-slate-700'}`}>
                <input
                  type="radio"
                  name="channelAction"
                  value="delete"
                  checked={channelAction === 'delete'}
                  onChange={() => setChannelAction('delete')}
                  className="mt-0.5"
                  disabled={busy}
                />
                <span>
                  <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('products.hardDelete.channelAction.delete.label')}</span>
                  <span className="block text-xs text-slate-600 dark:text-slate-400">{t('products.hardDelete.channelAction.delete.body')}</span>
                </span>
              </label>
              <label className={`flex items-start gap-2 rounded border p-2 cursor-pointer ${channelAction === 'none' ? 'border-slate-400 bg-slate-50 dark:border-slate-500 dark:bg-slate-800' : 'border-slate-200 dark:border-slate-700'}`}>
                <input
                  type="radio"
                  name="channelAction"
                  value="none"
                  checked={channelAction === 'none'}
                  onChange={() => setChannelAction('none')}
                  className="mt-0.5"
                  disabled={busy}
                />
                <span>
                  <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('products.hardDelete.channelAction.none.label')}</span>
                  <span className="block text-xs text-slate-600 dark:text-slate-400">{t('products.hardDelete.channelAction.none.body')}</span>
                </span>
              </label>
            </fieldset>
          )}

          <label className="block text-sm text-slate-700 dark:text-slate-300">
            {t('products.hardDelete.confirmTypePrefix')} <span className="font-mono font-semibold">{t('products.hardDelete.confirmPlaceholder')}</span> {t('products.hardDelete.confirmTypeSuffix')}
            <input
              type="text"
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={busy}
              className="mt-1 w-full px-3 py-1.5 border border-slate-300 rounded text-sm font-mono focus:outline-none focus:ring-2 focus:ring-rose-500 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
              placeholder={t('products.hardDelete.confirmPlaceholder')}
            />
          </label>
        </div>

        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-2 flex-shrink-0">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {t('products.hardDelete.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => onConfirm(channelAction)}
            disabled={!armed || busy}
            loading={busy}
            className="bg-rose-600 hover:bg-rose-700 border-rose-600 text-white disabled:bg-rose-300 disabled:border-rose-300"
            icon={<Trash2 size={12} />}
          >
            {channelAction === 'delete' ? t('products.hardDelete.submit.delete') :
             channelAction === 'unpublish' ? t('products.hardDelete.submit.unpublish') :
             t('products.hardDelete.submit.none')}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── MA.1 Bulk Availability Modal ───────────────────────────────────────────────
const MARKETS = [
  { channel: 'AMAZON', marketplace: 'IT', label: 'Amazon IT' },
  { channel: 'AMAZON', marketplace: 'DE', label: 'Amazon DE' },
  { channel: 'AMAZON', marketplace: 'FR', label: 'Amazon FR' },
  { channel: 'AMAZON', marketplace: 'ES', label: 'Amazon ES' },
  { channel: 'AMAZON', marketplace: 'UK', label: 'Amazon UK' },
  { channel: 'EBAY',   marketplace: 'IT', label: 'eBay IT' },
  { channel: 'EBAY',   marketplace: 'DE', label: 'eBay DE' },
  { channel: 'EBAY',   marketplace: 'FR', label: 'eBay FR' },
  { channel: 'EBAY',   marketplace: 'ES', label: 'eBay ES' },
  { channel: 'SHOPIFY', marketplace: 'GLOBAL', label: 'Shopify' },
]

function BulkAvailabilityModal({
  productIds,
  onClose,
  onComplete,
}: {
  productIds: string[]
  onClose: () => void
  onComplete: () => void
}) {
  const { toast } = useToast()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [offerActive, setOfferActive] = useState<boolean>(false)
  const [busy, setBusy] = useState(false)

  const marketKey = (m: { channel: string; marketplace: string }) => `${m.channel}:${m.marketplace}`

  const toggle = (key: string) =>
    setSelected((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })

  const apply = async () => {
    if (selected.size === 0) return
    setBusy(true)
    try {
      const markets = MARKETS.filter((m) => selected.has(marketKey(m))).map(({ channel, marketplace }) => ({ channel, marketplace }))
      const res = await fetch(`${getBackendUrl()}/api/products/bulk-offer-availability`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds, markets, offerActive }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const { upserted } = await res.json()
      toast({ tone: 'success', title: `${upserted} listing${upserted !== 1 ? 's' : ''} ${offerActive ? 'activated' : 'paused'}` })
      // Surface the listing flip on /products + every other open page.
      // Without the invalidation the modal would close but the grid's
      // channelCount / coverage badges would stay stale until the next
      // 30s poll.
      emitInvalidation({
        type: 'listing.updated',
        meta: { productIds, source: 'bulk-offer-availability', upserted, offerActive },
      })
      emitInvalidation({
        type: 'product.updated',
        meta: { productIds, source: 'bulk-offer-availability' },
      })
      onComplete()
    } catch (e: any) {
      toast({ tone: 'error', title: 'Failed', description: e?.message ?? String(e) })
    } finally {
      setBusy(false)
    }
  }

  // Quick-select shortcuts
  const selectNonIT = () => setSelected(new Set(MARKETS.filter((m) => m.marketplace !== 'IT').map(marketKey)))
  const selectAll = () => setSelected(new Set(MARKETS.map(marketKey)))
  const clearAll = () => setSelected(new Set())

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div className="relative bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-md">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Market Availability</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{productIds.length} product{productIds.length !== 1 ? 's' : ''} selected</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Action */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setOfferActive(false)}
              className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-colors ${!offerActive ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-700 dark:bg-rose-950/40 dark:text-rose-300' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-300'}`}
            >
              Pause offers
            </button>
            <button
              type="button"
              onClick={() => setOfferActive(true)}
              className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-colors ${offerActive ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-300'}`}
            >
              Activate offers
            </button>
          </div>

          {/* Market selection */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Target markets</span>
              <div className="flex gap-2">
                <button type="button" onClick={selectNonIT} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Non-IT</button>
                <button type="button" onClick={selectAll} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">All</button>
                <button type="button" onClick={clearAll} className="text-xs text-slate-500 hover:underline">Clear</button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {MARKETS.map((m) => {
                const key = marketKey(m)
                const checked = selected.has(key)
                return (
                  <label key={key} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border cursor-pointer transition-colors text-sm ${checked ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-300'}`}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(key)} className="rounded" />
                    {m.label}
                  </label>
                )
              })}
            </div>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            onClick={apply}
            loading={busy}
            disabled={selected.size === 0}
            className={offerActive ? '' : 'bg-rose-600 hover:bg-rose-700 border-rose-600 text-white'}
          >
            {offerActive ? 'Activate' : 'Pause'} {selected.size > 0 ? `(${selected.size} market${selected.size !== 1 ? 's' : ''})` : ''}
          </Button>
        </div>
      </div>
    </div>
  )
}
