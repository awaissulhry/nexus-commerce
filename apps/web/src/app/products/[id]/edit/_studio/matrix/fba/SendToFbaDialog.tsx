'use client'

/**
 * Send to FBA (Step 4 part E1, Owner 2026-10-07: "super simple", the Products page's Available pop-up + the PSIE dialog
 * pattern; Owner 2026-10-08: it fills a DRAFT). The toolbar's `Send to FBA…` opens it on the ticked SKUs:
 *
 *     Send to FBA · 6 SKUs                                         ✕
 *     the shared form (`FbaSendForm`): From · To · Ready, Prep by / Labels by, the SKU table, the box, the problems,
 *     ONE summary line                       [Cancel] [Add to draft · 120 units]
 *
 * "Add to draft" puts these SKUs into the ONE open draft for that From + To (made when none): no Amazon call, no hold.
 * The table starts from the draft's numbers for SKUs it already holds; a SKU set back to 0 leaves the draft. The dialog
 * closes and the Matrix shows "Added to draft · Open · Undo"; the FBA shipments page (Fulfillment › Outbound) sends the
 * draft. Nothing here computes a box, a count or a refusal: `sendToFba.ts` hands the shared rules the person's choice.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

import { FBA_SEND_COPY, type FbaDraftAddRequest, type FbaSendDraft, type FbaSendProblem } from '@nexus/shared/fba-send'

import { Banner, Modal } from '@/design-system/components'
import { Button, Skeleton } from '@/design-system/primitives'

import { FbaSendForm } from './FbaSendForm'
import {
  addPrimaryOf, addedUnits, draftAddRequest, draftUndoRequest, fetchSendDraft, postDraftAdd, startForm, startLines, summarize,
  type CreateOutcome, type DraftQuery, type SendForm,
} from './sendToFba'
import styles from './fba.module.css'
import dialogs from '../dialogs.module.css'
import { useFocusOffClose } from '../dialogFocus'

export interface SendToFbaTarget {
  /** The SKUs to send (variations; a ticked parent = every variation). */
  productIds: string[]
  /** The family's SKU, under the title. */
  subtitle?: string
}

/** What "Add to draft" did: the draft, the units put in, and how to put the draft back (Undo). */
export interface SendToFbaAdded {
  planId: string
  units: number
  /** This add made the draft (there was none for this From + To). */
  made: boolean
  /** The Undo: these SKUs back to the numbers the draft held for them. */
  undo: FbaDraftAddRequest
  /** The SKUs this add touched (the stock pages re-read them). */
  productIds: string[]
}

export interface SendToFbaApi {
  readDraft: (q: DraftQuery, signal?: AbortSignal) => Promise<FbaSendDraft>
  add: (req: FbaDraftAddRequest) => Promise<CreateOutcome>
}
const ROUTES: SendToFbaApi = {
  readDraft: (q, signal) => fetchSendDraft(q, { signal }),
  add: (req) => postDraftAdd(req),
}

/** Mounted once per opening (the page renders it only while it is open): every choice starts from the server's draft. */
export interface SendToFbaDialogProps {
  target: SendToFbaTarget
  /** The routes; injectable for a test. */
  api?: Partial<SendToFbaApi>
  /** Closed — with what "Add to draft" did, or null when nothing was added. */
  onClose: (added: SendToFbaAdded | null) => void
}

