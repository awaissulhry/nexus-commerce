'use client'

/**
 * The Listings page's bulk bar (step 6 of docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md): while rows are ticked
 * the toolbar says what is selected and which listings an action reaches, and offers
 *
 *   Publish…               the Publish window (its own review and gates) on the selected products, starting on the
 *                          destinations in scope
 *   Set price…             `POST /api/listings/bulk-action` `set-price` — a store or market page, one currency, a DS
 *                          confirm that says there is no undo; each price waits 30 s in the price queue
 *   Follow master          `follow-master` — its confirm says there is no undo (it clears each listing's own price)
 *   ⋯ Stop following master  `unfollow-master`, with the 30-second Undo the legacy page has (`../bulk-undo.ts`)
 *   ⋯ Translate selected…  the Translate window on these products, in the Language filter's language (Nexus only)
 *
 * The decisions and words are `listingsBulk.ts`'s. The reach is the API's (`POST …/readiness/listing-ids`), asked
 * whenever the selection or the scope changes and again on the click, so the confirm counts what is really sent. The
 * API's own refusal (403 permission, 409, a limit) is shown as it is. No bulk Resync and no "Refresh from channel"
 * (see the plan). The same Publish window serves the row menu (`publish`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Languages, Link2, MoreHorizontal, Send, Tag, Unlink } from 'lucide-react'
import type { ReadinessDestination } from '@nexus/shared/listing-readiness'

import { usePermission } from '@/lib/auth/AuthProvider'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { Button, Input } from '@/design-system/primitives'
import { Field, Menu, Modal, useActionConfirm, useToast, type MenuItemDef } from '@/design-system/components'
import { GridSelectionActions, SelectionLabel, SelectionNote } from '@/design-system/grid'
import { languageLabel } from '@/app/products/[id]/edit/_studio/scopes'
import { TranslateDialog } from '@/app/products/next/TranslateDialog'
import { ProductsPublishDialog } from '@/app/products/_publication/dialog/ProductsPublishDialog'

import { bulkUndoBody, bulkUndoTargets } from '../bulk-undo'
import { listingCall } from './listingCall'
import { errorText, parsePinPrice, refusalText } from './listingDialogModel'
import {
  BULK_REACH_MAX,
  followHeld,
  followMasterConfirm,
  jobFinished,
  jobOutcome,
  jobProgress,
  jobStillRunning,
  placeWords,
  priceDestinations,
  publishHeld,
  publishKeys,
  reachBody,
  reachCurrency,
  reachWords,
  selectionKey,
  setPriceConfirm,
  setPriceHeld,
  translateSelectedScope,
  type BulkJob,
  type BulkPriceAction,
  type BulkSelection,
  type ListingReach,
  type ReachState,
} from './listingsBulk'
import { plural } from './marketChips'
import type { ReadinessLock } from './readinessScope'
import styles from './readiness.module.css'

const REACH_DEBOUNCE_MS = 250
const POLL_MS = 600
const WATCH_MS = 60_000
const UNDO_MS = 30_000
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The API's answer, as the bar reads it: a 403 with its permission named, otherwise its own sentence. */
const refusal = (answer: { status: number; json: unknown }) => refusalText(answer.status, answer.json) ?? errorText(answer.status, answer.json)

async function readReach(body: ReturnType<typeof reachBody>, signal?: AbortSignal): Promise<ReachState> {
  try {
    const answer = await listingCall<ListingReach>('catalog-transfer/readiness/listing-ids', { method: 'POST', body, signal })
    return answer.ok ? { kind: 'counted', reach: answer.json } : { kind: 'failed', error: refusal(answer) }
  } catch (error) {
    return { kind: 'failed', error: message(error) }
  }
}

export interface ListingsBulkInput {
  selection: BulkSelection
  /** The destinations an action reaches (`destinationsInScope`). */
  scope: readonly ReadinessDestination[]
  lock: ReadinessLock | null
  /** The Language filter: what Translate selected writes. */
  language: string
  /** What narrows the page beyond its Filters (step 4's column filters, step 7's problem chip): Translate selected waits. */
  narrowed?: { columnFilters: number; problem: boolean }
  /** Untick every row: Clear, and after a bulk change ran. */
  clear: () => void
}

