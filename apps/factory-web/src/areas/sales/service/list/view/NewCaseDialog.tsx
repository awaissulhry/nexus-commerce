'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { Plus, ScanLine } from 'lucide-react'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { CASE_KINDS, CASE_LIMITS, CASE_PRIORITIES, CASE_WISHES } from '@nexus/factory-domain/sales/service/rules'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import type { CaseKind, CasePriority, CaseWish } from '../../api'
import { caseDraftProblems, NEW_CHANNELS, newDraftHeld, recordHref, warningPhrase, type NewDraft, type Phrase, type ServiceCan } from '../../model'
import { NoticeLine, useWords } from '../../parts'
import { ScanSheet } from '../../view/ScanSheet'
import { WarrantyLines } from '../../view/WarrantyLines'
import type { NewCaseActions, NewCaseModel } from '../view-model'

/**
 * New case (design pop:service.new, the band's New case; `?new=1`): the customer or a rider (no customer of ours: named in the
 * words), the serial — scanned with the camera or typed (a USB scanner types too) — or a batch, the problem in the customer's
 * words and the channel; then the kind, the customer's wish, priority, owner, the delivery day and the factory guarantee's end
 * when the records do not give them, and whether the customer is told at each status change (only with a contact who has an
 * e-mail; off by default). Beside it, read while typing (POST …/preview, nothing written): our garment the serial names, the
 * warranty check and the other open cases of the same garment (a duplicate?). ⌘↵ creates it.
 */
