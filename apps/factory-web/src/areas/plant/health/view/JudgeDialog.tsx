'use client'

import { Save, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { Banner, Field } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { Button, Input, RadioCard, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { FITNESS_OUTCOMES, HEALTH_LIMITS, JUDGEMENT_LAW } from '@nexus/factory-domain/safety/health/rules'
import { DateField, FileDropzone, Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import type { VisitRow } from '../api'
import { addressTerms, clinicalWords, COPY_ACCEPT, COPY_MOST_BYTES, EMPTY_ADDRESS, HEALTH_PATH, isOpen, judgementHeld, wordsIn } from '../model'
import type { HealthPageActions, HealthPageModel, JudgementDialogState } from '../view-model'
import { personText, ProtectedLaw, say, useWhen, useWords } from './parts'

/**
 * design pop:judgement — Record a judgement (band primary, `j`): the person (from an open visit of the due list, or — HR — a
 * person of the staff list) · the visit · the outcome (fit, fit with limits, temporarily unfit until …, unfit) · the task limits
 * with the hint "Write the task limit only, e.g. no lifting over 15 kg. Never the medical reason." (medical words are said at
 * once, the API refuses them too) · the day · the expiry · the doctor's copy (PDF or a picture of the paper). Only the outcome
 * is kept, never clinical data (art. 41 c.6). The visit becomes DONE in the same step. Esc closes; the focus returns.
 */
export function JudgeDialog({ model, state, actions }: { model: HealthPageModel; state: JudgementDialogState; actions?: HealthPageActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const when = useWhen()
  const locale = useLocale()
  const { draft } = state
  const set = (change: Partial<typeof draft>) => actions?.onJudgeDraft?.({ ...draft, ...change })
  const held = say(t, judgementHeld(draft, model.today))
  const at = (...fields: string[]) => (state.problem?.field && fields.includes(state.problem.field) ? t(state.problem.key) : undefined)
  const frame = model.frame.status === 'ready' ? model.frame.value : null
  const hint = frame ? wordsIn(frame.hint, locale) : t('judge.hint')
  const open = model.due?.status === 'ready' ? model.due.value.rows.filter(isOpen) : []
  const visits: VisitRow[] = state.fromWindow && !open.some((row) => row.id === state.fromWindow!.id) ? [state.fromWindow, ...open] : open
  const chosen = visits.find((row) => row.id === draft.visitId) ?? null
  const clinical = draft.outcome === 'FIT_WITH_LIMITS' ? clinicalWords(draft.taskLimits) : []
  const people = state.people?.status === 'ready' ? state.people.value.people : []

  if (state.savedWithoutCopy) {
    return (
      <Modal open onClose={() => actions?.onJudgeClose?.()} title={t('judge.title')} size="md" footer={<Button onClick={() => actions?.onJudgeClose?.()}>{t('common.close')}</Button>}>
        <Banner
          tone="warning"
          title={t('judge.savedWithoutCopy')}
          action={
            <Button size="sm" asChild>
              <Link href={`${model.prefix}${HEALTH_PATH}${addressTerms({ ...EMPTY_ADDRESS, judgement: state.savedWithoutCopy })}`}>{t('judge.openSaved')}</Link>
            </Button>
          }
        >
          {state.problem ? t(state.problem.key) : null}
        </Banner>
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={() => actions?.onJudgeClose?.()}
      title={t('judge.title')}
      size="xl"
      footer={
        <>
          <Button onClick={() => actions?.onJudgeClose?.()}>{t('common.cancel')}</Button>
          <span className="grow" />
          <Button variant="primary" heldReason={state.busy ? t('held.saving') : held} onClick={() => actions?.onJudgeSave?.()}>
            {state.busy ? <Spinner size={12} /> : <Save size={14} aria-hidden />} {t('judge.save')}
          </Button>
        </>
      }
    >
      <div className="fw-hv-form">
        <PrivacyNote level="protected" variant="panel" text={t('judge.privacy')} law={<LawRef law={JUDGEMENT_LAW} plain={t('law.judgementPlain')} labels={ds.lawRef} />} labels={ds.privacyNote} />
        {state.problem && !state.problem.field && <Banner tone="danger" title={t('judge.refused')}>{t(state.problem.key)}</Banner>}

        <Field label={t('judge.from')} required>
          <SegmentedControl
            ariaLabel={t('judge.from')}
            value={draft.from}
            onChange={(from) => set({ from: from as typeof draft.from, visitId: null, employeeId: null })}
            options={[
              { value: 'visit', label: t('judge.fromVisit') },
              { value: 'person', label: t('judge.fromPerson'), disabled: !model.can.pickPeople },
            ]}
          />
        </Field>
        {!model.can.pickPeople && <p className="fw-hv-muted">{t('held.pickPeople')}</p>}

        {draft.from === 'visit' ? (
          <Field label={t('judge.visit')} required hint={visits.length === 0 ? t('judge.noOpenVisit') : chosen ? undefined : t('judge.visitHint')} error={at('visitId', 'employeeId')}>
            <Select
              value={draft.visitId ?? ''}
              onChange={(event) => {
                const row = visits.find((entry) => entry.id === event.target.value) ?? null
                set({ visitId: row?.id ?? null, employeeId: row?.employee.id ?? null })
              }}
            >
              <option value="">{t('judge.chooseVisit')}</option>
              {visits.map((row) => (
                <option key={row.id} value={row.id}>
                  {t('judge.visitOption', { person: personText(row.employee), type: t(`visitType.${row.type}`), day: when.day(row.booked?.on ?? row.dueOn) })}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <fieldset className="fw-hv-fieldset">
            <legend>{t('judge.person')}</legend>
            {state.picked ? (
              <span className="fw-hv-row">
                <b>{personText({ name: state.picked.name, employeeCode: state.picked.employeeCode })}</b>
                <span className="fw-hv-muted">{state.picked.site.name}</span>
                <Button size="sm" variant="quiet" onClick={() => actions?.onJudgePick?.(null)}>
                  {t('judge.change')}
                </Button>
              </span>
            ) : (
              <div className="fw-hv-picker">
                <Input type="search" value={state.peopleQuery} placeholder={t('judge.search')} aria-label={t('judge.search')} onChange={(event) => actions?.onJudgePeopleQuery?.(event.target.value)} />
                {state.people?.status === 'loading' && <p className="fw-hv-muted">{t('common.reading')}</p>}
                {state.people?.status === 'error' && <p className="fw-hv-warn">{t(state.people.problem)}</p>}
                {state.people?.status === 'ready' && people.length === 0 && <p className="fw-hv-muted">{t('judge.nobody')}</p>}
                <ul className="fw-hv-picks">
                  {people.slice(0, 12).map((person) => (
                    <li key={person.id}>
                      <Button size="sm" variant="quiet" onClick={() => actions?.onJudgePick?.(person)}>
                        {personText({ name: person.name, employeeCode: person.employeeCode })} · {person.site.name}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="fw-hv-muted">{t('judge.personHint')}</p>
          </fieldset>
        )}
        {chosen && draft.from === 'visit' && <p className="fw-hv-muted">{t('judge.visitDone', { day: when.day(draft.judgedOn) })}</p>}

        <fieldset className="fw-hv-fieldset">
          <legend>{t('judge.outcome')}</legend>
          <div className="fw-hv-outcomes" role="radiogroup" aria-label={t('judge.outcome')}>
            {FITNESS_OUTCOMES.map((outcome) => (
              <RadioCard key={outcome} name="fw-hv-outcome" value={outcome} checked={draft.outcome === outcome} selected={draft.outcome === outcome} onChange={() => set({ outcome })} title={t(`outcome.${outcome}`)} description={t(`outcomeHint.${outcome}`)} />
            ))}
          </div>
          {at('outcome') && <p className="fw-hv-warn">{at('outcome')}</p>}
        </fieldset>

        {draft.outcome === 'FIT_WITH_LIMITS' && (
          <Field label={t('judge.limits')} required hint={hint} error={clinical.length > 0 ? t('held.judgement.clinical', { words: clinical.join(', ') }) : at('taskLimits')}>
            <Textarea value={draft.taskLimits} rows={3} maxLength={HEALTH_LIMITS.taskLimits} onChange={(event) => set({ taskLimits: event.target.value })} />
          </Field>
        )}

        <div className="fw-hv-form-row">
          <Field label={t('judge.day')} required error={at('judgedOn')}>
            <DateField value={draft.judgedOn} max={model.today} onChange={(value) => set({ judgedOn: value })} ariaLabel={t('judge.day')} />
          </Field>
          {draft.outcome === 'TEMPORARILY_UNFIT' && (
            <Field label={t('judge.unfitUntil')} required error={at('unfitUntil')}>
              <DateField value={draft.unfitUntil} min={draft.judgedOn || undefined} onChange={(value) => set({ unfitUntil: value })} ariaLabel={t('judge.unfitUntil')} />
            </Field>
          )}
          {draft.outcome !== 'UNFIT' && (
            <Field label={t('judge.expires')} hint={t('judge.expiresHint')} error={at('expiresOn')}>
              <DateField value={draft.expiresOn} min={draft.judgedOn || undefined} clearable onChange={(value) => set({ expiresOn: value })} ariaLabel={t('judge.expires')} />
            </Field>
          )}
        </div>

        <fieldset className="fw-hv-fieldset">
          <legend>{t('judge.copy')}</legend>
          <p className="fw-hv-muted">{t('judge.copyHint')}</p>
          {state.copy ? (
            <span className="fw-hv-row">
              <span>{state.copy.name}</span>
              <Button size="sm" variant="quiet" aria-label={t('judge.removeCopy')} onClick={() => actions?.onJudgeCopy?.(null)}>
                <Trash2 size={13} aria-hidden />
              </Button>
            </span>
          ) : (
            <FileDropzone accept={COPY_ACCEPT} maxBytes={COPY_MOST_BYTES} onFiles={(files) => actions?.onJudgeCopy?.(files[0] ?? null)} />
          )}
        </fieldset>
        <p className="fw-hv-muted">
          <ProtectedLaw /> {t('judge.recordedNote')}
        </p>
      </div>
    </Modal>
  )
}
