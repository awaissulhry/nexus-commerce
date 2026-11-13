'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { ArrowLeft, ArrowRight, Check as CheckMark, ExternalLink } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, Stepper } from '@nexus/ui/components'
import { CheckList } from '@nexus/ui/patterns/checklist/index'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import type { Check, PayrollMonth } from '../api'
import { checkState, checkWords, continueHeld, monthChoices, monthWords, nextRevision, orderedChecks, placeOf, showKindOf, stepOpen, STEPS, type Step } from '../model'
import type { PayrollActions, PayrollModel, WizardModel } from '../view-model'
import { MappingStep } from './MappingStep'
import { LayoutTag, LayoutWarning, NotPayroll, SectionLoading, usePayrollWords, useSaid } from './parts'
import { PreviewStep } from './PreviewStep'
import { SendStep } from './SendStep'
import { Listbox } from '../../../../lib/i18n/ds-parts' // B-W2b-F41: the DS parts in the page's language

/**
 * The export wizard (design people.payroll, archetype wizard; anatomy §2.6): 1 · Period and company, 2 · Checks, 3 · Code mapping,
 * 4 · Preview, 5 · Export and send on the DS Stepper, "This export" beside them on wide screens, Back / Continue at the foot.
 * Continue is never greyed out: it is held with what holds it, and ⌘↵ says the reason. Alt ← / → move between steps.
 */
export function Wizard({ model, wizard, actions }: { model: PayrollModel; wizard: WizardModel; actions?: PayrollActions }) {
  const t = usePayrollWords()
  const said = useSaid()
  const locale = useLocale()
  const month = model.month.status === 'ready' ? model.month.value : null
  const facts = { month, can: model.can }
  const index = STEPS.indexOf(wizard.step)
  const held = continueHeld(wizard.step, facts)
  const last = index === STEPS.length - 1

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      const typing = (event.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]')
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        actions?.onContinue?.()
      } else if (event.altKey && !typing && event.key === 'ArrowLeft') {
        event.preventDefault()
        actions?.onBack?.()
      } else if (event.altKey && !typing && event.key === 'ArrowRight') {
        event.preventDefault()
        actions?.onContinue?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions])

  return (
    <section className="fw-pay-section" aria-labelledby="fw-pay-wizard">
      <div className="fw-pay-section-head">
        <h2 className="fw-pp-h3" id="fw-pay-wizard">
          {month ? t('wizard.titleMonth', { month: monthWords(month.month, locale) }) : t('wizard.title')}
        </h2>
        <span className="fw-pp-hint">{t('wizard.stepOf', { step: index + 1, count: STEPS.length, name: t(`step.${wizard.step}.short`) })}</span>
      </div>
      <div className="fw-pay-stepper">
        <Stepper steps={STEPS.map((step) => ({ key: step, label: t(`step.${step}.short`) }))} current={index} onSelect={(_, step) => actions?.onStep?.(step.key as Step)} canSelect={(at) => stepOpen(STEPS[at]!, wizard.step, facts)} />
      </div>
      <div className={wizard.step === 'preview' || wizard.step === 'mapping' ? 'fw-pay-body is-wide' : 'fw-pay-body'}>
        <div className="fw-pp-stack">
          {model.month.status === 'loading' && wizard.step !== 'mapping' && (
            <Card padded>
              <SectionLoading words={t('step.reading', { step: t(`step.${wizard.step}.title`) })} />
            </Card>
          )}
          {model.month.status === 'error' && model.month.problem !== 'problem.gate' && (
            <Card padded>
              <EmptyState title={t('step.failed', { step: t(`step.${wizard.step}.title`) })} description={t(model.month.problem)} action={<Button size="sm" onClick={() => actions?.onRetryMonth?.()}>{t('common.retry')}</Button>} />
            </Card>
          )}
          {wizard.step === 'period' && month && <StepPeriod model={model} month={month} actions={actions} />}
          {wizard.step === 'checks' && month && <StepChecks model={model} month={month} actions={actions} />}
          {wizard.step === 'mapping' && <MappingStep model={model} wizard={wizard} actions={actions} />}
          {wizard.step === 'preview' && month && <PreviewStep model={model} wizard={wizard} month={month} actions={actions} />}
          {wizard.step === 'send' && month && <SendStep model={model} wizard={wizard} month={month} actions={actions} />}
        </div>
        {wizard.step !== 'preview' && wizard.step !== 'mapping' && <Aside model={model} month={month} />}
      </div>
      <div className="fw-pay-foot" role="group" aria-label={t('wizard.nav')}>
        <Button size="sm" onClick={() => actions?.onBack?.()} heldReason={index === 0 ? t('held.firstStep') : null} aria-keyshortcuts="Alt+ArrowLeft">
          <ArrowLeft size={13} aria-hidden /> {t('wizard.back')}
        </Button>
        <Button size="sm" variant="quiet" onClick={() => actions?.onLeave?.()}>
          {t('wizard.leave')}
        </Button>
        <span className="fw-pp-grow" />
        {held && (
          <span className="fw-pp-hint" role="status">
            {said(held)}
          </span>
        )}
        {last ? (
          <Button size="sm" variant="primary" onClick={() => actions?.onLeave?.()}>
            <CheckMark size={13} aria-hidden /> {t('wizard.done')}
          </Button>
        ) : (
          <Button size="sm" variant="primary" heldReason={held ? said(held) : null} onClick={() => actions?.onContinue?.()} aria-keyshortcuts="Meta+Enter Control+Enter Alt+ArrowRight">
            {t('wizard.continue')} <ArrowRight size={13} aria-hidden />
          </Button>
        )}
      </div>
      <p className="nds-vh" role="status" aria-live="polite">
        {said(wizard.heldNote)}
      </p>
    </section>
  )
}

