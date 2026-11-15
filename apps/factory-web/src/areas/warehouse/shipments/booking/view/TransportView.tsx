'use client'

import { useId } from 'react'
import { CircleCheck, ClipboardCheck, MapPin, Route, TriangleAlert } from 'lucide-react'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Pill, RadioCard } from '@nexus/ui/primitives'
import { DateTimeField } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DEPTH_NAMESPACES } from '../../queue/shared/depth'
import { DepthDialog, PartRead, useDepthWords } from '../../queue/shared/DepthDialog'
import type { LabelCheck, Transport } from '../api'
import { allProblems, arrangeDialogOf, arrangeProblem, checkProblemWords, MANUAL_EVENT_STATUSES, mayHeld, OWN_TRANSPORT_LIMITS, statusProblem, trackingProblem, type TransportActions, type TransportModel } from '../model'
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
          <Button size="sm" heldReason={trackBlocked} onClick={() => actions?.onDialog?.({ kind: 'tracking', text: shipment.manualTrackingNumber ?? '' })}>
            {shipment.manualTrackingNumber ? t('transport.changeTracking') : t('transport.typeTracking')}
          </Button>
        )}
        {typedStatuses && (
          <Button size="sm" heldReason={statusBlocked} onClick={() => actions?.onDialog?.({ kind: 'status', status: null, occurredAt: null, description: '', location: '' })}>
            <MapPin size={14} aria-hidden /> {t('transport.typeStatus')}
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

function TrackingDialog({ transport, model, actions }: { transport: Transport; model: TransportModel; actions?: TransportActions }) {
  const { t, say } = useDepthWords()
  if (model.dialog?.kind !== 'tracking') return null
  const dialog = model.dialog
  return (
    <DepthDialog
      title={t('transport.trackingTitle', { carrier: transport.shipment.carrierName ?? '—' })}
      subtitle={transport.shipment.number}
      held={model.busy ? t('transport.held.busy') : say(trackingProblem(dialog))}
      onGo={() => actions?.onTracking?.()}
      goLabel={dialog.text.trim() === '' && transport.shipment.manualTrackingNumber ? t('transport.clearTracking') : t('transport.saveTracking')}
      onClose={() => actions?.onDialog?.(null)}
      problem={say(model.problem)}
      size="sm"
    >
      <Field label={t('transport.trackingNumber')} hint={t('transport.trackingClearHint')}>
        <Input size="sm" value={dialog.text} onChange={(event) => actions?.onDialog?.({ ...dialog, text: event.target.value })} />
      </Field>
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
    </DepthDialog>
  )
}
