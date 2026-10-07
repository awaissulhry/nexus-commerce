'use client'

/**
 * Send to FBA (Step 4 part E1, Owner 2026-10-07: "super simple", the Products page's Available pop-up + the PSIE dialog
 * pattern). The toolbar's `Send to FBA…` opens it on the ticked SKUs:
 *
 *     Send to FBA · 6 SKUs                                         ✕
 *     From [IT-MAIN · Rimini]   To [Amazon IT]   Ready [08/10/2026]
 *     Prep by [Amazon|Seller]   Labels by [Amazon|Seller]          ← only when a SKU has "not set"; saved for those SKUs
 *     SKU · Free · Cases · Units · Boxes · Check                      ← ONE table, 0 by default, Tab / Enter move down
 *     Loose units go in 2 mixed boxes · 60 × 40 × 40 cm   ▸ Change box size
 *     one Banner per kind of problem (the shared `sendProblems`): the plan's under From / To (account, address, day,
 *     box), the SKUs' under the table (listing, free units, EU box limits 63.5 cm / 23 kg, unit weight, …)
 *     2 SKUs · 29 units · 3 boxes · 31.4 kg                          ← ONE summary line, the shared `sendSummary`
 *                                          [Cancel] [Create plan · 120 units]
 *     Done: "Plan sent to Amazon. …"   [Undo]               [Follow it] [Done]
 *
 * Create plan holds the units at From (the server makes the holds) and queues the plan; Undo cancels it (free until the
 * placement is confirmed with Amazon). Nothing here computes a box, a count or a refusal: `sendToFba.ts` hands the
 * shared rules the person's choice, and the server re-checks the create with the same rules.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { FBA_SEND_COPY, type FbaSendDraft, type FbaSendLine, type FbaSendProblem, type FbaSendSku } from '@nexus/shared/fba-send'
import type { CaseOwner } from '@nexus/shared/stock-cases'

import { Banner, DateField, Disclosure, EmptyState, Field, Listbox, Modal } from '@/design-system/components'
// The DS grid's DataGrid (AG Grid, the same props) — the retiring `components/DataGrid` is on the grid-kit ratchet.
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { Button, Input, NumberStepper, Pill, SegmentedControl, Skeleton } from '@/design-system/primitives'
import { useCommandKey } from '@/lib/command-key'

import {
  DONE_COPY, OWNER_OPTIONS, casesMax, createRequest, fetchSendDraft, locationOption, marketOption, ownersAsked, parseSide, postCancelPlan,
  postSendPlan, primaryOf, problemBanners, skuBoxes, skuCheck, startForm, startLines, summarize, summaryLine, unitsMax,
  type CancelOutcome, type CreateOutcome, type DraftQuery, type SendForm,
} from './sendToFba'
import styles from './fba.module.css'

export interface SendToFbaTarget {
  /** The SKUs to send (variations; a ticked parent = every variation). */
  productIds: string[]
  /** The family's SKU, under the title. */
  subtitle?: string
}

/** What the dialog created: the page re-reads, and offers Undo again in a toast when it closes. */
export interface SendToFbaCreated { planId: string; units: number }

export interface SendToFbaApi {
  readDraft: (q: DraftQuery, signal?: AbortSignal) => Promise<FbaSendDraft>
  create: (...args: Parameters<typeof postSendPlan>) => Promise<CreateOutcome>
  cancel: (...args: Parameters<typeof postCancelPlan>) => Promise<CancelOutcome>
}
const ROUTES: SendToFbaApi = {
  readDraft: (q, signal) => fetchSendDraft(q, { signal }),
  create: (...args) => postSendPlan(...args),
  cancel: (...args) => postCancelPlan(...args),
}

/** Mounted once per opening (the page renders it only while it is open): every choice starts from the server's draft. */
export interface SendToFbaDialogProps {
  target: SendToFbaTarget
  /** The routes; injectable for a test. */
  api?: Partial<SendToFbaApi>
  /** Closed — with the plan it created (and whether Undo cancelled it), or null when nothing was created. */
  onClose: (result: { created: SendToFbaCreated; undone: boolean } | null) => void
  /** A plan was created or cancelled: the holds moved the stock, so the page reads again. */
  onChanged: () => void
  /** `Follow it`: the plans drawer on this plan. */
  onFollow: (planId: string) => void
}

type Side = 'lengthCm' | 'widthCm' | 'heightCm'
const SIDES: ReadonlyArray<[Side, string]> = [['lengthCm', 'Length'], ['widthCm', 'Width'], ['heightCm', 'Height']]
const SHOWN_MESSAGES = 4

