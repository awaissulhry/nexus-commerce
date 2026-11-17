'use client'

import { useEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Kbd, Select } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import type { ShortProject } from '../api'
import type { PartyOption, SeasonOption } from '../list-api'
import { nameCounterShown, nameProblem, goalProblem, newDraftHeld, partyGroupsOf, partyNameOf, setOnceLine, type ListAddress, type NewDraft } from '../list-model'
import { PROJECT_LIMITS, projectHref, type Notice, type Phrase, type ProjectsCan } from '../model'
import { NoticeLine, useWords } from '../parts'

/**
 * New project (design PROJ.new-F01 … F06; picture 32 never drawn): the rule in one line at the top; Name (required, one line);
 * Outside company — none (office only), a customer or a supplier — with the set-once line said BEFORE Create; Lead (me by default:
 * no office-people picker exists before a project does, the lead changes on its page); Target date (required); Season and Goal
 * (optional); the duplicate warning while typing; "Will link: …" when started from a record. Enter in a field (or ⌘↵) creates;
 * an error keeps every typed field. A phone shows it full screen (the DS Modal's sheet).
 */
export interface NewProjectModel {
  draft: NewDraft
  can: ProjectsCan
  prefix: string
  /** The company it is made in (the address's). */
  companyId: string | null
  /** The lead: me (the person's own id and name). */
  lead: { id: string | null; name: string }
  /** The outside companies to pick (null without parties.view: the project is office only). */
  parties: { items: PartyOption[] | null; problem: string | null } | null
  seasons: { items: SeasonOption[] | null; problem: string | null }
  /** Active projects with a name alike (the duplicate warning); empty: nothing shown. */
  similar: readonly ShortProject[]
  /** Started from a record: it is linked at once. */
  link: ListAddress['link']
  busy: boolean
  notice: Notice | null
  /** The fields a refusal named. */
  lines: readonly Phrase[]
  offline: boolean
}

export interface NewProjectActions {
  onDraft?: (patch: Partial<NewDraft>) => void
  onSubmit?: () => void
  onClose?: () => void
}

const FORM_ID = 'fw-prj-new-form'