export interface ListingsBulk {
  /** The toolbar's count while rows are ticked: "12 products selected · reaches 214 listings on Amazon DE". */
  count: ReactNode
  /** The toolbar's actions while rows are ticked (they replace the search box). */
  actions: ReactNode
  /** The windows the bar opens. */
  dialogs: ReactNode
  /** The Publish window on these products, starting on these destinations (the row menu uses it too). */
  publish: (productIds: string[], families: number, keys: readonly string[]) => void
}

export function useListingsBulk({ selection, scope, lock, language, narrowed, clear }: ListingsBulkInput): ListingsBulk {
  const { toast } = useToast()
  const confirm = useActionConfirm()
  const canEditPrice = usePermission('products.price.edit')
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  // ── The reach: asked when the selection or the scope changes, and when listings come or go ──
  const stores = useMemo(() => priceDestinations(scope), [scope])
  const latest = useRef({ selection, stores })
  latest.current = { selection, stores }
  const requestKey = selection.count > 0 ? `${selectionKey(selection)}\u0001${stores.map((d) => d.key).join('\n')}` : ''
  const [listingsMoved, setListingsMoved] = useState(0)
  useInvalidationChannel(['listing.created', 'listing.deleted'], () => setListingsMoved((n) => n + 1))
  const [reach, setReach] = useState<{ key: string; state: ReachState } | null>(null)
  useEffect(() => {
    if (!requestKey) { setReach(null); return }
    const { selection: chosen, stores: here } = latest.current
    if (chosen.count > BULK_REACH_MAX) {
      setReach({ key: requestKey, state: { kind: 'failed', error: `select ${BULK_REACH_MAX.toLocaleString('en')} or fewer products` } })
      return
    }
    setReach((r) => (r?.key === requestKey && r.state.kind === 'counted' ? r : { key: requestKey, state: { kind: 'counting' } }))
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void readReach(reachBody(chosen, here), controller.signal).then((state) => {
        if (!controller.signal.aborted) setReach({ key: requestKey, state })
      })
    }, REACH_DEBOUNCE_MS)
    return () => { clearTimeout(timer); controller.abort() }
  }, [requestKey, listingsMoved])
  const state: ReachState | null = reach && reach.key === requestKey ? reach.state : requestKey ? { kind: 'counting' } : null

  // ── A running bulk change ──
  const [busy, setBusy] = useState<{ action: BulkPriceAction; job: BulkJob | null } | null>(null)
  const busyRef = useRef(false)

  /** Watch a job until it finishes, or for a minute. */
  const watch = useCallback(async (action: BulkPriceAction, jobId: string): Promise<BulkJob | null> => {
    const start = Date.now()
    let last: BulkJob | null = null
    while (alive.current && Date.now() - start < WATCH_MS) {
      await wait(POLL_MS)
      const answer = await listingCall<BulkJob>(`listings/bulk-action/${encodeURIComponent(jobId)}`).catch(() => null)
      if (!answer?.ok) break
      last = answer.json
      if (alive.current) setBusy({ action, job: last })
      if (jobFinished(last)) break
    }
    return last
  }, [])

  /** The Undo of a Stop following master: only what that job changed, each flag back to what it was. */
  const undo = useCallback(async (jobId: string, ids: string[]) => {
    const answer = await listingCall<{ total?: number }>('listings/bulk-action', { body: bulkUndoBody(jobId, ids) }).catch((e: unknown) => ({ ok: false, status: 0, json: { error: message(e) } }))
    if (!answer.ok) { toast(`Undo failed: ${refusal(answer)}`, 'danger', { duration: 10_000 }); return }
    emitInvalidation({ type: 'listing.updated', meta: { action: 'undo', count: ids.length, listingIds: ids, source: 'listings-bulk-undo' } })
    emitInvalidation({ type: 'bulk-job.completed', meta: { action: 'undo', listingIds: ids } })
    const total = typeof (answer.json as { total?: unknown }).total === 'number' ? (answer.json as { total: number }).total : ids.length
    toast(`Putting back ${plural(total, 'listing')} as they were.`, 'success')
  }, [toast])

  /** One bulk change: the reach read again, its hold, its confirm, the existing route, its job, its outcome. */
  const run = useCallback(async (action: BulkPriceAction, payload?: { price: number }) => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      const { selection: chosen, stores: here } = latest.current
      const fresh = await readReach(reachBody(chosen, here))
      const input = { state: fresh, destinations: here, canEditPrice, busy: false }
      const held = action === 'set-price' ? setPriceHeld({ ...input, lock }) : followHeld(input)
      if (held || fresh.kind !== 'counted') { toast(held ?? 'The listings could not be counted.', 'warning', { duration: 10_000 }); return }
      const place = placeWords(here)
      if (action === 'set-price' && payload && !(await confirm.ask(setPriceConfirm(fresh.reach, place, payload.price, reachCurrency(fresh))))) return
      if (action === 'follow-master' && !(await confirm.ask(followMasterConfirm(fresh.reach, place)))) return
      const listingIds = fresh.reach.listingIds
      setBusy({ action, job: null })
      const sent = await listingCall<{ jobId?: string }>('listings/bulk-action', { body: { action, listingIds, ...(payload ? { payload } : {}) } })
        .catch((e: unknown) => ({ ok: false, status: 0, json: { error: message(e) } as unknown as { jobId?: string } }))
      if (!sent.ok || !sent.json.jobId) { toast(refusal(sent), 'danger', { duration: 10_000 }); return }
      const jobId = sent.json.jobId
      const job = await watch(action, jobId)
      // Other open pages (and this grid) read the listings again.
      emitInvalidation({ type: 'listing.updated', meta: { action, count: listingIds.length, listingIds, source: 'listings-bulk' } })
      emitInvalidation({ type: 'bulk-job.completed', meta: { action, listingIds } })
      if (!alive.current) return
      if (!job || !jobFinished(job)) { toast(jobStillRunning(action, job), 'info', { duration: 10_000 }); return }
      const outcome = jobOutcome(action, job)
      const undoIds = bulkUndoTargets(action, job)
      if (undoIds) {
        let used = false
        toast(
          <span className={styles.toastLine}>
            {outcome.text} Undo within 30 seconds.
            <Button size="xs" variant="link" onClick={() => { if (used) return; used = true; void undo(jobId, undoIds) }}>Undo</Button>
          </span>,
          outcome.tone,
          { duration: UNDO_MS },
        )
      } else {
        toast(outcome.text, outcome.tone, outcome.tone === 'success' ? undefined : { duration: 10_000 })
      }
      clear()
    } finally {
      busyRef.current = false
      if (alive.current) setBusy(null)
    }
  }, [canEditPrice, lock, confirm, toast, watch, undo, clear])

  // ── Set price… (the price first, then the confirm) ──
  const [pricing, setPricing] = useState<{ text: string; error: string | null } | null>(null)
  const submitPrice = useCallback(() => {
    if (!pricing) return
    const parsed = parsePinPrice(pricing.text)
    if (!parsed.ok) { setPricing({ ...pricing, error: parsed.reason }); return }
    setPricing(null)
    void run('set-price', { price: parsed.value })
  }, [pricing, run])

  // ── The windows ──
  const [publishing, setPublishing] = useState<{ ids: string[]; families: number; keys: readonly string[] } | null>(null)
  const publish = useCallback((productIds: string[], families: number, keys: readonly string[]) => setPublishing({ ids: productIds, families, keys }), [])
  const [translating, setTranslating] = useState<{ query: Record<string, string>; language: string } | null>(null)

  // ── What each control says ──
  const hold = { state, destinations: stores, canEditPrice, busy: busy !== null }
  const priceHeld = setPriceHeld({ ...hold, lock })
  const followReason = followHeld(hold)
  const publishReason = publishHeld(selection, busy !== null)
  const translate = translateSelectedScope(state, language, narrowed)
  const translateReason = busy ? 'Wait for the last bulk action to finish.' : translate.ok ? null : translate.reason
  const currency = reachCurrency(state)

  const note = busy ? jobProgress(busy.action, busy.job) : state ? reachWords(state, scope) : null
  const count = selection.count > 0 ? (
    <>
      <b>{selection.count.toLocaleString('en')}</b> {selection.count === 1 ? 'product' : 'products'} selected
      {note && <SelectionNote>{' · '}{note}</SelectionNote>}
    </>
  ) : null

  const more: MenuItemDef[] = [
    followReason
      ? { id: 'unfollow', label: 'Stop following master', icon: <Unlink size={13} />, disabled: true, description: followReason }
      : {
        id: 'unfollow', label: 'Stop following master', icon: <Unlink size={13} />,
        description: 'Each listing keeps the price and quantity it shows now as its own. Undo for 30 seconds after.',
        onSelect: () => void run('unfollow-master'),
      },
    translateReason || !translate.ok
      ? { id: 'translate', label: 'Translate selected…', icon: <Languages size={13} />, disabled: true, description: translateReason ?? 'Not available.' }
      : {
        id: 'translate', label: 'Translate selected…', icon: <Languages size={13} />,
        description: `Nexus only: the shared ${languageLabel(language)} text.`,
        onSelect: () => setTranslating({ query: translate.query, language }),
      },
  ]

  const actions = selection.count > 0 ? (
    <GridSelectionActions>
      <Button size="sm" variant="primary" heldReason={publishReason} title="Publish…"
        onClick={() => publish(selection.productIds, selection.families, publishKeys(scope))}>
        <Send size={13} /> <SelectionLabel>Publish…</SelectionLabel>
      </Button>
      <Button size="sm" heldReason={priceHeld} title="Set price…" onClick={() => setPricing({ text: '', error: null })}>
        <Tag size={13} /> <SelectionLabel>Set price…</SelectionLabel>
      </Button>
      <Button size="sm" heldReason={followReason} title="Follow master" onClick={() => void run('follow-master')}>
        <Link2 size={13} /> <SelectionLabel>Follow master</SelectionLabel>
      </Button>
      <Menu
        label={<MoreHorizontal size={15} />}
        items={more}
        align="right"
        triggerProps={{ className: 'nds-btn sm', 'aria-label': 'More bulk actions' }}
      />
      <Button variant="link" size="sm" onClick={clear}>Clear</Button>
    </GridSelectionActions>
  ) : null

  const place = placeWords(stores)
  const dialogs = (
    <>
      {confirm.element}
      {pricing && (
        <Modal
          open
          onClose={() => setPricing(null)}
          size="sm"
          title="Set a price"
          subtitle={state?.kind === 'counted' ? `${plural(state.reach.listingIds.length, 'listing')} on ${place}` : place}
          footer={<>
            <Button onClick={() => setPricing(null)}>Cancel</Button>
            <Button variant="primary" heldReason={priceHeld} onClick={submitPrice}>Review…</Button>
          </>}
        >
          <Field label={`Price${currency ? ` (${currency})` : ''}`} error={pricing.error ?? undefined}
            hint="Each listing stops following the master price and keeps this one. You review it next; there is no undo.">
            <Input inputMode="decimal" autoFocus value={pricing.text}
              onChange={(e) => setPricing({ text: e.target.value, error: null })}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitPrice() } }} />
          </Field>
        </Modal>
      )}
      {publishing && (
        <ProductsPublishDialog
          productIds={publishing.ids}
          familyCount={publishing.families}
          initialKeys={publishing.keys.length ? publishing.keys : undefined}
          onClose={() => setPublishing(null)}
        />
      )}
      {translating && (
        <TranslateDialog open onClose={() => setTranslating(null)} language={translating.language} scope={{ kind: 'readiness', query: translating.query }} />
      )}
    </>
  )

  return { count, actions, dialogs, publish }
}
