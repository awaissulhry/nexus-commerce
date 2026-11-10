'use client'

import { Banner, Field } from '@nexus/ui/components'
import { SignOffPanel, type SignOffStep } from '@nexus/ui/components/SignOffPanel/index'
import { Button, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { INSTRUCTION_LIMITS } from '@nexus/factory-domain/production/instructions/rules'
import { DateField, Modal, Textarea, useDsWords } from '../../../../../lib/i18n/ds-parts'
import { INTL_LOCALE, type Locale } from '../../../../../lib/i18n/locales'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { InstructionRecord, VersionView } from '../../api'
import { changeSummary, currentOfRecord, languageName, nextNumber, NS, peopleRows, valueOf, type Phrase } from '../../model'
import { useSay } from '../../view/parts'
import type { RecordModel } from './InstructionRecordView'

/** The record's dialogs other than Approve (which follows the address, `?approve=1`). */
export type RecordDialog =
  | { readonly kind: 'newVersion'; readonly changeNote: string; readonly problem: string | null }
  | { readonly kind: 'discard'; readonly reason: string; readonly shown: boolean; readonly problem: string | null }
  | { readonly kind: 'status'; readonly to: 'ARCHIVED' | 'ACTIVE'; readonly reason: string; readonly problem: string | null }
  | { readonly kind: 'paper'; readonly workerId: string; readonly locale: string; readonly date: string; readonly problem: string | null }

export interface DialogActions {
  onApproveClose?: () => void
  onApprove?: () => void
  onDialog?: (dialog: RecordDialog | null) => void
  onNewVersion?: () => void
  onDiscard?: () => void
  onStatus?: () => void
  onPaper?: () => void
}

/**
 * Approve version N (design pop:wi-approve, a confirm: "the floor shows vN from now on; operators are asked to
 * acknowledge"): what changed against the version in force (step codes added, removed, changed), the change note, then the
 * sign-off — written by its author (signed), approved by a second person (now; the author never approves their own draft,
 * the database refuses it too) — and Approve, held with its reason in words. No step-up: the API asks none (B-W2b-214).
 */
export function ApproveDialog({ model, record, draft, held, actions }: { model: RecordModel; record: InstructionRecord; draft: VersionView; held: Phrase | null; actions?: DialogActions }) {
  const t = useT(NS)
  const say = useSay()
  const ds = useDsWords()
  const locale = useLocale()
  const shown = valueOf(model.shown)
  const summary = changeSummary(shown && shown.version.id === draft.id ? shown : null)
  const current = currentOfRecord(record)
  const isAuthor = draft.author.id === model.me
  const busy = model.busy === 'approve'
  const steps: SignOffStep[] = [
    {
      id: 'write',
      label: t('approve.stepWrite', { number: draft.number }),
      role: t('approve.roleAuthor'),
      state: 'signed',
      signer: draft.author.name || '—',
      signedAt: formatDateTime(draft.createdAt, { locale }),
    },
    {
      id: 'approve',
      label: t('approve.stepApprove', { number: draft.number }),
      role: t('approve.roleApprover'),
      state: 'waiting',
      whoMay: t('approve.whoMay'),
      heldReason: held ? say(held) : null,
      rules: [{ id: 'author', kind: 'authorNotApprover', state: isAuthor ? 'broken' : 'met', text: isAuthor ? t('approve.ruleBroken', { number: draft.number }) : t('approve.ruleMet', { name: draft.author.name || '—' }) }],
      action: { label: t('approve.do', { number: draft.number }), onClick: () => actions?.onApprove?.(), busy, busyLabel: t('common.working') },
      note: current ? t('approve.supersedes', { number: current.number }) : t('approve.first'),
    },
  ]
  const ackRequired = shown && shown.version.id === draft.id ? (model.draft?.acknowledgementRequired ?? shown.version.acknowledgementRequired) : draft.acknowledgementRequired
  return (
    <Modal
      open
      size="lg"
      title={t('approve.title', { number: draft.number })}
      subtitle={t('approve.subtitle', { number: record.instruction.number, operation: `${record.instruction.operation.code} · ${record.instruction.operation.name}` })}
      onClose={() => actions?.onApproveClose?.()}
      footer={<Button onClick={() => actions?.onApproveClose?.()}>{t('common.close')}</Button>}
    >
      <div className="fw-wi-dialog">
        {model.notice?.tone === 'danger' && <Banner tone="danger" title={t(model.notice.key, model.notice.params)} />}
        <Banner tone="info" title={t(ackRequired ? 'approve.floorAsked' : 'approve.floorNotAsked', { number: draft.number })} />
        <section className="fw-wi-stack" aria-labelledby="fw-wi-approve-changes">
          <h3 id="fw-wi-approve-changes" className="fw-wi-h3">
            {summary.from === null ? t('approve.allNew', { count: draft.steps }) : t('approve.changes', { from: summary.from, to: draft.number })}
          </h3>
          {summary.from !== null && (
            <div className="fw-wi-chips">
              {summary.added.map((code) => (
                <Tag key={`a-${code}`} tone="success">
                  {t('approve.added', { code })}
                </Tag>
              ))}
              {summary.changed.map((code) => (
                <Tag key={`c-${code}`} tone="warning">
                  {t('approve.changed', { code })}
                </Tag>
              ))}
              {summary.removed.map((code) => (
                <Tag key={`r-${code}`} tone="danger">
                  {t('approve.removed', { code })}
                </Tag>
              ))}
              {summary.added.length + summary.changed.length + summary.removed.length === 0 && <span className="fw-wi-hint">{t('approve.same')}</span>}
            </div>
          )}
          <p className="fw-wi-note">
            <strong>{t('approve.note')}</strong> {draft.changeNote || '—'}
          </p>
        </section>
        <SignOffPanel title={t('approve.signOff')} steps={steps} labels={ds.signOffPanel} headingLevel={3} />
      </div>
    </Modal>
  )
}

/** Start version N+1: a copy of the version in force (steps, photos and videos), a draft only its writers change. */
export function NewVersionDialog({ model, record, actions }: { model: RecordModel; record: InstructionRecord; actions?: DialogActions }) {
  const t = useT(NS)
  const dialog = model.dialog
  if (dialog?.kind !== 'newVersion') return null
  const busy = model.busy === 'newVersion'
  const current = currentOfRecord(record)
  return (
    <Modal
      open
      size="md"
      title={t('newVersion.title', { number: nextNumber(record) })}
      subtitle={current ? t('newVersion.copy', { number: current.number }) : t('newVersion.blank')}
      onClose={() => actions?.onDialog?.(null)}
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={busy ? t('held.busy') : model.offline ? t('held.offline') : null} onClick={() => actions?.onNewVersion?.()}>
            {busy ? <Spinner size={14} /> : null} {t('newVersion.do', { number: nextNumber(record) })}
          </Button>
        </>
      }
    >
      <div className="fw-wi-dialog">
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        <Field label={t('note.label')} hint={t('newVersion.noteHint')}>
          <Textarea value={dialog.changeNote} rows={3} maxLength={INSTRUCTION_LIMITS.changeNote} onChange={(event) => actions?.onDialog?.({ ...dialog, changeNote: event.target.value, problem: null })} />
        </Field>
        <p className="fw-wi-hint">{t('newVersion.floor')}</p>
      </div>
    </Modal>
  )
}

