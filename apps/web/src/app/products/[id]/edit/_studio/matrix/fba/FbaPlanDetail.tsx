'use client'

/**
 * One FBA plan's view and clicks (Step 4 part E2; Owner 2026-10-08: ONE view for the Matrix plans drawer and the FBA
 * shipments page). `useFbaPlanDetail` owns what a person does on a plan — the placement choice and its ONE "Confirm with
 * Amazon", the labels, the tracking numbers and "Mark shipped", "Try again", "Cancel plan" — and hands the host three
 * parts to place: the plan's body, its footer button and the confirm card (`DrawerOverlayCard`). Both hosts are a DS
 * `Drawer`. A DRAFT shows its SKUs and the host's action (the drawer: "Open in FBA shipments"); the page edits a draft
 * with `FbaSendForm` instead.
 *
 * Never a state the server did not send: after a click the view shows the plan the server answered with.
 */
import { useCallback, useId, useMemo, useState, type ClipboardEvent, type ReactElement, type ReactNode, type RefObject } from 'react'
import { FBA_SEND_COPY, type FbaPlacementOption, type FbaPlanView, type FbaShipmentView } from '@nexus/shared/fba-send'
import { Banner, Card, Disclosure, DrawerOverlayCard, Field, Listbox, SummaryTable, Timeline, type TimelineStep } from '@/design-system/components'
import { Button, Input, Pill, RadioCard, Spinner } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { commandKeyFor, sendCommand } from '@/lib/command-key'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'

import {
  DRAWER_COPY, FBA_ROUTES, canPrintLabels, canShip, choiceHeld, choicePayload, clockText, commandSlot, defaultPicks, fcOf, fillDown,
  isPartnered, isRunning, lineRows, offeredPlacements, placementLines, placementTitle, planFacts, planName, planProductIds,
  readLabelsAnswer, readPlanAnswer, shipmentTitle, shipmentTransportText, shippedConfirmText, shippedPayload, shippedText, statusText,
  statusTone, timelineItems, timelineTone, trackingHeld, trackingRows, transportText, windowText, windowsByStart, withTransport, withWindow,
  type ChoicePicks, type TrackingDraft,
} from './plansDrawer'
import styles from './plansDrawer.module.css'

type Ask =
  | { kind: 'confirm'; planId: string; option: FbaPlacementOption; picks: ChoicePicks }
  | { kind: 'cancel'; planId: string }
  | { kind: 'shipped'; planId: string; shipmentId: string }

interface ActionError { planId: string; message: string; problems: string[] }

/** The person's open pick of a placement option, for one read of Amazon's options. */
interface ChoiceDraft { key: string; optionId: string; picks: ChoicePicks }

export interface FbaPlanDetailOptions {
  /** The plan shown, or null (nothing to render). */
  plan: FbaPlanView | null
  /** A click answered with the plan as the server holds it now. */
  onApplied: (plan: FbaPlanView) => void
  /** A click was refused: the host reads again (the plan may have moved). */
  onStale: () => void
  /** Tells the host's caller (the Matrix) a click changed this plan. */
  onPlanChanged?: (plan: FbaPlanView) => void
  /** Focus lands here when the host opens a plan. */
  sectionRef?: RefObject<HTMLElement | null>
  /** A DRAFT's action under its SKUs (the drawer: a link to the page). */
  draftAction?: (plan: FbaPlanView) => ReactNode
  /** Where the source of a click is named in the stock re-read hint. */
  source: string
}

export interface FbaPlanDetailParts {
  /** The plan's body (status, problems, steps, choice, shipments, SKUs); null without a plan. */
  detail: ReactNode
  /** "Cancel plan" when the plan can be cancelled. */
  footer: ReactNode | undefined
  /** The confirm card of a click (Confirm with Amazon, Cancel plan, Mark shipped). */
  overlay: ReactNode | undefined
  /** A click is running (the host holds its own buttons). */
  busy: string | null
}

