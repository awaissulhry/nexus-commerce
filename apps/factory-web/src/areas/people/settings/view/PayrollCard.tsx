'use client'

import { useId } from 'react'
import { Banner, Card, Field } from '@nexus/ui/components'
import { Button, Input, NumberStepper, Select } from '@nexus/ui/primitives'
import { EditModeBar, Modal } from '../../../../lib/i18n/ds-parts'
import type { PayrollSettings, ReviewRule } from '../api'
import { codeFromName, consultantHeld, PAYROLL_CODE_MAX, payrollChanges, payrollDraftOf, payrollHeld, REVIEW_LIMITS, reviewChanges, reviewDraftOf, reviewHeld, type ConsultantDraft, type PayrollDraft, type ReviewDraft } from '../model'
import { CardHead, SectionState, useSaid, useSettingsWords, type Section, type SettingsModel, type SettingsProblem } from './SettingsView'

/**
 * People settings › Payroll and statements and › Standard review (B-W2b-89; follow-ups of B-W2b-54, -68 and -44): the company's
 * labour consultant (a party with the Consultant role; a new one from here with parties.manage), the payroll code their
 * software knows the company by, the office printer of the worker statements, and the two numbers of the standard review. A
 * named consultant or printer that no longer serves stays named and is said. Each card saves on its own (⌘S), with the People
 * settings row's version.
 */

export interface PayrollState {
  read: Section<PayrollSettings>
  draft: PayrollDraft | null
  busy: boolean
  problem: SettingsProblem | null
  /** New consultant (pop-up): the typed party and its save. */
  dialog: { draft: ConsultantDraft; busy: boolean; problem: SettingsProblem | null } | null
}

export interface ReviewState {
  read: Section<ReviewRule>
  draft: ReviewDraft | null
  busy: boolean
  problem: SettingsProblem | null
}

export interface PayrollActions {
  onDraft?: (patch: Partial<PayrollDraft>) => void
  onSave?: () => void
  onDiscard?: () => void
  onRetry?: () => void
  onNewConsultant?: () => void
  onConsultantDraft?: (patch: Partial<ConsultantDraft>) => void
  onConsultantClose?: () => void
  onConsultantSave?: () => void
}

export interface ReviewActions {
  onDraft?: (patch: Partial<ReviewDraft>) => void
  onSave?: () => void
  onDiscard?: () => void
  onRetry?: () => void
}