/** Discard draft N: it never goes to the floor; the reason is kept with it. */
export function DiscardDialog({ model, draft, actions }: { model: RecordModel; draft: VersionView; actions?: DialogActions }) {
  const t = useT(NS)
  const dialog = model.dialog
  if (dialog?.kind !== 'discard') return null
  const busy = model.busy === 'discard'
  const missing = !dialog.reason.trim()
  return (
    <Modal
      open
      size="sm"
      title={t('discard.title', { number: draft.number })}
      subtitle={t('discard.subtitle')}
      onClose={() => actions?.onDialog?.(null)}
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.cancel')}</Button>
          <Button variant="danger" heldReason={busy ? t('held.busy') : missing && dialog.shown ? t('discard.reasonMissing') : model.offline ? t('held.offline') : null} onClick={() => actions?.onDiscard?.()}>
            {busy ? <Spinner size={14} /> : null} {t('discard.do', { number: draft.number })}
          </Button>
        </>
      }
    >
      <div className="fw-wi-dialog">
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        <Field label={t('dialog.reasonRequired')} required error={missing && dialog.shown ? t('discard.reasonMissing') : undefined}>
          <Textarea value={dialog.reason} rows={3} maxLength={INSTRUCTION_LIMITS.reason} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value, problem: null })} />
        </Field>
      </div>
    </Modal>
  )
}