export function NewProjectDialog({ model, actions }: { model: NewProjectModel; actions?: NewProjectActions }) {
  const { t, say } = useWords()
  const draft = model.draft
  const held = newDraftHeld(draft, { can: model.can, offline: model.offline, leadId: model.lead.id, companyId: model.companyId })
  const heldText = model.busy ? t('common.working') : say(held)
  const parties = model.parties?.items ?? []
  const groups = partyGroupsOf(parties)
  const picked = draft.partyId ? parties.find((party) => party.id === draft.partyId) : undefined
  const pickedName = draft.partyId ? (picked ? partyNameOf(picked) : t('new.thisCompany')) : null
  // A field's own problem shows once something is typed there (an empty form is not shouted at).
  const nameError = draft.name !== '' ? say(nameProblem(draft.name)) : null
  const goalError = say(goalProblem(draft.goal))
  const named = (field: string) => model.lines.some((line) => line.key === `field.${field}`)
  const firstSimilar = model.similar[0] ?? null

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held && !model.busy) {
        event.preventDefault()
        actions?.onSubmit?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [held, model.busy, actions])

  // Enter in a one-line field creates (the goal is a paragraph: Enter is a new line there).
  const onFormKey = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    const target = event.target as HTMLElement
    if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.nativeEvent.isComposing) return
    if (target.tagName !== 'INPUT') return
    event.preventDefault()
    if (!held && !model.busy) actions?.onSubmit?.()
  }

  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('new.title')}
      size="lg"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" variant="secondary" onClick={() => actions?.onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={heldText} onClick={() => actions?.onSubmit?.()} aria-keyshortcuts="Meta+Enter">
            {t('new.submit')}
            <span className="fw-prj-keys" aria-hidden>
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd>
            </span>
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        className="fw-prj-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held && !model.busy) actions?.onSubmit?.()
        }}
        onKeyDown={onFormKey}
      >
        <p className="fw-prj-rule">{t('new.rule')}</p>
        {model.link && <p className="fw-prj-willlink">{t('new.willLink', { record: model.link.label ?? t(`linkType.${model.link.type}`) })}</p>}
        <div className="fw-prj-form-grid">
          <Field
            className="fw-prj-wide"
            label={t('field.name')}
            required
            error={nameError ?? (named('name') ? t('new.fieldRefused') : undefined)}
            hint={nameCounterShown(draft.name) ? t('new.nameCounter', { count: draft.name.trim().length, max: PROJECT_LIMITS.name }) : t('new.nameHint')}
          >
            <Input size="sm" value={draft.name} maxLength={PROJECT_LIMITS.name + 10} autoFocus placeholder={t('new.namePlaceholder')} onChange={(event) => actions?.onDraft?.({ name: event.target.value })} />
          </Field>
          <Field className="fw-prj-wide" label={t('field.partyId')} hint={say(setOnceLine(pickedName))} error={named('partyId') ? t('new.fieldRefused') : undefined}>
            <Select size="sm" value={draft.partyId ?? ''} disabled={!model.parties} onChange={(event) => actions?.onDraft?.({ partyId: event.target.value || null })}>
              <option value="">{t('new.officeOnly')}</option>
              {draft.partyId && !picked && <option value={draft.partyId}>{t('new.thisCompany')}</option>}
              {groups.customers.length > 0 && (
                <optgroup label={t('filter.customers')}>
                  {groups.customers.map((party) => (
                    <option key={party.id} value={party.id}>
                      {party.code} · {partyNameOf(party)}
                    </option>
                  ))}
                </optgroup>
              )}
              {groups.suppliers.length > 0 && (
                <optgroup label={t('filter.suppliers')}>
                  {groups.suppliers.map((party) => (
                    <option key={party.id} value={party.id}>
                      {party.code} · {partyNameOf(party)}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>
          <Field label={t('field.leadId')} required hint={t('new.leadHint')}>
            <span className="fw-prj-lead">{model.lead.id ? t('common.you', { name: model.lead.name }) : t('new.noLead')}</span>
          </Field>
          <Field label={t('field.targetDate')} required error={named('targetDate') ? t('new.fieldRefused') : undefined} hint={t('new.targetHint')}>
            <DateField value={draft.targetDate} onChange={(value) => actions?.onDraft?.({ targetDate: value })} />
          </Field>
          <Field label={t('field.seasonCode')} hint={model.seasons.problem ? say({ key: model.seasons.problem }) : model.seasons.items && model.seasons.items.length === 0 ? t('new.noSeasons') : t('new.seasonHint')} error={named('seasonCode') ? t('new.fieldRefused') : undefined}>
            <Select size="sm" value={draft.seasonCode ?? ''} disabled={!model.seasons.items || model.seasons.items.length === 0} onChange={(event) => actions?.onDraft?.({ seasonCode: event.target.value || null })}>
              <option value="">{t('new.noSeason')}</option>
              {(model.seasons.items ?? []).map((season) => (
                <option key={season.id} value={season.code}>
                  {season.code} · {season.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field className="fw-prj-wide" label={t('field.goal')} hint={t('new.goalHint')} error={goalError ?? (named('goal') ? t('new.fieldRefused') : undefined)}>
            <Textarea value={draft.goal} rows={3} honourRows maxLength={PROJECT_LIMITS.goal} onChange={(event) => actions?.onDraft?.({ goal: event.target.value })} />
          </Field>
        </div>
        {!model.parties && <p className="fw-prj-hint">{t('new.partiesNoRight')}</p>}
        {model.parties?.problem && <Banner tone="warning" title={t('new.partiesFailed')}>{say({ key: model.parties.problem })}</Banner>}
        {firstSimilar && (
          <Banner tone="warning" title={pickedName ? t('new.similarParty', { name: pickedName, project: `${firstSimilar.number} · ${firstSimilar.name}` }) : t('new.similar', { project: `${firstSimilar.number} · ${firstSimilar.name}` })}>
            <ul className="fw-prj-lines">
              {model.similar.map((project) => (
                <li key={project.id}>
                  <a className="fw-prj-link" href={projectHref(model.prefix, project.id)} target="_blank" rel="noopener noreferrer">
                    {t('new.similarOpen', { project: `${project.number} · ${project.name}` })}
                  </a>
                </li>
              ))}
            </ul>
          </Banner>
        )}
        <NoticeLine notice={model.notice} />
        {model.lines.length > 0 && (
          <ul className="fw-prj-lines">
            {model.lines.map((line, index) => (
              <li key={index}>{say(line)}</li>
            ))}
          </ul>
        )}
      </form>
    </Modal>
  )
}