export function SendToFbaDialog(p: SendToFbaDialogProps) {
  const api: SendToFbaApi = { ...ROUTES, ...p.api }
  const createKey = useCommandKey()
  const cancelKey = useCommandKey()
  const bodyRef = useRef<HTMLDivElement>(null)

  const [query, setQuery] = useState<DraftQuery>(() => ({ productIds: p.target.productIds }))
  const [draft, setDraft] = useState<FbaSendDraft | null>(null)
  const [reading, setReading] = useState(true)
  const [readError, setReadError] = useState<string | null>(null)
  const [form, setForm] = useState<SendForm | null>(null)
  const [sides, setSides] = useState<Record<Side, string>>({ lengthCm: '', widthCm: '', heightCm: '' })
  const [creating, setCreating] = useState(false)
  const [failure, setFailure] = useState<{ message: string; problems: FbaSendProblem[] } | null>(null)
  const [created, setCreated] = useState<SendToFbaCreated | null>(null)
  const [undo, setUndo] = useState<'idle' | 'undoing' | 'undone'>('idle')
  const [undoError, setUndoError] = useState<string | null>(null)
  const focused = useRef(false)

  /* The draft: on opening, and again when From or To changes (what was typed stays for the SKUs still there). */
  useEffect(() => {
    const ctrl = new AbortController()
    setReading(true); setReadError(null)
    api.readDraft(query, ctrl.signal).then(
      (next) => {
        if (ctrl.signal.aborted) return
        setDraft(next)
        setForm((f) => (f ? { ...f, lines: startLines(next, f.lines) } : startForm(next)))
        setSides((s) => (s.lengthCm ? s : { lengthCm: String(next.mixedBox.lengthCm), widthCm: String(next.mixedBox.widthCm), heightCm: String(next.mixedBox.heightCm) }))
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
  const primary = summary ? primaryOf(summary, creating ? 'creating' : reading ? 'reading' : null) : { label: FBA_SEND_COPY.primary(0), held: reading ? 'Reading the warehouse…' : readError }
  const asked = draft ? ownersAsked(draft) : false
  const banners = useMemo(() => (summary ? problemBanners(summary.problems) : []), [summary])

  const setLine = (productId: string, patch: Partial<FbaSendLine>) => {
    setForm((f) => (f ? { ...f, lines: { ...f.lines, [productId]: { ...(f.lines[productId] ?? { productId, cases: 0, looseUnits: 0 }), ...patch, productId } } } : f))
    setFailure(null)
  }
  const setSide = (side: Side, text: string) => {
    setSides((s) => ({ ...s, [side]: text }))
    // An empty or non-numeric side is held as 0: the shared box check names it, and nothing is sent.
    setForm((f) => (f ? { ...f, mixedBox: { ...f.mixedBox, [side]: parseSide(text) ?? 0 } } : f))
    setFailure(null)
  }

  /* Tab / Enter move DOWN a column (the Available pop-up's spreadsheet feel); Shift goes up; past the ends, Tab is Tab. */
  const moveDown = (e: KeyboardEvent<HTMLInputElement>, column: 'cases' | 'units', index: number) => {
    if ((e.key !== 'Tab' && e.key !== 'Enter') || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return
    const next = bodyRef.current?.querySelector<HTMLInputElement>(`[data-fba-step="${column}-${index + (e.shiftKey ? -1 : 1)}"]`)
    if (!next) { if (e.key === 'Enter') e.preventDefault(); return }
    e.preventDefault()
    next.focus()
    next.select()
  }

  const create = async () => {
    if (!draft || !form || primary.held !== null) return
    const req = createRequest(draft, form)
    if (!req) return
    setCreating(true); setFailure(null)
    try {
      const outcome = await api.create(createKey, req)
      if (!outcome.ok) { setFailure({ message: outcome.message, problems: outcome.problems }); return }
      setCreated({ planId: outcome.planId, units: summary?.units ?? 0 })
      p.onChanged()
    } catch (e) {
      // No answer: the key is kept, so pressing again cannot make a second plan.
      setFailure({ message: e instanceof Error ? e.message : String(e), problems: [] })
    } finally {
      setCreating(false)
    }
  }

  const undoPlan = async () => {
    if (!created || undo !== 'idle') return
    setUndo('undoing'); setUndoError(null)
    try {
      const outcome = await api.cancel(cancelKey, created.planId)
      if (!outcome.ok) { setUndoError(outcome.message); setUndo('idle'); return }
      setUndo('undone')
      p.onChanged()
    } catch (e) {
      setUndoError(e instanceof Error ? e.message : String(e))
      setUndo('idle')
    }
  }

  const close = () => {
    if (creating || undo === 'undoing') return
    p.onClose(created ? { created, undone: undo === 'undone' } : null)
  }

  /* ── the table ── */

  const indexOf = useMemo(() => new Map((draft?.skus ?? []).map((s, i) => [s.productId, i])), [draft])
  const columns: Column<FbaSendSku>[] = [
    { key: 'sku', label: FBA_SEND_COPY.columns.sku, width: 250, render: (s) => <span className={styles.sku}>{s.sku}</span> },
    { key: 'free', label: FBA_SEND_COPY.columns.free, width: 96, numeric: true, render: (s) => FBA_SEND_COPY.free(s.free, s.freeSealed) },
    {
      key: 'cases', label: FBA_SEND_COPY.columns.cases, width: 128,
      render: (s) => {
        const max = casesMax(s)
        if (max === null) return <span className={styles.muted}>—</span>
        const line = form?.lines[s.productId]
        return (
          <NumberStepper size="sm" min={0} max={max} value={line?.cases ?? 0} disabled={creating || !!created}
            aria-label={`Cases of ${s.sku}`} decrementLabel={`One case less of ${s.sku}`} incrementLabel={`One case more of ${s.sku}`}
            data-fba-step={`cases-${indexOf.get(s.productId) ?? 0}`} onKeyDown={(e) => moveDown(e, 'cases', indexOf.get(s.productId) ?? 0)}
            onFocus={(e) => e.currentTarget.select()} onChange={(n) => setLine(s.productId, { cases: n })} />
        )
      },
    },
    {
      key: 'units', label: FBA_SEND_COPY.columns.units, width: 128,
      render: (s) => (
        <NumberStepper size="sm" min={0} max={unitsMax(s)} value={form?.lines[s.productId]?.looseUnits ?? 0} disabled={creating || !!created}
          aria-label={`Loose units of ${s.sku}`} decrementLabel={`One unit less of ${s.sku}`} incrementLabel={`One unit more of ${s.sku}`}
          data-fba-step={`units-${indexOf.get(s.productId) ?? 0}`} onKeyDown={(e) => moveDown(e, 'units', indexOf.get(s.productId) ?? 0)}
          onFocus={(e) => e.currentTarget.select()} onChange={(n) => setLine(s.productId, { looseUnits: n })} />
      ),
    },
    { key: 'boxes', label: FBA_SEND_COPY.columns.boxes, width: 96, numeric: true, render: (s) => (summary ? skuBoxes(summary.plan, s.productId) : '—') },
    {
      key: 'check', label: FBA_SEND_COPY.columns.check, width: 200,
      render: (s) => {
        const check = summary ? skuCheck(summary, s.productId, form?.lines[s.productId]) : null
        return check ? <Pill tone={check.tone}>{check.text}</Pill> : null
      },
    },
  ]

  /* ── the parts ── */

  const where = draft && form && (
    <div className={styles.where}>
      <Field label={FBA_SEND_COPY.from}>
        <Listbox size="sm" options={draft.locations.map(locationOption)} value={draft.from?.code} placeholder="Choose a warehouse"
          disabled={creating || !!created} onChange={(code) => setQuery((q) => ({ ...q, from: code }))} />
      </Field>
      <Field label={FBA_SEND_COPY.to}>
        <Listbox size="sm" options={draft.markets.map(marketOption)} value={draft.markets.some((m) => m.code === draft.market) ? draft.market : undefined}
          placeholder={draft.market} disabled={creating || !!created} onChange={(market) => setQuery((q) => ({ ...q, market }))} />
      </Field>
      <Field label={FBA_SEND_COPY.ready}>
        <DateField value={form.readyToShipOn} min={draft.today || undefined} disabled={creating || !!created}
          onChange={(day) => { setForm((f) => (f ? { ...f, readyToShipOn: day } : f)); setFailure(null) }} />
      </Field>
    </div>
  )

  const owners = draft && form && asked && (
    <div className={styles.owners}>
      {(['prepOwner', 'labelOwner'] as const).map((key) => (
        <div key={key} className="nds-field-w">
          <span className="nds-field-lbl" aria-hidden="true">{key === 'prepOwner' ? FBA_SEND_COPY.prepBy : FBA_SEND_COPY.labelsBy}</span>
          <SegmentedControl ariaLabel={key === 'prepOwner' ? FBA_SEND_COPY.prepBy : FBA_SEND_COPY.labelsBy} size="sm" value={form.owners[key]}
            disabled={creating || !!created} options={OWNER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(v) => { setForm((f) => (f ? { ...f, owners: { ...f.owners, [key]: v as CaseOwner } } : f)); setFailure(null) }} />
        </div>
      ))}
      <span className={styles.muted}>{FBA_SEND_COPY.ownersHint}</span>
    </div>
  )

  const box = summary && summary.looseUnits > 0 && (
    <div className={styles.box}>
      {summary.mixedLine && <span>{summary.mixedLine}</span>}
      <Disclosure summary={FBA_SEND_COPY.changeBox}>
        <div className={styles.sides}>
          {SIDES.map(([side, word]) => (
            <Field key={side} label={word}>
              <Input size="sm" inputMode="decimal" autoComplete="off" suffix="cm" value={sides[side]} disabled={creating || !!created}
                aria-invalid={parseSide(sides[side]) === null ? true : undefined} onChange={(e) => setSide(side, e.target.value)} />
            </Field>
          ))}
        </div>
      </Disclosure>
    </div>
  )

  /* ONE summary line (Owner): what Create plan sends, as the shared rules count it. */
  const totals = summary && <p className={styles.totals} role="status">{summaryLine(summary)}</p>

  const list = (messages: readonly string[]) => (messages.length === 1 ? messages[0] : (
    <ul className={styles.list}>
      {messages.slice(0, SHOWN_MESSAGES).map((m) => <li key={m}>{m}</li>)}
      {messages.length > SHOWN_MESSAGES && <li>…and {messages.length - SHOWN_MESSAGES} more</li>}
    </ul>
  ))
  const bannersOf = (whole: boolean) => banners.filter((b) => b.whole === whole).map((b) => <Banner key={b.code} tone={b.tone} title={b.title}>{list(b.messages)}</Banner>)
  const failed = failure && (
    <Banner tone="danger" title="The plan was not created">
      {failure.problems.length ? list([failure.message, ...failure.problems.map((x) => x.message)]) : failure.message}
    </Banner>
  )

  let body
  if (!draft) {
    body = readError
      ? <Banner tone="danger" title="The send could not be read" action={<Button size="sm" variant="secondary" onClick={() => setQuery((q) => ({ ...q }))}>Try again</Button>}>{readError}</Banner>
      : (
        <div className={styles.loading} role="status" aria-label="Reading the SKUs at the warehouse">
          <Skeleton height={28} /><Skeleton height={14} /><Skeleton height={14} width="90%" /><Skeleton height={14} width="75%" />
        </div>
      )
  } else if (created) {
    body = (
      <>
        {undo === 'undone' ? <Banner tone="info">{DONE_COPY.undone}</Banner> : <Banner tone="success">{FBA_SEND_COPY.done}</Banner>}
        {undoError && <Banner tone="danger" title="The plan was not cancelled">{undoError}</Banner>}
        {totals}
      </>
    )
  } else {
    body = (
      <>
        {readError && <Banner tone="danger" title="The send could not be read again">{readError}</Banner>}
        {failed}
        {where}
        {bannersOf(true)}
        {owners}
        <div className={styles.table} aria-busy={reading || undefined}>
          <DataGrid ariaLabel="SKUs to send" size="sm" keyboardScroll maxHeight={320} columns={columns} rows={draft.skus} rowKey={(s) => s.productId}
            emptyState={<EmptyState title="No SKU to send" description="None of the ticked rows is a SKU this business sells." />} />
        </div>
        {box}
        {bannersOf(false)}
        {totals}
      </>
    )
  }

  const heldProps = (reason: string | null) => (reason !== null ? { 'aria-disabled': true as const, className: 'held', title: reason } : {})
  const footer = created ? (
    <>
      {undo !== 'undone' && (
        <Button size="sm" variant="secondary" title={FBA_SEND_COPY.undoHint} onClick={() => { void undoPlan() }} {...heldProps(undo === 'undoing' ? 'Undoing…' : null)}>
          {undo === 'undoing' ? 'Undoing…' : FBA_SEND_COPY.undo}
        </Button>
      )}
      <span className="grow" />
      {undo !== 'undone' && <Button size="sm" variant="secondary" onClick={() => p.onFollow(created.planId)} {...heldProps(undo === 'undoing' ? 'Undoing…' : null)}>{FBA_SEND_COPY.follow}</Button>}
      <Button size="sm" variant="primary" onClick={close} {...heldProps(undo === 'undoing' ? 'Undoing…' : null)}>{FBA_SEND_COPY.doneButton}</Button>
    </>
  ) : (
    <>
      <span className={styles.status} role="status">{draft && primary.held !== 'Creating…' ? primary.held ?? '' : ''}</span>
      <span className="grow" />
      <Button size="sm" variant="secondary" onClick={close} {...heldProps(creating ? 'Creating…' : null)}>Cancel</Button>
      <Button size="sm" variant="primary" onClick={() => { void create() }} title={primary.held ?? primary.label} {...heldProps(primary.held)}>{primary.label}</Button>
    </>
  )

  const skus = draft?.skus.length ?? p.target.productIds.length
  return (
    <Modal open onClose={close} size="xl" title={FBA_SEND_COPY.title(skus)} subtitle={p.target.subtitle} footer={footer}>
      <div ref={bodyRef} className={styles.body}>{body}</div>
    </Modal>
  )
}
