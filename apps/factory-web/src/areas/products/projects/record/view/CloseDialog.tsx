'use client'

import { useId, type KeyboardEvent } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, RadioCard } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { PROJECT_LIMITS, PROJECT_OUTCOMES } from '../../model'
import { useWords } from '../../parts'
import { closeProblem, offersTell, RECORD_NS, type CloseDraft } from '../model'
import type { ProjectView } from '../../api'
import type { ProjectRecordActions } from '../view-model'

/**
 * Close the project (PROJ.record-F03): Done or Stopped, and ONE outcome line ("FW27 airbag line approved, 6 styles to production in
 * March") — both required; the line is posted as an office note and pinned, the thread closes and every open invitation ends (said
 * before Close). "Also post the outcome to <outside company>" only on a project that has one, off by default. Never offered for a
 * closed project (the band offers Reopen instead).
 */
export function CloseDialog({ project, draft, busy, problem, offline, actions }: { project: ProjectView; draft: CloseDraft; busy: boolean; problem: { key: string; params?: Readonly<Record<string, string | number>> } | null; offline: boolean; actions?: ProjectRecordActions['close'] }) {
  const { t, say, shared } = useWords(RECORD_NS)
  const noteId = useId()
  const held = closeProblem(draft)
  const heldText = offline ? say({ key: 'held.offline' }) : busy ? shared('common.working') : held ? say(held) : null
  const submit = () => {
    if (!heldText) actions?.onSubmit()
  }
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  }
  return (
    <Modal
      open
      size="md"
      onClose={() => actions?.onCancel()}
      title={t('close.title', { number: project.number })}
      subtitle={project.name}
      footer={
        <span className="fw-prjr-buttons">
          <Button variant="secondary" onClick={() => actions?.onCancel()}>
            {shared('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={heldText} onClick={submit} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('close.submit')}
          </Button>
        </span>
      }
    >
      <div className="fw-prjr-form" onKeyDown={onKey}>
        {problem && <Banner tone="danger" title={say(problem)} />}
        <p className="fw-prjr-hint">{t('close.intro')}</p>
        <div className="fw-prjr-choices" role="radiogroup" aria-label={t('close.outcomeLabel')}>
          {PROJECT_OUTCOMES.map((outcome) => (
            <RadioCard
              key={outcome}
              name="fw-prjr-outcome"
              value={outcome}
              checked={draft.outcome === outcome}
              selected={draft.outcome === outcome}
              onChange={() => actions?.onDraft({ outcome })}
              title={shared(`outcome.${outcome}`)}
              description={t(`close.outcomeHint.${outcome}`)}
            />
          ))}
        </div>
        <Field label={t('close.noteLabel')} required hint={t('close.noteHint')} htmlFor={noteId}>
          <Textarea id={noteId} value={draft.note} limit={PROJECT_LIMITS.outcomeNote} rows={2} honourRows onChange={(event) => actions?.onDraft({ note: event.target.value.replace(/[\r\n]+/g, ' ') })} placeholder={t('close.notePlaceholder')} />
        </Field>
        {offersTell(project) && project.party && (
          <Checkbox checked={draft.tell} onChange={(event) => actions?.onDraft({ tell: event.target.checked })} label={t('close.tell', { party: project.party.name })} />
        )}
        <p className="fw-prjr-hint">{offersTell(project) ? t('close.endsShared') : t('close.endsOffice')}</p>
      </div>
    </Modal>
  )
}
