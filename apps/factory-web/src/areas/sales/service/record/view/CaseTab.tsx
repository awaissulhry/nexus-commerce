'use client'

import Link from 'next/link'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { Checkbox, Input, Select } from '@nexus/ui/primitives'
import { CASE_KINDS, CASE_LIMITS, CASE_PRIORITIES, CASE_WISHES } from '@nexus/factory-domain/sales/service/rules'
import { DateField, EditModeBar, Textarea } from '../../../../../lib/i18n/ds-parts'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { CaseKind, CasePriority, CaseRecord, CaseWish } from '../../api'
import { actionHeld, caseChangesOf, caseDraftOf, caseDraftProblems, personPhrase, type CaseDraft } from '../../model'
import { useWords } from '../../parts'
import type { ServiceRecordActions, ServiceRecordModel } from '../view-model'

/**
 * Case (design case.case "What the customer reports", explicit save: the DS EditModeBar, ⌘S): the customer and contact, the
 * serial or batch (ours fills the style, size and delivery day), the problem in the customer's words, what they want, the
 * priority and owner, the warranty's days (delivery, the legal and factory guarantee's last days), whether the customer is
 * told at each status change, and the internal note (staff only). Apply sends only what changed with the version read. A
 * closed case keeps its internal note editable only; without the right the fields are text and the card says so. Beside it:
 * our garment (serial → style, size, made on, work order, batch, shipped on). Photos are posted on the case's thread (Activity).
 */