export function PayrollCard({ model, actions }: { model: SettingsModel; actions?: PayrollActions }) {
  const t = useSettingsWords()
  const say = useSaid()
  const id = useId()
  const { read, draft, busy, problem } = model.payroll
  return (
    <Card padded>
      <div className="fw-ps-stack">
        <CardHead title={t('payroll.title')} purpose={t('payroll.purpose')} />
        <SectionState read={read} title={t('payroll.title')} onRetry={() => actions?.onRetry?.()}>
          {(value) => {
            const manage = model.can.managePayroll && value.canManage
            const values = draft ?? payrollDraftOf(value)
            const changes = payrollChanges(value, values)
            const held = payrollHeld(values)
            const set = (patch: Partial<PayrollDraft>) => actions?.onDraft?.(patch)
            const named = value.consultant
            const consultantMissing = named !== null && !value.choices.consultants.some((row) => row.id === named.partyId)
            const printer = value.statementPrinter
            const printerMissing = printer !== null && !value.choices.printers.some((row) => row.id === printer.id)
            const chosenConsultant = value.choices.consultants.find((row) => row.id === values.consultantPartyId) ?? null
            return (
              <>
                {problem && <Banner tone="danger" title={say(problem) ?? ''} />}
                {named?.problem && <Banner tone="warning" title={t(`payroll.consultantProblem.${named.problem}`, { name: named.name ?? '—' })} />}
                {printer?.problem && <Banner tone="warning" title={t(`payroll.printerProblem.${printer.problem}`, { name: printer.name ?? '—' })} />}
                <div className="fw-ps-fields">
                  <Field label={t('payroll.consultant')} hint={chosenConsultant ? (chosenConsultant.email ? t('payroll.consultantMail', { email: chosenConsultant.email }) : t('payroll.consultantNoMail')) : t('payroll.consultantHint')}>
                    <span className="fw-ps-row">
                      <Select id={`${id}-consultant`} aria-label={t('payroll.consultant')} size="sm" value={values.consultantPartyId ?? ''} disabled={!manage} onChange={(event) => set({ consultantPartyId: event.target.value || null })}>
                        <option value="">{t('payroll.consultantNone')}</option>
                        {consultantMissing && named && <option value={named.partyId}>{t('payroll.namedNoLonger', { name: named.name ?? '—' })}</option>}
                        {value.choices.consultants.map((row) => (
                          <option key={row.id} value={row.id}>
                            {row.companyWide ? t('payroll.consultantGroup', { name: row.name }) : row.name}
                          </option>
                        ))}
                      </Select>
                      {manage && (
                        <Button size="sm" variant="quiet" heldReason={model.can.addParty ? null : t('held.noParties')} onClick={() => actions?.onNewConsultant?.()}>
                          {t('payroll.newConsultant')}
                        </Button>
                      )}
                    </span>
                  </Field>
                  <Field label={t('payroll.code')} hint={t('payroll.codeHint', { code: value.company.code })} error={held ? t(held, { max: PAYROLL_CODE_MAX }) : undefined}>
                    <Input size="sm" value={values.payrollCode} placeholder={value.company.code} maxLength={PAYROLL_CODE_MAX + 5} disabled={!manage} aria-label={t('payroll.code')} onChange={(event) => set({ payrollCode: event.target.value })} />
                  </Field>
                  <Field label={t('payroll.printer')} hint={values.statementPrinterId ? t('payroll.printerHint') : t('payroll.printerNone')}>
                    <Select id={`${id}-printer`} aria-label={t('payroll.printer')} size="sm" value={values.statementPrinterId ?? ''} disabled={!manage} onChange={(event) => set({ statementPrinterId: event.target.value || null })}>
                      <option value="">{t('payroll.printerSite')}</option>
                      {printerMissing && printer && <option value={printer.id}>{t('payroll.namedNoLonger', { name: printer.name ?? '—' })}</option>}
                      {value.choices.printers.map((row) => (
                        <option key={row.id} value={row.id}>
                          {t('payroll.printerAt', { name: row.name, site: row.site.name })}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                {value.choices.printers.length === 0 && <p className="fw-ps-hint">{t('payroll.noPrinters')}</p>}
                {!manage && <p className="fw-ps-hint">{t('held.noPayroll')}</p>}
                {changes > 0 && <EditModeBar message={t('card.unsaved')} count={changes} busy={busy} applyHeldReason={held ? t(held, { max: PAYROLL_CODE_MAX }) : null} saveShortcut onDiscard={() => actions?.onDiscard?.()} onApply={() => actions?.onSave?.()} />}
              </>
            )
          }}
        </SectionState>
      </div>
    </Card>
  )
}

export function ConsultantDialog({ model, actions }: { model: SettingsModel; actions?: PayrollActions }) {
  const t = useSettingsWords()
  const say = useSaid()
  const dialog = model.payroll.dialog
  if (!dialog) return null
  const { draft, busy, problem } = dialog
  const held = consultantHeld(draft)
  return (
    <Modal
      open
      onClose={() => actions?.onConsultantClose?.()}
      title={t('payroll.dialog.title')}
      size="sm"
      footer={
        <>
          <Button variant="quiet" onClick={() => actions?.onConsultantClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={busy} heldReason={held ? t(held) : null} onClick={() => actions?.onConsultantSave?.()}>
            {t('payroll.dialog.save')}
          </Button>
        </>
      }
    >
      <div className="fw-ps-stack">
        <p className="fw-ps-hint">{t('payroll.dialog.body')}</p>
        {problem && <Banner tone="danger" title={say(problem) ?? ''} />}
        <Field label={t('payroll.dialog.name')} error={held === 'payroll.problem.name' && draft.name !== '' ? t(held) : undefined}>
          <Input value={draft.name} maxLength={200} autoFocus onChange={(event) => actions?.onConsultantDraft?.({ name: event.target.value, ...(draft.code === '' || draft.code === codeFromName(draft.name) ? { code: codeFromName(event.target.value) } : {}) })} />
        </Field>
        <Field label={t('payroll.dialog.code')} hint={t('payroll.dialog.codeHint')} error={held === 'payroll.problem.code' && draft.code !== '' ? t(held) : undefined}>
          <Input value={draft.code} maxLength={24} onChange={(event) => actions?.onConsultantDraft?.({ code: event.target.value.toUpperCase() })} />
        </Field>
        <Field label={t('payroll.dialog.email')} hint={t('payroll.dialog.emailHint')} error={held === 'payroll.problem.email' ? t(held) : undefined}>
          <Input type="email" value={draft.email} maxLength={254} onChange={(event) => actions?.onConsultantDraft?.({ email: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}

export function ReviewCard({ model, actions }: { model: SettingsModel; actions?: ReviewActions }) {
  const t = useSettingsWords()
  const say = useSaid()
  const { read, draft, busy, problem } = model.review
  return (
    <Card padded>
      <div className="fw-ps-stack">
        <CardHead title={t('review.title')} purpose={t('review.purpose')} />
        <SectionState read={read} title={t('review.title')} onRetry={() => actions?.onRetry?.()}>
          {(value) => {
            const manage = model.can.manageReview && value.canManage
            const values = draft ?? reviewDraftOf(value)
            const changes = reviewChanges(value, values)
            const held = reviewHeld(values)
            const set = (patch: Partial<ReviewDraft>) => actions?.onDraft?.(patch)
            return (
              <>
                {problem && <Banner tone="danger" title={say(problem) ?? ''} />}
                <div className="fw-ps-fields">
                  <Field label={t('review.percent')} error={held === 'review.problem.tolerancePercent' ? t(held) : undefined}>
                    <NumberStepper value={values.tolerancePercent} min={REVIEW_LIMITS.percentMin} max={REVIEW_LIMITS.percentMax} suffix="%" disabled={!manage} onChange={(next) => set({ tolerancePercent: next })} />
                  </Field>
                  <Field label={t('review.bundles')} error={held === 'review.problem.minBundles' ? t(held) : undefined}>
                    <NumberStepper value={values.minBundles} min={REVIEW_LIMITS.bundlesMin} max={REVIEW_LIMITS.bundlesMax} suffix={t('review.bundlesUnit')} disabled={!manage} onChange={(next) => set({ minBundles: next })} />
                  </Field>
                </div>
                <div className="fw-ps-example">
                  <h3>{t('review.example')}</h3>
                  <p className="fw-ps-value">{t('review.rule', { percent: values.tolerancePercent, bundles: values.minBundles, days: value.windowDays })}</p>
                </div>
                {!manage && <p className="fw-ps-hint">{t('held.noReview')}</p>}
                {changes > 0 && <EditModeBar message={t('card.unsaved')} count={changes} busy={busy} applyHeldReason={held ? t(held) : null} saveShortcut onDiscard={() => actions?.onDiscard?.()} onApply={() => actions?.onSave?.()} />}
              </>
            )
          }}
        </SectionState>
      </div>
    </Card>
  )
}
