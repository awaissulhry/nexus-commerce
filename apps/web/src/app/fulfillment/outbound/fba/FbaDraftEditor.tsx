'use client'

/**
 * A DRAFT on the FBA shipments page (Owner 2026-10-08): the Matrix dialog's form (`FbaSendForm`) on the draft's own SKUs,
 * From, To, day and box, with the live free numbers at From. It saves as the person types (PATCH, 600 ms after the last
 * change; a small "Saved"), "Add SKUs" takes any product (a parent adds its variations), a SKU can be removed, and:
 *
 *     [Delete draft]                          Saved      [Send to Amazon · 120 units]
 *
 * "Send to Amazon" is today's Create plan on the draft: the server checks it with the same shared rules, holds the units
 * at From and starts Amazon's steps; the panel then shows the plan. Returns the parts the host's `Drawer` places.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Plus } from 'lucide-react'

import { FBA_SEND_COPY, type FbaPlanView, type FbaSendDraft, type FbaSendProblem, type FbaSendSku } from '@nexus/shared/fba-send'

import { Banner, DrawerOverlayCard, EmptyState, ResourcePickerDialog } from '@/design-system/components'
import type { MediaChoice } from '@/design-system/lib/media-choice'
import { Button, Skeleton } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { useCommandKey } from '@/lib/command-key'

import { FbaSendForm } from '@/app/products/[id]/edit/_studio/matrix/fba/FbaSendForm'
import {
  deleteDraft, draftSendRequest, draftUpdateRequest, fetchSendDraft, patchDraft, postSendDraft, sendPrimaryOf, startForm, startLines, summarize,
  type SendForm,
} from '@/app/products/[id]/edit/_studio/matrix/fba/sendToFba'
import { PAGE_COPY, productChoices, productSearchUrl } from './fbaShipments'
import styles from './fbaShipments.module.css'

const SAVE_DELAY_MS = 600

export interface FbaDraftEditorOptions {
  /** The draft shown, or null (nothing to render). */
  plan: FbaPlanView | null
  /** "Send to Amazon" answered: the panel reads the plan again (it is QUEUED now). */
  onSent: (planId: string) => void
  /** The draft is gone (deleted here). */
  onDeleted: () => void
  /** The draft changed (saved, a SKU added or removed): the list reads again. */
  onSaved: () => void
}

export interface FbaDraftEditorParts {
  body: ReactNode
  footer: ReactNode | undefined
  overlay: ReactNode | undefined
}

type Save = { state: 'idle' | 'saving' | 'saved' } | { state: 'error'; message: string; code: string | null }

