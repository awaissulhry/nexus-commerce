'use client'

import { Camera, Send, Trash2, UserPlus } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { PhotoCapture } from '@nexus/ui/components/PhotoCapture/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { Button, Checkbox, Input, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { INCIDENT_KINDS, type IncidentKind } from '@nexus/factory-domain/safety/incidents/rules'
import { usePhotoWords } from '../../../../lib/ds-words/photo-capture'
import { DateTimeField, Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { ALL_BODY_PARTS, ALL_BODY_SIDES, ALL_NATURES } from '../api'
import { newPersonDraft, reportHeld, toggleBodyPart, withKind, type PersonDraft } from '../model'
import type { IncidentsPageActions, IncidentsPageModel, ReportDialogState } from '../view-model'
import { PeopleLaw, useWords } from './parts'

/**
 * design pop:report — Report an incident (band primary, `c`): kind · what · when · where (a station or a machine of the site,
 * or a place in words) · photos (the DS photo capture with markup: no faces) · the people involved, optional (an injury: the
 * person, the body parts, the nature, first aid). From the office a report always carries the reporter's name (the API's
 * rule); the people are written with it and never read back here. Esc closes; the focus returns to the opener.
 */
export function ReportDialog({ model, state, actions }: { model: IncidentsPageModel; state: ReportDialogState; actions?: IncidentsPageActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const photoWords = usePhotoWords()
  const { draft } = state
  const held = reportHeld(draft, new Date()) ?? (state.siteId ? null : 'held.report.site')
  const set = (change: Partial<typeof draft>) => actions?.onReportDraft?.({ ...draft, ...change })
  const problem = state.problem
  const at = (...fields: string[]) => (problem?.field && fields.includes(problem.field) ? t(problem.key) : undefined)
  const site = model.scope.sites.find((entry) => entry.id === state.siteId) ?? null
  const stations = state.places?.status === 'ready' ? (state.places.value.sites.find((entry) => entry.id === state.siteId)?.stations ?? []) : []
  const machines = state.machines?.status === 'ready' ? state.machines.value : []

  if (state.capturing) {
    return (
      <Modal open onClose={() => actions?.onReportCapture?.(false)} title={t('report.photoTitle')} size="lg">
        <PhotoCapture label={t('report.photoLabel')} words={photoWords} onCapture={(photo) => actions?.onReportPhoto?.(photo)} onCancel={() => actions?.onReportCapture?.(false)} />
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={() => actions?.onReportClose?.()}
      title={t('report.title')}
      subtitle={site ? t('report.at', { site: site.name }) : undefined}
      size="xl"
      footer={
        <>
          <Button onClick={() => actions?.onReportClose?.()}>{t('common.cancel')}</Button>
          <span className="grow" />
          <Button variant="primary" heldReason={state.busy ? t('held.saving') : held ? t(held) : null} onClick={() => actions?.onReportSend?.()}>
            {state.busy ? <Spinner size={12} /> : <Send size={14} aria-hidden />} {t('report.send')}
          </Button>
        </>
      }
    >
      <div className="fw-inc-form">
        {problem && !problem.field && <Banner tone="danger" title={t('report.refused')}>{t(problem.key)}</Banner>}
        <Field label={t('report.kind')} required error={at('kind')}>
          <SegmentedControl
            ariaLabel={t('report.kind')}
            value={draft.kind ?? ''}
            onChange={(kind) => actions?.onReportDraft?.(withKind(draft, kind as IncidentKind))}
            options={INCIDENT_KINDS.map((kind) => ({ value: kind, label: t(`kind.${kind}`) }))}
          />
        </Field>
        <div className="fw-inc-form-row">
          <Field label={t('report.what')} required hint={t('report.whatHint')} error={at('what')}>
            <Textarea value={draft.what} onChange={(event) => set({ what: event.target.value })} rows={3} maxLength={2000} />
          </Field>
          <Field label={t('report.when')} required error={at('occurredAt')}>
            <DateTimeField value={draft.occurredAt} onChange={(value) => set({ occurredAt: value })} max={new Date().toISOString()} stepMinutes={5} ariaLabel={t('report.when')} />
          </Field>
        </div>
        {model.scope.allSites && (
          <Field label={t('report.site')} required>
            <Select value={state.siteId ?? ''} onChange={(event) => actions?.onReportSite?.(event.target.value)}>
              <option value="">{t('report.chooseSite')}</option>
              {model.scope.sites.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <fieldset className="fw-inc-fieldset">
          <legend>{t('report.where')}</legend>
          <p className="fw-inc-muted">{t('report.whereHint')}</p>
          <div className="fw-inc-form-row">
            <Field label={t('report.station')} hint={model.can.plantView ? undefined : t('held.noPlantPicker')} error={at('stationId', 'where')}>
              <Select value={draft.stationId ?? ''} disabled={!model.can.plantView || !state.siteId} onChange={(event) => set({ stationId: event.target.value || null })}>
                <option value="">{state.places?.status === 'loading' ? t('common.reading') : t('report.none')}</option>
                {stations.map((station) => (
                  <option key={station.id} value={station.id}>
                    {station.code} · {station.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('report.machine')} hint={model.can.plantView ? undefined : t('held.noPlantPicker')} error={at('machineId')}>
              <Select value={draft.machineId ?? ''} disabled={!model.can.plantView || !state.siteId} onChange={(event) => set({ machineId: event.target.value || null })}>
                <option value="">{state.machines?.status === 'loading' ? t('common.reading') : t('report.none')}</option>
                {machines.map((machine) => (
                  <option key={machine.id} value={machine.id}>
                    {machine.assetNumber}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('report.place')} error={at('place')}>
              <Input value={draft.place} onChange={(event) => set({ place: event.target.value })} maxLength={500} placeholder={t('report.placeHint')} />
            </Field>
          </div>
          {(state.places?.status === 'error' || state.machines?.status === 'error') && <p className="fw-inc-warn">{t('report.pickersFailed')}</p>}
        </fieldset>
        <Field label={t('report.immediate')} hint={t('report.immediateHint')} error={at('immediateAction')}>
          <Input value={draft.immediateAction} onChange={(event) => set({ immediateAction: event.target.value })} maxLength={500} />
        </Field>

        <fieldset className="fw-inc-fieldset">
          <legend>{t('report.photos')}</legend>
          <p className="fw-inc-muted">{t('report.photosHint')}</p>
          {state.photos.length > 0 && (
            <ul className="fw-inc-chips">
              {state.photos.map((_, index) => (
                <li key={index} className="fw-inc-chip">
                  {t('report.photoN', { n: index + 1 })}
                  <Button size="sm" variant="quiet" aria-label={t('report.removePhoto', { n: index + 1 })} onClick={() => actions?.onReportRemovePhoto?.(index)}>
                    <Trash2 size={13} aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <span>
            <Button size="sm" heldReason={state.photos.length >= 4 ? t('held.photosFull') : null} onClick={() => actions?.onReportCapture?.(true)}>
              <Camera size={14} aria-hidden /> {t('report.addPhoto')}
            </Button>
          </span>
        </fieldset>

        <fieldset className="fw-inc-fieldset">
          <legend>{t('report.people')}</legend>
          <PrivacyNote level="protected" variant="panel" text={t('report.peopleNote')} whoMore={t('people.who')} law={<PeopleLaw />} labels={ds.privacyNote} />
          {!model.can.pickPeople && <p className="fw-inc-muted">{t('report.noStaffList')}</p>}
          {draft.people.map((person, index) => (
            <PersonCard key={person.key} n={index + 1} person={person} kind={draft.kind} state={state} canPick={model.can.pickPeople} actions={actions} at={at} />
          ))}
          <span>
            <Button size="sm" heldReason={draft.people.length >= 20 ? t('held.report.people') : null} onClick={() => actions?.onReportPerson?.(newPersonDraft(`p${Date.now()}`, draft.kind), undefined)}>
              <UserPlus size={14} aria-hidden /> {t('report.addPerson')}
            </Button>
          </span>
        </fieldset>
      </div>
    </Modal>
  )
}

function PersonCard({ n, person, kind, state, canPick, actions, at }: { n: number; person: PersonDraft; kind: IncidentKind | null; state: ReportDialogState; canPick: boolean; actions?: IncidentsPageActions | undefined; at: (...fields: string[]) => string | undefined }) {
  const t = useWords()
  const update = (change: Partial<PersonDraft>) => actions?.onReportPerson?.({ ...person, ...change }, person.key)
  const injured = person.involvement === 'INJURED'
  const people = state.people?.status === 'ready' ? state.people.value.people : []
  const who = canPick ? person.who : 'OUTSIDE'
  return (
    <div className="fw-inc-person" role="group" aria-label={t('report.personN', { n })}>
      <div className="fw-inc-head">
        <b>{t('report.personN', { n })}</b>
        <Button size="sm" variant="quiet" onClick={() => actions?.onReportPerson?.(null, person.key)}>
          <Trash2 size={13} aria-hidden /> {t('report.removePerson')}
        </Button>
      </div>
      <div className="fw-inc-form-row">
        <Field label={t('report.who')}>
          <SegmentedControl
            size="sm"
            ariaLabel={t('report.who')}
            value={who}
            onChange={(value) => update({ who: value === 'OUTSIDE' ? 'OUTSIDE' : 'EMPLOYEE' })}
            options={[
              { value: 'EMPLOYEE', label: t('report.employee'), disabled: !canPick },
              { value: 'OUTSIDE', label: t('report.outside') },
            ]}
          />
        </Field>
        {who === 'EMPLOYEE' ? (
          <Field label={t('report.person')} required error={at('people', 'employeeId')}>
            <span className="fw-inc-picker">
              <Input size="sm" type="search" value={state.peopleQuery} placeholder={t('report.findPerson')} aria-label={t('report.findPerson')} onChange={(event) => actions?.onReportPeopleQuery?.(event.target.value)} />
              <Select
                value={person.employeeId ?? ''}
                onChange={(event) => {
                  const chosen = people.find((entry) => entry.id === event.target.value) ?? null
                  update({ employeeId: chosen?.id ?? null, employeeName: chosen?.name ?? null })
                }}
              >
                <option value="">{state.people?.status === 'loading' ? t('common.reading') : t('report.choosePerson')}</option>
                {person.employeeId && !people.some((entry) => entry.id === person.employeeId) ? <option value={person.employeeId}>{person.employeeName ?? ''}</option> : null}
                {people.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                    {entry.employeeCode ? ` · ${entry.employeeCode}` : ''}
                  </option>
                ))}
              </Select>
            </span>
            {state.people?.status === 'ready' && !state.people.value.complete ? <span className="fw-inc-muted">{t('report.typeMore')}</span> : null}
            {state.people?.status === 'error' ? <span className="fw-inc-warn">{t('report.peopleFailed')}</span> : null}
          </Field>
        ) : (
          <Field label={t('report.outsideName')} required error={at('outsideName')}>
            <Input value={person.outsideName} onChange={(event) => update({ outsideName: event.target.value })} maxLength={200} />
          </Field>
        )}
        <Field label={t('report.involvement')}>
          <SegmentedControl
            size="sm"
            ariaLabel={t('report.involvement')}
            value={person.involvement}
            onChange={(value) => update(value === 'INJURED' ? { involvement: 'INJURED' } : { involvement: 'INVOLVED', bodyParts: [], bodySide: null, nature: null, firstAidGiven: false, sentToHospital: false })}
            options={[
              { value: 'INJURED', label: t('involvement.INJURED'), disabled: kind !== 'INJURY' },
              { value: 'INVOLVED', label: t('involvement.INVOLVED') },
            ]}
          />
        </Field>
      </div>
      {kind !== 'INJURY' && <p className="fw-inc-muted">{t('report.injuredOnlyInjury')}</p>}
      {injured && (
        <div className="fw-inc-stack">
          <fieldset className="fw-inc-parts">
            <legend>{t('report.bodyParts')}</legend>
            {ALL_BODY_PARTS.map((part) => (
              <Checkbox key={part} label={t(`bodyPart.${part}`)} checked={person.bodyParts.includes(part)} onChange={() => update({ bodyParts: toggleBodyPart(person.bodyParts, part) })} />
            ))}
          </fieldset>
          <div className="fw-inc-form-row">
            <Field label={t('report.side')}>
              <Select value={person.bodySide ?? ''} disabled={person.bodyParts.length === 0} onChange={(event) => update({ bodySide: (event.target.value || null) as PersonDraft['bodySide'] })}>
                <option value="">{t('report.none')}</option>
                {ALL_BODY_SIDES.map((side) => (
                  <option key={side} value={side}>
                    {t(`side.${side}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('report.nature')}>
              <Select value={person.nature ?? ''} onChange={(event) => update({ nature: (event.target.value || null) as PersonDraft['nature'] })}>
                <option value="">{t('report.none')}</option>
                {ALL_NATURES.map((nature) => (
                  <option key={nature} value={nature}>
                    {t(`nature.${nature}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <span className="fw-inc-row">
            <Checkbox label={t('person.firstAid')} checked={person.firstAidGiven} onChange={(event) => update({ firstAidGiven: event.target.checked })} />
            <Checkbox label={t('person.hospital')} checked={person.sentToHospital} onChange={(event) => update({ sentToHospital: event.target.checked })} />
          </span>
        </div>
      )}
    </div>
  )
}