export function CaseTab({ model, record, actions }: { model: ServiceRecordModel; record: CaseRecord; actions?: ServiceRecordActions }) {
  const { t, say, day } = useWords()
  const offline = model.live === 'offline'
  const editHeld = actionHeld(record, 'edit', false, model.can)
  const closed = record.status === 'CLOSED'
  // A closed case: the internal note only, for a person who may change cases (held CLOSED, not NO_PERMISSION).
  const noteOnly = closed && editHeld?.key === 'held.CLOSED'
  const editable = editHeld === null
  const draft: CaseDraft = model.draft ?? caseDraftOf(record)
  const changes = editable || noteOnly ? caseChangesOf(record, draft) : {}
  const count = Object.keys(changes).length
  const contact = model.contacts.items?.find((entry) => entry.id === draft.contactId) ?? (record.contact && record.contact.id === draft.contactId ? { ...record.contact, status: 'ACTIVE' } : null)
  const problems = caseDraftProblems(draft, model.today, contact?.email ?? null)
  const first = Object.values(problems)[0] ?? null
  const set = (patch: Partial<CaseDraft>) => actions?.onDraft?.(patch)
  const linked = record.links.length > 0
  const owners = model.owners ?? []
  const ownerOptions = draft.ownerId && !owners.some((person) => person.id === draft.ownerId) ? [{ id: draft.ownerId, name: say(personPhrase(record.people, draft.ownerId, model.me)) ?? '' }, ...owners] : owners
  const customers = model.customers.items ?? []
  const customerOptions = record.party && !customers.some((party) => party.id === record.party!.id) ? [{ id: record.party.id, code: record.party.code, legalName: record.party.legalName, tradeName: null }, ...customers] : customers
  const contacts = model.contacts.items ?? (record.contact ? [{ ...record.contact, status: 'ACTIVE' }] : [])
  const serial = record.garment.serial
  const batch = record.garment.batch
  const href = (type: string, id: string, label: string) => `${model.prefix}${recordAddress({ type, id, label, companyId: record.companyId }, OFFICE_PAGES)}`

  return (
    <div className="fw-svc-two">
      <div className="fw-svc-stack">
        {!editable && !noteOnly && <Banner tone="info" title={t('form.readOnly', { why: say(editHeld) ?? '' })} />}
        {noteOnly && <Banner tone="info" title={t('form.closedNoteOnly')} />}
        <Card padded>
          <section className="fw-svc-stack" aria-labelledby="svc-case">
            <h2 id="svc-case" className="fw-svc-h2">
              {t('form.title')}
            </h2>
            {editable ? (
              <div className="fw-svc-form">
                <Field label={t('new.party')} hint={linked ? t('form.partyLinked') : !model.can.parties ? say({ key: 'held.right', params: { right: 'right.parties.view' } }) : undefined}>
                  <Select value={draft.partyId} disabled={linked || !model.can.parties} onChange={(event) => set({ partyId: event.target.value, contactId: '', notifyCustomer: false })}>
                    <option value="">{t('new.rider')}</option>
                    {customerOptions.map((party) => (
                      <option key={party.id} value={party.id}>
                        {`${party.code} · ${party.tradeName ?? party.legalName}`}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('new.contact')} hint={draft.partyId ? t('new.contactHint') : t('form.contactNeedsParty')}>
                  <Select value={draft.contactId} disabled={!draft.partyId} onChange={(event) => set({ contactId: event.target.value, notifyCustomer: event.target.value ? draft.notifyCustomer : false })}>
                    <option value="">{t('new.noContact')}</option>
                    {contacts.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.email ? `${entry.name} · ${entry.email}` : entry.name}
                      </option>
                    ))}
                  </Select>
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
                <Field label={t('new.priority')}>
                  <Select value={draft.priority} onChange={(event) => set({ priority: event.target.value as CasePriority })}>
                    {CASE_PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>
                        {t(`priority.${priority}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('garment.serial')} hint={t('form.serialHint')} error={problems.serial ? say(problems.serial) : undefined}>
                  <Input value={draft.serial} maxLength={CASE_LIMITS.label} onChange={(event) => set({ serial: event.target.value })} />
                </Field>
                <Field label={t('new.batch')} error={problems.batchNumber ? say(problems.batchNumber) : undefined}>
                  <Input value={draft.batchNumber} maxLength={CASE_LIMITS.label} onChange={(event) => set({ batchNumber: event.target.value })} />
                </Field>
                <Field label={t('new.size')} error={problems.size ? say(problems.size) : undefined}>
                  <Input value={draft.size} maxLength={CASE_LIMITS.size} onChange={(event) => set({ size: event.target.value })} />
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
                <Field label={t('new.problem')} required className="is-wide" error={problems.problem ? say(problems.problem) : undefined}>
                  <Textarea value={draft.problem} rows={5} maxLength={CASE_LIMITS.problem} onChange={(event) => set({ problem: event.target.value })} />
                </Field>
                <Field label={t('new.owner')} hint={model.owners === null ? t('common.reading') : undefined}>
                  <Select value={draft.ownerId} onChange={(event) => set({ ownerId: event.target.value })}>
                    <option value="">{t('common.nobody')}</option>
                    {ownerOptions.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.id === model.me ? t('common.you') : person.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('form.deliveredOn')} hint={record.warranty.suggestedDeliveredOn ? t('form.deliveredSuggested', { date: day(record.warranty.suggestedDeliveredOn) }) : t('form.deliveredOnHint')} error={problems.deliveredOn ? say(problems.deliveredOn) : undefined}>
                  <DateField value={draft.deliveredOn} onChange={(value) => set({ deliveredOn: value })} />
                </Field>
                <Field label={t('form.legalEnds')} hint={t('form.legalEndsHint')} error={problems.legalGuaranteeEndsOn ? say(problems.legalGuaranteeEndsOn) : undefined}>
                  <DateField value={draft.legalGuaranteeEndsOn} onChange={(value) => set({ legalGuaranteeEndsOn: value })} />
                </Field>
                <Field label={t('form.factoryEnds')} hint={t('form.factoryEndsHint')} error={problems.factoryGuaranteeEndsOn ? say(problems.factoryGuaranteeEndsOn) : undefined}>
                  <DateField value={draft.factoryGuaranteeEndsOn} onChange={(value) => set({ factoryGuaranteeEndsOn: value })} />
                </Field>
                <Field label={t('form.notify')} className="is-wide" hint={contact?.email ? t('form.notifyHint', { to: contact.email }) : t('form.notifyNeedsEmail')} error={problems.notifyCustomer ? say(problems.notifyCustomer) : undefined}>
                  <Checkbox label={t('form.notifyLabel')} checked={draft.notifyCustomer} disabled={!contact?.email && !draft.notifyCustomer} onChange={(event) => set({ notifyCustomer: event.target.checked })} />
                </Field>
              </div>
            ) : (
              <>
                {!noteOnly && <p className="fw-svc-hint">{t('form.viewOnly')}</p>}
                <KeyValue
                  items={[
                    { label: t('new.party'), value: record.party ? `${record.party.code} · ${record.party.legalName}` : t('new.rider') },
                    { label: t('new.contact'), value: record.contact ? (record.contact.email ? `${record.contact.name} · ${record.contact.email}` : record.contact.name) : '—' },
                    { label: t('new.kind'), value: t(`kind.${record.kind}`) },
                    { label: t('new.channel'), value: t(`channel.${record.channel}`) },
                    { label: t('new.priority'), value: t(`priority.${record.priority}`) },
                    { label: t('garment.serial'), value: record.serial ?? '—' },
                    { label: t('new.batch'), value: record.batchNumber ?? '—' },
                    { label: t('new.size'), value: record.size ?? '—' },
                    { label: t('new.wish'), value: record.customerWants ? t(`wish.${record.customerWants}`) : t('wish.none') },
                    { label: t('new.owner'), value: say(personPhrase(record.people, record.ownerId, model.me)) },
                    { label: t('form.deliveredOn'), value: day(record.warranty.deliveredOn) },
                    { label: t('form.legalEnds'), value: day(record.warranty.legalGuaranteeEndsOn) },
                    { label: t('form.factoryEnds'), value: day(record.warranty.factoryGuaranteeEndsOn) },
                    { label: t('form.notify'), value: record.notifyCustomer ? t('form.notifyOn') : t('form.notifyOff') },
                  ]}
                />
                <p className="fw-svc-text">{record.problem}</p>
              </>
            )}
          </section>
        </Card>
        {(editable || noteOnly) && count > 0 && <EditModeBar count={count} busy={model.saving} onDiscard={() => actions?.onDiscard?.()} onApply={() => actions?.onSave?.()} applyHeldReason={offline ? t('form.offlineKept') : first ? say(first) : null} saveShortcut />}
      </div>

      <div className="fw-svc-stack">
        <Card padded>
          <section className="fw-svc-stack" aria-labelledby="svc-garment">
            <h2 id="svc-garment" className="fw-svc-h2">
              {t('garment.title')}
            </h2>
            {serial ? (
              <KeyValue
                items={[
                  { label: t('garment.serial'), value: serial.serial },
                  { label: t('garment.style'), value: record.style ? `${record.style.code} · ${record.style.name}` : '—' },
                  { label: t('garment.colourway'), value: record.colourway ? `${record.colourway.code} · ${record.colourway.name}` : '—' },
                  { label: t('new.size'), value: record.size ?? '—' },
                  { label: t('garment.madeOn'), value: day(serial.madeOn) },
                  { label: t('garment.workOrder'), value: serial.workOrderNumber },
                  { label: t('garment.batch'), value: serial.batchNumber ?? '—' },
                  {
                    label: t('garment.shipment'),
                    value: serial.shipment ? (
                      <Link className="fw-svc-link" href={href('Shipment', serial.shipment.id, serial.shipment.number)}>
                        {t('garment.shippedOn', { number: serial.shipment.number, date: day(serial.shipment.day) })}
                      </Link>
                    ) : (
                      t('garment.notShipped')
                    ),
                  },
                ]}
              />
            ) : batch ? (
              <KeyValue
                items={[
                  { label: t('garment.batch'), value: batch.batchNumber },
                  { label: t('garment.workOrder'), value: batch.workOrderNumber },
                  { label: t('garment.style'), value: record.style ? `${record.style.code} · ${record.style.name}` : '—' },
                  { label: t('garment.deliveries'), value: batch.deliveries.length === 0 ? t('garment.noDeliveries') : batch.deliveries.map((delivery) => t('garment.shippedOn', { number: delivery.number, date: day(delivery.day) })).join(', ') },
                ]}
              />
            ) : (
              <p className="fw-svc-hint">{record.serial || record.batchNumber ? t('garment.notOurs', { label: record.serial ?? record.batchNumber ?? '' }) : t('garment.none')}</p>
            )}
            <p className="fw-svc-hint">{t('garment.photos')}</p>
          </section>
        </Card>
        <Card padded>
          <section className="fw-svc-stack" aria-labelledby="svc-note">
            <h2 id="svc-note" className="fw-svc-h2">
              {t('form.internalNote')}
            </h2>
            <p className="fw-svc-hint">{t('form.internalNoteHint')}</p>
            {editable || noteOnly ? (
              <Field label={t('form.internalNote')} error={problems.internalNote ? say(problems.internalNote) : undefined}>
                <Textarea value={draft.internalNote} rows={4} maxLength={CASE_LIMITS.internalNote} onChange={(event) => set({ internalNote: event.target.value })} />
              </Field>
            ) : (
              <p className="fw-svc-text">{record.internalNote || '—'}</p>
            )}
          </section>
        </Card>
        {record.resolution && (
          <Card padded>
            <section className="fw-svc-stack" aria-labelledby="svc-resolution">
              <h2 id="svc-resolution" className="fw-svc-h2">
                {t('form.resolution')}
              </h2>
              <p className="fw-svc-hint">{t('form.resolvedOn', { date: day(record.resolution.at) })}</p>
              <p className="fw-svc-text">{record.resolution.words}</p>
            </section>
          </Card>
        )}
      </div>
    </div>
  )
}
