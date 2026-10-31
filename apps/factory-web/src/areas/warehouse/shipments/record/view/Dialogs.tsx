'use client'

import { useState } from 'react'
import { CheckCircle2, CircleAlert, Lock } from 'lucide-react'
import { Banner, Field, KeyValue, phraseMatches } from '@nexus/ui/components'
import { Button, Checkbox, Input, NumberStepper, Select, Spinner, Textarea } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { DDT_FREIGHT, DDT_REASONS, LINK_EXPIRY_DAYS, TRANSPORT_BY, type Shipment, type TransportBy } from '../../api'
import { annulPhrase, carrierWords, ddtProblemGroups, kilos, newShipmentLines, newShipmentProblems, type DdtForm } from '../../model'
import type { ShipmentRecordActions, ShipmentRecordModel } from '../record-model'
import { DailyDialog } from './DailyDialogs'
import { close, Frame } from './DialogFrame'

/**
 * A shipment's dialogs (design sh-issue-ddt, sh-buy, sh-handover, sh-annul; W1): Issue DDT (what the office says on it,
 * the server's checks, "Number N is taken and kept for 10 years; the DDT cannot change after this"), Annul DDT (a reason
 * and its number typed: it keeps its number, "Annulled", and a new DDT replaces it), Buy labels (outside the building:
 * the company's carrier account is charged; the outcome per parcel), Mark handed over, Cancel shipment, Change delivery,
 * Add garments (from what the order can still ship), a carton's weight and size, Send the document link, Unpack. Esc
 * closes; the focus returns to the opener (DS Modal); ⌘↵ confirms. A refused write is said inside its dialog.
 */
