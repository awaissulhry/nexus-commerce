'use client'

import { FolderKanban } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input } from '@nexus/ui/primitives'
import { DateField, FileRow, Modal, Textarea } from '../../../../../../lib/i18n/ds-parts'
import { useWords } from '../../../parts'
import type { StartProjectActions, StartProjectModel } from '../../../start-project'

/**
 * B-TH-252 — "Start a project…" from an Incoming request (⋯ of the pane and the full page; PROJ.new-F07): the request is the start of
 * development work rather than one order. The project's outside company is the REQUEST's customer, said plainly and never offered as
 * a choice (W38: a project started from Brand Alpha's request is Brand Alpha's, set once); a name (the subject by default), the target
 * date (required), a goal, and the request's files to carry (ticked). The request is linked to it and stays as it is. Draws its model.
 */
export function StartProjectDialog({ model, actions }: { model: StartProjectModel; actions?: StartProjectActions }) {
  const { t } = useWords()
  const close = () => actions?.onClose?.()
  const held = model.busy ? t('common.working') : model.offline ? t('project.held.offline') : !model.draft.targetDate ? t('project.problem.target') : null
  const picked = new Set(model.draft.fileIds)
  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={t('project.title')}
      subtitle={model.number}
      footer={
        <span className="fw-inq-buttons">
          <Button variant="secondary" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onSubmit?.()}>
            <FolderKanban size={14} aria-hidden /> {t('project.go')}
          </Button>
        </span>
      }
    >
      <div className="fw-inq-dialog">
        {model.notice && <Banner tone="danger" title={t(model.notice.key, model.notice.params)} />}
        <p className="fw-inq-hint">{t('project.rule')}</p>
        <Field label={t('project.customer')} hint={t('project.customerHint', { customer: model.customer })}>
          <span className="fw-inq-value">{model.customer}</span>
        </Field>
        <Field label={t('project.name')} hint={t('project.nameHint')}>
          <Input size="sm" value={model.draft.name} maxLength={200} onChange={(event) => actions?.onDraft?.({ name: event.target.value })} />
        </Field>
        <Field label={t('project.target')} required hint={t('project.targetHint')}>
          <DateField value={model.draft.targetDate} onChange={(value) => actions?.onDraft?.({ targetDate: value })} />
        </Field>
        <Field label={t('project.goal')} hint={t('project.goalHint')}>
          <Textarea value={model.draft.goal} rows={3} honourRows maxLength={4000} onChange={(event) => actions?.onDraft?.({ goal: event.target.value })} />
        </Field>
        <h3 className="fw-inq-h3">{t('project.files', { count: picked.size })}</h3>
        {model.files.length === 0 ? (
          <p className="fw-inq-hint">{t('project.noFiles')}</p>
        ) : (
          <div className="fw-inq-files">
            {model.files.map((file) => (
              <FileRow
                key={file.id}
                name={file.name}
                size={file.sizeBytes}
                actions={
                  <Checkbox
                    checked={picked.has(file.id)}
                    aria-label={file.name}
                    onChange={(event) => actions?.onDraft?.({ fileIds: event.target.checked ? [...model.draft.fileIds, file.id] : model.draft.fileIds.filter((id) => id !== file.id) })}
                  />
                }
              />
            ))}
          </div>
        )}
        <p className="fw-inq-hint">{t('project.after', { customer: model.customer })}</p>
      </div>
    </Modal>
  )
}