export function useFbaDraftEditor({ plan, onSent, onDeleted, onSaved }: FbaDraftEditorOptions): FbaDraftEditorParts {
  const planId = plan?.id ?? null
  const sendKey = useCommandKey()
  const askTitleId = useId()

  const [draft, setDraft] = useState<FbaSendDraft | null>(null)
  const [form, setForm] = useState<SendForm | null>(null)
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [save, setSave] = useState<Save>({ state: 'idle' })
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<{ message: string; problems: FbaSendProblem[] } | null>(null)
  const [askDelete, setAskDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [pickQuery, setPickQuery] = useState('')
  const [pickChoices, setPickChoices] = useState<MediaChoice[]>([])
  const [pickLoading, setPickLoading] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)
  /** "Add SKUs" found nothing to add (a parent whose variations have no free units at From). */
  const [addNote, setAddNote] = useState<string | null>(null)

  /* ── reading the draft (on opening, after From / To, after SKUs were added or removed) ─────────── */

  const seq = useRef(0)
  const read = useCallback(async (keepTyped: boolean) => {
    if (!planId) return
    const mine = ++seq.current
    setReading(true); setReadError(null)
    try {
      const next = await fetchSendDraft({ productIds: [], planId })
      if (mine !== seq.current) return
      setDraft(next)
      setForm((f) => (f && keepTyped ? { ...f, lines: startLines(next, f.lines) } : { ...startForm(next), lines: startLines(next) }))
    } catch (e) {
      if (mine !== seq.current) return
      setReadError(e instanceof Error ? e.message : String(e))
    } finally {
      if (mine === seq.current) setReading(false)
    }
  }, [planId])

  useEffect(() => {
    setDraft(null); setForm(null); setSave({ state: 'idle' }); setFailure(null); setAskDelete(false); setDeleteError(null)
    if (planId) void read(false)
  }, [planId, read])

  /* ── saving as the person types ─────────────────────────────────────────────────────────────── */

  const pending = useRef<SendForm | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft

  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    const f = pending.current
    const d = draftRef.current
    if (!f || !d || !planId) return true
    pending.current = null
    setSave({ state: 'saving' })
    try {
      const outcome = await patchDraft(planId, draftUpdateRequest(d, f))
      if (!outcome.ok) { setSave({ state: 'error', message: outcome.message, code: outcome.code }); return false }
      setSave({ state: 'saved' })
      onSaved()
      return true
    } catch (e) {
      setSave({ state: 'error', message: e instanceof Error ? e.message : String(e), code: null })
      return false
    }
  }, [planId, onSaved])

  const schedule = useCallback((next: SendForm) => {
    pending.current = next
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void flush() }, SAVE_DELAY_MS)
  }, [flush])
  // Leaving the draft (another row, the panel closed): what was typed is saved first.
  useEffect(() => () => { if (pending.current) void flush() }, [planId]) // eslint-disable-line react-hooks/exhaustive-deps

  const onForm = useCallback((change: (f: SendForm) => SendForm) => {
    setFailure(null)
    setForm((f) => {
      if (!f) return f
      const next = change(f)
      schedule(next)
      return next
    })
  }, [schedule])

  /** From or To changed: saved at once (another draft may already hold that pair: 409), then read again. */
  const move = useCallback(async (change: { from?: string; market?: string }) => {
    if (!planId) return
    await flush()
    setSave({ state: 'saving' })
    const outcome = await patchDraft(planId, change)
    if (!outcome.ok) { setSave({ state: 'error', message: outcome.message, code: outcome.code }); return }
    setSave({ state: 'saved' })
    onSaved()
    await read(true)
  }, [planId, flush, read, onSaved])

  /** The lines now, with a change to the SKUs, saved at once, then read again (the new SKUs' free numbers). */
  const saveLines = useCallback(async (lines: SendForm['lines'], skus: readonly FbaSendSku[]) => {
    if (!planId || !draft || !form) return
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    pending.current = null
    const nextDraft: FbaSendDraft = { ...draft, skus: [...skus] }
    const nextForm: SendForm = { ...form, lines }
    setDraft(nextDraft); setForm(nextForm)
    setSave({ state: 'saving' })
    const outcome = await patchDraft(planId, draftUpdateRequest(nextDraft, nextForm))
    if (!outcome.ok) { setSave({ state: 'error', message: outcome.message, code: outcome.code }); return }
    setSave({ state: 'saved' })
    onSaved()
    await read(true)
  }, [planId, draft, form, read, onSaved])

  const remove = useCallback((sku: FbaSendSku) => {
    if (!draft || !form) return
    const lines = { ...form.lines }
    delete lines[sku.productId]
    void saveLines(lines, draft.skus.filter((s) => s.productId !== sku.productId))
  }, [draft, form, saveLines])

  /* ── "Add SKUs" ──────────────────────────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!picking) return
    const q = pickQuery.trim()
    if (q.length < 2) { setPickChoices([]); setPickLoading(false); return }
    const ctrl = new AbortController()
    setPickLoading(true); setPickError(null)
    const t = setTimeout(() => {
      fetch(`${getBackendUrl()}${productSearchUrl(q)}`, { signal: ctrl.signal })
        .then(async (res) => {
          const body = await res.json().catch(() => null)
          if (!res.ok) throw new Error(`The search did not answer (HTTP ${res.status})`)
          setPickChoices(productChoices(body))
        })
        .catch((e: unknown) => { if (!ctrl.signal.aborted) setPickError(e instanceof Error ? e.message : String(e)) })
        .finally(() => { if (!ctrl.signal.aborted) setPickLoading(false) })
    }, 250)
    return () => { ctrl.abort(); clearTimeout(t) }
  }, [picking, pickQuery])

  const addSkus = useCallback(async (picked: string[]) => {
    setPicking(false)
    setAddNote(null)
    if (!draft || !form || !draft.from) return
    const have = new Set(draft.skus.map((s) => s.productId))
    const wanted = picked.filter((id) => !have.has(id))
    if (wanted.length === 0) return
    try {
      // The server expands a parent into its variations and reads their free numbers at the draft's From.
      const facts = await fetchSendDraft({ productIds: wanted, from: draft.from.code, market: draft.market })
      // A SKU picked by itself is added as it is; a parent adds only its variations with free units at From (the
      // others cannot be sent, and 40 empty rows hide the ones that can).
      const added = facts.skus.filter((s) => !have.has(s.productId) && (wanted.includes(s.productId) || s.free > 0))
      if (added.length === 0) { setAddNote(`No free units of these SKUs at ${draft.from.code}`); return }
      const lines = { ...form.lines }
      for (const s of added) lines[s.productId] = { productId: s.productId, cases: [], looseUnits: 0 }
      await saveLines(lines, [...draft.skus, ...added])
    } catch (e) {
      setSave({ state: 'error', message: e instanceof Error ? e.message : String(e), code: null })
    }
  }, [draft, form, saveLines])

  /* ── Send to Amazon, Delete draft ───────────────────────────────────────────────────────────── */

  const summary = useMemo(() => (draft && form ? summarize(draft, form) : null), [draft, form])
  const primary = summary
    ? sendPrimaryOf(summary, sending ? 'sending' : reading ? 'reading' : save.state === 'saving' ? 'saving' : null)
    : { label: FBA_SEND_COPY.sendToAmazon(0), held: readError ?? 'Reading the warehouse…' }

  const sendNow = useCallback(async () => {
    if (!planId || !draft || !form || primary.held !== null) return
    setSending(true); setFailure(null)
    try {
      if (!(await flush())) return
      const outcome = await postSendDraft(sendKey, planId, draftSendRequest(draft, form))
      if (!outcome.ok) { setFailure({ message: outcome.message, problems: outcome.problems }); return }
      onSent(outcome.planId)
    } catch (e) {
      // No answer: the key is kept, so pressing again cannot send a second plan.
      setFailure({ message: e instanceof Error ? e.message : String(e), problems: [] })
    } finally {
      setSending(false)
    }
  }, [planId, draft, form, primary.held, flush, sendKey, onSent])

  const deleteNow = useCallback(async () => {
    if (!planId) return
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    pending.current = null
    setDeleting(true); setDeleteError(null)
    try {
      const outcome = await deleteDraft(planId)
      if (!outcome.ok) { setDeleteError(outcome.message); return }
      setAskDelete(false)
      onDeleted()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeleting(false)
    }
  }, [planId, onDeleted])

  /* ── the parts ───────────────────────────────────────────────────────────────────────────────── */

  if (!plan) return { body: null, footer: undefined, overlay: undefined }

  const busy = sending || deleting
  const heldProps = (reason: string | null) => (reason !== null ? { 'aria-disabled': true as const, className: 'held', title: reason } : {})
  const saveWord = save.state === 'saving' ? 'Saving…' : save.state === 'saved' ? 'Saved' : ''

  const body = !draft || !form ? (
    readError
      ? <Banner tone="danger" title="The draft could not be read" action={<Button size="sm" onClick={() => void read(false)}>{FBA_SEND_COPY.tryAgain}</Button>}>{readError}</Banner>
      : (
        <div className={styles.loading} role="status" aria-label="Reading the draft">
          <Skeleton height={28} /><Skeleton height={14} /><Skeleton height={14} width="90%" />
        </div>
      )
  ) : (
    <div className={styles.draft}>
      {addNote && <Banner tone="info" onDismiss={() => setAddNote(null)}>{addNote}</Banner>}
      {save.state === 'error' && (
        <Banner tone="danger" title={save.code === 'DRAFT_EXISTS' ? 'Another draft has this From and To' : 'The draft was not saved'}>{save.message}</Banner>
      )}
      {failure && (
        <Banner tone="danger" title="The plan was not sent">
          {failure.problems.length ? [failure.message, ...failure.problems.map((x) => x.message)].join(' · ') : failure.message}
        </Banner>
      )}
      <FbaSendForm
        draft={draft} form={form} summary={summary} disabled={busy} reading={reading} maxHeight={480}
        onFrom={(code) => { void move({ from: code }) }}
        onMarket={(market) => { void move({ market }) }}
        onForm={onForm}
        onRemove={remove}
        tableActions={(
          <div className={styles.tableActions}>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setPickQuery(''); setPickChoices([]); setPicking(true) }}>
              <Plus size={14} aria-hidden="true" /> {FBA_SEND_COPY.addSkus}
            </Button>
          </div>
        )}
        emptyState={<EmptyState title="No SKU in this draft" description={`${FBA_SEND_COPY.addSkus} adds any product; Send to FBA… in a Matrix does too.`} />}
      />
      <ResourcePickerDialog
        open={picking} title={PAGE_COPY.pickTitle} noun={PAGE_COPY.pickNoun} choices={pickChoices} initialSelected={[]}
        search="remote" query={pickQuery} onQueryChange={setPickQuery} searchPlaceholder={PAGE_COPY.pickSearch}
        loading={pickLoading} error={pickError}
        onDone={(values) => { void addSkus(values) }} onCancel={() => setPicking(false)}
      />
    </div>
  )

  const footer = (
    <div className={styles.footer}>
      <Button size="md" variant="danger-outline" onClick={() => { setDeleteError(null); setAskDelete(true) }} {...heldProps(busy ? 'Working…' : null)}>
        {FBA_SEND_COPY.deleteDraft}
      </Button>
      <span className="grow" />
      <span className={styles.saved} role="status">{saveWord}</span>
      <Button size="md" variant="primary" onClick={() => { void sendNow() }} title={primary.held ?? primary.label} {...heldProps(primary.held)}>{primary.label}</Button>
    </div>
  )

  const overlay = askDelete ? (
    <DrawerOverlayCard role="alertdialog" labelledBy={askTitleId} onCancel={deleting ? undefined : () => setAskDelete(false)}>
      <div className={styles.overlayBody}>
        <h3 id={askTitleId} className={styles.overlayTitle}>Delete this draft?</h3>
        <p className={styles.muted}>Nothing is at Amazon and no unit is held. The SKUs leave the draft.</p>
      </div>
      {deleteError && <Banner tone="danger" title="The draft was not deleted">{deleteError}</Banner>}
      <div className={styles.overlayActions}>
        <Button size="md" autoFocus disabled={deleting} onClick={() => setAskDelete(false)}>Keep draft</Button>
        <Button size="md" variant="danger" disabled={deleting} onClick={() => { void deleteNow() }}>{deleting ? 'Deleting…' : FBA_SEND_COPY.deleteDraft}</Button>
      </div>
    </DrawerOverlayCard>
  ) : undefined

  return { body, footer, overlay }
}