export function NewCaseDialog({ model, can, me, prefix, today, actions }: { model: NewCaseModel; can: ServiceCan; me: string; prefix: string; today: string; actions?: NewCaseActions }) {
  const { t, say, day } = useWords()
  const draft = model.draft
  const set = (patch: Partial<NewDraft>) => actions?.onDraft?.(patch)
  const contact = model.contacts.items?.find((entry) => entry.id === draft.contactId) ?? null
  const problems = caseDraftProblems({ ...draft, legalGuaranteeEndsOn: '', internalNote: '' }, today, contact?.email ?? null)
  const heldPhrase: Phrase | null = !can.manage
    ? { key: 'held.right', params: { right: 'right.sales.service.manage' } }
    : model.offline
      ? { key: 'held.offline' }
      : model.busy
        ? { key: 'common.working' }
        : newDraftHeld(draft, today, contact?.email ?? null)
  const held = say(heldPhrase)
  const submit = () => {
    if (!heldPhrase) actions?.onSubmit?.()
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !heldPhrase && !model.scanning) {
        event.preventDefault()
        actions?.onSubmit?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [heldPhrase, actions, model.scanning])

  const owners = Array.isArray(model.owners) ? model.owners : []
  const ownerOptions = owners.some((person) => person.id === me) ? owners : [{ id: me, name: t('common.you') }, ...owners]
  const preview = model.preview.value
  const garment = preview?.garment ?? null
  const serial = garment?.serial ?? null
  const batch = garment?.batch ?? null
  // The customer the garment left for, offered while none is named (never set by itself: a rider's claim stays a rider's).
  const leftForId = !draft.partyId ? (preview?.draft.partyId ?? null) : null
  const leftFor = leftForId ? (model.customers.items?.find((party) => party.id === leftForId) ?? null) : null
  // One line per kind of warning (the other open cases have their own banner above).
  const warnings = [...new Set((preview?.warnings ?? []).map((warning) => warning.path))].filter((path) => !(path === 'body/serial' && (preview?.others.length ?? 0) > 0))

  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="xl"
      title={t('new.title')}
      subtitle={t('new.subtitle')}
      footer={
        <span className="fw-svc-actions">
          <Button variant="secondary" onClick={() => actions?.onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={held} onClick={submit} aria-keyshortcuts="Meta+Enter">
            {model.busy ? <Spinner size={12} /> : <Plus size={14} aria-hidden />} {t('new.go')}
          </Button>
        </span>
      }
    >
      <div className="fw-svc-two">
        <div className="fw-svc-dialog">
          <NoticeLine notice={model.notice} />
          <div className="fw-svc-form">
            <Field label={t('new.party')} className="is-wide" hint={can.parties ? t('new.partyHint') : say({ key: 'held.right', params: { right: 'right.parties.view' } })}>
              <Select value={draft.partyId} disabled={!can.parties} onChange={(event) => set({ partyId: event.target.value, contactId: '', notifyCustomer: false })}>
                <option value="">{t('new.rider')}</option>
                {(model.customers.items ?? []).map((party) => (
                  <option key={party.id} value={party.id}>
                    {`${party.code} · ${party.tradeName ?? party.legalName}`}
                  </option>
                ))}
              </Select>
            </Field>
            {model.customers.problem && <Banner tone="warning" title={t('new.customersFailed')} />}
            {draft.partyId && (
              <Field label={t('new.contact')} hint={model.contacts.items === null && !model.contacts.problem ? t('common.reading') : t('new.contactHint')}>
                <Select value={draft.contactId} onChange={(event) => set({ contactId: event.target.value, notifyCustomer: false })}>
                  <option value="">{t('new.noContact')}</option>
                  {(model.contacts.items ?? []).map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.email ? `${entry.name} · ${entry.email}` : entry.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label={t('new.channel')} className="is-wide">
              <SegmentedControl size="sm" ariaLabel={t('new.channel')} value={draft.channel} onChange={(value) => set({ channel: value as NewDraft['channel'] })} options={NEW_CHANNELS.map((channel) => ({ value: channel, label: t(`channel.${channel}`) }))} />
            </Field>
            <Field label={t('new.serial')} hint={t('new.serialHint')} error={problems.serial ? say(problems.serial) : undefined}>
              <span className="fw-svc-row">
                <Input value={draft.serial} maxLength={CASE_LIMITS.label} autoComplete="off" onChange={(event) => set({ serial: event.target.value })} aria-label={t('new.serial')} />
                <Button size="sm" variant="secondary" onClick={() => actions?.onScan?.(true)}>
                  <ScanLine size={14} aria-hidden /> {t('new.scan')}
                </Button>
              </span>
            </Field>
            <Field label={t('new.batch')} hint={t('new.batchHint')} error={problems.batchNumber ? say(problems.batchNumber) : undefined}>
              <Input value={draft.batchNumber} maxLength={CASE_LIMITS.label} onChange={(event) => set({ batchNumber: event.target.value })} />
            </Field>
            <Field label={t('new.problem')} hint={t('new.problemHint')} required className="is-wide" error={draft.problem && problems.problem ? say(problems.problem) : undefined}>
              <Textarea value={draft.problem} rows={4} maxLength={CASE_LIMITS.problem} onChange={(event) => set({ problem: event.target.value })} />
            </Field>
            <Field label={t('new.kind')}>
              <Select value={draft.kind} onChange={(event) => set({ kind: event.target.value as CaseKind })}>
                {CASE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`kind.${kind}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('new.wish')}>
              <Select value={draft.customerWants} onChange={(event) => set({ customerWants: event.target.value as CaseWish | '' })}>
                <option value="">{t('wish.none')}</option>
                {CASE_WISHES.map((wish) => (
                  <option key={wish} value={wish}>
                    {t(`wish.${wish}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('new.priority')}>
              <Select value={draft.priority} onChange={(event) => set({ priority: event.target.value as CasePriority })}>
                {CASE_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {t(`priority.${priority}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('new.owner')} hint={model.owners === 'failed' ? t('new.ownersFailed') : undefined}>
              <Select value={draft.ownerId} onChange={(event) => set({ ownerId: event.target.value })}>
                {ownerOptions.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.id === me ? t('common.you') : person.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('new.size')} error={problems.size ? say(problems.size) : undefined}>
              <Input value={draft.size} maxLength={CASE_LIMITS.size} onChange={(event) => set({ size: event.target.value })} />
            </Field>
            <Field label={t('form.deliveredOn')} hint={t('form.deliveredOnHint')} error={problems.deliveredOn ? say(problems.deliveredOn) : undefined}>
              <DateField value={draft.deliveredOn} onChange={(value) => set({ deliveredOn: value })} />
            </Field>
            <Field label={t('form.factoryEnds')} hint={t('form.factoryEndsHint')} error={problems.factoryGuaranteeEndsOn ? say(problems.factoryGuaranteeEndsOn) : undefined}>
              <DateField value={draft.factoryGuaranteeEndsOn} onChange={(value) => set({ factoryGuaranteeEndsOn: value })} />
            </Field>
            <Field label={t('form.notify')} className="is-wide" hint={contact?.email ? t('form.notifyHint', { to: contact.email }) : t('form.notifyNeedsEmail')} error={problems.notifyCustomer ? say(problems.notifyCustomer) : undefined}>
              <Checkbox label={t('form.notifyLabel')} checked={draft.notifyCustomer} disabled={!contact?.email} onChange={(event) => set({ notifyCustomer: event.target.checked })} />
            </Field>
          </div>
        </div>

        <Card padded>
          <section className="fw-svc-preview" aria-labelledby="svc-new-preview" aria-live="polite">
            <h3 id="svc-new-preview" className="fw-svc-h2">
              {t('new.previewTitle')}
            </h3>
            {model.preview.reading && (
              <p className="fw-svc-hint" role="status">
                <Spinner size={12} /> {t('new.previewReading')}
              </p>
            )}
            {model.preview.problem && <Banner tone="warning" title={t('new.previewFailed')} />}
            {!preview && !model.preview.reading && !model.preview.problem && <p className="fw-svc-hint">{t('new.previewEmpty')}</p>}
            {preview && (
              <>
                {draft.serial.trim() && !serial && <p className="fw-svc-hint">{t('new.notOurs', { serial: draft.serial.trim() })}</p>}
                {serial && (
                  <KeyValue
                    items={[
                      { label: t('garment.serial'), value: serial.serial },
                      { label: t('garment.madeOn'), value: day(serial.madeOn) },
                      { label: t('garment.workOrder'), value: serial.workOrderNumber },
                      { label: t('garment.batch'), value: serial.batchNumber ?? '—' },
                      { label: t('garment.shipment'), value: serial.shipment ? t('garment.shippedOn', { number: serial.shipment.number, date: day(serial.shipment.day) }) : t('garment.notShipped') },
                    ]}
                  />
                )}
                {batch && <p className="fw-svc-hint">{t('new.batchFound', { batch: batch.batchNumber, workOrder: batch.workOrderNumber, count: batch.deliveries.length })}</p>}
                {leftFor && (
                  <p className="fw-svc-row">
                    <span className="fw-svc-hint">{t('new.leftFor', { customer: `${leftFor.code} · ${leftFor.tradeName ?? leftFor.legalName}` })}</span>
                    <Button size="sm" variant="quiet" onClick={() => set({ partyId: leftFor.id, contactId: '', notifyCustomer: false })}>
                      {t('new.useCustomer')}
                    </Button>
                  </p>
                )}
                <WarrantyLines check={preview.warranty} label={t('warranty.title')} />
                <p className="fw-svc-text">{say({ key: preview.warranty.suggested ? `suggested.${preview.warranty.suggested}` : 'suggested.unknown' })}</p>
                {preview.others.length > 0 && (
                  <Banner tone="warning" title={t('new.others', { count: preview.others.length })}>
                    <ul className="fw-svc-lines">
                      {preview.others.map((other) => (
                        <li key={other.id}>
                          <Link className="fw-svc-link fw-svc-code" href={recordHref(prefix, other.id)} target="_blank">
                            {other.number}
                          </Link>{' '}
                          · {t(`status.${other.status}`)} · {t(`kind.${other.kind}`)}
                        </li>
                      ))}
                    </ul>
                  </Banner>
                )}
                {warnings.length > 0 && (
                  <ul className="fw-svc-lines">
                    {warnings.map((path) => (
                      <li key={path}>{say(warningPhrase(path))}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        </Card>
      </div>
      {model.scanning && <ScanSheet scanner={actions?.scanner ?? null} onScanned={(code) => actions?.onScanned?.(code)} onClose={() => actions?.onScan?.(false)} />}
    </Modal>
  )
}
