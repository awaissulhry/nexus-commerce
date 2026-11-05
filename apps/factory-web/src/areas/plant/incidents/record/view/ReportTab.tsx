'use client'

import Link from 'next/link'
import { Camera, ExternalLink, Image as ImageIcon, Pencil } from 'lucide-react'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { ProtectedValue } from '@nexus/ui/components/ProtectedValue/index'
import { Button, Input, SegmentedControl, Select } from '@nexus/ui/primitives'
import { INCIDENT_KINDS, INCIDENT_SEVERITIES, type IncidentKind, type IncidentSeverity } from '@nexus/factory-domain/safety/incidents/rules'
import { DateTimeField, EditModeBar, Textarea, useDsWords } from '../../../../../lib/i18n/ds-parts'
import type { IncidentPerson, IncidentRecord } from '../../api'
import { editBody, editDraftHeld, editDraftOf, editHeld, peopleHeld, personName, photoHeld, whereText } from '../../model'
import type { IncidentRecordActions, IncidentRecordModel } from '../../view-model'
import { injuryText } from '../../view/IncidentsView'
import { PeopleLaw, SectionHead, useWhen, useWords } from '../../view/parts'

/**
 * design rec:Incident/report — What happened (the report as sent from the floor or the office: kind, what, when, where with the
 * machine's link, the photos, who reported it — or nobody, sent without a name —, the immediate action and a machine locked
 * as unsafe; EditModeBar for the safety roles) and People involved (protected, GDPR art. 9: everyone sees the count, "One
 * person involved"; HR and the safety officer open the names and injuries, each opening recorded).
 */
