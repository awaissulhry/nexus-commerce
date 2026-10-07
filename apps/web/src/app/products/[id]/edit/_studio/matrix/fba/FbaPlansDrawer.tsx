'use client'

/**
 * Step 4 Send to FBA (Owner 2026-10-07; plan 11-step4-build-plan.md §4c) — the FBA plans drawer (Part E2): the ONE place
 * where a plan's live status, the Owner's placement choice, the labels and "Mark shipped" live. The Matrix (Part E1)
 * mounts it; the dialog's "Follow it", the toolbar's "FBA plans · N" and the FBA qty cell open it.
 *
 * Props (all the host passes):
 *   open        — shows the drawer (DS `Drawer`, right, 480 px; full width on a phone).
 *   onClose     — Esc, the ✕ and the backdrop call it.
 *   productId   — the family root (or one product): the drawer lists the OPEN plans holding any SKU of it,
 *                 newest first (`GET /api/fba/inbound/plans?productId=<id>&open=1`).
 *   planId      — optional: open on this plan (`FbaInboundPlanV2.id`, the create answer's `planId`). Absent = the list,
 *                 or the plan itself when there is only one. A plan that is no longer open is read by its id.
 *   onPlanChanged — optional: a click here changed a plan (choice, cancel, try again, shipped); gets the server's view.
 *
 * Per plan: its steps (Timeline, from the server's status and step log), Amazon's placement options with their fees and
 * carriers in ONE choice, ONE "Confirm with Amazon" click that says it is final at Amazon (no authenticator code), the
 * labels PDF per shipment, one tracking number per box, "Mark shipped" (the held units leave the From warehouse),
 * "Cancel plan" (free until confirmed; releases the holds) and "Try again" on a failed step. A refusal shows the
 * server's sentence. Live: `fba.plan_changed` arrives as `inventory.stock_changed` with `meta.subtype 'fba-plan'`
 * (E1's bridge) and the drawer re-reads; it also re-reads gently by itself (8 s while the job runs, else 60 s).
 * Never a state the server did not send: after a click the drawer shows the plan the server answered with.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type ReactElement, type RefObject } from 'react'
import { FBA_SEND_COPY, type FbaPlacementOption, type FbaPlanView, type FbaShipmentView } from '@nexus/shared/fba-send'
import {
  Banner, Card, Disclosure, Drawer, DrawerOverlayCard, EmptyState, Field, Listbox, PressableRow, ProgressBar, SummaryTable, Timeline,
  type TimelineStep,
} from '@/design-system/components'
import { Button, Input, Pill, RadioCard, Spinner } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { commandKeyFor, sendCommand } from '@/lib/command-key'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'

import {
  DRAWER_COPY, FBA_ROUTES, canPrintLabels, canShip, choiceHeld, choicePayload, clockText, commandSlot, defaultPicks, fcOf, fillDown,
  isFbaPlanEvent, isPartnered, isRunning, lineRows, offeredPlacements, placementLines, placementTitle, planFacts, planName, planProductIds,
  readLabelsAnswer, readOnePlanAnswer, readPlanAnswer, readPlansAnswer, rereadDelay, shipmentTitle, shipmentTransportText,
  shippedConfirmText, shippedPayload, shippedText, shownPlanId, statusText, statusTone, timelineItems, timelineTone, trackingHeld,
  trackingRows, transportText, windowText, windowsByStart, withTransport, withWindow,
  type ChoicePicks, type TrackingDraft,
} from './plansDrawer'
import styles from './plansDrawer.module.css'

export interface FbaPlansDrawerProps {
  open: boolean
  onClose: () => void
  /** The family root (or one product); the drawer lists the open plans holding any of its SKUs. */
  productId: string
  /** Open on this plan; absent = the list (or the only plan). */
  planId?: string | null
  /** A click here changed this plan (the server's view after the click). */
  onPlanChanged?: (plan: FbaPlanView) => void
}

