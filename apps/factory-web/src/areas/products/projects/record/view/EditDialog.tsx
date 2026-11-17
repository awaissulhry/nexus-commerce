'use client'

import { useId, type KeyboardEvent } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select, Skeleton } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { PROJECT_LIMITS } from '../../model'
import { useWords } from '../../parts'
import type { ProjectView } from '../../api'
import { editBody, editProblems, RECORD_NS } from '../model'
import type { ProjectDialog, ProjectRecordActions } from '../view-model'

type EditState = Extract<ProjectDialog, { kind: 'edit' }>

/**
 * Edit details (PROJ.record-F05): name, goal, lead (its office people and the colleagues who may read it), target date, season —
 * saved with the version read, only what changed. The outside company is shown and never editable, with why (chosen when the
 * project was made; it never changes). Someone else's save first: "Someone changed it" with Reload; the draft stays until then.
 */
export function EditDialog({ project, state, offline, actions }: { project: ProjectView; state: EditState; offline: boolean; actions?: ProjectRecordActions['edit'] }) {
  const { t, say, shared, locale } = useWords(RECORD_NS)
  const ids = { name: useId(), goal: useId(), lead: useId(), season: useId() }
  const { draft } = state
  const problems = editProblems(draft)
  const body = editBody(project, draft)
  const heldText = offline
    ? say({ key: 'held.offline' })
    : state.busy
      ? shared('common.working')
      : state.stale
        ? t('edit.held.stale')
        : Object.keys(problems).length > 0
          ? t('edit.held.fields')
          : body === null
            ? t('edit.held.nothing')
            : null
  const submit = () => {
    if (!heldText) actions?.onSubmit()
  }
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  }
  const refused = (field: string) => state.fields.includes(`field.${field}`)
  const error = (field: keyof typeof problems) => (problems[field] ? say(problems[field]) : refused(field) ? t('edit.problem.refused') : undefined)
  return (
    <Modal
      open
      size="md"
      onClose={() => actions?.onCancel()}
      title={t('edit.title', { number: project.number })}
      footer={
        <span className="fw-prjr-buttons">
          <Button variant="secondary" onClick={() => actions?.onCancel()}>
            {shared('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={heldText} onClick={submit} aria-keyshortcuts="Meta+Enter Control+Enter">
            {shared('common.save')}
          </Button>
        </span>
      }
    >
      <div className="fw-prjr-form" onKeyDown={onKey}>
        {state.stale ? (
          <Banner
            tone="warning"
            title={t('edit.stale')}
            action={
              <Button size="sm" onClick={() => actions?.onReload()}>
                {t('edit.reload')}
              </Button>
            }
          />
        ) : state.problem ? (
          <Banner tone="danger" title={say(state.problem)} />
        ) : null}
        <Field label={shared('field.name')} required error={error('name')} htmlFor={ids.name}>
          <Input id={ids.name} value={draft.name} maxLength={PROJECT_LIMITS.name + 10} onChange={(event) => actions?.onDraft({ name: event.target.value })} autoFocus />
        </Field>
        <Field label={shared('field.partyId')} hint={t('edit.partyFixed')}>
          <Input value={project.party ? project.party.name : shared('common.officeOnly')} readOnly aria-readonly="true" />
        </Field>
        <div className="fw-prjr-form-row">
          <Field label={shared('field.leadId')} required error={error('leadId')} htmlFor={ids.lead}>
            {state.leads.status === 'loading' ? (
              <Skeleton height={32} />
            ) : state.leads.status === 'error' ? (
              <Banner
                tone="danger"
                title={shared(state.leads.problem)}
                action={
                  <Button size="sm" onClick={() => actions?.onRetryLeads()}>
                    {shared('common.retry')}
                  </Button>
                }
              />
            ) : (
              <Select id={ids.lead} value={draft.leadId} onChange={(event) => actions?.onDraft({ leadId: event.target.value })}>
                {state.leads.data.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={shared('field.targetDate')} required error={error('targetDate')}>
            <DateField value={draft.targetDate} onChange={(value) => actions?.onDraft({ targetDate: value })} locale={INTL_LOCALE[locale]} ariaLabel={shared('field.targetDate')} />
          </Field>
        </div>
        <Field label={shared('field.seasonCode')} hint={t('edit.seasonHint')} error={error('seasonCode')} htmlFor={ids.season}>
          <Input id={ids.season} value={draft.seasonCode} maxLength={40} onChange={(event) => actions?.onDraft({ seasonCode: event.target.value })} />
        </Field>
        <Field label={shared('field.goal')} hint={t('edit.goalHint')} error={error('goal')} htmlFor={ids.goal}>
          <Textarea id={ids.goal} value={draft.goal} limit={PROJECT_LIMITS.goal} rows={4} honourRows onChange={(event) => actions?.onDraft({ goal: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}