export function SendToFbaDialog(p: SendToFbaDialogProps) {
  const api: SendToFbaApi = { ...ROUTES, ...p.api }
  const bodyRef = useRef<HTMLDivElement>(null)

  const [query, setQuery] = useState<DraftQuery>(() => ({ productIds: p.target.productIds }))
  const [draft, setDraft] = useState<FbaSendDraft | null>(null)
  const [reading, setReading] = useState(true)
  const [readError, setReadError] = useState<string | null>(null)
  const [form, setForm] = useState<SendForm | null>(null)
  const [adding, setAdding] = useState(false)
  const [failure, setFailure] = useState<{ message: string; problems: FbaSendProblem[] } | null>(null)
  const focused = useRef(false)
  useFocusOffClose()

  /* The draft: on opening, and again when From or To changes (what was typed stays for the SKUs still there). */
  useEffect(() => {
    const ctrl = new AbortController()
    setReading(true); setReadError(null)
    api.readDraft(query, ctrl.signal).then(
      (next) => {
        if (ctrl.signal.aborted) return
        setDraft(next)
        setForm((f) => (f ? { ...f, lines: startLines(next, f.lines) } : startForm(next)))
        setReading(false)
      },
      (e: unknown) => {
        if (ctrl.signal.aborted) return
        setReadError(e instanceof Error ? e.message : String(e))
        setReading(false)
      },
    )
    return () => ctrl.abort()
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  /* The first stepper takes the focus once the table is there (the grid draws its rows a moment after the draft lands):
     a keyboard opening can type at once. Never taken from a control the person already moved to. Not on a phone: the
     grid scrolls a focused cell into view and the SKU column left the screen (measured at 390 px, 2026-10-07). */
  useEffect(() => {
    if (focused.current || !draft || reading) return
    if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 599px)').matches) { focused.current = true; return }
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const attempt = () => {
      const body = bodyRef.current
      const first = body?.querySelector<HTMLInputElement>('[data-fba-step]')
      const active = typeof document !== 'undefined' ? document.activeElement : null
      if (first && !(active instanceof HTMLInputElement && body?.contains(active))) { focused.current = true; first.focus(); first.select(); return }
      if (first || ++tries > 20) return
      timer = setTimeout(attempt, 50)
    }
    attempt()
    return () => { if (timer) clearTimeout(timer) }
  }, [draft, reading])

  const summary = useMemo(() => (draft && form ? summarize(draft, form) : null), [draft, form])
  const primary = summary && draft && form
    ? addPrimaryOf(summary, draft, form, adding ? 'adding' : reading ? 'reading' : null)
    : { label: FBA_SEND_COPY.addToDraft(0), held: reading ? 'Reading the warehouse…' : readError }

  const add = async () => {
    if (!draft || !form || primary.held !== null) return
    const req = draftAddRequest(draft, form)
    if (!req) return
    setAdding(true); setFailure(null)
    try {
      const outcome = await api.add(req)
      if (!outcome.ok) { setFailure({ message: outcome.message, problems: outcome.problems }); return }
      p.onClose({
        planId: outcome.planId,
        units: addedUnits(req),
        made: draft.draftId === null,
        undo: draftUndoRequest(draft, req),
        productIds: req.lines.map((l) => l.productId),
      })
    } catch (e) {
      setFailure({ message: e instanceof Error ? e.message : String(e), problems: [] })
    } finally {
      setAdding(false)
    }
  }

  const close = () => { if (!adding) p.onClose(null) }

  let body
  if (!draft || !form) {
    body = readError
      ? <Banner tone="danger" title="The send could not be read" action={<Button size="sm" variant="secondary" onClick={() => setQuery((q) => ({ ...q }))}>Try again</Button>}>{readError}</Banner>
      : (
        <div className={styles.loading} role="status" aria-label="Reading the SKUs at the warehouse">
          <Skeleton height={28} /><Skeleton height={14} /><Skeleton height={14} width="90%" /><Skeleton height={14} width="75%" />
        </div>
      )
  } else {
    body = (
      <>
        {readError && <Banner tone="danger" title="The send could not be read again">{readError}</Banner>}
        {failure && (
          <Banner tone="danger" title="The draft was not saved">
            {failure.problems.length ? [failure.message, ...failure.problems.map((x) => x.message)].join(' · ') : failure.message}
          </Banner>
        )}
        <FbaSendForm
          draft={draft} form={form} summary={summary} disabled={adding} reading={reading}
          onFrom={(code) => setQuery((q) => ({ ...q, from: code }))}
          onMarket={(market) => setQuery((q) => ({ ...q, market }))}
          onForm={(change) => { setForm((f) => (f ? change(f) : f)); setFailure(null) }}
        />
      </>
    )
  }

  const heldProps = (reason: string | null) => (reason !== null ? { 'aria-disabled': true as const, className: 'held', title: reason } : {})
  const footer = (
    <>
      <span className={styles.status} role="status">{draft && primary.held !== 'Adding…' ? primary.held ?? '' : ''}</span>
      <span className="grow" />
      <Button size="sm" variant="secondary" onClick={close} {...heldProps(adding ? 'Adding…' : null)}>Cancel</Button>
      <Button size="sm" variant="primary" onClick={() => { void add() }} title={primary.held ?? primary.label} {...heldProps(primary.held)}>{primary.label}</Button>
    </>
  )

  const skus = draft?.skus.length ?? p.target.productIds.length
  // "<Thing> · <SKU>" like the other Matrix pop-ups (Matrix polish, Owner 2026-10-08); several SKUs say how many.
  const title = draft?.skus.length === 1 ? `${FBA_SEND_COPY.open.replace(/…$/, '')} · ${draft.skus[0]!.sku}` : FBA_SEND_COPY.title(skus)
  return (
    <Modal open onClose={close} size="xl" className={dialogs.box} title={title} subtitle={p.target.subtitle} footer={footer}>
      <div ref={bodyRef} className={styles.body}>{body}</div>
    </Modal>
  )
}