export const FBA_PLANS_DRAWER_WIDTH = 480

type Ask =
  | { kind: 'confirm'; planId: string; option: FbaPlacementOption; picks: ChoicePicks }
  | { kind: 'cancel'; planId: string }
  | { kind: 'shipped'; planId: string; shipmentId: string }

interface ActionError { planId: string; message: string; problems: string[] }

/** The person's open pick of a placement option, for one read of Amazon's options. */
interface ChoiceDraft { key: string; optionId: string; picks: ChoicePicks }

/** A burst of plan events (one per SKU) is one read. */
const LIVE_DEBOUNCE_MS = 300

export function FbaPlansDrawer({ open, onClose, productId, planId, onPlanChanged }: FbaPlansDrawerProps) {
  const [plans, setPlans] = useState<FbaPlanView[] | null>(null)
  /** The shown plan when the open list does not hold it (cancelled, closed, or asked for by id). */
  const [extra, setExtra] = useState<FbaPlanView | null>(null)
  const [missing, setMissing] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [readAt, setReadAt] = useState(0)
  /** undefined = the host's choice (`planId`, else the only plan); null = the list; a string = the plan the person opened. */
  const [pick, setPick] = useState<string | null | undefined>(undefined)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<ActionError | null>(null)
  const [choice, setChoice] = useState<ChoiceDraft | null>(null)
  const [tracking, setTracking] = useState<Readonly<Record<string, TrackingDraft>>>({})
  const [labelBusy, setLabelBusy] = useState<string | null>(null)
  const [labelNote, setLabelNote] = useState<{ shipmentId: string; message: string; url: string | null } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const askTitleId = useId()

  const shownId = pick === undefined ? shownPlanId(plans ?? [], null, planId) : pick
  const shown = useMemo(
    () => (shownId ? plans?.find(p => p.id === shownId) ?? (extra?.id === shownId ? extra : null) : null),
    [plans, extra, shownId],
  )
  const shownRef = useRef<string | null>(shownId)
  shownRef.current = shownId

  /* ── reading ─────────────────────────────────────────────────────────────────────────────────── */

  const seq = useRef(0)
  /** `want` = the plan to read by id when the open list does not hold it; absent = the one shown now. */
  const load = useCallback(async (want: string | null = shownRef.current) => {
    const mine = ++seq.current
    const base = getBackendUrl()
    try {
      let response: Response
      try { response = await fetch(`${base}${FBA_ROUTES.plans(productId)}`) } catch { throw new Error(DRAWER_COPY.readNoAnswer) }
      const list = readPlansAnswer(response.status, await response.json().catch(() => null))
      let one: FbaPlanView | null = null
      let gone: string | null = null
      if (want && !list.some(p => p.id === want)) {
        let single: Response
        try { single = await fetch(`${base}${FBA_ROUTES.plan(want)}`) } catch { throw new Error(DRAWER_COPY.readNoAnswer) }
        one = readOnePlanAnswer(single.status, await single.json().catch(() => null))
        if (!one) gone = want
      }
      if (mine !== seq.current) return
      setPlans(list); setExtra(one); setMissing(gone); setReadError(null)
    } catch (error) {
      if (mine !== seq.current) return
      setReadError(error instanceof Error ? error.message : DRAWER_COPY.readNoAnswer)
    } finally {
      if (mine === seq.current) setReadAt(Date.now())
    }
  }, [productId])

  // Every opening starts clean on the host's plan.
  useEffect(() => {
    if (!open) return
    setPick(undefined); setAsk(null); setActionError(null); setLabelNote(null); setAnnouncement('')
    void load(planId ?? null)
  }, [open, planId, load])

  // Live: the server's plan event (E1's bridge) — coalesced, so a burst for many SKUs is one read.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  useInvalidationChannel('inventory.stock_changed', event => {
    if (!open || !isFbaPlanEvent(event) || debounce.current) return
    debounce.current = setTimeout(() => { debounce.current = null; void load() }, LIVE_DEBOUNCE_MS)
  })
  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current) }, [])

  // The gentle re-read, and a read when the window comes back.
  const visible = useMemo(() => [...(plans ?? []), ...(extra && !plans?.some(p => p.id === extra.id) ? [extra] : [])], [plans, extra])
  useEffect(() => {
    if (!open || readAt === 0) return
    const t = setTimeout(() => { if (document.visibilityState === 'visible') void load() }, rereadDelay(visible))
    return () => clearTimeout(t)
  }, [open, readAt, visible, load])
  useEffect(() => {
    if (!open) return
    const back = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', back)
    return () => document.removeEventListener('visibilitychange', back)
  }, [open, load])

  // A screen reader hears a change of the shown plan's status once.
  const lastStatus = useRef<{ id: string; status: string } | null>(null)
  useEffect(() => {
    if (!shown) return
    const before = lastStatus.current
    lastStatus.current = { id: shown.id, status: shown.status }
    if (before && before.id === shown.id && before.status !== shown.status) setAnnouncement(`${planName(shown)}: ${statusText(shown.status)}`)
  }, [shown])

  // Keyboard: opening a plan from the list, or going back to it, moves focus there (the row or link pressed is gone).
  const listRef = useRef<HTMLUListElement>(null)
  const detailRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (pick === undefined) return
    const t = window.setTimeout(() => (pick === null ? listRef.current : detailRef.current)?.focus({ preventScroll: true }), 0)
    return () => window.clearTimeout(t)
  }, [pick])

  /* ── clicks ──────────────────────────────────────────────────────────────────────────────────── */

  const applyPlan = useCallback((plan: FbaPlanView) => {
    setPlans(previous => (previous?.some(p => p.id === plan.id) ? previous.map(p => (p.id === plan.id ? plan : p)) : previous))
    setExtra(previous => (previous?.id === plan.id || shownRef.current === plan.id ? plan : previous))
  }, [])

  const send = useCallback(async (kind: string, planIdOfClick: string, slot: string, url: string, body: unknown): Promise<boolean> => {
    setBusy(kind); setActionError(null)
    try {
      const { response, body: answer, conflict } = await sendCommand(commandKeyFor(slot), `${getBackendUrl()}${url}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
      })
      const result = readPlanAnswer(response.status, answer, conflict)
      if (!result.ok) {
        setActionError({ planId: planIdOfClick, message: result.message, problems: result.problems })
        void load()
        return false
      }
      applyPlan(result.plan)
      onPlanChanged?.(result.plan)
      // The Matrix re-reads its stock and plan cells (holds made, released or shipped): the same hint E1's bridge gives.
      for (const id of planProductIds(result.plan)) {
        emitInvalidation({ type: 'inventory.stock_changed', id, meta: { source: 'fba-plans-drawer', subtype: 'fba-plan', planId: result.plan.id, productId: id } })
      }
      return true
    } catch {
      setActionError({ planId: planIdOfClick, message: DRAWER_COPY.noAnswer, problems: [] })
      return false
    } finally {
      setBusy(null)
    }
  }, [applyPlan, load, onPlanChanged])

  const closeAsk = useCallback(() => { setAsk(null); setActionError(null) }, [])

  const confirmAsk = useCallback(async () => {
    if (!ask) return
    if (ask.kind === 'confirm') {
      const ok = await send('confirm', ask.planId, commandSlot('choice', ask.planId), FBA_ROUTES.choice(ask.planId), choicePayload(ask.option, ask.picks))
      if (ok) { setAsk(null); setChoice(null) }
    } else if (ask.kind === 'cancel') {
      const ok = await send('cancel', ask.planId, commandSlot('cancel', ask.planId), FBA_ROUTES.cancel(ask.planId), {})
      if (ok) setAsk(null)
    } else {
      const plan = visible.find(p => p.id === ask.planId)
      const shipment = plan?.shipments.find(s => s.id === ask.shipmentId)
      if (!shipment) { setAsk(null); return }
      const typed = tracking[shipment.id] ?? {}
      const ok = await send('shipped', ask.planId, commandSlot('shipped', shipment.id), FBA_ROUTES.shipped(shipment.id), shippedPayload(shipment, typed))
      if (ok) {
        setAsk(null)
        setTracking(previous => { const next = { ...previous }; delete next[shipment.id]; return next })
      }
    }
  }, [ask, send, tracking, visible])

  const retry = useCallback((plan: FbaPlanView) => {
    void send('retry', plan.id, commandSlot('retry', plan.id), FBA_ROUTES.retry(plan.id), {})
  }, [send])

  const openLabels = useCallback(async (shipment: FbaShipmentView) => {
    setLabelBusy(shipment.id); setLabelNote(null)
    // Opened inside the click, so the browser lets the tab through; the link arrives a moment later.
    const tab = typeof window !== 'undefined' ? window.open('', '_blank') : null
    try {
      let response: Response
      try { response = await fetch(`${getBackendUrl()}${FBA_ROUTES.labels(shipment.id)}`) } catch { throw new Error(DRAWER_COPY.readNoAnswer) }
      const url = readLabelsAnswer(response.status, await response.json().catch(() => null))
      if (tab && !tab.closed) {
        tab.opener = null
        tab.location.href = url
      } else {
        setLabelNote({ shipmentId: shipment.id, message: DRAWER_COPY.labelsBlocked, url })
      }
    } catch (error) {
      tab?.close()
      setLabelNote({ shipmentId: shipment.id, message: error instanceof Error ? error.message : DRAWER_COPY.readNoAnswer, url: null })
    } finally {
      setLabelBusy(null)
    }
  }, [])

  /* ── the choice ──────────────────────────────────────────────────────────────────────────────── */

  const offered = useMemo(() => (shown ? offeredPlacements(shown) : []), [shown])
  const choiceKey = shown ? `${shown.id}:${shown.options?.readAt ?? ''}` : ''
  const draft: ChoiceDraft | null = useMemo(() => {
    if (choice && choice.key === choiceKey && offered.some(o => o.placementOptionId === choice.optionId)) return choice
    const first = offered[0]
    return first ? { key: choiceKey, optionId: first.placementOptionId, picks: defaultPicks(first) } : null
  }, [choice, choiceKey, offered])
  const chosen = draft ? offered.find(o => o.placementOptionId === draft.optionId) ?? null : null

  /* ── render ──────────────────────────────────────────────────────────────────────────────────── */

  const othersCount = visible.filter(p => p.id !== shown?.id).length
  const footer = shown?.can.cancel ? (
    <Button size="md" variant="danger-outline" disabled={busy !== null} onClick={() => { setActionError(null); setAsk({ kind: 'cancel', planId: shown.id }) }}>
      {FBA_SEND_COPY.cancelPlan}
    </Button>
  ) : undefined

  const askedPlan = ask ? visible.find(p => p.id === ask.planId) ?? null : null
  const overlay = ask && askedPlan ? (
    <DrawerOverlayCard role="alertdialog" labelledBy={askTitleId} onCancel={busy ? undefined : closeAsk}>
      <AskBody ask={ask} plan={askedPlan} titleId={askTitleId} />
      {actionError && actionError.planId === ask.planId && <ActionErrorBanner error={actionError} />}
      <div className={styles.footer}>
        <Button size="md" autoFocus disabled={busy !== null} onClick={closeAsk}>
          {ask.kind === 'cancel' ? DRAWER_COPY.keepPlan : DRAWER_COPY.back}
        </Button>
        <Button size="md" variant={ask.kind === 'cancel' ? 'danger' : 'primary'} disabled={busy !== null} onClick={() => void confirmAsk()}>
          {ask.kind === 'confirm' ? (busy ? DRAWER_COPY.confirming : FBA_SEND_COPY.confirm)
            : ask.kind === 'cancel' ? (busy ? DRAWER_COPY.cancelling : FBA_SEND_COPY.cancelPlan)
              : (busy ? DRAWER_COPY.shipping : FBA_SEND_COPY.markShipped)}
        </Button>
      </div>
    </DrawerOverlayCard>
  ) : undefined

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={FBA_SEND_COPY.drawerTitle}
      subtitle={shown ? planName(shown) : undefined}
      footer={footer}
      overlay={overlay}
      width={FBA_PLANS_DRAWER_WIDTH}
      closeLabel="Close FBA plans"
    >
      <div className={styles.body}>
        <p className="nds-vh" role="status" aria-live="polite">{announcement}</p>

        {plans === null && !readError && <ProgressBar indeterminate ariaLabel={DRAWER_COPY.reading} />}

        {readError && (
          <Banner
            tone={plans ? 'warning' : 'danger'}
            title={plans ? DRAWER_COPY.stale : DRAWER_COPY.readFailed}
            action={<Button size="sm" onClick={() => void load()}>{FBA_SEND_COPY.tryAgain}</Button>}
          >
            {readError}
          </Banner>
        )}

        {plans !== null && shownId === null && (
          plans.length === 0
            ? <EmptyState title={DRAWER_COPY.empty} description={DRAWER_COPY.emptyHint} />
            : (
              <ul ref={listRef} tabIndex={-1} className={styles.list} aria-label={DRAWER_COPY.plansLabel}>
                {plans.map(plan => (
                  <li key={plan.id}>
                    <PressableRow label={planName(plan)} description={`${statusText(plan.status)} · ${planFacts(plan)}`} onClick={() => setPick(plan.id)} stacked>
                      <span className={styles.rowFacts}>
                        <Pill tone={statusTone(plan.status)} dot={isRunning(plan.status)}>{statusText(plan.status)}</Pill>
                        <span className={styles.muted}>{planFacts(plan)}</span>
                      </span>
                    </PressableRow>
                  </li>
                ))}
              </ul>
            )
        )}

        {shownId !== null && othersCount > 0 && (
          <div>
            <Button size="sm" variant="link" onClick={() => setPick(null)}>{DRAWER_COPY.allPlans}</Button>
          </div>
        )}

        {shownId !== null && !shown && plans !== null && !readError && (
          missing === shownId ? <EmptyState title={DRAWER_COPY.notFound} /> : <ProgressBar indeterminate ariaLabel={DRAWER_COPY.reading} />
        )}

        {shown && (
          <PlanDetail
            sectionRef={detailRef}
            plan={shown}
            busy={busy}
            error={!ask && actionError?.planId === shown.id ? actionError : null}
            offered={offered}
            draft={draft}
            chosen={chosen}
            onChoose={option => setChoice({ key: choiceKey, optionId: option.placementOptionId, picks: defaultPicks(option) })}
            onPicks={picks => draft && setChoice({ ...draft, picks })}
            onConfirm={() => { if (chosen && draft) { setActionError(null); setAsk({ kind: 'confirm', planId: shown.id, option: chosen, picks: draft.picks }) } }}
            onRetry={() => retry(shown)}
            tracking={tracking}
            onTracking={(shipmentId, typed) => setTracking(previous => ({ ...previous, [shipmentId]: typed }))}
            onShipped={shipment => { setActionError(null); setAsk({ kind: 'shipped', planId: shown.id, shipmentId: shipment.id }) }}
            labelBusy={labelBusy}
            labelNote={labelNote}
            onLabels={shipment => void openLabels(shipment)}
          />
        )}
      </div>
    </Drawer>
  )
}

/* ── one plan ─────────────────────────────────────────────────────────────────────────────────── */

interface PlanDetailProps {
  sectionRef?: RefObject<HTMLElement | null>
  plan: FbaPlanView
  busy: string | null
  error: ActionError | null
  offered: FbaPlacementOption[]
  draft: ChoiceDraft | null
  chosen: FbaPlacementOption | null
  onChoose: (option: FbaPlacementOption) => void
  onPicks: (picks: ChoicePicks) => void
  onConfirm: () => void
  onRetry: () => void
  tracking: Readonly<Record<string, TrackingDraft>>
  onTracking: (shipmentId: string, typed: TrackingDraft) => void
  onShipped: (shipment: FbaShipmentView) => void
  labelBusy: string | null
  labelNote: { shipmentId: string; message: string; url: string | null } | null
  onLabels: (shipment: FbaShipmentView) => void
}

function PlanDetail(props: PlanDetailProps) {
  const { sectionRef, plan, busy, error, onRetry } = props
  const steps: TimelineStep[] = timelineItems(plan).map(item => ({
    key: item.key,
    label: item.state === 'running' ? <span className={styles.running}><Spinner size={12} />{item.label}</span> : item.label,
    tone: timelineTone(item.state),
    at: item.at,
    detail: item.detail ?? undefined,
  }))
  const amazonProblems = plan.problems.filter(p => p.message && p.message !== plan.message)

  return (
    <section ref={sectionRef} tabIndex={-1} className={styles.plan} aria-label={planName(plan)}>
      <div className={styles.head}>
        <Pill tone={statusTone(plan.status)} dot={isRunning(plan.status)}>{statusText(plan.status)}</Pill>
        <span className={styles.muted}>{planFacts(plan)}</span>
      </div>

      {error && <ActionErrorBanner error={error} />}

      {(plan.status === 'FAILED' || plan.status === 'HELD') && (
        <Banner
          tone={plan.status === 'FAILED' ? 'danger' : 'warning'}
          title={statusText(plan.status)}
          action={plan.can.retry ? <Button size="sm" disabled={busy !== null} onClick={onRetry}>{busy === 'retry' ? DRAWER_COPY.retrying : FBA_SEND_COPY.tryAgain}</Button> : undefined}
        >
          {plan.message && <p className={styles.text}>{plan.message}</p>}
          {amazonProblems.length > 0 && (
            <ul className={styles.problems}>
              {amazonProblems.map((p, i) => <li key={`${p.code}-${i}`}>{p.code ? `${p.code}: ` : ''}{p.message}{p.details ? ` (${p.details})` : ''}</li>)}
            </ul>
          )}
        </Banner>
      )}

      <Timeline steps={steps} label={DRAWER_COPY.stepsLabel} />

      {plan.status === 'WAITING_FOR_CHOICE' && <ChoiceSection {...props} />}

      {plan.shipments.length > 0 && <ShipmentsSection {...props} />}

      {plan.lines.length > 0 && (
        <Disclosure summary={DRAWER_COPY.linesTitle(plan.skus)}>
          <SummaryTable label={DRAWER_COPY.linesTitle(plan.skus)} columns={DRAWER_COPY.lineColumns} rows={lineRows(plan)} />
        </Disclosure>
      )}
    </section>
  )
}

function ChoiceSection({ plan, busy, offered, draft, chosen, onChoose, onPicks, onConfirm, onRetry }: PlanDetailProps) {
  if (plan.can.newOptions) {
    return (
      <Banner
        tone="warning"
        title={FBA_SEND_COPY.optionsExpired}
        action={<Button size="sm" disabled={busy !== null} onClick={onRetry}>{busy === 'retry' ? DRAWER_COPY.retrying : FBA_SEND_COPY.newOptions}</Button>}
      />
    )
  }
  if (!plan.can.choose) return null
  if (offered.length === 0) return <Banner tone="warning">{DRAWER_COPY.noOptions}</Banner>
  const picks = draft?.picks ?? {}
  const held = choiceHeld(chosen, picks)

  return (
    <div className={styles.section}>
      <fieldset className={styles.choices}>
        <legend className={styles.legend}>{DRAWER_COPY.choiceLegend}</legend>
        {offered.map(option => {
          const isChosen = option.placementOptionId === chosen?.placementOptionId
          const lines = placementLines(option, isChosen ? picks : defaultPicks(option))
          return (
            <RadioCard
              key={option.placementOptionId}
              name={`fba-placement-${plan.id}`}
              value={option.placementOptionId}
              checked={isChosen}
              selected={isChosen}
              onChange={() => onChoose(option)}
              title={placementTitle(option)}
              description={lines.length ? <span className={styles.lines}>{lines.map(line => <span key={line}>{line}</span>)}</span> : undefined}
            />
          )
        })}
      </fieldset>

      {chosen && <Pickers option={chosen} picks={picks} onPicks={onPicks} />}

      {plan.options?.expiresAt && <p className={styles.muted}>{DRAWER_COPY.validUntil(clockText(plan.options.expiresAt))}</p>}

      <div className={styles.actions}>
        <Button size="md" variant="primary" disabled={held !== null || busy !== null} onClick={onConfirm}>{FBA_SEND_COPY.confirm}</Button>
        {held && <span className={styles.muted}>{held}</span>}
      </div>
    </div>
  )
}

/** Per shipment of the chosen option: a carrier and an arrival window — only where Amazon offers more than one. */
function Pickers({ option, picks, onPicks }: { option: FbaPlacementOption; picks: ChoicePicks; onPicks: (picks: ChoicePicks) => void }) {
  const fields = option.shipments.flatMap(shipment => {
    const pick = picks[shipment.shipmentId]
    const transport = pick ? shipment.transport.find(t => t.transportationOptionId === pick.transportationOptionId) : undefined
    const windows = windowsByStart(shipment)
    const out: ReactElement[] = []
    if (shipment.transport.length > 1) {
      out.push(
        <Field key={`${shipment.shipmentId}-carrier`} label={DRAWER_COPY.carrier(fcOf(shipment))}>
          <Listbox
            size="sm"
            options={shipment.transport.map(t => ({ value: t.transportationOptionId, label: transportText(t) }))}
            value={pick?.transportationOptionId}
            onChange={value => onPicks(withTransport(picks, option, shipment.shipmentId, value))}
          />
        </Field>,
      )
    }
    if (transport && !isPartnered(transport) && windows.length > 1) {
      out.push(
        <Field key={`${shipment.shipmentId}-window`} label={DRAWER_COPY.window(fcOf(shipment))}>
          <Listbox
            size="sm"
            options={windows.map(w => ({ value: w.deliveryWindowOptionId, label: windowText(w) }))}
            value={pick?.deliveryWindowOptionId ?? undefined}
            onChange={value => onPicks(withWindow(picks, option, shipment.shipmentId, value))}
          />
        </Field>,
      )
    }
    return out
  })
  return fields.length ? <div className={styles.pickers}>{fields}</div> : null
}

function ShipmentsSection({ plan, busy, tracking, onTracking, onShipped, labelBusy, labelNote, onLabels }: PlanDetailProps) {
  return (
    <section className={styles.section} aria-label={DRAWER_COPY.shipmentsLabel}>
      {plan.shipments.map(shipment => {
        const typed = tracking[shipment.id] ?? {}
        const shipping = canShip(plan, shipment)
        const held = shipping ? trackingHeld(shipment, typed) : null
        const transport = shipmentTransportText(shipment)
        const after = shippedText(shipment)
        const note = labelNote?.shipmentId === shipment.id ? labelNote : null
        const rows = trackingRows(shipment, typed)
        const boxIds = shipment.boxes.map(b => b.boxId)
        const onPaste = (boxId: string) => (event: ClipboardEvent<HTMLInputElement>) => {
          const next = fillDown(boxIds, boxId, event.clipboardData.getData('text'), typed)
          if (!next) return
          event.preventDefault()
          onTracking(shipment.id, next)
        }
        return (
          <Card key={shipment.id} padded className={styles.shipment}>
            <div className={styles.shipHead}>
              <span className={styles.strong}>{shipmentTitle(shipment)}</span>
              <span className={styles.muted}>{DRAWER_COPY.units(shipment.units)}</span>
            </div>
            {transport && <span className={styles.muted}>{transport}</span>}
            {after && <span className={styles.text}>{after}</span>}

            {canPrintLabels(plan, shipment) && (
              <div className={styles.actions}>
                <Button size="sm" disabled={labelBusy !== null} onClick={() => onLabels(shipment)}>
                  {labelBusy === shipment.id ? DRAWER_COPY.labelsOpening : FBA_SEND_COPY.labels}
                </Button>
                {note?.url && <a className={styles.link} href={note.url} target="_blank" rel="noopener noreferrer">{DRAWER_COPY.labelsLink}</a>}
              </div>
            )}
            {note && <Banner tone={note.url ? 'info' : 'danger'}>{note.message}</Banner>}

            {shipping && (
              <>
                <fieldset className={styles.tracking}>
                  <legend className={styles.legend}>{FBA_SEND_COPY.tracking}</legend>
                  {rows.map(row => (
                    <Field key={row.boxId} label={row.label} hint={row.content || undefined}>
                      <Input
                        size="sm"
                        value={row.value}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={event => onTracking(shipment.id, { ...typed, [row.boxId]: event.target.value })}
                        onPaste={onPaste(row.boxId)}
                      />
                    </Field>
                  ))}
                </fieldset>
                <div className={styles.actions}>
                  <Button size="md" variant="primary" disabled={held !== null || busy !== null} onClick={() => onShipped(shipment)}>{FBA_SEND_COPY.markShipped}</Button>
                  {held && <span className={styles.muted}>{held}</span>}
                </div>
              </>
            )}
          </Card>
        )
      })}
    </section>
  )
}

/* ── the questions ────────────────────────────────────────────────────────────────────────────── */

function AskBody({ ask, plan, titleId }: { ask: Ask; plan: FbaPlanView; titleId: string }) {
  if (ask.kind === 'confirm') {
    return (
      <div className={styles.overlayBody}>
        <h3 id={titleId} className={styles.overlayTitle}>{DRAWER_COPY.confirmTitle}</h3>
        <p className={styles.text}>{placementTitle(ask.option)}</p>
        {placementLines(ask.option, ask.picks).map(line => <p key={line} className={styles.muted}>{line}</p>)}
        <p className={styles.strong}>{FBA_SEND_COPY.confirmFinal}</p>
      </div>
    )
  }
  if (ask.kind === 'cancel') {
    return (
      <div className={styles.overlayBody}>
        <h3 id={titleId} className={styles.overlayTitle}>{DRAWER_COPY.cancelTitle}</h3>
        <p className={styles.text}>{DRAWER_COPY.holdsBack(plan.from?.code ?? null)}</p>
        <p className={plan.confirmedAt ? styles.strong : styles.muted}>{plan.confirmedAt ? FBA_SEND_COPY.cancelConfirmed : FBA_SEND_COPY.undoHint}</p>
      </div>
    )
  }
  const shipment = plan.shipments.find(s => s.id === ask.shipmentId)
  return (
    <div className={styles.overlayBody}>
      <h3 id={titleId} className={styles.overlayTitle}>{DRAWER_COPY.shippedTitle}</h3>
      {shipment && <p className={styles.text}>{shipmentTitle(shipment)}</p>}
      {shipment && <p className={styles.strong}>{shippedConfirmText(plan, shipment)}</p>}
      <p className={styles.muted}>{DRAWER_COPY.trackingGoes}</p>
    </div>
  )
}

function ActionErrorBanner({ error }: { error: ActionError }) {
  return (
    <Banner tone="danger" title={DRAWER_COPY.failedTitle}>
      <p className={styles.text}>{error.message}</p>
      {error.problems.length > 0 && (
        <ul className={styles.problems}>{error.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
      )}
    </Banner>
  )
}