// ---- 1 · Period and company ----------------------------------------------------------------------------------------------------

function StepPeriod({ model, month, actions }: { model: PayrollModel; month: PayrollMonth; actions?: PayrollActions | undefined }) {
  const t = usePayrollWords()
  const locale = useLocale()
  const closed = month.close.state === 'CLOSED'
  const attendance = placeOf('ATTENDANCE', model.prefix, month.month, model.pages)
  const label = monthWords(month.month, locale)
  // The company's payroll code (People settings › Payroll and statements); none: the company's own code.
  const code = month.company.payrollCode ?? month.company.code
  return (
    <Card padded className="fw-pay-card">
      <h3 className="fw-pp-h3">{t('step.period.title')}</h3>
      <p className="fw-pp-hint">{t('step.period.lead')}</p>
      <LayoutWarning layout={model.layout} />
      <div className="fw-pp-form">
        <KeyValue
          dense
          items={[
            { label: t('period.company'), value: `${month.company.code} · ${month.company.legalName}` },
            { label: t('period.companyCode'), value: code, hint: t('period.companyCodeHint') },
          ]}
        />
        <div className="fw-pp-stack tight">
          <span className="fw-pp-h3" id="fw-pay-month">
            {t('period.month')}
          </span>
          <Listbox
            aria-describedby="fw-pay-month"
            ariaLabel={t('period.month')}
            value={month.month}
            options={monthChoices(model.today, month.month).map((value) => ({ value, label: monthWords(value, locale) }))}
            onChange={(value) => actions?.onMonth?.(value)}
          />
        </div>
      </div>
      <div className="fw-pp-stack tight">
        <h4 className="fw-pp-h3">{t('period.close')}</h4>
        {closed ? (
          <span>
            <Pill tone="success" dot>
              {t('period.closed', { month: label })}
            </Pill>
          </span>
        ) : (
          <Banner tone="warning" title={t('period.notClosed', { month: label })}>
            {attendance.kind === 'page' ? (
              <Link className="fw-pp-link" href={attendance.href}>
                {t('period.closeIt')}
              </Link>
            ) : (
              t('period.closeLater')
            )}
          </Banner>
        )}
      </div>
      <div className="fw-pp-stack tight">
        <h4 className="fw-pp-h3">{t('period.sites')}</h4>
        <ul className="fw-pay-sites" aria-label={t('period.sites')}>
          {month.sites.map((site) => (
            <li key={site.siteId}>
              <span>{`${site.code} · ${site.name}`}</span>
              <Tag tone={site.gateOpen ? 'success' : 'warning'}>{t(site.gateOpen ? 'period.gateOn' : 'period.gateOff')}</Tag>
            </li>
          ))}
        </ul>
        <p className="fw-pp-hint">{t('period.wholeCompany')}</p>
      </div>
      <p className="fw-pp-hint">{month.latest ? t('period.correction', { version: month.latest.revision, month: label }) : t('period.first', { month: label })}</p>
      <NotPayroll />
    </Card>
  )
}