export function ShipmentDialogs({ shipment, model, actions }: { shipment: Shipment; model: ShipmentRecordModel; actions?: ShipmentRecordActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  const props = { shipment, model, actions }
  switch (dialog.kind) {
    case 'issueDdt':
      return <IssueDdtDialog {...props} />
    case 'annulDdt':
      return <AnnulDialog {...props} ddtId={dialog.ddtId} />
    case 'buyLabels':
      return <BuyDialog {...props} />
    case 'handOver':
      return <HandOverDialog {...props} />
    case 'cancel':
      return <CancelDialog {...props} />
    case 'delivery':
      return <DeliveryDialog {...props} />
    case 'addLines':
      return <AddLinesDialog {...props} />
    case 'parcel':
      return <ParcelDialog {...props} parcelId={dialog.parcelId} />
    case 'sendLink':
      return <SendLinkDialog {...props} />
    case 'unpack':
      return <UnpackDialog {...props} />
    default:
      // B-W2a-71: Void labels, the freight charged, the transport evidence.
      return <DailyDialog {...props} />
  }
}

interface DialogProps {
  shipment: Shipment
  model: ShipmentRecordModel
  actions?: ShipmentRecordActions
}

// ---- Issue DDT ---------------------------------------------------------------------------------------------------------

function IssueDdtDialog({ shipment, model, actions }: DialogProps) {
  const t = useT('shipments')
  const locale = useLocale()
  const form = model.ddtForm
  const preview = model.preview?.value ?? null
  if (!form) return null
  const set = (next: Partial<DdtForm>) => actions?.onDdtForm?.({ ...form, ...next })
  const groups = ddtProblemGroups(preview)
  const field = (name: string) => groups.fields.find((entry) => entry.path === `body/${name}` || entry.path.startsWith(`body/${name}/`))?.message
  const number = preview?.expectedNumber ?? null
  const held = model.busy ? t('held.busy') : !preview ? t('held.previewFirst') : groups.state.length + groups.company.length > 0 ? t('held.ddtChecks', { count: groups.state.length + groups.company.length }) : null
  return (
    <Frame
      title={t('issue.title')}
      subtitle={t('issue.subtitle', { number: shipment.number })}
      held={held}
      go={() => actions?.onIssueDdt?.()}
      goLabel={form.ship ? t('issue.goShip', { number: number ?? '' }) : t('issue.go', { number: number ?? '' })}
      onClose={close(actions)}
      problem={model.dialogProblem}
      size="lg"
    >
      <p className="fw-sh-frozen">
        <Lock size={14} aria-hidden /> {number ? t('issue.frozen', { number }) : t('issue.frozenNoNumber')}
      </p>
      {groups.state.length + groups.company.length > 0 && (
        <Banner tone="warning" title={t('issue.checks', { count: groups.state.length + groups.company.length })}>
          <ul className="fw-sh-list">
            {[...groups.state, ...groups.company].map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Banner>
      )}
      <div className="fw-sh-fields">
        {/* B-W2a-71 (the DDT reason choice): each reason says when it applies; processing on account and returns to a
            supplier travel with the DDT of their own record (B-W2a-17), never a shipment to a customer. */}
        <Field label={t('issue.reason')} hint={t(`issue.reasonHint.${form.reason ?? 'SALE'}`)} error={field('reason')}>
          <Select size="sm" value={form.reason ?? 'SALE'} onChange={(event) => set({ reason: event.target.value as DdtForm['reason'] })}>
            {DDT_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {t(`reason.${reason}`)}
              </option>
            ))}
          </Select>
        </Field>
        {form.reason === 'OTHER' && (
          <Field label={t('issue.reasonText')} required error={field('reasonText')}>
            <Input size="sm" value={form.reasonText} onChange={(event) => set({ reasonText: event.target.value })} />
          </Field>
        )}
        {shipment.transportBy === 'CARRIER' && (
          <Field label={t('issue.carrier')} hint={t('issue.carrierHint')} error={field('carrier')}>
            <Input size="sm" value={form.carrierName} onChange={(event) => set({ carrierName: event.target.value })} />
          </Field>
        )}
        <Field label={t('issue.appearance')} hint={t('issue.appearanceHint')} error={field('appearance')}>
          <Input size="sm" value={form.appearance} onChange={(event) => set({ appearance: event.target.value })} />
        </Field>
        <Field label={t('issue.net')} hint={t('issue.netHint', { gross: kilos(preview?.draft.grossWeightKg ?? null, locale) ?? '—' })} error={field('netWeightKg')}>
          <Input size="sm" inputMode="decimal" value={form.netWeightKg} onChange={(event) => set({ netWeightKg: event.target.value })} suffix="kg" />
        </Field>
        <Field label={t('issue.freight')} error={field('freight')}>
          <Select size="sm" value={form.freight} onChange={(event) => set({ freight: event.target.value as DdtForm['freight'] })}>
            <option value="">{t('issue.freightNone')}</option>
            {DDT_FREIGHT.map((value) => (
              <option key={value} value={value}>
                {t(`freight.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <p className="fw-sh-hint">{t('issue.otherReasons')}</p>
      <Field label={t('issue.remarks')} error={field('remarks')}>
        <Textarea rows={2} value={form.remarks} onChange={(event) => set({ remarks: event.target.value })} />
      </Field>
      {shipment.transportBy !== 'CARRIER' && (
        <Checkbox checked={form.ship} onChange={(event) => set({ ship: event.target.checked })} label={t(`issue.ship.${shipment.transportBy}`)} />
      )}
      {preview && (
        <KeyValue
          labelCase="sentence"
          items={[
            { label: t('docs.ddt.field.packages'), value: String(preview.draft.packages) },
            { label: t('docs.ddt.field.weight'), value: t('list.kg', { value: kilos(preview.draft.grossWeightKg, locale) ?? '—' }) },
            { label: t('docs.ddt.field.recipient'), value: preview.draft.recipient.name },
            { label: t('docs.ddt.field.language'), value: preview.language.toUpperCase() },
          ]}
        />
      )}
      <span className="fw-sh-inline">
        <Button size="sm" onClick={() => actions?.onPreview?.()} heldReason={model.busy ? t('held.busy') : null}>
          {t('issue.check')}
        </Button>
        {model.preview && !model.preview.value && !model.preview.problem && <Spinner size={14} />}
      </span>
    </Frame>
  )
}

// ---- Annul DDT --------------------------------------------------------------------------------------------------------

function AnnulDialog({ shipment, model, actions, ddtId }: DialogProps & { ddtId: string }) {
  const t = useT('shipments')
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const ddt = model.ddt?.value && model.ddt.value.id === ddtId ? model.ddt.value : null
  const number = ddt?.number ?? model.ddts.value?.find((row) => row.id === ddtId)?.number ?? ''
  const held = model.busy ? t('held.busy') : reason.trim().length < 3 ? t('annul.held.reason') : !phraseMatches(typed, annulPhrase({ number })) ? t('annul.held.phrase') : null
  return (
    <Frame title={t('annul.title', { number })} held={held} go={() => actions?.onAnnulDdt?.(ddtId, reason.trim())} goLabel={t('annul.go')} onClose={close(actions)} problem={model.dialogProblem} tone="danger">
      <p>{t('annul.what', { number })}</p>
      <ul className="fw-sh-list">
        <li>{t('annul.keeps')}</li>
        <li>{shipment.status === 'SHIPPED' ? t('annul.shipped') : t('annul.packed')}</li>
        <li>{t('annul.invoice')}</li>
      </ul>
      <Field label={t('annul.reason')} required>
        <Textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
      {/* The DS ConfirmPhraseField speaks English only ("Capital letters and spaces count."): the same check, our words. */}
      <Field label={t('annul.type', { number })} hint={t('annul.typeHint')} error={typed.trim() !== '' && !phraseMatches(typed, annulPhrase({ number })) ? t('annul.typeWrong') : undefined}>
        <Input size="sm" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} />
      </Field>
    </Frame>
  )
}

// ---- Buy labels ---------------------------------------------------------------------------------------------------------

function BuyDialog({ shipment, model, actions }: DialogProps) {
  const t = useT('shipments')
  const locale = useLocale()
  const carrier = carrierWords(shipment)
  const toLabel = model.labels?.value?.toLabel ?? shipment.parcels.filter((parcel) => !parcel.trackingNumber).length
  const bought = model.bought
  const done = bought ? (
    <div className="fw-sh-stack">
      <p className="fw-sh-done">
        {bought.problem ? <CircleAlert size={16} aria-hidden /> : <CheckCircle2 size={16} aria-hidden />} {bought.problem ? t('buy.partial') : t('buy.done', { count: bought.outcomes.filter((entry) => entry.ok).length })}
      </p>
      <ul className="fw-sh-list">
        {bought.outcomes.map((outcome) => (
          <li key={outcome.parcelId}>{outcome.ok ? t('buy.parcelOk', { seq: outcome.seq }) : t('buy.parcelRefused', { seq: outcome.seq, problem: outcome.problem ?? '—' })}</li>
        ))}
      </ul>
      {bought.problem && <p className="fw-sh-hint">{bought.problem}</p>}
    </div>
  ) : undefined
  return (
    <Frame title={t('buy.title')} held={model.busy ? t('held.busy') : null} go={() => actions?.onBuyLabels?.()} goLabel={t('buy.go', { count: toLabel })} onClose={close(actions)} problem={model.dialogProblem} done={done}>
      <KeyValue
        labelCase="sentence"
        items={[
          { label: t('carrier.carrier'), value: t(carrier.key, carrier.params) },
          { label: t('carrier.service'), value: shipment.serviceCode ?? t('carrier.serviceDefault') },
          { label: t('carrier.parcels'), value: shipment.parcels.filter((parcel) => !parcel.trackingNumber).map((parcel) => `${parcel.seq}: ${kilos(parcel.grossWeightKg, locale) ?? '—'} kg`).join(' · ') },
        ]}
      />
      <ul className="fw-sh-list">
        <li>{t('buy.outside')}</li>
        <li>{t('buy.void')}</li>
        <li>{t('buy.test')}</li>
      </ul>
      {model.busy && (
        <p className="fw-sh-hint" role="status">
          <Spinner size={14} /> {t('buy.busy')}
        </p>
      )}
    </Frame>
  )
}

// ---- Mark handed over ---------------------------------------------------------------------------------------------------

function HandOverDialog({ shipment, model, actions }: DialogProps) {
  const t = useT('shipments')
  const locale = useLocale()
  const ddt = model.ddt?.value ?? null
  return (
    <Frame title={t('handOver.title')} subtitle={shipment.number} held={model.busy ? t('held.busy') : null} go={() => actions?.onHandOver?.()} goLabel={t('step.handOver')} onClose={close(actions)} problem={model.dialogProblem}>
      <ul className="fw-sh-list">
        <li>{t('handOver.stock', { count: shipment.garments })}</li>
        <li>{ddt ? t('handOver.ddt', { number: ddt.number, start: formatDateTime(ddt.startAt, { locale }) }) : t('handOver.noDdt')}</li>
        <li>{t('handOver.documents')}</li>
        <li>{t('handOver.final')}</li>
      </ul>
    </Frame>
  )
}

// ---- Cancel shipment ----------------------------------------------------------------------------------------------------

function CancelDialog({ shipment, model, actions }: DialogProps) {
  const t = useT('shipments')
  const [reason, setReason] = useState('')
  const held = model.busy ? t('held.busy') : reason.trim() === '' ? t('cancel.held') : null
  return (
    <Frame title={t('cancel.title', { number: shipment.number })} held={held} go={() => actions?.onCancel?.(reason.trim())} goLabel={t('cancel.go')} onClose={close(actions)} problem={model.dialogProblem} tone="danger">
      <p>{t('cancel.what', { count: shipment.garments })}</p>
      <Field label={t('cancel.reason')} required>
        <Textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
    </Frame>
  )
}

// ---- Change delivery ----------------------------------------------------------------------------------------------------

function DeliveryDialog({ shipment, model, actions }: DialogProps) {
  const t = useT('shipments')
  const [transportBy, setTransportBy] = useState<TransportBy>(shipment.transportBy)
  const [carrierCode, setCarrierCode] = useState(shipment.carrierCode ?? '')
  const [serviceCode, setServiceCode] = useState(shipment.serviceCode ?? '')
  return (
    <Frame title={t('delivery.title')} held={model.busy ? t('held.busy') : null} go={() => actions?.onDelivery?.({ transportBy, carrierCode, serviceCode })} goLabel={t('delivery.go')} onClose={close(actions)} problem={model.dialogProblem}>
      <div className="fw-sh-fields">
        <Field label={t('new.transportBy')}>
          <Select size="sm" value={transportBy} onChange={(event) => setTransportBy(event.target.value as TransportBy)}>
            {TRANSPORT_BY.map((value) => (
              <option key={value} value={value}>
                {t(`transportBy.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
        {transportBy === 'CARRIER' && (
          <>
            <Field label={t('new.carrierCode')} hint={t('new.carrierHint')}>
              <Input size="sm" value={carrierCode} onChange={(event) => setCarrierCode(event.target.value)} />
            </Field>
            <Field label={t('new.serviceCode')} hint={t('delivery.serviceHint')}>
              <Input size="sm" value={serviceCode} onChange={(event) => setServiceCode(event.target.value)} />
            </Field>
          </>
        )}
      </div>
      <p className="fw-sh-hint">{t('delivery.note')}</p>
    </Frame>
  )
}

// ---- Add garments ---------------------------------------------------------------------------------------------------------

function AddLinesDialog({ model, actions }: DialogProps) {
  const t = useT('shipments')
  const [quantities, setQuantities] = useState<Record<string, number>>({})
  const ready = model.ready
  const order = ready?.value ?? null
  const cells = (order?.cells ?? []).filter((cell) => cell.shippable > 0)
  const lines = newShipmentLines(cells, quantities)
  const problems = newShipmentProblems(cells, quantities)
  const held = model.busy ? t('held.busy') : problems.length > 0 ? t('new.held.range') : lines.length === 0 ? t('new.held.none') : null
  return (
    <Frame title={t('addLines.title')} held={held} go={() => actions?.onAddLines?.(lines)} goLabel={t('addLines.go', { count: lines.reduce((sum, line) => sum + line.quantity, 0) })} onClose={close(actions)} problem={model.dialogProblem} size="lg">
      {!ready || (!ready.value && !ready.problem) ? (
        <p className="fw-sh-hint" role="status">
          <Spinner size={14} /> {t('new.loading')}
        </p>
      ) : ready.problem ? (
        <Banner tone="warning" title={t(ready.problem)} />
      ) : cells.length === 0 ? (
        <p className="fw-sh-hint">{t('addLines.none')}</p>
      ) : (
        <div className="fw-sh-size-grid">
          {cells.map((cell) => (
            <Field key={cell.workOrderSizeId} label={`${cell.styleCode} · ${cell.colourwayName} · ${cell.size}`} hint={t('new.cap', { count: cell.shippable, batch: cell.batchNumber ?? cell.workOrderNumber })} error={problems.find((entry) => entry.cellId === cell.workOrderSizeId) ? t('new.problem.range', { max: cell.shippable }) : undefined}>
              <NumberStepper size="sm" min={0} max={cell.shippable} value={quantities[cell.workOrderSizeId] ?? 0} onChange={(next) => setQuantities((current) => ({ ...current, [cell.workOrderSizeId]: next }))} decrementLabel={t('new.minus', { size: cell.size })} incrementLabel={t('new.plus', { size: cell.size })} />
            </Field>
          ))}
        </div>
      )}
    </Frame>
  )
}

// ---- A carton's weight and size ------------------------------------------------------------------------------------------

function ParcelDialog({ shipment, model, actions, parcelId }: DialogProps & { parcelId: string | null }) {
  const t = useT('shipments')
  const parcel = parcelId ? (shipment.parcels.find((entry) => entry.id === parcelId) ?? null) : null
  const number = (value: string | null) => (value === null ? '' : String(Number(value)))
  const [grossWeightKg, setWeight] = useState(number(parcel?.grossWeightKg ?? null))
  const [lengthCm, setLength] = useState(number(parcel?.lengthCm ?? null))
  const [widthCm, setWidth] = useState(number(parcel?.widthCm ?? null))
  const [heightCm, setHeight] = useState(number(parcel?.heightCm ?? null))
  const bad = (text: string) => text.trim() !== '' && !(Number(text.replace(',', '.')) > 0)
  const held = model.busy ? t('held.busy') : [grossWeightKg, lengthCm, widthCm, heightCm].some(bad) ? t('parcel.held') : shipment.status === 'PACKED' && grossWeightKg.trim() === '' ? t('parcel.heldWeight') : null
  return (
    <Frame
      title={parcel ? t('parcel.title', { carton: t('cartons.name', { seq: parcel.seq, count: shipment.parcels.length }) }) : t('parcel.new')}
      held={held}
      go={() => actions?.onSaveParcel?.(parcelId, { grossWeightKg, lengthCm, widthCm, heightCm })}
      goLabel={parcel ? t('parcel.save') : t('cartons.add')}
      onClose={close(actions)}
      problem={model.dialogProblem}
      size="sm"
    >
      <Field label={t('parcel.weight')} error={bad(grossWeightKg) ? t('parcel.positive') : undefined}>
        <Input size="sm" inputMode="decimal" value={grossWeightKg} onChange={(event) => setWeight(event.target.value)} suffix="kg" autoFocus />
      </Field>
      <div className="fw-sh-fields fw-sh-fields--three">
        <Field label={t('parcel.length')} error={bad(lengthCm) ? t('parcel.positive') : undefined}>
          <Input size="sm" inputMode="decimal" value={lengthCm} onChange={(event) => setLength(event.target.value)} suffix="cm" />
        </Field>
        <Field label={t('parcel.width')} error={bad(widthCm) ? t('parcel.positive') : undefined}>
          <Input size="sm" inputMode="decimal" value={widthCm} onChange={(event) => setWidth(event.target.value)} suffix="cm" />
        </Field>
        <Field label={t('parcel.height')} error={bad(heightCm) ? t('parcel.positive') : undefined}>
          <Input size="sm" inputMode="decimal" value={heightCm} onChange={(event) => setHeight(event.target.value)} suffix="cm" />
        </Field>
      </div>
    </Frame>
  )
}

// ---- Send the document link ------------------------------------------------------------------------------------------------

function SendLinkDialog({ shipment, model, actions }: DialogProps) {
  const t = useT('shipments')
  const locale = useLocale()
  const recipients = model.documents.value?.recipients ?? []
  const [picked, setPicked] = useState<string[]>(recipients.map((entry) => entry.contactId))
  const [days, setDays] = useState(LINK_EXPIRY_DAYS)
  const sent = model.sent
  const held = model.busy ? t('held.busy') : picked.length === 0 ? t('link.held') : null
  const done = sent ? (
    <div className="fw-sh-stack">
      <p className="fw-sh-done">
        <CheckCircle2 size={16} aria-hidden /> {t('link.sent', { count: sent.links.length })}
      </p>
      <ul className="fw-sh-list">
        {sent.links.map((link) => (
          <li key={link.linkId}>{t(link.delivery === 'SENT' ? 'link.sentTo' : 'link.notSent', { email: link.email, until: formatDate(link.expiresAt, { locale }) })}</li>
        ))}
        {sent.skipped.map((entry) => (
          <li key={entry.email}>{t(`link.skipped.${entry.reason}`, { email: entry.email })}</li>
        ))}
      </ul>
    </div>
  ) : undefined
  return (
    <Frame title={t('link.title')} subtitle={shipment.number} held={held} go={() => actions?.onSendLink?.(picked, days)} goLabel={t('link.go', { count: picked.length })} onClose={close(actions)} problem={model.dialogProblem} done={done}>
      <p>{t('link.what')}</p>
      <fieldset className="fw-sh-fieldset">
        <legend className="fw-sh-h3">{t('link.to')}</legend>
        {recipients.map((recipient) => (
          <Checkbox
            key={recipient.contactId}
            checked={picked.includes(recipient.contactId)}
            onChange={(event) => setPicked((current) => (event.target.checked ? [...current, recipient.contactId] : current.filter((id) => id !== recipient.contactId)))}
            label={`${recipient.name} · ${recipient.email}`}
          />
        ))}
      </fieldset>
      <Field label={t('link.days')} hint={t('link.daysHint', { max: LINK_EXPIRY_DAYS })}>
        <NumberStepper size="sm" min={1} max={LINK_EXPIRY_DAYS} value={days} onChange={setDays} decrementLabel={t('link.fewer')} incrementLabel={t('link.more')} />
      </Field>
      <p className="fw-sh-hint">{t('link.resendNote')}</p>
    </Frame>
  )
}

// ---- Unpack ---------------------------------------------------------------------------------------------------------------

function UnpackDialog({ shipment, model, actions }: DialogProps) {
  const t = useT('shipments')
  return (
    <Frame title={t('unpack.title')} subtitle={shipment.number} held={model.busy ? t('held.busy') : null} go={() => actions?.onUnpack?.()} goLabel={t('action.unpack')} onClose={close(actions)} problem={model.dialogProblem} size="sm">
      <p>{t('unpack.what')}</p>
    </Frame>
  )
}
