'use client'

import { useId } from 'react'
import { CircleCheck, ClipboardCheck, MapPin, Route, TriangleAlert } from 'lucide-react'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, Pill, RadioCard } from '@nexus/ui/primitives'
import { DateField, DateTimeField, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format' // F-OS-305: formatDate (Customer told {day})
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DepthDialog, PartRead } from '../../queue/shared/DepthDialog'
// F-OS-203: Warehouse's words and the lane's (`order-shipments`: door.*) — the Mark delivered / returned reason, the expected arrival.
import { DOOR_NAMESPACES as DEPTH_NAMESPACES, useDoorWords as useDepthWords } from '../../queue/shared/door-words'
import type { LabelCheck, Transport } from '../api'
import { allProblems, arrangeDialogOf, arrangeProblem, checkProblemWords, MANUAL_EVENT_STATUSES, mayHeld, OWN_TRANSPORT_LIMITS, statusProblem, trackingProblem, type TransportActions, type TransportModel } from '../model'
import { etaDialogOf, etaHeld, etaProblem, overridesLabels } from '../model' // F-OS-203 (B-OS-015, B-OS-016)
import { awbCheck, noticeOffered, parcelChangesOf, parcelLabelled, trackingDialogOf, trackingReasonNeeded } from '../model' // F-OS-301 (B-OS-022)
import { PARCEL_TRACKING_LIMITS } from '@nexus/factory-domain/shipping/own-transport/rules' // F-OS-301
import { OVERRIDE_REASON } from '@nexus/factory-domain/shipping/own-transport/rules' // F-OS-203
import '../../shipments.css'
import '../../queue/shared/depth.css'

const STATUS_TONE = { LABEL_CREATED: 'neutral', IN_TRANSIT: 'info', OUT_FOR_DELIVERY: 'info', DELIVERED: 'success', EXCEPTION: 'danger', RETURNED: 'warning' } as const

/**
 * SCR-595 — Carrier & label › How it travels (design sh-booking "W2b own van or manual; customer collects ex works"; B-W2b-390
 * LOG-122, LOG-045): the arrangement (a carrier through Sendcloud, a carrier booked by hand with its name and the tracking
 * number typed, our own van, the customer collecting), each change held with the API's reason in words (labels bought, a
 * DDT issued, gone); the statuses typed for our van or a carrier booked by hand (in transit, out for delivery, a problem,
 * delivered, returned) at the time they happened; and before any label, every parcel against its carrier's rules —
 * the TEST mode line, the problems in words by parcel, the limits kept or not.
 */
export function TransportView({ model, actions }: { model: TransportModel; actions?: TransportActions }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <TransportCard model={model} actions={actions} />
    </WithMessages>
  )
}