// ---- 2 · Checks ---------------------------------------------------------------------------------------------------------------

function CheckFix({ model, month, check, actions }: { model: PayrollModel; month: PayrollMonth; check: Check; actions?: PayrollActions | undefined }) {
  const t = usePayrollWords()
  const kind = showKindOf(check.code)
  const place = placeOf(check.place, model.prefix, month.month, model.pages)
  return (
    <span className="fw-pp-row">
      {kind !== 'place' && (
        <Button size="sm" onClick={() => actions?.onShow?.(check)} heldReason={model.can.records ? null : t('held.noRecords')}>
          {t('wizard.showMe')}
        </Button>
      )}
      {place.kind === 'page' && (
        <Button asChild size="sm" variant="quiet">
          <Link href={place.href} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={13} aria-hidden /> {t(place.words)}
          </Link>
        </Button>
      )}
      {place.kind === 'step' && (
        <Button size="sm" variant="quiet" onClick={() => actions?.onStep?.(place.step)}>
          {t(place.words)}
        </Button>
      )}
      {place.kind === 'notBuilt' && <span className="fw-pp-hint">{t('place.notBuilt', { place: t(place.words) })}</span>}
    </span>
  )
}

function StepChecks({ model, month, actions }: { model: PayrollModel; month: PayrollMonth; actions?: PayrollActions | undefined }) {
  const t = usePayrollWords()
  const said = useSaid()
  const locale = useLocale()
  const ds = useDsWords()
  const checks = orderedChecks(month.checks)
  const warnings = checks.filter((check) => !check.blocking && !check.passed).length
  return (
    <Card padded className="fw-pay-card">
      <div className="fw-pay-section-head">
        <h3 className="fw-pp-h3">{t('step.checks.title')}</h3>
        <span className="fw-pp-hint">{t('checks.counts', { blocking: month.blocking, warnings })}</span>
      </div>
      <p className="fw-pp-hint">{t('step.checks.lead')}</p>
      <LayoutWarning layout={model.layout} />
      <CheckList
        label={t('step.checks.title')}
        labels={ds.checkList}
        checks={checks.map((check) => {
          const words = checkWords(check, month.month, locale)
          return {
            id: check.code,
            state: checkState(check),
            name: t(words.name),
            detail: said(words.detail),
            ...(check.passed ? {} : { fix: <CheckFix model={model} month={month} check={check} actions={actions} /> }),
          }
        })}
      />
      <p className="fw-pp-hint">{t('checks.recorded')}</p>
    </Card>
  )
}

// ---- This export ---------------------------------------------------------------------------------------------------------------

function Aside({ model, month }: { model: PayrollModel; month: PayrollMonth | null }) {
  const t = usePayrollWords()
  const locale = useLocale()
  const warnings = month ? month.checks.filter((check) => !check.blocking && !check.passed).length : 0
  return (
    <aside aria-label={t('aside.title')}>
      <Card padded className="fw-pay-card">
        <h3 className="fw-pp-h3">{t('aside.title')}</h3>
        <KeyValue
          dense
          items={[
            { label: t('aside.month'), value: month ? monthWords(month.month, locale) : '—' },
            {
              label: t('aside.format'),
              value: model.layout ? (
                <span className="fw-pp-row">
                  {model.layout.name} <LayoutTag layout={model.layout} />
                </span>
              ) : (
                t('aside.noFormat')
              ),
            },
            { label: t('aside.version'), value: month ? `v${month.state === 'EXPORTED' ? (month.latest?.revision ?? 1) : nextRevision(month)}` : '—', hint: month?.state === 'CORRECTION_PENDING' ? t('aside.versionHint', { version: month.latest?.revision ?? 1 }) : undefined },
            { label: t('aside.people'), value: month ? String(month.people) : '—', hint: t('aside.peopleHint') },
            { label: t('aside.checks'), value: month ? t('checks.counts', { blocking: month.blocking, warnings }) : '—' },
          ]}
        />
        {!model.can.manage && <p className="fw-pp-hint">{t('held.noManage')}</p>}
      </Card>
    </aside>
  )
}
