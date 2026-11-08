'use client'

import type { ReactNode } from 'react'
import { Field } from '@nexus/ui/components'
import { Button, Select, SegmentedControl, Spinner } from '@nexus/ui/primitives'
import { ACTION_KINDS, CAPA_LIMITS, STAGES } from '@nexus/factory-domain/quality/capa/rules'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import type { ActionKind, CapaRecord } from '../../api'
import { actionDraftProblems } from '../../model'
import { NoticeLine, personWords, useCapaWords } from '../../parts'
import type { CapaRecordActions, CapaRecordModel } from '../view-model'

/**
 * The record's dialogs (the DS Modal: Esc closes, the focus returns to the opener): Add action (design kb `a`; kind, what
 * to do, owner, due day, the escalation path), Done (the evidence: a note, or the action's files already added), Cancel an
 * action and Cancel the CAPA (each with its reason), Move to a stage (any stage of its type, either way), Remove a source.
 * Each primary is held, with the reason, until the dialog says enough.
 */
export function RecordDialogs({ model, record, actions }: { model: CapaRecordModel; record: CapaRecord; actions?: CapaRecordActions }) {
  const { t, say } = useCapaWords()
  const dialog = model.dialog
  if (!dialog) return null
  const offline = model.live === 'offline'
  const change = (patch: Record<string, unknown>) => actions?.onDialogChange?.(patch)
  const close = () => actions?.onDialog?.(null)
  const people = model.people ?? []
  const frame = (title: string, submit: string, held: string | null, body: ReactNode, tone: 'primary' | 'danger' = 'primary') => (
    <Modal
      open
      onClose={close}
      title={title}
      size="md"
      footer={
        <span className="fw-capa-foot">
          <Button size="sm" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant={tone === 'danger' ? 'danger' : 'primary'} heldReason={dialog.busy ? t('common.working') : offline ? t('held.offline') : held} onClick={() => actions?.onSubmitDialog?.()}>
            {dialog.busy && <Spinner size={12} />} {submit}
          </Button>
        </span>
      }
    >
      <div className="fw-capa-stack">
        <NoticeLine notice={dialog.notice} />
        {body}
      </div>
    </Modal>
  )

  if (dialog.kind === 'addAction') {
    const problems = actionDraftProblems(dialog.draft, model.today)
    const first = Object.values(problems)[0] ?? null
    const draft = dialog.draft
    const set = (patch: Partial<typeof draft>) => change({ draft: { ...draft, ...patch } })
    return frame(
      t('add.title', { number: record.capa.number }),
      t('add.submit'),
      first ? say(first) : null,
      <div className="fw-capa-form">
        <Field label={t('actions.col.kind')} className="is-wide" hint={t(`kind.hint.${draft.kind}`)}>
          <SegmentedControl size="sm" ariaLabel={t('actions.col.kind')} value={draft.kind} onChange={(value) => set({ kind: value as ActionKind })} options={ACTION_KINDS.map((kind) => ({ value: kind, label: t(`kind.${kind}`) }))} />
        </Field>
        <Field label={t('add.description')} required className="is-wide" error={draft.description && problems.description ? say(problems.description) : undefined}>
          <Textarea value={draft.description} rows={3} maxLength={CAPA_LIMITS.description} onChange={(event) => set({ description: event.target.value })} />
        </Field>
        <Field label={t('actions.col.owner')} hint={t('add.ownerHint')}>
          <Select value={draft.ownerId} onChange={(event) => set({ ownerId: event.target.value })}>
            {!people.some((person) => person.id === draft.ownerId) && <option value={draft.ownerId}>{personWords(record.people, draft.ownerId, model.me, t)}</option>}
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.me ? t('common.me', { name: person.name }) : person.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('actions.col.due')} required error={problems.dueOn ? say(problems.dueOn) : undefined}>
          <DateField value={draft.dueOn} min={model.today} onChange={(value) => set({ dueOn: value })} />
        </Field>
        <Field label={t('drawer.escalateTo')} hint={t('drawer.escalateHint')} className="is-wide">
          <Select value={draft.escalateToId} onChange={(event) => set({ escalateToId: event.target.value })}>
            <option value="">{t('actions.byRule')}</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.me ? t('common.me', { name: person.name }) : person.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>,
    )
  }

  if (dialog.kind === 'done') {
    const action = record.actions.find((entry) => entry.id === dialog.actionId)
    const files = action?.files ?? 0
    const held = dialog.evidence.trim() || files > 0 ? null : t('done.heldEvidence')
    return frame(
      t('done.title', { seq: action?.seq ?? '' }),
      t('done.submit'),
      held,
      <>
        <p>{action?.description}</p>
        <Field label={t('done.evidence')} hint={files > 0 ? t('done.filesThere', { count: files }) : t('done.evidenceHint')} required={files === 0}>
          <Textarea value={dialog.evidence} rows={4} maxLength={CAPA_LIMITS.evidence} onChange={(event) => change({ evidence: event.target.value })} />
        </Field>
      </>,
    )
  }

  if (dialog.kind === 'cancelAction') {
    const action = record.actions.find((entry) => entry.id === dialog.actionId)
    return frame(
      t('cancelAction.title', { seq: action?.seq ?? '' }),
      t('cancelAction.submit'),
      dialog.reason.trim() ? null : t('cancel.heldReason'),
      <Field label={t('cancel.reason')} required hint={t('cancelAction.hint')}>
        <Textarea value={dialog.reason} rows={3} maxLength={CAPA_LIMITS.reason} onChange={(event) => change({ reason: event.target.value })} />
      </Field>,
      'danger',
    )
  }

  if (dialog.kind === 'cancelCapa')
    return frame(
      t('cancel.title', { number: record.capa.number }),
      t('cancel.submit'),
      dialog.reason.trim() ? null : t('cancel.heldReason'),
      <>
        <p className="fw-capa-hint">{t('cancel.body')}</p>
        <Field label={t('cancel.reason')} required>
          <Textarea value={dialog.reason} rows={3} maxLength={CAPA_LIMITS.reason} onChange={(event) => change({ reason: event.target.value })} />
        </Field>
      </>,
      'danger',
    )

  if (dialog.kind === 'stage') {
    const stages = STAGES[record.capa.type].filter((stage) => stage !== record.capa.status)
    return frame(
      t('stage.title', { number: record.capa.number }),
      t('stage.submit'),
      dialog.to ? null : t('stage.heldPick'),
      <>
        <p className="fw-capa-hint">{t('stage.body', { stage: t(`stage.${record.capa.status}`) })}</p>
        <Field label={t('stage.to')} required>
          <Select value={dialog.to} onChange={(event) => change({ to: event.target.value })}>
            <option value="">{t('stage.pick')}</option>
            {stages.map((stage) => (
              <option key={stage} value={stage}>
                {t(`stage.${stage}`)}
              </option>
            ))}
          </Select>
        </Field>
      </>,
    )
  }

  const source = record.sources.find((entry) => entry.id === dialog.sourceId)
  return frame(
    t('removeSource.title', { number: source?.record?.number ?? '' }),
    t('removeSource.submit'),
    null,
    <p className="fw-capa-hint">{t(source?.recordType === 'Nonconformance' ? 'removeSource.bodyNcr' : 'removeSource.body')}</p>,
    'danger',
  )
}