export function useFbaPlanDetail({ plan, onApplied, onStale, onPlanChanged, sectionRef, draftAction, source }: FbaPlanDetailOptions): FbaPlanDetailParts {
  const [ask, setAsk] = useState<Ask | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<ActionError | null>(null)
  const [choice, setChoice] = useState<ChoiceDraft | null>(null)
  const [tracking, setTracking] = useState<Readonly<Record<string, TrackingDraft>>>({})
  const [labelBusy, setLabelBusy] = useState<string | null>(null)
  const [labelNote, setLabelNote] = useState<{ shipmentId: string; message: string; url: string | null } | null>(null)
  const askTitleId = useId()

  /* ── clicks ──────────────────────────────────────────────────────────────────────────────────── */

  const send = useCallback(async (kind: string, planIdOfClick: string, slot: string, url: string, body: unknown): Promise<boolean> => {
    setBusy(kind); setActionError(null)
    try {
      const { response, body: answer, conflict } = await sendCommand(commandKeyFor(slot), `${getBackendUrl()}${url}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
      })
      const result = readPlanAnswer(response.status, answer, conflict)
      if (!result.ok) {
        setActionError({ planId: planIdOfClick, message: result.message, problems: result.problems })
        onStale()
        return false
      }
      onApplied(result.plan)
      onPlanChanged?.(result.plan)
      // The Matrix and the stock pages re-read (holds made, released or shipped): the same hint the event bridge gives.
      for (const id of planProductIds(result.plan)) {
        emitInvalidation({ type: 'inventory.stock_changed', id, meta: { source, subtype: 'fba-plan', planId: result.plan.id, productId: id } })
      }
      return true
    } catch {
      setActionError({ planId: planIdOfClick, message: DRAWER_COPY.noAnswer, problems: [] })
      return false
    } finally {
      setBusy(null)
    }
  }, [onApplied, onStale, onPlanChanged, source])

  const closeAsk = useCallback(() => { setAsk(null); setActionError(null) }, [])

  const confirmAsk = useCallback(async () => {
    if (!ask || !plan || ask.planId !== plan.id) return
    if (ask.kind === 'confirm') {
      const ok = await send('confirm', ask.planId, commandSlot('choice', ask.planId), FBA_ROUTES.choice(ask.planId), choicePayload(ask.option, ask.picks))
      if (ok) { setAsk(null); setChoice(null) }
    } else if (ask.kind === 'cancel') {
      const ok = await send('cancel', ask.planId, commandSlot('cancel', ask.planId), FBA_ROUTES.cancel(ask.planId), {})
      if (ok) setAsk(null)
    } else {
      const shipment = plan.shipments.find(s => s.id === ask.shipmentId)
      if (!shipment) { setAsk(null); return }
      const typed = tracking[shipment.id] ?? {}
      const ok = await send('shipped', ask.planId, commandSlot('shipped', shipment.id), FBA_ROUTES.shipped(shipment.id), shippedPayload(shipment, typed))
      if (ok) {
        setAsk(null)
        setTracking(previous => { const next = { ...previous }; delete next[shipment.id]; return next })
      }
    }
  }, [ask, plan, send, tracking])

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

  const offered = useMemo(() => (plan ? offeredPlacements(plan) : []), [plan])
  const choiceKey = plan ? `${plan.id}:${plan.options?.readAt ?? ''}` : ''
  const draft: ChoiceDraft | null = useMemo(() => {
    if (choice && choice.key === choiceKey && offered.some(o => o.placementOptionId === choice.optionId)) return choice
    const first = offered[0]
    return first ? { key: choiceKey, optionId: first.placementOptionId, picks: defaultPicks(first) } : null
  }, [choice, choiceKey, offered])
  const chosen = draft ? offered.find(o => o.placementOptionId === draft.optionId) ?? null : null

  /* ── the parts ───────────────────────────────────────────────────────────────────────────────── */

  if (!plan) return { detail: null, footer: undefined, overlay: undefined, busy }

  const footer = plan.can.cancel ? (
    <Button size="md" variant="danger-outline" disabled={busy !== null} onClick={() => { setActionError(null); setAsk({ kind: 'cancel', planId: plan.id }) }}>
      {FBA_SEND_COPY.cancelPlan}
    </Button>
  ) : undefined

  const overlay = ask && ask.planId === plan.id ? (
    <DrawerOverlayCard role="alertdialog" labelledBy={askTitleId} onCancel={busy ? undefined : closeAsk}>
      <AskBody ask={ask} plan={plan} titleId={askTitleId} />
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

  const detail = (
    <PlanDetail
      sectionRef={sectionRef}
      plan={plan}
      busy={busy}
      error={!ask && actionError?.planId === plan.id ? actionError : null}
      offered={offered}
      draft={draft}
      chosen={chosen}
      onChoose={option => setChoice({ key: choiceKey, optionId: option.placementOptionId, picks: defaultPicks(option) })}
      onPicks={picks => draft && setChoice({ ...draft, picks })}
      onConfirm={() => { if (chosen && draft) { setActionError(null); setAsk({ kind: 'confirm', planId: plan.id, option: chosen, picks: draft.picks }) } }}
      onRetry={() => { void send('retry', plan.id, commandSlot('retry', plan.id), FBA_ROUTES.retry(plan.id), {}) }}
      tracking={tracking}
      onTracking={(shipmentId, typed) => setTracking(previous => ({ ...previous, [shipmentId]: typed }))}
      onShipped={shipment => { setActionError(null); setAsk({ kind: 'shipped', planId: plan.id, shipmentId: shipment.id }) }}
      labelBusy={labelBusy}
      labelNote={labelNote}
      onLabels={shipment => void openLabels(shipment)}
      draftAction={draftAction}
    />
  )
  return { detail, footer, overlay, busy }
}

/* ── one plan ─────────────────────────────────────────────────────────────────────────────────── */

interface PlanDetailProps {
  sectionRef?: RefObject<HTMLElement | null>
  draftAction?: (plan: FbaPlanView) => ReactNode
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
  const { sectionRef, plan, busy, error, onRetry, draftAction } = props
  if (plan.status === 'DRAFT') {
    // A draft is not at Amazon yet: its SKUs, and where it is sent from (the page).
    return (
      <section ref={sectionRef} tabIndex={-1} className={styles.plan} aria-label={planName(plan)}>
        <div className={styles.head}>
          <Pill tone={statusTone(plan.status)}>{statusText(plan.status)}</Pill>
          <span className={styles.muted}>{planFacts(plan)}</span>
        </div>
        {plan.lines.length > 0 && <SummaryTable label={DRAWER_COPY.linesTitle(plan.skus)} columns={DRAWER_COPY.lineColumns} rows={lineRows(plan)} />}
        {draftAction?.(plan)}
      </section>
    )
  }
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
