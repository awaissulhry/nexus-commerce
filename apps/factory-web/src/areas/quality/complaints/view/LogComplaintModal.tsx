'use client'

import { useId } from 'react'
import Link from 'next/link'
import { ScanLine } from 'lucide-react'
import { Banner, Combobox, DateField, Field, Modal } from '@nexus/ui/components'
import { Button, Input, Select, Spinner, Textarea } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { OFFICE_CHANNELS, type OfficeChannel } from '../api'
import { dayAt, logProblems, PHOTO_MAX, recordHref, type LogField } from '../model'
import type { LogActions, LogModel } from '../view-model'
import { StatusPill, useWords } from './parts'

/**
 * Log complaint (design quality.complaints/pop:cmp-log; c, ?new=1, the band's primary): the customer, the order or the
 * garment's serial (scanned or typed: our serial finds its style, size, batch, the shipment it left on, its order and
 * customer — the preview fills only what is empty), what happened in the customer's words, the photos (sent once the
 * complaint is logged), how it came in and when. The customer's other open complaints show as a possible duplicate.
 * Log complaint is held with the first thing missing; Esc closes and the focus goes back to the opener.
 */
export function LogComplaintModal({ model, prefix, actions }: { model: LogModel; prefix: string; actions?: LogActions }) {
  const t = useWords()
  const locale = useLocale()
  const draft = model.draft
  const set = (patch: Partial<LogModel['draft']>) => actions?.onLogDraft?.(patch)
  const problems = logProblems(draft, model.today)
  const shown = (field: LogField) => (model.showProblems ? (problems.find((entry) => entry.field === field)?.key ?? null) : null)
  const error = (field: LogField) => {
    const key = shown(field)
    return key ? t(key) : undefined
  }
  const ids = {
    customer: useId(),
    contact: useId(),
    ref: useId(),
    serial: useId(),
    order: useId(),
    shipment: useId(),
    ret: useId(),
    style: useId(),
    size: useId(),
    batch: useId(),
    words: useId(),
    channel: useId(),
    received: useId(),
    photos: useId(),
    note: useId(),
  }
  const customers = model.customers.items
  const held = model.busy ? t('common.working') : problems.length > 0 && model.showProblems ? t(problems[0]!.key) : null
  const preview = model.preview
  const docSelect = (id: string, label: string, value: string, options: readonly { id: string; number: string }[] | null, onChange: (value: string) => void, noRight: string) => (
    <Field label={label} hint={options === null ? (draft.partyId ? t(noRight) : t('log.customerFirst')) : undefined} htmlFor={id}>
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={options === null}>
        <option value="">{t('log.none')}</option>
        {(options ?? []).map((option) => (
          <option key={option.id} value={option.id}>
            {option.number}
          </option>
        ))}
        {value && options && !options.some((option) => option.id === value) && <option value={value}>{t('log.foundByPreview')}</option>}
      </Select>
    </Field>
  )

  return (
    <Modal
      open
      onClose={() => actions?.onLogClose?.()}
      title={t('log.title')}
      size="lg"
      footer={
        <>
          <span className="fw-q-hint">{t('log.foot')}</span>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onLogClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onLogSubmit?.()}>
            {model.busy ? <Spinner size={12} /> : null} {t('log.submit')}
          </Button>
        </>
      }
    >
      <form
        className="fw-q-stack"
        onSubmit={(event) => {
          event.preventDefault()
          actions?.onLogSubmit?.()
        }}
      >
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
        <div className="fw-q-form-two">
          <Field label={<span id={`${ids.customer}-label`}>{t('log.customer')}</span>} required error={error('partyId') ?? (model.customers.problem ? t(model.customers.problem) : undefined)} hint={customers === null && !model.customers.problem ? t('log.customerHint') : undefined} htmlFor={ids.customer}>
            {customers ? (
              <Combobox
                options={customers.map((party) => ({ value: party.id, label: `${party.code} · ${party.tradeName ?? party.legalName}` }))}
                value={draft.partyId}
                onChange={(value) => set({ partyId: value, contactId: '', salesOrderId: '', shipmentId: '', returnId: '' })}
                placeholder={t('log.customerSearch')}
                labelledBy={`${ids.customer}-label`}
              />
            ) : (
              <Input id={ids.customer} disabled value={draft.partyId ? t('log.foundByPreview') : ''} placeholder={t('log.customerScan')} readOnly />
            )}
          </Field>
          <Field label={t('log.serial')} hint={t('log.serialHint')} error={error('serial')} htmlFor={ids.serial}>
            <span className="fw-cmp-scan">
              <Input
                id={ids.serial}
                value={draft.serial}
                leadingIcon={<ScanLine size={14} aria-hidden />}
                onChange={(event) => set({ serial: event.target.value })}
                onBlur={() => draft.serial.trim() && actions?.onLogLookUp?.()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    actions?.onLogLookUp?.()
                  }
                }}
                autoComplete="off"
              />
              <Button size="sm" heldReason={draft.serial.trim() || draft.partyId ? (model.previewing ? t('common.working') : null) : t('log.lookUpHeld')} onClick={() => actions?.onLogLookUp?.()}>
                {model.previewing ? <Spinner size={12} /> : null} {t('log.lookUp')}
              </Button>
            </span>
          </Field>
        </div>

        {preview?.garment && (
          <Banner tone={preview.garment.forThisCustomer ? 'info' : 'warning'} title={t(preview.garment.forThisCustomer ? 'log.garmentFound' : 'log.garmentOther')}>
            {t('garment.found', { day: formatDate(dayAt(preview.garment.madeOn), { locale }), workOrder: preview.garment.workOrderNumber, batch: preview.garment.batchNumber ?? '—' })}
            {preview.garment.shipment ? ` ${t('log.leftOn', { shipment: preview.garment.shipment.number })}` : ''}
          </Banner>
        )}
        {preview && !preview.garment && draft.serial.trim() && <Banner tone="warning" title={t('garment.unknownSerial')} />}
        {preview && preview.others.length > 0 && (
          <Banner tone="warning" title={t('log.others', { count: preview.others.length })}>
            <ul className="fw-q-lines">
              {preview.others.slice(0, 5).map((other) => (
                <li key={other.id}>
                  <Link className="fw-q-link" href={recordHref(prefix, other.id)} target="_blank">
                    {other.number}
                  </Link>{' '}
                  <StatusPill status={other.status} /> {other.summary}
                </li>
              ))}
            </ul>
          </Banner>
        )}

        <div className="fw-q-form-three">
          {docSelect(ids.order, t('field.order'), draft.salesOrderId, model.orders, (value) => set({ salesOrderId: value }), 'log.noOrders')}
          {docSelect(ids.shipment, t('field.shipment'), draft.shipmentId, model.shipments, (value) => set({ shipmentId: value }), 'log.noShipments')}
          {docSelect(ids.ret, t('field.return'), draft.returnId, model.returns, (value) => set({ returnId: value }), 'log.noReturns')}
          <Field label={t('field.style')} hint={model.styles === null ? t('triage.styleNoList') : undefined} htmlFor={ids.style}>
            <Select id={ids.style} value={draft.styleId} onChange={(event) => set({ styleId: event.target.value })} disabled={model.styles === null}>
              <option value="">{t('log.none')}</option>
              {(model.styles ?? []).map((style) => (
                <option key={style.id} value={style.id}>
                  {`${style.code} · ${style.name}`}
                </option>
              ))}
              {draft.styleId && model.styles && !model.styles.some((style) => style.id === draft.styleId) && <option value={draft.styleId}>{t('log.foundByPreview')}</option>}
            </Select>
          </Field>
          <Field label={t('field.size')} error={error('size')} htmlFor={ids.size}>
            <Input id={ids.size} value={draft.size} onChange={(event) => set({ size: event.target.value })} />
          </Field>
          <Field label={t('field.batch')} error={error('batchNumber')} hint={t('log.batchHint')} htmlFor={ids.batch}>
            <Input id={ids.batch} value={draft.batchNumber} onChange={(event) => set({ batchNumber: event.target.value })} />
          </Field>
        </div>

        <Field label={t('log.words')} required error={error('description')} hint={t('log.wordsHint')} htmlFor={ids.words}>
          <Textarea id={ids.words} rows={4} value={draft.description} onChange={(event) => set({ description: event.target.value })} />
        </Field>

        <div className="fw-q-form-three">
          <Field label={t('log.channel')} htmlFor={ids.channel}>
            <Select id={ids.channel} value={draft.channel} onChange={(event) => set({ channel: event.target.value as OfficeChannel })}>
              {OFFICE_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {t(`channel.${channel}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('log.receivedOn')} error={error('receivedOn')} htmlFor={ids.received}>
            <DateField id={ids.received} value={draft.receivedOn} onChange={(value) => set({ receivedOn: value })} locale={INTL_LOCALE[locale]} max={model.today} ariaLabel={t('log.receivedOn')} placeholder={t('log.now')} clearLabel={t('log.now')} />
          </Field>
          <Field label={t('log.contact')} hint={model.contacts === null ? (draft.partyId ? t('log.noContacts') : t('log.customerFirst')) : undefined} htmlFor={ids.contact}>
            <Select id={ids.contact} value={draft.contactId} onChange={(event) => set({ contactId: event.target.value })} disabled={model.contacts === null}>
              <option value="">{t('log.none')}</option>
              {(model.contacts ?? []).map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.email ? `${contact.name} · ${contact.email}` : contact.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('log.ref')} error={error('customerRef')} htmlFor={ids.ref}>
            <Input id={ids.ref} value={draft.customerRef} onChange={(event) => set({ customerRef: event.target.value })} />
          </Field>
          <Field label={t('log.photos')} error={error('photos')} hint={model.canPhotos ? t('log.photosHint', { max: PHOTO_MAX }) : t('log.photosNoRight')} htmlFor={ids.photos}>
            <Input
              id={ids.photos}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic"
              multiple
              disabled={!model.canPhotos}
              onChange={(event) => set({ photos: Array.from(event.target.files ?? []) })}
            />
          </Field>
        </div>
        {draft.photos.length > 0 && <p className="fw-q-hint">{t('log.photosPicked', { count: draft.photos.length })}</p>}

        <Field label={t('log.note')} hint={t('log.noteHint')} error={error('internalNote')} htmlFor={ids.note}>
          <Textarea id={ids.note} rows={2} value={draft.internalNote} onChange={(event) => set({ internalNote: event.target.value })} />
        </Field>
      </form>
    </Modal>
  )
}
