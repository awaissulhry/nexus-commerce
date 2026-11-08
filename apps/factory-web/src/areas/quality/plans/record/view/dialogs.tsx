'use client'

import { Banner, ChangeReview, Field, type ChangeReviewItem } from '@nexus/ui/components'
import { SignOffPanel, type SignOffStep } from '@nexus/ui/components/SignOffPanel/index'
import { Button, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea, useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Comparison, PlanRecord, Profile, VersionView } from '../../api'
import { PLAN_LIMITS } from '../../constants'
import { approveHeld, reasonProblem, reviewLines, type ReviewLine } from '../../model'
import { useSay } from '../../view/parts'
import type { PlanRecordModel } from './PlanRecordView'

export interface DialogActions {
  onApproveOpen?: () => void
  onApproveClose?: () => void
  onApprove?: () => void
  onRetireOpen?: (versionId: string, number: number, status: 'DRAFT' | 'APPROVED') => void
  onRetireReason?: (reason: string) => void
  onRetireClose?: () => void
  onRetire?: () => void
}

const TONE: Record<ReviewLine['change'], 'success' | 'danger' | 'warning' | 'info' | 'neutral'> = { added: 'success', removed: 'danger', changed: 'warning', moved: 'info', sampling: 'warning' }

/** A compared value in the page's words: a type, a class, yes / no, a profile by its code, a list. */
function useValueWords(profiles: readonly Profile[]) {
  const t = useT('quality-plans')
  return (field: string, value: string): string => {
    if (value === '—') return value
    switch (field) {
      case 'type':
        return t(`type.${value}`)
      case 'checkClass':
        return t(`class.${value}`)
      case 'mandatory':
      case 'photoRequired':
        return value === 'true' ? t('common.yes') : t('common.no')
      case 'stopAtReject':
        return value === 'true' ? t('sampling.stopSTOP') : t('sampling.stopFINISH')
      case 'frequency':
        return t(`frequencyForm.${value}`)
      case 'samplingMethod':
        return value === 'FIXED' ? t('sampling.fixed') : t('sampling.aql')
      case 'aqlProfileId':
        return profiles.find((profile) => profile.id === value)?.code ?? t('compare.aProfile')
      case 'labelI18n':
        return t('compare.otherLanguages')
      default:
        return value
    }
  }
}

/** The comparison as the DS ChangeReview's items (no checkbox: a version is approved whole). */
export function useReviewItems(comparison: Comparison, version: VersionView | null, profiles: readonly Profile[]): ChangeReviewItem[] {
  const t = useT('quality-plans')
  const locale = useLocale()
  const value = useValueWords(profiles)
  return reviewLines(comparison, version).map((line) => {
    const words = locale === 'it' ? line.labelIt : line.labelEn
    return {
      id: line.id,
      label: line.change === 'sampling' ? t('compare.sampling') : `${line.subject}${words ? ` · ${words}` : ''}`,
      status: <Tag tone={TONE[line.change]}>{t(`compare.${line.change}`)}</Tag>,
      note: line.change === 'moved' ? t('compare.movedNote') : line.fields.length === 0 ? '' : t('compare.fields', { count: line.fields.length }),
      selectable: false,
      values: line.fields.map((field) => ({ label: t(`field.${field.field}`), value: `${value(field.field, field.before)} → ${value(field.field, field.after)}` })),
    }
  })
}

/**
 * Approve version (design pop:pl-approve, QHS-016): what changed against the version in force (ChangeReview), then the
 * sign-off — written by its author (signed), approved by a second person (now), with the duty "the author does not approve"
 * said for the person looking, and the approval held with its reason. Approve asks a fresh code (the step-up), then
 * freezes the version and retires the one in force.
 */
