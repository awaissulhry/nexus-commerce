'use client'

import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Select } from '@nexus/ui/primitives'
import { ITEM_KINDS } from '@nexus/factory-domain/product/materials/rules'
import { WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { CATEGORIES, DECISION_CODES, type ChangeRequest, type Qualification, type VaultCategory, type VaultUpload } from '../api'
import { acceptProblem, changeLines, dueProblem, qualificationProblem, refuseProblem, type AcceptDraft, type QualificationDialog } from '../model'
import { useSay } from './parts'

interface Busy {
  readonly busy: boolean
  readonly failed: string | null
  readonly tried: boolean
}

export type DocumentsDialog =
  | ({ readonly kind: 'accept'; readonly upload: VaultUpload; readonly draft: AcceptDraft; readonly replaceable: ReadonlyArray<{ fileId: string; name: string }> } & Busy)
  | ({ readonly kind: 'refuse'; readonly upload: VaultUpload; readonly reason: string } & Busy)
  | ({ readonly kind: 'approveChange'; readonly request: ChangeRequest } & Busy)
  | ({ readonly kind: 'refuseChange'; readonly request: ChangeRequest; readonly reason: string } & Busy)
  | ({ readonly kind: 'request'; readonly due: string } & Busy)
  | ({ readonly kind: 'qualification'; readonly form: QualificationDialog; readonly workshop: boolean; readonly companyId: string } & Busy)
  | ({ readonly kind: 'lift'; readonly row: Qualification } & Busy)

export interface DocumentsDialogActions {
  onAcceptDraft?: (draft: AcceptDraft) => void
  onReason?: (reason: string) => void
  onDue?: (due: string) => void
  onForm?: (form: QualificationDialog) => void
  onCompany?: (companyId: string) => void
  onConfirm?: () => void
  onClose?: () => void
}

const REFUSE_MAX = 500

/** The pop-ups of Documents & qualification: accept or refuse an upload, approve or refuse a change, ask for documents, a qualification's move. */
export function DocumentsDialogs({ dialog, companies, today, actions }: { dialog: DocumentsDialog | null; companies: ReadonlyArray<{ id: string; name: string }>; today: string; actions?: DocumentsDialogActions | undefined }) {
  const { t, say } = useSay()
  const locale = useLocale()
  if (!dialog) return null
  const close = () => actions?.onClose?.()
  const failed = dialog.failed ? <Banner tone={dialog.failed === 'problem.conflict' ? 'warning' : 'danger'} title={t(dialog.failed)} /> : null
  const footer = (label: string, held: string | null, variant: 'primary' | 'danger' = 'primary') => (
    <>
      <Button onClick={close}>{t('dialog.cancel')}</Button>
      <Button variant={variant} onClick={() => actions?.onConfirm?.()} heldReason={dialog.busy ? t('dialog.saving') : held}>
        {label}
      </Button>
    </>
  )

  if (dialog.kind === 'accept') {
    const problem = acceptProblem(dialog.draft, today)
    const upload = dialog.upload
    return (
      <Modal open onClose={close} title={t('review.acceptTitle')} footer={footer(t('review.accept'), dialog.tried && problem ? say(problem) : null)}>
        <div className="fw-spd-stack">
          <KeyValue
            columns={2}
            dense
            labelCase="sentence"
            items={[
              { label: t('review.col.said'), value: [upload.issuer, upload.number].filter(Boolean).join(' · ') || '—' },
              { label: t('review.col.for'), value: upload.record.label },
              { label: t('review.saidUntil'), value: upload.expiresOn ? formatDate(upload.expiresOn, { locale }) : t('expiry.none') },
              { label: t('review.col.sent'), value: upload.uploadedByName },
            ]}
          />
          <Field label={t('review.kind')} hint={t('review.kindHint')}>
            <Select value={dialog.draft.category} onChange={(event) => actions?.onAcceptDraft?.({ ...dialog.draft, category: event.target.value as VaultCategory })}>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {t(`category.${category}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('review.lastDay')} hint={t('review.lastDayHint')} error={dialog.tried && problem ? say(problem) : undefined}>
            <DateField value={dialog.draft.expiresOn} clearable onChange={(value) => actions?.onAcceptDraft?.({ ...dialog.draft, expiresOn: value })} />
          </Field>
          {dialog.replaceable.length > 0 ? (
            <Field label={t('review.replacesField')} hint={t('review.replacesHint')}>
              <Select value={dialog.draft.replacesFileId ?? ''} onChange={(event) => actions?.onAcceptDraft?.({ ...dialog.draft, replacesFileId: event.target.value || null })}>
                <option value="">{t('review.replacesNone')}</option>
                {dialog.replaceable.map((file) => (
                  <option key={file.fileId} value={file.fileId}>
                    {file.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <p className="fw-spd-hint">{t('review.acceptBody')}</p>
          {failed}
        </div>
      </Modal>
    )
  }

  if (dialog.kind === 'refuse' || dialog.kind === 'refuseChange') {
    const problem = refuseProblem(dialog.reason, dialog.kind === 'refuse' ? REFUSE_MAX : 600)
    return (
      <Modal open onClose={close} title={t(dialog.kind === 'refuse' ? 'review.refuseTitle' : 'review.refuseChangeTitle')} footer={footer(t('review.refuse'), dialog.tried && problem ? say(problem) : null, 'danger')}>
        <div className="fw-spd-stack">
          <p className="fw-spd-hint">{t(dialog.kind === 'refuse' ? 'review.refuseBody' : 'review.refuseChangeBody')}</p>
          <Field label={t('review.reason')} required error={dialog.tried && problem ? say(problem) : undefined}>
            <Textarea rows={3} value={dialog.reason} onChange={(event) => actions?.onReason?.(event.target.value)} />
          </Field>
          {failed}
        </div>
      </Modal>
    )
  }

  if (dialog.kind === 'approveChange') {
    return (
      <Modal open onClose={close} title={t('review.approveTitle')} footer={footer(t('review.approve'), null)}>
        <div className="fw-spd-stack">
          <ul className="fw-spd-list">
            {changeLines(dialog.request.changes).map((line, index) => (
              <li key={index}>
                {say(line.words)}
                {line.fields.map((field) => (
                  <span key={field.field} className="fw-spd-hint">
                    {' '}
                    {t('change.field', { field: t(`field.${field.field}`), before: field.before, after: field.after })}
                  </span>
                ))}
              </li>
            ))}
          </ul>
          <p className="fw-spd-hint">{t('review.approveBody')}</p>
          {failed}
        </div>
      </Modal>
    )
  }

  if (dialog.kind === 'request') {
    const problem = dueProblem(dialog.due, today)
    return (
      <Modal open onClose={close} title={t('request.titleOne')} footer={footer(t('request.send'), dialog.tried && problem ? say(problem) : null)}>
        <div className="fw-spd-stack">
          <p className="fw-spd-hint">{t('request.body')}</p>
          <Field label={t('request.due')} hint={t('request.dueHint')} error={dialog.tried && problem ? say(problem) : undefined}>
            <DateField value={dialog.due} clearable onChange={(value) => actions?.onDue?.(value)} />
          </Field>
          {failed}
        </div>
      </Modal>
    )
  }

  if (dialog.kind === 'lift') {
    return (
      <Modal open onClose={close} title={t('qual.liftTitle')} footer={footer(t('qual.move.lift'), null)}>
        <div className="fw-spd-stack">
          <p>{t('qual.liftBody', { reason: dialog.row.suspended?.reason ?? '—' })}</p>
          {failed}
        </div>
      </Modal>
    )
  }

  // a qualification: ask, decide, suspend, withdraw
  const form = dialog.form
  const problem = qualificationProblem(form, dialog.workshop)
  const held = dialog.tried && problem ? say(problem) : null
  const set = (patch: Partial<QualificationDialog>) => actions?.onForm?.({ ...form, ...patch } as QualificationDialog)
  const titleKey = form.kind === 'ask' ? 'qual.askTitle' : `qual.${form.kind}Title`
  const confirm = form.kind === 'ask' ? t('qual.askConfirm') : t(`qual.move.${form.kind}`)
  return (
    <Modal open onClose={close} title={t(titleKey)} footer={footer(confirm, held, form.kind === 'suspend' || form.kind === 'withdraw' ? 'danger' : 'primary')}>
      <div className="fw-spd-stack">
        {form.kind === 'ask' ? (
          <>
            {companies.length > 1 ? (
              <Field label={t('qual.company')}>
                <Select value={dialog.companyId} onChange={(event) => actions?.onCompany?.(event.target.value)}>
                  {companies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <fieldset className="fw-spd-checks">
              <legend className="fw-spd-legend">{t(dialog.workshop ? 'qual.workKinds' : 'qual.materialKinds')}</legend>
              {(dialog.workshop ? WORK_CENTRE_KINDS : ITEM_KINDS).map((kind) => {
                const list = dialog.workshop ? form.workCentreKinds : form.materialKinds
                const on = list.includes(kind)
                const next = on ? list.filter((item) => item !== kind) : [...list, kind]
                return <Checkbox key={kind} label={t(dialog.workshop ? `work.${kind}` : `material.${kind}`)} checked={on} onChange={() => set(dialog.workshop ? { workCentreKinds: next } : { materialKinds: next })} />
              })}
            </fieldset>
            <div className="fw-spd-grid">
              <Field label={t('qual.from')}>
                <DateField value={form.validFrom} clearable onChange={(value) => set({ validFrom: value })} />
              </Field>
              <Field label={t('qual.until')} hint={t('qual.untilHint')}>
                <DateField value={form.validUntil} clearable onChange={(value) => set({ validUntil: value })} />
              </Field>
            </div>
            <p className="fw-spd-hint">{t('qual.askBody')}</p>
          </>
        ) : form.kind === 'decide' ? (
          <>
            <Field label={t('qual.decision')}>
              <Select value={form.decision} onChange={(event) => set({ decision: event.target.value as (typeof DECISION_CODES)[number] })}>
                {DECISION_CODES.map((decision) => (
                  <option key={decision} value={decision}>
                    {t(`qual.decisionOf.${decision}`)}
                  </option>
                ))}
              </Select>
            </Field>
            {form.decision === 'CONDITIONAL' ? (
              <Field label={t('qual.conditions')} required>
                <Textarea rows={2} value={form.conditions} onChange={(event) => set({ conditions: event.target.value })} />
              </Field>
            ) : null}
            {form.decision === 'REFUSED' ? (
              <Field label={t('qual.refuseReason')} required>
                <Textarea rows={2} value={form.refuseReason} onChange={(event) => set({ refuseReason: event.target.value })} />
              </Field>
            ) : (
              <div className="fw-spd-grid">
                <Field label={t('qual.from')} hint={t('qual.fromHint')}>
                  <DateField value={form.validFrom} clearable onChange={(value) => set({ validFrom: value })} />
                </Field>
                <Field label={t('qual.until')} hint={t('qual.untilHint')}>
                  <DateField value={form.validUntil} clearable onChange={(value) => set({ validUntil: value })} />
                </Field>
              </div>
            )}
          </>
        ) : (
          <Field label={t('qual.reason')} required>
            <Textarea rows={2} value={form.reason} onChange={(event) => set({ reason: event.target.value })} />
          </Field>
        )}
        {held ? <p className="fw-spd-error">{held}</p> : null}
        {failed}
      </div>
    </Modal>
  )
}