function TransportCard({ model, actions }: { model: TransportModel; actions?: TransportActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const head = (
    <h2 className="fw-sh-h2">
      <Route size={16} aria-hidden /> {t('transport.title')}
    </h2>
  )
  if (model.transport.state !== 'ready') {
    return (
      <Card padded>
        {head}
        <PartRead problem={model.transport.state === 'error' ? model.transport.problem : null} onRetry={actions?.onRetry} label={t('transport.title')} />
      </Card>
    )
  }
  const transport = model.transport.value
  const { arrangement, shipment } = transport
  const busy = model.busy ? t('transport.held.busy') : null
  const arrangeBlocked = busy ?? say(mayHeld(transport.may.arrange, model.can.manage))
  const trackBlocked = busy ?? say(mayHeld(transport.may.track, model.can.manage))
  const statusBlocked = busy ?? say(mayHeld(transport.may.status, model.can.manage))
  const typedStatuses = arrangement === 'OWN_VAN' || arrangement === 'MANUAL_CARRIER'
  return (
    <Card padded>
      <div className="fw-sh-card-head">
        {head}
        <Pill tone="info">{t(`arrangement.${arrangement}`)}</Pill>
      </div>
      <KeyValue
        labelCase="sentence"
        items={[
          { label: t('transport.how'), value: arrangement === 'MANUAL_CARRIER' ? t('transport.manualNamed', { carrier: shipment.carrierName ?? '—' }) : t(`arrangementLong.${arrangement}`) },
          ...(arrangement === 'MANUAL_CARRIER' || shipment.manualTrackingNumber ? [{ label: t('transport.trackingNumber'), value: shipment.manualTrackingNumber ?? t('transport.noTracking') }] : []),
          { label: t('transport.ddt'), value: transport.ddt ? transport.ddt.number : shipment.ddtRequired ? t('transport.ddtNotYet') : t('transport.ddtNotNeeded') },
          ...(transport.labels.carrier > 0 ? [{ label: t('transport.labels'), value: transport.labels.test > 0 ? t('transport.labelsTest', { count: transport.labels.carrier, test: transport.labels.test }) : t('transport.labelsCount', { count: transport.labels.carrier }) }] : []),
        ]}
      />
      <p className="fw-sh-hint">{t(`transport.explain.${arrangement}`)}</p>
      {model.done && (
        <p className="fw-sh-hint" role="status">
          {say(model.done)}
        </p>
      )}
      {model.problem && !model.dialog && <Banner tone="danger" title={say(model.problem) ?? ''} />}
      <span className="fw-shd-actions">
        {shipment.status !== 'CANCELLED' && arrangement !== 'CUSTOMER_COLLECTS' && (
          <Button size="sm" heldReason={arrangeBlocked} onClick={() => actions?.onDialog?.(arrangeDialogOf(transport))}>
            {arrangement === 'CARRIER' ? t('transport.arrange') : t('transport.change')}
          </Button>
        )}
        {arrangement === 'MANUAL_CARRIER' && (
          <Button size="sm" heldReason={trackBlocked} onClick={() => actions?.onDialog?.(trackingDialogOf(transport) /* F-OP-135 → F-OS-301: its parcels too */)}>
            {shipment.manualTrackingNumber ? t('transport.changeTracking') : t('transport.typeTracking')}
          </Button>
        )}
        {typedStatuses && (
          <Button size="sm" heldReason={statusBlocked} onClick={() => actions?.onDialog?.({ kind: 'status', status: null, occurredAt: null, description: '', location: '' })}>
            <MapPin size={14} aria-hidden /> {t('transport.typeStatus')}
          </Button>
        )}
        {/* F-OS-203 (B-OS-015, Owner D5): a carrier's labels move it — a person who knows better marks it, saying why (L1: "Mark returned…"). */}
        {!typedStatuses && shipment.status === 'SHIPPED' && transport.may.endByHand && (
          <>
            <Button size="sm" heldReason={busy ?? say(mayHeld(transport.may.endByHand, model.can.manage))} onClick={() => actions?.onDialog?.({ kind: 'status', status: 'DELIVERED', occurredAt: null, description: '', location: '', reason: '' })}>
              {t('ships.act.delivered')}
            </Button>
            <Button size="sm" heldReason={busy ?? say(mayHeld(transport.may.endByHand, model.can.manage))} onClick={() => actions?.onDialog?.({ kind: 'status', status: 'RETURNED', occurredAt: null, description: '', location: '', reason: '' })}>
              {t('ships.act.returned')}
            </Button>
          </>
        )}
        {/* F-OS-203 (B-OS-016): the expected arrival typed where no carrier feed tracks it. */}
        {transport.may.eta && (shipment.status === 'PACKED' || shipment.status === 'SHIPPED') && (
          <Button size="sm" heldReason={busy ?? say(etaHeld(transport.may.eta, model.can.manage))} onClick={() => actions?.onDialog?.(etaDialogOf(transport))}>
            {t('ships.act.eta')}
          </Button>
        )}
      </span>
      {typedStatuses && (
        <section aria-labelledby="fw-shd-typed">
          <h3 className="fw-sh-h3" id="fw-shd-typed">
            {t('transport.typed')}
          </h3>
          {transport.events.length === 0 ? (
            <p className="fw-sh-hint">{shipment.shippedAt ? t('transport.noTyped') : t('transport.typedAfterLeft')}</p>
          ) : (
            <ol className="fw-sh-timeline" aria-label={t('transport.typed')}>
              {transport.events.map((event) => (
                <li key={event.id} className="fw-sh-event" data-tone={STATUS_TONE[event.status]}>
                  <span className="fw-sh-event-dot" aria-hidden />
                  <span className="fw-sh-event-text">
                    <strong>{t(`trackingStatus.${event.status}`)}</strong>
                    <span className="fw-sh-cell-sub">
                      {formatDateTime(event.occurredAt, { locale })}
                      {event.location ? ` · ${event.location}` : ''}
                      {` · ${t('transport.typedAt', { when: formatDateTime(event.recordedAt, { locale }) })}`}
                    </span>
                    {event.description && <span className="fw-sh-hint">{event.description}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      {arrangement === 'CARRIER' && model.check && <CheckPart check={model.check} actions={actions} />}
      {model.dialog?.kind === 'arrange' && <ArrangeDialog transport={transport} model={model} actions={actions} />}
      {model.dialog?.kind === 'tracking' && <TrackingDialog transport={transport} model={model} actions={actions} />}
      {model.dialog?.kind === 'status' && <StatusDialog transport={transport} model={model} actions={actions} />}
      {model.dialog?.kind === 'eta' && <EtaDialog transport={transport} model={model} actions={actions} />}
    </Card>
  )
}

function CheckPart({ check, actions }: { check: NonNullable<TransportModel['check']>; actions?: TransportActions }) {
  const { t, say } = useDepthWords()
  if (check.state !== 'ready') {
    return (
      <section aria-label={t('check.title')}>
        <PartRead problem={check.state === 'error' ? check.problem : null} onRetry={actions?.onRetryCheck} label={t('check.title')} />
      </section>
    )
  }
  const value: LabelCheck = check.value
  const problems = allProblems(value)
  const unlabelled = value.parcels.filter((parcel) => !parcel.labelled)
  return (
    <section className="fw-shd-check" aria-labelledby="fw-shd-check-title">
      <h3 className="fw-sh-h3" id="fw-shd-check-title">
        <ClipboardCheck size={14} aria-hidden /> {t('check.title')}
      </h3>
      {value.testMode && <Banner tone="warning" title={t('check.testMode')} />}
      {!value.applies ? (
        <p className="fw-sh-hint">{t(`check.notApplying.${value.notApplying ?? 'MANUAL_CARRIER'}`)}</p>
      ) : value.parcels.length === 0 ? (
        <p className="fw-sh-hint">{t('check.noParcels')}</p>
      ) : unlabelled.length === 0 ? (
        <p className="fw-sh-hint">{t('check.allLabelled')}</p>
      ) : problems.length === 0 ? (
        <p className="fw-shd-ok" role="status">
          <CircleCheck size={14} aria-hidden /> {t('check.ok', { count: unlabelled.length, carrier: value.carrier.name })}
        </p>
      ) : (
        <ul className="fw-shd-problems" aria-label={t('check.problems', { count: problems.length })}>
          {problems.map((problem) => (
            <li key={`${problem.code}|${problem.parcelSeq ?? ''}|${problem.path}`}>
              <TriangleAlert size={14} aria-hidden /> {say(checkProblemWords(problem, value.carrier.name))}
            </li>
          ))}
        </ul>
      )}
      {value.applies && <p className="fw-sh-hint">{value.carrier.ruleKept ? t('check.limitsKept', { carrier: value.carrier.name }) : t('check.noLimits', { carrier: value.carrier.name })}</p>}
    </section>
  )
}

function ArrangeDialog({ transport, model, actions }: { transport: Transport; model: TransportModel; actions?: TransportActions }) {
  const { t, say } = useDepthWords()
  if (model.dialog?.kind !== 'arrange') return null
  const dialog = model.dialog
  return (
    <DepthDialog
      title={t('transport.arrangeTitle', { number: transport.shipment.number })}
      held={model.busy ? t('transport.held.busy') : say(arrangeProblem(dialog))}
      onGo={() => actions?.onArrange?.()}
      goLabel={t('transport.arrangeGo')}
      onClose={() => actions?.onDialog?.(null)}
      problem={say(model.problem)}
    >
      <fieldset className="fw-shd-choices">
        <legend className="fw-sh-h3">{t('transport.how')}</legend>
        <RadioCard name="transport-mode" value="OWN_VAN" checked={dialog.mode === 'OWN_VAN'} selected={dialog.mode === 'OWN_VAN'} onChange={() => actions?.onDialog?.({ ...dialog, mode: 'OWN_VAN' })} title={t('arrangement.OWN_VAN')} description={t('transport.ownVanHint')} />
        <RadioCard name="transport-mode" value="MANUAL_CARRIER" checked={dialog.mode === 'MANUAL_CARRIER'} selected={dialog.mode === 'MANUAL_CARRIER'} onChange={() => actions?.onDialog?.({ ...dialog, mode: 'MANUAL_CARRIER' })} title={t('arrangement.MANUAL_CARRIER')} description={t('transport.manualHint')} />
      </fieldset>
      {dialog.mode === 'MANUAL_CARRIER' && (
        <div className="fw-shd-fields">
          <Field label={t('transport.carrierName')} required>
            <Input size="sm" value={dialog.carrierName} maxLength={OWN_TRANSPORT_LIMITS.carrierName * 2} onChange={(event) => actions?.onDialog?.({ ...dialog, carrierName: event.target.value })} />
          </Field>
          <Field label={t('transport.trackingNumber')} hint={t('transport.trackingHint')}>
            <Input size="sm" value={dialog.trackingNumber} onChange={(event) => actions?.onDialog?.({ ...dialog, trackingNumber: event.target.value })} />
          </Field>
        </div>
      )}
      <p className="fw-sh-hint">{t('transport.arrangeNote')}</p>
    </DepthDialog>
  )
}

/**
 * Tracking number… → F-OS-301 (order SHIPMENTS tab; Owner D4; 10-design §7 D5; 18-lead-settles L2, L4; B-OS-022) "Tracking numbers of
 * SEED-SH-0014", extended ONCE for Warehouse and the order's Shipments tab: the consignment number (tracking, AWB or B/L — no kind is
 * stored, L4) with a soft air-waybill check in words (never a refusal) and its link; one row per parcel — "Parcel 2 of 3" and, where
 * the opener knows it (`parcelWords`: the tab's own contents of this order), its weight and what it holds — its typed number and link;
 * a labelled parcel read only "From the label"; after the goods left, a number the customer saw that changes asks why (office only);
 * "Send the shipping notice again" off by default (only once the goods left).
 */
function TrackingDialog({ transport, model, actions, parcelWords }: { transport: Transport; model: TransportModel; actions?: TransportActions; parcelWords?: Readonly<Record<string, string>> }) {
  const { t, say } = useDepthWords()
  const locale = useLocale() // F-OS-305: a parcel's weight and the day the customer was told, in the reader's language
  if (model.dialog?.kind !== 'tracking') return null
  const dialog = model.dialog
  // F-OS-301: the parcels as the read sends them (absent in an older answer: the one consignment number, as before).
  const parcels = [...(transport.parcels ?? [])].sort((a, b) => a.seq - b.seq)
  const perParcel = parcels.length > 0
  const awb = awbCheck(dialog.text)
  const changes = parcelChangesOf(dialog, transport)
  const clearing = dialog.text.trim() === '' && !!transport.shipment.manualTrackingNumber && changes.length === 0
  const setParcel = (id: string, patch: { text?: string; link?: string }) => actions?.onDialog?.({ ...dialog, parcels: (dialog.parcels ?? []).map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)) })
  const left = noticeOffered(transport)
  // F-OS-305 (os-fx3; absent or null: not said): each parcel's weight ("27.5 kg") and when the shipping notice last went.
  const kg = new Intl.NumberFormat(INTL_LOCALE[locale], { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  const weightOf = (value: string | null | undefined): string | null => (value && Number.isFinite(Number(value)) && Number(value) > 0 ? t('door.tracking.kg', { kg: kg.format(Number(value)) }) : null)
  const told = transport.shipment.noticeSentAt ? t('door.tracking.told', { day: formatDate(transport.shipment.noticeSentAt, { locale }) }) : null
  return (
    <DepthDialog
      title={perParcel ? t('door.tracking.title', { number: transport.shipment.number }) : t('transport.trackingTitle', { carrier: transport.shipment.carrierName ?? '—' })}
      subtitle={perParcel ? (transport.shipment.carrierName ?? undefined) : transport.shipment.number}
      held={model.busy ? t('transport.held.busy') : say(trackingProblem(dialog, transport.shipment.manualTrackingNumber, transport))}
      onGo={() => actions?.onTracking?.()}
      goLabel={clearing ? t('transport.clearTracking') : perParcel ? t('door.tracking.go') : t('transport.saveTracking')}
      onClose={() => actions?.onDialog?.(null)}
      problem={say(model.problem)}
      size={perParcel ? 'lg' : 'sm'}
    >
      {/* L2: "Consignment number (tracking, AWB or B/L)" — the shipment's own number; L4: an air waybill's last digit checked in words. */}
      <Field label={perParcel ? t('door.tracking.consignment') : t('transport.trackingNumber')} hint={awb === 'fits' ? t('door.tracking.awbFits') : awb === 'off' ? t('door.tracking.awbOff') : t('transport.trackingClearHint')}>
        <Input size="sm" value={dialog.text} onChange={(event) => actions?.onDialog?.({ ...dialog, text: event.target.value })} />
      </Field>
      {/* F-OP-135 (B-OP-034): the carrier's tracking page typed beside the number — the customer's Track ›. */}
      <Field label={t('transport.trackingLink')} hint={t('transport.trackingLinkHint')}>
        <Input size="sm" type="url" inputMode="url" value={dialog.link ?? ''} onChange={(event) => actions?.onDialog?.({ ...dialog, link: event.target.value })} />
      </Field>
      {perParcel && (
        <fieldset className="fw-shd-choices">
          <legend className="fw-sh-h3">{t('door.tracking.parcels', { count: parcels.length })}</legend>
          {parcels.map((parcel) => {
            const head = [t('door.tracking.parcelOf', { seq: parcel.seq, count: parcels.length }), weightOf(parcel.grossWeightKg), parcelWords?.[parcel.id]].filter(Boolean).join(' · ')
            if (parcelLabelled(parcel))
              return (
                <div key={parcel.id} className="fw-shd-stack">
                  <span className="fw-sh-cell-sub">{head}</span>
                  <span>
                    <code>{parcel.label?.number ?? '—'}</code> <span className="fw-sh-hint">{t('door.tracking.fromLabel')}</span>
                  </span>
                </div>
              )
            const draft = (dialog.parcels ?? []).find((entry) => entry.id === parcel.id)
            if (!draft || !parcel.may.allowed)
              return (
                <div key={parcel.id} className="fw-shd-stack">
                  <span className="fw-sh-cell-sub">{head}</span>
                  <span className="fw-sh-hint">{parcel.may.refusal ? t(parcel.may.refusal.code === 'PARCEL_LABELLED' || parcel.may.refusal.code === 'NOT_PACKED' ? `door.tracking.refusal.${parcel.may.refusal.code}` : `transport.refusal.${parcel.may.refusal.code}`) : t('transport.held.notNow')}</span>
                </div>
              )
            return (
              <div key={parcel.id} className="fw-shd-stack">
                <span className="fw-sh-cell-sub">{head}</span>
                <div className="fw-shd-fields">
                  <Field label={t('door.tracking.parcelNumber', { seq: parcel.seq })}>
                    <Input size="sm" value={draft.text} onChange={(event) => setParcel(parcel.id, { text: event.target.value })} />
                  </Field>
                  <Field label={t('door.tracking.parcelLinkLabel', { seq: parcel.seq })}>
                    <Input size="sm" type="url" inputMode="url" value={draft.link} onChange={(event) => setParcel(parcel.id, { link: event.target.value })} />
                  </Field>
                </div>
              </div>
            )
          })}
          <p className="fw-sh-hint">{left ? t('door.tracking.afterLeft') : t('door.tracking.fromPacked')}</p>
        </fieldset>
      )}
      {/* B-OS-022: after the goods left, a number the customer could read changes or is cleared — the person says why (the audit keeps both). */}
      {trackingReasonNeeded(dialog, transport) && (
        <>
          <Banner tone="warning" title={t('door.tracking.seen')} />
          <Field label={t('door.why')} required hint={t('door.officeOnly')}>
            <Textarea rows={2} limit={PARCEL_TRACKING_LIMITS.reasonMax} value={dialog.reason ?? ''} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value })} />
          </Field>
        </>
      )}
      {perParcel && left && <Checkbox label={t('door.tracking.notify')} checked={dialog.notify === true} onChange={(event) => actions?.onDialog?.({ ...dialog, notify: event.target.checked })} />}
      {told && <p className="fw-sh-hint">{told}</p>}
      {perParcel && (
        <>
          <p className="fw-sh-hint">{left ? t('door.tracking.notifyHint') : t('door.tracking.toldPacked')}</p>
          <p className="fw-sh-hint">{t('door.tracking.never')}</p>
          <p className="fw-sh-hint">{t('door.audit')}</p>
        </>
      )}
    </DepthDialog>
  )
}

function StatusDialog({ transport, model, actions }: { transport: Transport; model: TransportModel; actions?: TransportActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const whenId = useId()
  if (model.dialog?.kind !== 'status') return null
  const dialog = model.dialog
  return (
    <DepthDialog
      title={t('transport.statusTitle', { number: transport.shipment.number })}
      held={model.busy ? t('transport.held.busy') : say(statusProblem(dialog, transport))}
      onGo={() => actions?.onStatus?.()}
      goLabel={dialog.status ? t('transport.statusGo', { status: t(`trackingStatus.${dialog.status}`) }) : t('transport.typeStatus')}
      onClose={() => actions?.onDialog?.(null)}
      problem={say(model.problem)}
    >
      <fieldset className="fw-shd-choices fw-shd-choices--grid">
        <legend className="fw-sh-h3">{t('transport.status')}</legend>
        {MANUAL_EVENT_STATUSES.map((status) => (
          <RadioCard key={status} name="typed-status" value={status} checked={dialog.status === status} selected={dialog.status === status} onChange={() => actions?.onDialog?.({ ...dialog, status })} title={t(`trackingStatus.${status}`)} description={status === 'DELIVERED' || status === 'RETURNED' ? t('transport.movesIt') : undefined} />
        ))}
      </fieldset>
      <div className="fw-shd-fields">
        <Field label={t('transport.when')} hint={t('transport.whenHint')} htmlFor={whenId}>
          <DateTimeField id={whenId} value={dialog.occurredAt ?? ''} onChange={(value) => actions?.onDialog?.({ ...dialog, occurredAt: value || null })} min={transport.shipment.shippedAt ?? undefined} max={new Date().toISOString()} locale={INTL_LOCALE[locale]} ariaLabel={t('transport.when')} />
        </Field>
        <Field label={t('transport.location')}>
          <Input size="sm" value={dialog.location} onChange={(event) => actions?.onDialog?.({ ...dialog, location: event.target.value })} />
        </Field>
        <Field label={t('transport.description')}>
          <Input size="sm" value={dialog.description} onChange={(event) => actions?.onDialog?.({ ...dialog, description: event.target.value })} />
        </Field>
      </div>
      {/* F-OS-203 (B-OS-015, Owner D5): over a carrier's labels the person says why; it is tagged "Set by hand" and stays final. */}
      {overridesLabels(dialog, transport) && (
        <>
          <p className="fw-sh-hint">{t('door.status.labelled')}</p>
          <Field label={t('door.why')} required hint={t('door.officeOnly')}>
            <Textarea rows={2} limit={OVERRIDE_REASON.max} value={dialog.reason ?? ''} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value })} />
          </Field>
        </>
      )}
      {(dialog.status === 'DELIVERED' || dialog.status === 'RETURNED') && (
        <>
          <p className="fw-sh-hint">{dialog.status === 'DELIVERED' ? t('door.status.deliveredFinal') : t('door.status.returnedThen')}</p>
          <p className="fw-sh-hint">{t('door.status.told')}</p>
        </>
      )}
    </DepthDialog>
  )
}

// ── F-OS-203 (order SHIPMENTS tab; B-OS-016): Set expected arrival… — typed by hand where no carrier feed tracks it ──────────────
function EtaDialog({ transport, model, actions }: { transport: Transport; model: TransportModel; actions?: TransportActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const dayId = useId()
  if (model.dialog?.kind !== 'eta') return null
  const dialog = model.dialog
  return (
    <DepthDialog
      title={t('door.eta.title', { number: transport.shipment.number })}
      held={model.busy ? t('transport.held.busy') : say(etaProblem(dialog, transport))}
      onGo={() => actions?.onEta?.()}
      goLabel={dialog.day === '' ? t('door.eta.clear') : t('door.eta.go')}
      onClose={() => actions?.onDialog?.(null)}
      problem={say(model.problem)}
      size="sm"
    >
      <p className="fw-sh-hint">{t('door.eta.what')}</p>
      <Field label={t('door.eta.day')} htmlFor={dayId}>
        <DateField id={dayId} value={dialog.day} onChange={(value) => actions?.onDialog?.({ ...dialog, day: value })} min={transport.shipment.shippedAt ? transport.shipment.shippedAt.slice(0, 10) : undefined} locale={INTL_LOCALE[locale]} clearable ariaLabel={t('door.eta.day')} />
      </Field>
      <Field label={t('door.wordsOptional')} hint={t('door.officeOnly')}>
        <Textarea rows={2} limit={500} value={dialog.reason} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value })} />
      </Field>
      <p className="fw-sh-hint">{t('door.eta.told')}</p>
    </DepthDialog>
  )
}
// ── end F-OS-203 ──

// ── F-OP-119 → F-OS-201 (order SHIPMENTS tab; 13-backend §7; L7): this card's windows opened from a sales order's Shipments tab ────────
/**
 * One of this card's own dialogs alone, for a page that opens it for ONE shipment (its container mounts useOwnTransport for it and
 * opens the dialog asked): Tracking number… · Mark delivered… / Mark returned… (the status dialog) · Change how it travels… (the
 * arrange dialog, L7) · Set expected arrival…. The same dialogs, words and refusals as here; a failed read said in a dialog with Try
 * again; nothing while it reads.
 */
export function TransportDoorDialog({ model, actions, onClose, parcelWords }: { model: TransportModel; actions?: TransportActions; onClose: () => void; /* F-OS-301: each parcel's weight and contents, as the opener knows them */ parcelWords?: Readonly<Record<string, string>> }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <TransportDoor model={model} actions={actions} onClose={onClose} parcelWords={parcelWords} />
    </WithMessages>
  )
}

function TransportDoor({ model, actions, onClose, parcelWords }: { model: TransportModel; actions?: TransportActions; onClose: () => void; parcelWords?: Readonly<Record<string, string>> }) {
  const { t } = useDepthWords()
  if (model.transport.state === 'error') {
    return <DepthDialog title={t('transport.title')} held={null} onGo={onClose} goLabel={t('common.done')} onClose={onClose} problem={null} size="sm" done={<PartRead problem={model.transport.problem} onRetry={actions?.onRetry} label={t('transport.title')} />} />
  }
  if (model.transport.state !== 'ready') return null
  const transport = model.transport.value
  switch (model.dialog?.kind) {
    case 'tracking':
      return <TrackingDialog transport={transport} model={model} actions={actions} parcelWords={parcelWords} />
    case 'status':
      return <StatusDialog transport={transport} model={model} actions={actions} />
    case 'arrange':
      return <ArrangeDialog transport={transport} model={model} actions={actions} />
    case 'eta':
      return <EtaDialog transport={transport} model={model} actions={actions} />
    default:
      return null
  }
}
// ── end F-OP-119 ──