export function ApproveDialog({ model, record, actions }: { model: PlanRecordModel; record: PlanRecord; actions?: DialogActions }) {
  const t = useT('quality-plans')
  const say = useSay()
  const ds = useDsWords()
  const locale = useLocale()
  const draft = record.current.status === 'DRAFT' ? record.current : null
  const items = useReviewItems(record.comparison, record.current, model.profiles?.value?.profiles ?? [])
  if (!draft) return null
  const held = approveHeld(record, model.me, model.can, model.live === 'offline')
  const author = draft.author
  const isAuthor = author?.id === model.me
  const editor = held?.key === 'approve.editor'
  const busy = model.busy === 'approve'
  const steps: SignOffStep[] = [
    {
      id: 'write',
      label: t('approve.stepWrite', { number: draft.number }),
      role: t('approve.roleAuthor'),
      state: 'signed',
      signer: author?.name ?? '—',
      signedAt: formatDateTime(draft.submitted?.at ?? draft.updatedAt, { locale }),
      methodDetail: draft.submitted ? t('approve.submitted') : t('approve.notSubmitted'),
    },
    {
      id: 'approve',
      label: t('approve.stepApprove', { number: draft.number }),
      role: t('approve.roleApprover'),
      state: 'waiting',
      whoMay: t('approve.whoMay'),
      heldReason: held && !isAuthor && !editor ? say(held) : null,
      rules: [
        { id: 'author', kind: 'authorNotApprover', state: isAuthor ? 'broken' : 'met', text: isAuthor ? t('approve.ruleAuthorBroken', { number: draft.number }) : t('approve.ruleAuthorMet', { name: author?.name ?? '—' }) },
        { id: 'editor', kind: 'fourEyes', state: editor ? 'broken' : 'met', text: editor ? t('approve.ruleEditorBroken', { number: draft.number }) : t('approve.ruleEditorMet') },
      ],
      action: { label: t('approve.do', { number: draft.number }), onClick: () => actions?.onApprove?.(), busy, busyLabel: t('common.working') },
      note: record.versions.some((version) => version.status === 'APPROVED') ? t('approve.retiresNote', { number: record.versions.find((version) => version.status === 'APPROVED')!.number }) : t('approve.firstNote'),
    },
  ]
  return (
    <Modal
      open
      size="lg"
      title={t('approve.title', { code: record.plan.code, number: draft.number })}
      subtitle={t('approve.subtitle')}
      onClose={() => actions?.onApproveClose?.()}
      footer={<Button onClick={() => actions?.onApproveClose?.()}>{t('common.close')}</Button>}
    >
      <div className="fw-qp-form">
        {model.approve?.problem && <Banner tone="danger" title={t(model.approve.problem)} />}
        <section aria-labelledby="fw-qp-approve-changes" className="fw-qp-form">
          <h3 id="fw-qp-approve-changes" className="fw-qp-h3">
            {record.comparison.fromNumber === null ? t('approve.allNew', { count: draft.checks.length }) : t('approve.changes', { from: record.comparison.fromNumber, to: draft.number })}
          </h3>
          {record.comparison.same ? <p className="fw-qp-muted">{t('approve.same')}</p> : items.length > 0 && <ChangeReview label={t('approve.changesLabel')} items={items} selectedIds={[]} onSelectionChange={() => undefined} tick={false} />}
        </section>
        {draft.changeNote && (
          <p className="fw-qp-note">
            <strong>{t('approve.note')}</strong> {draft.changeNote}
          </p>
        )}
        <SignOffPanel title={t('approve.signOff')} steps={steps} labels={ds.signOffPanel} headingLevel={3} />
        <p className="fw-qp-muted">{t('approve.code')}</p>
      </div>
    </Modal>
  )
}

/** Retire a version (a draft nobody wants, or the version in force): the reason is kept with it. */
export function RetireDialog({ model, actions }: { model: PlanRecordModel; actions?: DialogActions }) {
  const t = useT('quality-plans')
  const say = useSay()
  const retire = model.retire
  if (!retire) return null
  const problem = reasonProblem(retire.reason)
  const busy = model.busy === 'retire'
  return (
    <Modal
      open
      size="sm"
      title={t('retire.title', { number: retire.number })}
      subtitle={retire.status === 'APPROVED' ? t('retire.approvedSub') : t('retire.draftSub')}
      onClose={() => actions?.onRetireClose?.()}
      footer={
        <>
          <Button onClick={() => actions?.onRetireClose?.()}>{t('common.cancel')}</Button>
          <Button variant="danger" disabled={busy} heldReason={problem && retire.shown ? say(problem) : model.live === 'offline' ? t('held.offline') : null} onClick={() => actions?.onRetire?.()}>
            {busy ? t('common.working') : t('retire.do', { number: retire.number })}
          </Button>
        </>
      }
    >
      <div className="fw-qp-form">
        {retire.problem && <Banner tone="danger" title={t(retire.problem)} />}
        <Field label={t('retire.reason')} hint={t('retire.reasonHint')} error={retire.shown && problem ? say(problem) : undefined} required>
          <Textarea value={retire.reason} rows={3} maxLength={PLAN_LIMITS.reason} onChange={(event) => actions?.onRetireReason?.(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
