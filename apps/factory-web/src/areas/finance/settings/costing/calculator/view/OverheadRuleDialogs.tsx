'use client'

import { useState } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { OverheadRuleView } from '../api'
import { CPM_NS, isAmountBasis, monthName, OHR_BASES, OHR_KINDS, ruleDraftOf, ruleEditBody, ruleEditOf, ruleEditProblems, ruleNewHeld, ruleProblems, ruleRowHeld, type OhrBasis, type RuleDraft, type RuleEdit } from '../model'
import type { CalculatorActions, CalculatorModel } from './CalculatorCard'

/**
 * B-W2b-GB02 (G054; B-W2b-430 gap 3) — the overhead rules kept on screen (design finance.settings sec:costing; FIN-007;
 * B-W2b-419's routes): a new rule for this company or every company, per department or every one, from a month on (ending
 * the rule before it), an active rule corrected (its figure, last month, note) or archived with a reason. Every rule waits
 * for the accountant (said on the card). Esc closes each (the DS Modal); a refused write is said in the dialog.
 */

/** The months a rule may start or end in: from 12 months back to 24 ahead (YYYY-MM), oldest first. */
function ruleMonths(today: string): string[] {
  const [year, month] = today.split('-').map(Number)
  return Array.from({ length: 37 }, (_, index) => {
    const date = new Date(Date.UTC(year!, month! - 1 - 12 + index, 1))
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
  })
}