/** Archive (the floor stops showing it; the typed lines or nothing take its place) or Restore. */
export function StatusDialog({ model, record, actions }: { model: RecordModel; record: InstructionRecord; actions?: DialogActions }) {
  const t = useT(NS)
  const dialog = model.dialog
  if (dialog?.kind !== 'status') return null
  const busy = model.busy === 'status'
  const archive = dialog.to === 'ARCHIVED'
  return (
    <Modal
      open
      size="sm"
      title={t(archive ? 'archiveOne.title' : 'restoreOne.title', { number: record.instruction.number })}
      onClose={() => actions?.onDialog?.(null)}
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.cancel')}</Button>
          <Button variant={archive ? 'danger' : 'primary'} heldReason={busy ? t('held.busy') : model.offline ? t('held.offline') : null} onClick={() => actions?.onStatus?.()}>
            {busy ? <Spinner size={14} /> : null} {t(archive ? 'record.archive' : 'record.restore')}
          </Button>
        </>
      }
    >
      <div className="fw-wi-dialog">
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        <ul className="fw-wi-list">{(archive ? ['archive.floor', 'archive.kept', 'archive.back'] : ['restore.floor', 'restore.twin']).map((key) => <li key={key}>{t(key)}</li>)}</ul>
        <Field label={t('dialog.reason')} hint={t('dialog.reasonHint')}>
          <Textarea value={dialog.reason} rows={2} maxLength={INSTRUCTION_LIMITS.reason} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value, problem: null })} />
        </Field>
      </div>
    </Modal>
  )
}

/** Record a paper acknowledgement (HR): who signed the printed sheet of the version in force, in which language, on which day. */
export function PaperDialog({ model, actions }: { model: RecordModel; actions?: DialogActions }) {
  const t = useT(NS)
  const locale = useLocale()
  const dialog = model.dialog
  const acks = valueOf(model.acks)
  if (dialog?.kind !== 'paper' || !acks?.current) return null
  const busy = model.busy === 'paper'
  const named = peopleRows(acks).filter((row) => row.worker && !row.seenCurrent)
  const held = busy ? t('held.busy') : !dialog.workerId ? t('paper.pickPerson') : !dialog.date ? t('paper.pickDate') : model.offline ? t('held.offline') : null
  return (
    <Modal
      open
      size="md"
      title={t('paper.title', { number: acks.current.number })}
      subtitle={t('paper.subtitle')}
      onClose={() => actions?.onDialog?.(null)}
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onPaper?.()}>
            {busy ? <Spinner size={14} /> : null} {t('paper.do')}
          </Button>
        </>
      }
    >
      <div className="fw-wi-dialog">
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        <Field label={t('paper.person')} required hint={named.length === 0 ? t('paper.nobody') : t('paper.personHint')}>
          <Select value={dialog.workerId} onChange={(event) => actions?.onDialog?.({ ...dialog, workerId: event.target.value, problem: null })}>
            <option value="">{t('paper.choose')}</option>
            {named.map((row) => (
              <option key={row.worker!.id} value={row.worker!.id}>
                {row.worker!.name} · {row.site.code}
              </option>
            ))}
          </Select>
        </Field>
        <div className="fw-wi-form-grid">
          <Field label={t('paper.language')}>
            <Select value={dialog.locale} onChange={(event) => actions?.onDialog?.({ ...dialog, locale: event.target.value, problem: null })}>
              {['it', 'en', 'ro', 'sq', 'ar', 'hi', 'pa', 'bn', 'ur', 'uk', 'es', 'fr', 'de', 'pl', 'pt'].map((code) => (
                <option key={code} value={code}>
                  {languageName(code, locale)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('paper.date')} required hint={t('paper.dateHint')}>
            <DateField value={dialog.date} max={new Date().toISOString().slice(0, 10)} locale={INTL_LOCALE[locale as Locale]} ariaLabel={t('paper.date')} onChange={(date) => actions?.onDialog?.({ ...dialog, date, problem: null })} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
