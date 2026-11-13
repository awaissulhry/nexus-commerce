'use client'

import { useId } from 'react'
import { Save } from 'lucide-react'
import { Banner, Card, Field } from '@nexus/ui/components'
import { Button, Input, Kbd, Select, Spinner } from '@nexus/ui/primitives'
import { DateTimeField, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useDsLabels } from '../../../../lib/i18n/ds-labels'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { basicsOf, formProblems, type Measurer } from '../model'
import { MtmMessages, NoticeLine, StartedTag, useSubmitKey, useWords } from '../parts'
import type { MeasurementsDialogActions, MeasurementsDialogModel } from '../view-model'
import { MeasurementForm } from './MeasurementForm'

/**
 * New measurements (design pop:mtm.new) and the record's New revision: the customer (team, dealer or private rider) and the
 * rider (a contact with the Rider role, or a new name), the garment type (its measurement template; whether made-to-measure has
 * started for it, GATE-MTM), the privacy notice given BEFORE any value (GDPR art. 13: which notice, when), who measured (the
 * person, another office person of ours, or someone outside named in words) and where, the MeasurementForm, fit notes and the
 * internal note, the base size (typed; suggested from the measures against an MTM style, PRD-202). Save makes revision 1 (or
 * N+1: the old one stays). ⌘↵ saves; Esc asks to keep or discard what was typed. Fetches nothing.
 */
export function MeasurementsDialog({ model, actions }: { model: MeasurementsDialogModel; actions?: MeasurementsDialogActions }) {
  return (
    <MtmMessages>
      <Dialog model={model} actions={actions} />
    </MtmMessages>
  )
}

function measurerValue(measurer: Measurer): string {
  return measurer.kind === 'person' ? measurer.id : measurer.kind
}