export function NewRuleDialog({ model, actions }: { model: CalculatorModel; actions?: CalculatorActions }) {
  const t = useT(CPM_NS)
  const locale = useLocale()
  const [draft, setDraft] = useState<RuleDraft>(() => ruleDraftOf(model.today, model.currency, model.ruleDraft))
  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const problems = ruleProblems(draft)
  const first = Object.values(problems)[0]
  const held = ruleNewHeld(model.can, model.busy)
  const months = ruleMonths(model.today)
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={t('ohrEdit.newTitle')}
      footer={
        <>
          <Button onClick={close}>{t('csCommon.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : first ? t(first) : null} onClick={() => actions?.onCreateRule?.(draft)}>
            {model.busy ? t('csCommon.working') : t('ohrEdit.keep')}
          </Button>
        </>
      }
    >
      <div className="fw-fin-stack-tight fw-cpm-form">
        <p className="fw-fin-hint">{t('ohrEdit.newIntro')}</p>
        <div className="fw-cpm-grid">
          <Field label={t('ohrEdit.scope')} hint={t('ohrEdit.scopeHint')}>
            <Select value={draft.scope} onChange={(event) => set('scope', event.target.value as RuleDraft['scope'])}>
              <option value="company">{t('ohr.thisCompany')}</option>
              <option value="every">{t('ohr.everyCompany')}</option>
            </Select>
          </Field>
          <Field label={t('ohr.col.basis')}>
            <Select value={draft.basis} onChange={(event) => set('basis', event.target.value as OhrBasis)}>
              {OHR_BASES.map((basis) => (
                <option key={basis} value={basis}>
                  {t(`ohrBasis.${basis}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('ohr.col.department')}>
            <Select value={draft.workCentreKind} onChange={(event) => set('workCentreKind', event.target.value)}>
              <option value="">{t('ohr.everyDepartment')}</option>
              {OHR_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`dept.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={isAmountBasis(draft.basis) ? t(`ohrEdit.amount.${draft.basis}`) : t('ohrEdit.percent')} error={draft.value.trim() !== '' && problems.value ? t(problems.value) : undefined}>
            <Input inputMode="decimal" value={draft.value} onChange={(event) => set('value', event.target.value)} />
          </Field>
          {isAmountBasis(draft.basis) && (
            <Field label={t('ohrEdit.currency')} hint={t('ohrEdit.currencyHint')} error={problems.currency ? t(problems.currency) : undefined}>
              <Input value={draft.currency} maxLength={3} onChange={(event) => set('currency', event.target.value.toUpperCase())} />
            </Field>
          )}
          <Field label={t('cpm.fromMonth')} error={problems.period ? t(problems.period) : undefined}>
            <Select value={draft.fromMonth} onChange={(event) => set('fromMonth', event.target.value)}>
              {months.map((month) => (
                <option key={month} value={month}>
                  {monthName(month, locale)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('ohrEdit.toMonth')}>
            <Select value={draft.toMonth} onChange={(event) => set('toMonth', event.target.value)}>
              <option value="">{t('ohrEdit.openEnded')}</option>
              {months.map((month) => (
                <option key={month} value={month}>
                  {monthName(month, locale)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Checkbox checked={draft.endPrevious} onChange={(event) => set('endPrevious', event.target.checked)} label={t('ohrEdit.endPrevious')} />
        <Field label={t('cpm.note')} error={problems.note ? t(problems.note) : undefined}>
          <Textarea rows={2} maxLength={1000} value={draft.note} onChange={(event) => set('note', event.target.value)} />
        </Field>
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      </div>
    </Modal>
  )
}

export function EditRuleDialog({ rule, model, actions }: { rule: OverheadRuleView; model: CalculatorModel; actions?: CalculatorActions }) {
  const t = useT(CPM_NS)
  const locale = useLocale()
  const [edit, setEdit] = useState<RuleEdit>(() => ruleEditOf(rule))
  const set = <K extends keyof RuleEdit>(key: K, value: RuleEdit[K]) => setEdit((current) => ({ ...current, [key]: value }))
  const problems = ruleEditProblems(edit, rule)
  const first = Object.values(problems)[0]
  const held = ruleRowHeld(rule, model.can, model.busy)
  const body = ruleEditBody(edit, rule)
  const months = ruleMonths(model.today).filter((month) => month >= rule.periodStart.slice(0, 7))
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={t('ohrEdit.editTitle', { basis: t(`ohrBasis.${rule.basis}`), department: rule.workCentreKind ? t(`dept.${rule.workCentreKind}`) : t('ohr.everyDepartment') })}
      footer={
        <>
          <Button onClick={close}>{t('csCommon.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : first ? t(first) : body === null ? t('ohrEdit.held.nothing') : null} onClick={() => actions?.onUpdateRule?.(rule, edit)}>
            {model.busy ? t('csCommon.working') : t('ohrEdit.save')}
          </Button>
        </>
      }
    >
      <div className="fw-fin-stack-tight">
        <p className="fw-fin-hint">{t('ohrEdit.editIntro', { from: monthName(rule.periodStart.slice(0, 7), locale) })}</p>
        <Field label={isAmountBasis(rule.basis) ? t(`ohrEdit.amount.${rule.basis}`) : t('ohrEdit.percent')} error={problems.value ? t(problems.value) : undefined}>
          <Input inputMode="decimal" value={edit.value} onChange={(event) => set('value', event.target.value)} />
        </Field>
        {isAmountBasis(rule.basis) && (
          <Field label={t('ohrEdit.currency')} error={problems.currency ? t(problems.currency) : undefined}>
            <Input value={edit.currency} maxLength={3} onChange={(event) => set('currency', event.target.value.toUpperCase())} />
          </Field>
        )}
        <Field label={t('ohrEdit.toMonth')} error={problems.period ? t(problems.period) : undefined}>
          <Select value={edit.toMonth} onChange={(event) => set('toMonth', event.target.value)}>
            <option value="">{t('ohrEdit.openEnded')}</option>
            {months.map((month) => (
              <option key={month} value={month}>
                {monthName(month, locale)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('cpm.note')} error={problems.note ? t(problems.note) : undefined}>
          <Textarea rows={2} maxLength={1000} value={edit.note} onChange={(event) => set('note', event.target.value)} />
        </Field>
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      </div>
    </Modal>
  )
}

export function ArchiveRuleDialog({ rule, model, actions }: { rule: OverheadRuleView; model: CalculatorModel; actions?: CalculatorActions }) {
  const t = useT(CPM_NS)
  const [reason, setReason] = useState('')
  const held = ruleRowHeld(rule, model.can, model.busy)
  const short = reason.trim() !== '' && reason.trim().length < 3
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={t('ohrEdit.archiveTitle', { basis: t(`ohrBasis.${rule.basis}`), department: rule.workCentreKind ? t(`dept.${rule.workCentreKind}`) : t('ohr.everyDepartment') })}
      footer={
        <>
          <Button onClick={close}>{t('csCommon.cancel')}</Button>
          <Button variant="danger" heldReason={held ? t(held) : short ? t('ohrEdit.problem.reason') : null} onClick={() => actions?.onArchiveRule?.(rule, reason.trim())}>
            {model.busy ? t('csCommon.working') : t('ohrEdit.archiveConfirm')}
          </Button>
        </>
      }
    >
      <div className="fw-fin-stack-tight">
        <p className="fw-fin-hint">{t('ohrEdit.archiveIntro')}</p>
        <Field label={t('ohrEdit.reason')} error={short ? t('ohrEdit.problem.reason') : undefined}>
          <Textarea rows={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      </div>
    </Modal>
  )
}