export function ReportTab({ model, incident, actions }: { model: IncidentRecordModel; incident: IncidentRecord; actions?: IncidentRecordActions | undefined }) {
  const t = useWords()
  const when = useWhen()
  const edit = model.edit
  const held = editHeld(incident)
  const reporter = (() => {
    switch (incident.reporter.kind) {
      case 'ANONYMOUS':
        return t('reporter.anonymous')
      case 'SYSTEM':
        return t('reporter.system')
      case 'WORKER':
        return incident.reporter.hidden || !incident.reporter.name ? t('reporter.workerHidden') : t('reporter.worker', { name: incident.reporter.name })
      default:
        return incident.reporter.name ?? t('reporter.office')
    }
  })()

  return (
    <div className="fw-inc-tab">
      <section className="fw-inc-section" aria-labelledby="fw-inc-what">
        <SectionHead id="fw-inc-what" title={t('what.title')} note={t(incident.reportedVia === 'FLOOR' ? 'what.fromFloor' : 'what.fromOffice')}>
          {!edit && (
            <Button size="sm" heldReason={held ? t(held) : null} onClick={() => actions?.onEdit?.(editDraftOf(incident))}>
              <Pencil size={13} aria-hidden /> {t('what.edit')}
            </Button>
          )}
        </SectionHead>
        <Card padded>{edit ? <EditForm model={model} incident={incident} actions={actions} /> : <Facts incident={incident} reporter={reporter} prefix={model.prefix} />}</Card>
      </section>

      <section className="fw-inc-section" aria-labelledby="fw-inc-photos">
        <SectionHead id="fw-inc-photos" title={t('photos.title')} note={t('photos.note')}>
          <Button size="sm" heldReason={photoHeld(incident) ? t(photoHeld(incident)!) : null} onClick={() => actions?.onDialog?.({ kind: 'photo', busy: false, problem: null })}>
            <Camera size={13} aria-hidden /> {t('photos.add')}
          </Button>
        </SectionHead>
        {incident.photos.length === 0 ? (
          <p className="fw-inc-muted">{t('photos.none')}</p>
        ) : (
          <ul className="fw-inc-chips">
            {incident.photos.map((photo, index) => (
              <li key={photo.id} className="fw-inc-chip">
                <ImageIcon size={14} aria-hidden /> {t('photos.n', { n: index + 1 })}
                {photo.availableAt ? <span className="fw-inc-muted">{when.at(photo.availableAt)}</span> : null}
                <Button size="sm" variant="quiet" onClick={() => actions?.onPhotoOpen?.(photo.id)}>
                  <ExternalLink size={13} aria-hidden /> {t('photos.open')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <PeoplePanel model={model} incident={incident} actions={actions} />
    </div>
  )
}

function Facts({ incident, reporter, prefix }: { incident: IncidentRecord; reporter: string; prefix: string }) {
  const t = useWords()
  const when = useWhen()
  const where = whereText(incident)
  return (
    <KeyValue
      columns={2}
      labelCase="sentence"
      items={[
        { label: t('what.kind'), value: t(`kind.${incident.kind}`) },
        { label: t('what.when'), value: when.at(incident.occurredAt), hint: t('what.reportedAt', { at: when.at(incident.reportedAt) }) },
        { label: t('what.what'), value: <span className="fw-inc-text">{incident.what}</span> },
        {
          label: t('what.where'),
          value: (
            <span className="fw-inc-cell">
              <span>{where || '—'}</span>
              {incident.machine ? <Link href={`${prefix}/plant/machines/${encodeURIComponent(incident.machine.id)}`}>{t('what.machine', { asset: incident.machine.assetNumber })}</Link> : null}
            </span>
          ),
          hint: incident.site.name,
        },
        { label: t('what.severity'), value: t(`severity.${incident.severity ?? 'UNKNOWN'}`) },
        { label: t('what.reporter'), value: reporter, hint: incident.reporter.device ? t('what.device', { device: incident.reporter.device.name }) : undefined },
        {
          label: t('what.immediate'),
          value: (
            <span className="fw-inc-cell">
              <span>{incident.immediateAction ?? t('what.noImmediate')}</span>
              {incident.maintenanceRequest ? (
                <Link href={`${prefix}/plant/requests?open=${encodeURIComponent(incident.maintenanceRequest.id)}`}>{t(incident.maintenanceRequest.unsafe ? 'what.lockedRequest' : 'what.request')}</Link>
              ) : null}
            </span>
          ),
        },
        { label: t('what.seen'), value: incident.seen ? t('what.seenBy', { at: when.at(incident.seen.at), by: incident.seen.by ?? t('record.someone') }) : t('what.notSeen') },
        ...(incident.closed ? [{ label: t('what.closed'), value: t('what.closedBy', { at: when.at(incident.closed.at), by: incident.closed.by ?? t('record.someone') }) }] : []),
      ]}
    />
  )
}

function EditForm({ model, incident, actions }: { model: IncidentRecordModel; incident: IncidentRecord; actions?: IncidentRecordActions | undefined }) {
  const t = useWords()
  const edit = model.edit!
  const draft = edit.draft
  const set = (change: Partial<typeof draft>) => actions?.onEdit?.({ ...draft, ...change })
  const changes = editBody(incident, draft)
  const held = editDraftHeld(incident, draft)
  const at = (field: string) => (edit.problem?.field === field ? t(edit.problem.key) : undefined)
  return (
    <div className="fw-inc-form">
      {edit.problem && !edit.problem.field && <Banner tone="danger" title={t('what.refused')}>{t(edit.problem.key)}</Banner>}
      <Field label={t('what.kind')} error={at('kind')}>
        <SegmentedControl ariaLabel={t('what.kind')} value={draft.kind} onChange={(kind) => set({ kind: kind as IncidentKind })} options={INCIDENT_KINDS.map((kind) => ({ value: kind, label: t(`kind.${kind}`), disabled: kind !== 'INJURY' && incident.people.injured > 0 }))} />
      </Field>
      <div className="fw-inc-form-row">
        <Field label={t('what.what')} required error={at('what')}>
          <Textarea value={draft.what} onChange={(event) => set({ what: event.target.value })} rows={3} maxLength={2000} />
        </Field>
        <Field label={t('what.when')} error={at('occurredAt')}>
          <DateTimeField value={draft.occurredAt} onChange={(value) => set({ occurredAt: value })} max={new Date().toISOString()} stepMinutes={5} ariaLabel={t('what.when')} />
        </Field>
      </div>
      <div className="fw-inc-form-row">
        <Field label={t('what.place')} error={at('place')}>
          <Input value={draft.place} onChange={(event) => set({ place: event.target.value })} maxLength={500} />
        </Field>
        <Field label={t('what.severity')} error={at('severity')}>
          <Select value={draft.severity ?? ''} onChange={(event) => set({ severity: (event.target.value || null) as IncidentSeverity | null })}>
            <option value="">{t('severity.UNKNOWN')}</option>
            {INCIDENT_SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {t(`severity.${severity}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('what.immediate')} error={at('immediateAction')}>
          <Input value={draft.immediateAction} onChange={(event) => set({ immediateAction: event.target.value })} maxLength={500} />
        </Field>
      </div>
      <EditModeBar
        message={t('what.editing')}
        count={changes ? Object.keys(changes).length - 1 : 0}
        onDiscard={() => actions?.onEdit?.(null)}
        onApply={() => actions?.onSaveEdit?.()}
        applyLabel={t('what.save')}
        busy={edit.busy}
        applyHeldReason={held ? t(held) : !changes ? t('held.noChange') : null}
        saveShortcut
      />
    </div>
  )
}

/** design rec:Incident/report sec:people — the count for everyone; the names and injuries behind the recorded open. */
function PeoplePanel({ model, incident, actions }: { model: IncidentRecordModel; incident: IncidentRecord; actions?: IncidentRecordActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const when = useWhen()
  const count = incident.people.count
  const summary = count === 0 ? t('people.none') : t('people.count', { count, injured: incident.people.injured })
  const opened = model.people.state === 'open' ? model.people : null
  const held = peopleHeld(incident)
  return (
    <section className="fw-inc-section" aria-labelledby="fw-inc-people">
      <SectionHead id="fw-inc-people" title={t('people.title')} note={summary} />
      <PrivacyNote level="protected" variant="panel" recorded={incident.canPeople} text={t('people.panelNote')} whoMore={t('people.who')} law={<PeopleLaw />} labels={ds.privacyNote} />
      {count > 0 && (
        <ProtectedValue
          label={t('people.value')}
          allowed={!held}
          value={opened ? <PeopleList people={opened.value} /> : undefined}
          onOpen={() => actions?.onOpenPeople?.()}
          opening={model.people.state === 'reading'}
          failed={model.people.state === 'error'}
          recordedAt={opened ? when.at(opened.at) : undefined}
          restrictedReason={t('people.restricted')}
          onHide={() => actions?.onHidePeople?.()}
          labels={ds.protectedValue}
        />
      )}
    </section>
  )
}

export function PeopleList({ people }: { people: readonly IncidentPerson[] }) {
  const t = useWords()
  if (people.length === 0) return <span>{t('people.none')}</span>
  return (
    <ul className="fw-inc-list fw-inc-protected">
      {people.map((person) => (
        <li key={person.id}>
          <b>{personName(person)}</b> · {t(`involvement.${person.involvement}`)}
          {person.involvement === 'INJURED' && injuryText(t, person) ? ` · ${injuryText(t, person)}` : ''}
          {person.employee === null ? ` · ${t('person.outside')}` : ''}
        </li>
      ))}
    </ul>
  )
}