function Dialog({ model, actions }: { model: MeasurementsDialogModel; actions?: MeasurementsDialogActions }) {
  const { t, say, locale } = useWords()
  const ds = useDsLabels()
  const ids = { customer: useId(), rider: useId(), riderName: useId(), garment: useId(), takenAt: useId(), noticeRef: useId(), noticeAt: useId(), measurer: useId(), takenBy: useId(), place: useId(), base: useId(), style: useId(), fit: useId(), internal: useId() }
  const points = model.points ?? []
  const own = model.points ? formProblems(model.draft, points, { needNotice: model.mode === 'new', now: new Date().toISOString() }) : {}
  const problems = { ...own, ...model.problems }
  const isNew = model.mode === 'new'
  const headerHeld = isNew ? (!model.partyId ? t('new.held.customer') : !(model.contactId || model.riderName?.trim()) ? t('new.held.rider') : !model.garmentType ? t('new.held.garment') : null) : null
  const fieldCount = Object.keys(own).length
  const held = model.offline ? t('held.offline') : model.busy ? t('common.working') : headerHeld ?? (!model.points ? t('new.held.points') : points.length === 0 ? t('form.noPoints') : fieldCount > 0 ? t('form.problem.fix', { count: fieldCount }) : null)
  const onKey = useSubmitKey(true, !!held, () => actions?.onSave?.())
  const title = isNew ? t('new.title') : t('revision.title', { revision: (model.fixed?.revision ?? 0) + 1 })
  const now = new Date().toISOString()

  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="xl"
      title={title}
      subtitle={model.fixed ? t('revision.whose', { rider: model.fixed.riderName, customer: model.fixed.customer, garment: model.fixed.garmentType }) : t('new.sub')}
      footer={
        <span className="fw-mtm-actions">
          <Button variant="secondary" onClick={() => actions?.onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onSave?.()} aria-keyshortcuts="Meta+Enter">
            {model.busy ? <Spinner size={12} /> : <Save size={14} aria-hidden />} {isNew ? t('new.save') : t('revision.save', { revision: (model.fixed?.revision ?? 0) + 1 })} <Kbd>⌘↵</Kbd>
          </Button>
        </span>
      }
    >
      <div className="fw-mtm-stack" onKeyDown={onKey}>
        {model.leaving && (
          <Banner
            tone="warning"
            title={t('new.leave')}
            action={
              <span className="fw-mtm-actions">
                <Button size="sm" variant="secondary" onClick={() => actions?.onKeep?.()}>
                  {t('new.keep')}
                </Button>
                <Button size="sm" variant="danger" onClick={() => actions?.onDiscard?.()}>
                  {t('new.discard')}
                </Button>
              </span>
            }
          />
        )}
        {model.offline && <Banner tone="warning" title={t('held.offlineKept')} />}
        <NoticeLine notice={model.notice} />
        {isNew && (
          <div className="fw-mtm-fields">
            <Field label={t('new.customer')} required htmlFor={ids.customer} error={say(problems.customer) ?? undefined} hint={model.customers?.problem ? t(model.customers.problem) : t('new.customerHint')}>
              <span className="fw-mtm-tight">
                <Input id={ids.customer} size="sm" type="search" value={model.customerQ ?? ''} placeholder={t('new.customerSearch')} aria-label={t('new.customerSearch')} onChange={(event) => actions?.onCustomerQ?.(event.target.value)} />
                <Select size="sm" aria-label={t('new.customer')} value={model.partyId ?? ''} onChange={(event) => actions?.onCustomer?.(event.target.value)}>
                  <option value="">{model.customers?.items === null ? t('common.reading') : t('new.customerPick', { count: model.customers?.items?.length ?? 0 })}</option>
                  {(model.customers?.items ?? []).map((party) => (
                    <option key={party.id} value={party.id}>
                      {party.code} · {party.legalName}
                    </option>
                  ))}
                </Select>
              </span>
            </Field>
            <Field label={t('new.rider')} required htmlFor={ids.rider} error={say(problems.contact ?? problems.rider) ?? undefined} hint={t('new.riderHint')}>
              <span className="fw-mtm-tight">
                <Select id={ids.rider} size="sm" disabled={!model.partyId} value={model.contactId ?? ''} onChange={(event) => actions?.onRider?.({ contactId: event.target.value })}>
                  <option value="">{t('new.riderNew')}</option>
                  {(model.contacts?.items ?? []).map((contact) => (
                    <option key={contact.id} value={contact.id}>
                      {contact.name}
                      {contact.roles.includes('RIDER') ? ` · ${t('new.riderRole')}` : ''}
                    </option>
                  ))}
                </Select>
                {!model.contactId && <Input id={ids.riderName} size="sm" value={model.riderName ?? ''} placeholder={t('new.riderName')} aria-label={t('new.riderName')} onChange={(event) => actions?.onRider?.({ riderName: event.target.value })} />}
              </span>
            </Field>
            <Field label={t('new.garment')} required htmlFor={ids.garment} error={say(problems.garment) ?? undefined} hint={model.templates?.problem ? t(model.templates.problem) : t('new.garmentHint')}>
              <Select id={ids.garment} size="sm" value={model.garmentType ?? ''} onChange={(event) => actions?.onGarment?.(event.target.value)}>
                <option value="">{model.templates?.items === null ? t('common.reading') : t('new.garmentPick')}</option>
                {(model.templates?.items ?? []).map((template) => (
                  <option key={template.id} value={template.code}>
                    {template.code} · {template.nameI18n[locale] ?? template.name} · {t(template.rulesOn ? 'off.on' : 'off.off')}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        {model.template && (
          <p className="fw-mtm-row fw-mtm-hint">
            <StartedTag on={model.template.rulesOn} />
            <span>{model.template.rulesOn ? t('new.rulesOn', { template: model.template.code }) : t('off.template', { template: model.template.code })}</span>
          </p>
        )}
        <Card padded>
          <section className="fw-mtm-stack" aria-labelledby={`${ids.noticeRef}-h`}>
            <h3 id={`${ids.noticeRef}-h`} className="fw-mtm-h3">
              {t('new.who')}
            </h3>
            <div className="fw-mtm-fields">
              <Field label={t('new.noticeRef')} required={isNew} htmlFor={ids.noticeRef} hint={isNew ? t('new.noticeHint') : t('revision.noticeHint')} error={say(problems.noticeRef) ?? undefined}>
                <Input id={ids.noticeRef} size="sm" value={model.draft.noticeRef} onChange={(event) => actions?.onDraft?.({ noticeRef: event.target.value })} />
              </Field>
              <Field label={t('new.noticeAt')} required={isNew} htmlFor={ids.noticeAt} error={say(problems.noticeAt) ?? undefined}>
                <DateTimeField id={ids.noticeAt} value={model.draft.noticeAt} onChange={(value) => actions?.onDraft?.({ noticeAt: value })} max={now} defaultTime="09:00" locale={INTL_LOCALE[locale]} ariaLabel={t('new.noticeAt')} labels={ds.dateTimeField} />
              </Field>
              <Field label={t('new.takenAt')} required htmlFor={ids.takenAt} error={say(problems.takenAt) ?? undefined}>
                <DateTimeField id={ids.takenAt} value={model.draft.takenAt} onChange={(value) => actions?.onDraft?.({ takenAt: value })} max={now} defaultTime="09:00" locale={INTL_LOCALE[locale]} ariaLabel={t('new.takenAt')} labels={ds.dateTimeField} />
              </Field>
              <Field label={t('new.measurer')} htmlFor={ids.measurer} error={say(problems.measurer) ?? undefined}>
                <Select
                  id={ids.measurer}
                  size="sm"
                  value={measurerValue(model.draft.measurer)}
                  onChange={(event) => {
                    const value = event.target.value
                    actions?.onDraft?.({ measurer: value === 'me' ? { kind: 'me' } : value === 'outside' ? { kind: 'outside' } : { kind: 'person', id: value } })
                  }}
                >
                  <option value="me">{t('new.measurerMe', { name: model.me.name })}</option>
                  {(model.people ?? [])
                    .filter((person) => person.id !== model.me.id)
                    .map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                      </option>
                    ))}
                  <option value="outside">{t('new.measurerOutside')}</option>
                </Select>
              </Field>
              {model.draft.measurer.kind === 'outside' && (
                <Field label={t('new.takenBy')} required htmlFor={ids.takenBy} hint={t('new.takenByHint')} error={say(problems.takenBy) ?? undefined}>
                  <Input id={ids.takenBy} size="sm" value={model.draft.takenBy} onChange={(event) => actions?.onDraft?.({ takenBy: event.target.value })} />
                </Field>
              )}
              <Field label={t('new.place')} htmlFor={ids.place} hint={t('new.placeHint')}>
                <Input id={ids.place} size="sm" value={model.draft.place} onChange={(event) => actions?.onDraft?.({ place: event.target.value })} />
              </Field>
            </div>
          </section>
        </Card>
        {model.pointsProblem ? (
          <Banner tone="danger" title={t(model.pointsProblem)} />
        ) : !model.points ? (
          isNew && !model.garmentType ? (
            <p className="fw-mtm-hint">{t('new.pickGarmentFirst')}</p>
          ) : (
            <p className="fw-mtm-hint" role="status">
              <Spinner size={12} /> {t('new.readingPoints')}
            </p>
          )
        ) : (
          <MeasurementForm
            model={{ points, values: model.draft.values, confirmed: model.draft.confirmed, problems, flags: model.flags, basics: basicsOf(points), checking: model.checking, rulesOff: model.template ? !model.template.rulesOn : false }}
            actions={{ onValue: actions?.onValue, onConfirm: actions?.onConfirm }}
          />
        )}
        <div className="fw-mtm-fields">
          <Field label={t('new.baseSize')} htmlFor={ids.base} hint={model.suggested?.size ? t(model.suggested.how === 'INSIDE' ? 'new.suggestedInside' : 'new.suggestedNearest', { size: model.suggested.size }) : t('new.baseSizeHint')}>
            <span className="fw-mtm-row">
              <Input id={ids.base} size="sm" value={model.draft.baseSize} onChange={(event) => actions?.onDraft?.({ baseSize: event.target.value })} />
              {model.suggested?.size && model.suggested.size !== model.draft.baseSize && (
                <Button size="sm" variant="secondary" onClick={() => actions?.onDraft?.({ baseSize: model.suggested?.size ?? '' })}>
                  {t('new.useSuggested', { size: model.suggested.size })}
                </Button>
              )}
            </span>
          </Field>
          <Field label={t('new.checkStyle')} htmlFor={ids.style} hint={model.template && !model.template.rulesOn ? t('new.checkStyleOff') : t('new.checkStyleHint')}>
            <Select id={ids.style} size="sm" value={model.styleId} disabled={!model.styles || (model.template ? !model.template.rulesOn : true)} onChange={(event) => actions?.onStyle?.(event.target.value)}>
              <option value="">{model.styles === null ? t('common.reading') : t('new.checkStyleNone')}</option>
              {(model.styles ?? []).map((style) => (
                <option key={style.id} value={style.id}>
                  {style.code} · {style.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="fw-mtm-fields">
          <Field label={t('new.fitNotes')} htmlFor={ids.fit} hint={t('new.fitNotesHint')} error={say(problems.fitNotes) ?? undefined}>
            <Textarea id={ids.fit} rows={3} value={model.draft.fitNotes} onChange={(event) => actions?.onDraft?.({ fitNotes: event.target.value })} />
          </Field>
          <Field label={t('new.internal')} htmlFor={ids.internal} hint={t('new.internalHint')} error={say(problems.internalNote) ?? undefined}>
            <Textarea id={ids.internal} rows={3} value={model.draft.internalNote} onChange={(event) => actions?.onDraft?.({ internalNote: event.target.value })} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
