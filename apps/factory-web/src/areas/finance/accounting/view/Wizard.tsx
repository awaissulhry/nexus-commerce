'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Download, ExternalLink, FileSpreadsheet } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, MetricStrip, Stepper, SummaryTable } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, CheckboxCard, Pill, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { FileRow, JobProgress, Textarea } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { CheckList } from '../../_shared/parts'
import { ACCOUNTING_PACKAGES, MAX_EXPLANATION, PACKAGE_RULES, type Check, type IntrastatRow, type PackageSum, type PeriodAnswer } from '../api'
import {
  batchPackages,
  changesOf,
  checkPhrase,
  checksOf,
  continueHeld,
  contentOf,
  exportHeld,
  fieldLabel,
  fileHeld,
  filesHref,
  fixLabel,
  lockStateOf,
  monthWords,
  packageHeld,
  showMeStep,
  stepsFor,
  unexplainedOf,
  type AccountingCan,
  type WizardFacts,
  type WizardStep,
} from '../model'
import type { AccountingActions, AccountingModel, WizardModel } from '../view-model'
import { LockPanel } from './LockPanel'

/** A business day as an instant at noon UTC, so it formats as the same day in Rome. */
const dayInstant = (day: string): string => `${day}T12:00:00Z`

const factsOf = (wizard: WizardModel, can: AccountingCan): WizardFacts => ({ month: wizard.month, answer: wizard.period.value, problem: wizard.period.problem, chosen: wizard.chosen, explanations: wizard.explanations, can })

const explanationId = (code: string) => `fw-fac-explain-${code}`

/**
 * The export wizard (design finance.accounting, archetype wizard; anatomy §2.6): the steps in order — 1 · Period, 2 ·
 * Checks, 3 · Contents, Intrastat rows (when Intrastat goes in), 4 · Review, 5 · Export and lock — on the DS Stepper
 * (a finished step can be opened again), one step at a time with "This export" beside it on wide screens, and Back /
 * Continue at the foot. Continue is never greyed out: it is held with the count of what holds it, "Show me" opens the
 * first, and ⌘↵ says the reason when it is held (⇧⌘↵ goes back). A live change behind a check shows "N checks fixed
 * since you opened this · Check again". Every amount by its grain; nothing is sent to the accountant or any authority.
 */
export function Wizard({ model, wizard, actions }: { model: AccountingModel; wizard: WizardModel; actions?: AccountingActions }) {
  const t = useT('finance-accounting')
  const locale = useLocale()
  const facts = factsOf(wizard, model.can)
  const steps = stepsFor(wizard.chosen)
  const index = Math.max(0, steps.indexOf(wizard.step))
  const held = continueHeld(wizard.step, facts)
  const showMe = held ? showMeStep(wizard.step, facts) : null
  const last = index === steps.length - 1

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      event.preventDefault()
      if (event.shiftKey) actions?.onBack?.()
      else actions?.onContinue?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions])

  const goShowMe = () => {
    if (!showMe) return
    actions?.onShowMe?.()
    setTimeout(() => {
      const first = wizard.period.value && wizard.chosen ? unexplainedOf(checksOf(wizard.period.value, wizard.chosen), wizard.explanations)[0] : undefined
      if (first) document.getElementById(explanationId(first.code))?.focus()
    }, 60)
  }

  return (
    <section className="fw-fac-wizard" aria-labelledby="fw-fac-wizard-title">
      <div className="fw-fac-section-head">
        <h2 className="fw-fac-h2" id="fw-fac-wizard-title">
          {wizard.month ? t('wizard.titleMonth', { month: monthWords(wizard.month, locale) }) : t('wizard.title')}
        </h2>
        <span className="fw-fac-muted">{t('wizard.stepOf', { step: index + 1, count: steps.length, name: t(`step.${wizard.step}.title`) })}</span>
      </div>
      <div className="fw-fac-stepper">
        <Stepper
          steps={steps.map((step) => ({ key: step, label: t(`step.${step}.title`) }))}
          current={index}
          onSelect={(_, step) => actions?.onStep?.(step.key as WizardStep)}
        />
      </div>
      {wizard.pending && (
        <Banner
          tone="info"
          title={wizard.pending.fixed.length > 0 ? t('live.fixed', { count: wizard.pending.fixed.length }) : t('live.changed')}
          action={
            <Button size="sm" onClick={() => actions?.onCheckAgain?.()}>
              {t('live.checkAgain')}
            </Button>
          }
        />
      )}
      <div className={wizard.step === 'intrastat' ? 'fw-fac-wizard-body is-wide' : 'fw-fac-wizard-body'}>
        <div className="fw-fac-wizard-main">
          {wizard.step === 'period' && <StepPeriod model={model} wizard={wizard} actions={actions} />}
          {wizard.step !== 'period' && <PeriodState wizard={wizard} actions={actions} />}
          {wizard.step === 'checks' && wizard.period.value && wizard.chosen && <StepChecks model={model} wizard={wizard} answer={wizard.period.value} actions={actions} />}
          {wizard.step === 'contents' && wizard.period.value && wizard.chosen && <StepContents model={model} wizard={wizard} answer={wizard.period.value} actions={actions} />}
          {wizard.step === 'intrastat' && wizard.period.value && wizard.chosen && <StepIntrastat model={model} wizard={wizard} answer={wizard.period.value} actions={actions} />}
          {wizard.step === 'review' && wizard.period.value && wizard.chosen && <StepReview model={model} wizard={wizard} answer={wizard.period.value} />}
          {wizard.step === 'export' && wizard.period.value && wizard.chosen && <StepExport model={model} wizard={wizard} answer={wizard.period.value} actions={actions} />}
        </div>
        <Aside model={model} wizard={wizard} />
      </div>
      <div className="fw-fac-wizard-foot" role="group" aria-label={t('wizard.nav')}>
        <Button size="sm" onClick={() => actions?.onBack?.()} heldReason={index === 0 ? t('held.firstStep') : undefined} aria-keyshortcuts="Shift+Meta+Enter Shift+Control+Enter">
          <ArrowLeft size={13} aria-hidden /> {t('wizard.back')}
        </Button>
        <span className="grow" />
        {held && (
          <span className="fw-fac-muted" role="status">
            {t(held.key, held.params)}
          </span>
        )}
        {held && showMe && (
          <Button size="sm" variant="quiet" onClick={goShowMe}>
            {t('wizard.showMe')}
          </Button>
        )}
        {!last && (
          <Button size="sm" variant="primary" heldReason={held ? t(held.key, held.params) : undefined} onClick={() => actions?.onContinue?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('wizard.continue')} <ArrowRight size={13} aria-hidden />
          </Button>
        )}
      </div>
      <p className="nds-vh" role="status" aria-live="polite">
        {wizard.heldNote ? t(wizard.heldNote.key, wizard.heldNote.params) : ''}
      </p>
    </section>
  )
}

/** The month's read, on every step after the first: reading, failed (Try again), or a re-export's note. */
function PeriodState({ wizard, actions }: { wizard: WizardModel; actions?: AccountingActions }) {
  const t = useT('finance-accounting')
  if (wizard.period.problem) {
    return (
      <Card padded>
        <EmptyState title={t('step.failed', { step: t(`step.${wizard.step}.title`) })} description={t(wizard.period.problem)} action={<Button size="sm" onClick={() => actions?.onRetryPeriod?.()}>{t('common.retry')}</Button>} />
      </Card>
    )
  }
  if (!wizard.period.value || !wizard.chosen) {
    return (
      <Card padded aria-busy="true">
        <p className="fw-fac-muted" role="status">
          <Spinner size={12} /> {t('step.reading', { step: t(`step.${wizard.step}.title`) })}
        </p>
      </Card>
    )
  }
  return null
}

// ---- 1 · Period -------------------------------------------------------------------------------------------------------------

function StepPeriod({ model, wizard, actions }: { model: AccountingModel; wizard: WizardModel; actions?: AccountingActions }) {
  const t = useT('finance-accounting')
  const locale = useLocale()
  const today = model.today
  const thisYear = Number(today.slice(0, 4))
  const months = wizard.periods.value?.months.filter((entry) => entry.period.month <= today.slice(0, 7)) ?? []
  const answer = wizard.period.value
  return (
    <Card padded className="fw-fac-card">
      <div className="fw-fac-card-head">
        <h3 className="fw-fac-h3">{t('step.period.title')}</h3>
        <span className="fw-fac-inline">
          <Button size="sm" variant="quiet" aria-label={t('period.previousYear')} onClick={() => actions?.onPeriodYear?.(wizard.year - 1)}>
            <ChevronLeft size={14} aria-hidden />
          </Button>
          <span className="fw-fac-strong">{String(wizard.year)}</span>
          <Button size="sm" variant="quiet" aria-label={t('period.nextYear')} heldReason={wizard.year >= thisYear ? t('period.noNextYear') : undefined} onClick={() => actions?.onPeriodYear?.(wizard.year + 1)}>
            <ChevronRight size={14} aria-hidden />
          </Button>
        </span>
      </div>
      <p className="fw-fac-muted">{t('step.period.lead')}</p>
      {wizard.periods.problem ? (
        <EmptyState title={t('step.failed', { step: t('step.period.title') })} description={t(wizard.periods.problem)} action={<Button size="sm" onClick={() => actions?.onRetryPeriods?.()}>{t('common.retry')}</Button>} />
      ) : !wizard.periods.value ? (
        <p className="fw-fac-muted" role="status">
          <Spinner size={12} /> {t('step.reading', { step: t('step.period.title') })}
        </p>
      ) : (
        <div className="fw-fac-months" role="radiogroup" aria-label={t('period.months', { year: wizard.year })}>
          {[...months].reverse().map((entry) => {
            const state = lockStateOf(entry.lock)
            const exported = entry.exports.filter((row) => row.status === 'EXPORTED').map((row) => row.number ?? '—')
            const first = exported.length > 0 ? t('period.exported', { numbers: exported.join(', ') }) : entry.ended ? t('period.notExported') : t('period.notOver')
            return (
              <RadioCard
                key={entry.period.month}
                name="fw-fac-month"
                title={monthWords(entry.period.month, locale)}
                description={`${first} · ${t(`lockState.${state}`)}`}
                checked={wizard.month === entry.period.month}
                selected={wizard.month === entry.period.month}
                onChange={() => actions?.onMonth?.(entry.period.month)}
              />
            )
          })}
        </div>
      )}
      {wizard.month && (
        <div className="fw-fac-period-note">
          {wizard.period.problem ? (
            <Banner tone="danger" title={t('step.failed', { step: t('step.period.title') })}>
              {t(wizard.period.problem)}
            </Banner>
          ) : !answer ? (
            <p className="fw-fac-muted" role="status">
              <Spinner size={12} /> {t('period.readingMonth', { month: monthWords(wizard.month, locale) })}
            </p>
          ) : (
            <MonthWords answer={answer} />
          )}
        </div>
      )}
    </Card>
  )
}

/** The chosen month in words: first export or re-export, the open draft it replaces, its lock. */
function MonthWords({ answer }: { answer: PeriodAnswer }) {
  const t = useT('finance-accounting')
  const locale = useLocale()
  const month = monthWords(answer.period.month, locale)
  const state = lockStateOf(answer.lock)
  return (
    <div className="fw-fac-stack">
      <p className="fw-fac-muted">{answer.reExportOf ? t('period.reExport', { month, number: answer.reExportOf.number ?? '—', count: answer.changes }) : t('period.first', { month })}</p>
      {!answer.ended && <p className="fw-fac-muted">{t('period.running', { end: formatDate(dayInstant(answer.period.end), { locale }) })}</p>}
      {answer.draft && <p className="fw-fac-muted">{t('period.draft')}</p>}
      <p className="fw-fac-muted">{t(`lock.short.${state}`, { month })}</p>
      {answer.yearEnd && <p className="fw-fac-muted">{t('period.yearEnd')}</p>}
    </div>
  )
}

// ---- 2 · Checks --------------------------------------------------------------------------------------------------------------

function CheckRows({ checks, answer, wizard, model, actions }: { checks: readonly Check[]; answer: PeriodAnswer; wizard: WizardModel; model: AccountingModel; actions?: AccountingActions }) {
  const t = useT('finance-accounting')
  const locale = useLocale()
  const end = formatDate(dayInstant(answer.period.end), { locale })
  return (
    <CheckList
      label={t('step.checks.title')}
      items={checks.map((check) => {
        const sentence = checkPhrase(check, answer.period.month, end, locale)
        return {
          id: check.code,
          ok: check.passed,
          words: (
            <span className="fw-fac-stack">
              <b>{t(`check.${check.code}.title`)}</b>
              <span>{t(sentence.key, sentence.params)}</span>
            </span>
          ),
          fix: check.passed ? undefined : (
            <div className="fw-fac-check-fix">
              {check.fixes.length > 0 && (
                <ul className="fw-fac-fixes" aria-label={t('check.fixesLabel', { check: t(`check.${check.code}.title`) })}>
                  {check.fixes.map((fix) => {
                    const label = fixLabel(fix)
                    const field = fieldLabel(fix.field)
                    return (
                      <li key={`${fix.recordType}|${fix.recordId}|${fix.field ?? ''}`}>
                        <Link className="fw-fac-link" href={`${model.prefix}${recordAddress({ type: fix.recordType, id: fix.recordId, label: fix.number ?? undefined }, OFFICE_PAGES)}`} target="_blank" rel="noopener noreferrer">
                          {t(label.key, label.params)}
                        </Link>
                        {field && <span className="fw-fac-muted">{` · ${t(field.key)}`}</span>}
                      </li>
                    )
                  })}
                  {check.count > check.fixes.length && <li className="fw-fac-muted">{t('check.moreFixes', { count: check.count - check.fixes.length })}</li>}
                </ul>
              )}
              <Field label={t('check.explain')} hint={t('check.explainHint')}>
                <Textarea
                  id={explanationId(check.code)}
                  value={wizard.explanations[check.code] ?? ''}
                  limit={MAX_EXPLANATION}
                  rows={2}
                  readOnly={!model.can.export}
                  onChange={(event) => actions?.onExplain?.(check.code, event.target.value)}
                />
              </Field>
            </div>
          ),
        }
      })}
    />
  )
}

function StepChecks({ model, wizard, answer, actions }: { model: AccountingModel; wizard: WizardModel; answer: PeriodAnswer; actions?: AccountingActions }) {
  const t = useT('finance-accounting')
  const checks = checksOf(answer, wizard.chosen ?? [])
  const failing = checks.filter((check) => !check.passed).length
  const unexplained = unexplainedOf(checks, wizard.explanations).length
  return (
    <Card padded className="fw-fac-card">
      <div className="fw-fac-card-head">
        <h3 className="fw-fac-h3">{t('step.checks.title')}</h3>
        <span className="fw-fac-muted">{failing === 0 ? t('checks.allPass', { count: checks.length }) : t('checks.failing', { count: failing, unexplained })}</span>
      </div>
      <p className="fw-fac-muted">{t('step.checks.lead')}</p>
      {!model.can.export && <p className="fw-fac-muted">{t('held.noExport')}</p>}
      <CheckRows checks={checks} answer={answer} wizard={wizard} model={model} actions={actions} />
      <p className="fw-fac-muted">{t('checks.w2b')}</p>
    </Card>
  )
}

// ---- 3 · Contents ------------------------------------------------------------------------------------------------------------

/** A package's sums in words, by its grain (absent amounts are not drawn). */
function sumsText(sums: readonly PackageSum[], t: ReturnType<typeof useT>, locale: ReturnType<typeof useLocale>): string {
  return sums
    .filter((sum) => typeof sum.amount === 'number')
    .map((sum) => `${t(`sum.${sum.key}`)} ${moneyOf(sum.amount!, sum.currency, locale)}`)
    .join(' · ')
}

function moneyOf(minor: number, currency: string | null, locale: string): string {
  const options: Intl.NumberFormatOptions = currency ? { style: 'currency', currency } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', options).format(minor / 100)
}

function StepContents({ model, wizard, answer, actions }: { model: AccountingModel; wizard: WizardModel; answer: PeriodAnswer; actions?: AccountingActions }) {
  const t = useT('finance-accounting')
  const locale = useLocale()
  const chosen = wizard.chosen ?? []
  return (
    <Card padded className="fw-fac-card">
      <h3 className="fw-fac-h3">{t('step.contents.title')}</h3>
      <p className="fw-fac-muted">{t('step.contents.lead')}</p>
      <div className="fw-fac-cards fw-fac-cards--wide">
        {ACCOUNTING_PACKAGES.map((pkg) => {
          const held = packageHeld(pkg, { yearEnd: answer.yearEnd }, model.can)
          const content = contentOf(answer, pkg)
          const facts = content ? [t('contents.documents', { count: content.documents.documents }), t('contents.rows', { count: content.rows }), sumsText([...content.priceTotals, ...content.costTotals], t, locale)].filter(Boolean).join(' · ') : null
          const description = (
            <span className="fw-fac-stack">
              <span>{t(`package.${pkg}.body`)}</span>
              {held ? <span className="fw-fac-held">{t(held.key)}</span> : facts ? <span>{facts}</span> : null}
              {!held && answer.reExportOf && content && <span>{t(PACKAGE_RULES[pkg].scope === 'WHOLE' ? 'contents.reWhole' : 'contents.reDocuments', { count: changesOf(content) })}</span>}
              {pkg === 'INTRASTAT' && !held && <span>{t('contents.intrastatAccountant')}</span>}
            </span>
          )
          return (
            <CheckboxCard
              key={pkg}
              title={t(`package.${pkg}.title`)}
              description={description}
              checked={!held && chosen.includes(pkg)}
              selected={!held && chosen.includes(pkg)}
              aria-disabled={held || !model.can.export ? true : undefined}
              onChange={() => {
                if (!held && model.can.export) actions?.onTogglePackage?.(pkg)
              }}
            />
          )
        })}
      </div>
    </Card>
  )
}

// ---- Intrastat rows ------------------------------------------------------------------------------------------------------------

function StepIntrastat({ model, wizard, answer, actions }: { model: AccountingModel; wizard: WizardModel; answer: PeriodAnswer; actions?: AccountingActions }) {
  const t = useT('finance-accounting')
  const locale = useLocale()
  const intrastat = wizard.intrastat.value
  const check = checksOf(answer, wizard.chosen ?? []).find((entry) => entry.code === 'INTRASTAT_COMPLETE') ?? null
  const columns: ColDef<IntrastatRow>[] = [
    {
      colId: 'invoice',
      headerName: t('intrastat.col.invoice'),
      minWidth: 150,
      flex: 1,
      cellRenderer: ({ data }: ICellRendererParams<IntrastatRow>) =>
        data ? (
          <span className="fw-fac-cell">
            <Link className="fw-fac-link" href={`${model.prefix}${recordAddress({ type: 'Invoice', id: data.invoice.id }, OFFICE_PAGES)}`} target="_blank" rel="noopener noreferrer">
              {data.invoice.number}
            </Link>
            <span className="fw-fac-cell-sub">{t('intrastat.line', { seq: data.line.seq, nature: t(`intrastat.nature.${data.nature}`), code: data.suggestedNatureCode })}</span>
          </span>
        ) : null,
    },
    {
      colId: 'partner',
      headerName: t('intrastat.col.partner'),
      minWidth: 170,
      flex: 1.2,
      cellRenderer: ({ data }: ICellRendererParams<IntrastatRow>) =>
        data ? (
          <span className="fw-fac-cell">
            <span className="fw-fac-ellipsis">{`${data.partner.code} · ${data.partner.name}`}</span>
            <span className="fw-fac-cell-sub">{data.partnerVatId ?? t('intrastat.noVat')}</span>
          </span>
        ) : null,
    },
    {
      colId: 'goods',
      headerName: t('intrastat.col.goods'),
      minWidth: 170,
      flex: 1.1,
      cellRenderer: ({ data }: ICellRendererParams<IntrastatRow>) =>
        data ? (
          <span className="fw-fac-cell">
            <span>{data.cnCode ? t('intrastat.cn', { code: data.cnCode }) : t('intrastat.noCn')}</span>
            <span className="fw-fac-cell-sub">{[data.style?.code, data.originCountry ? t('intrastat.origin', { country: data.originCountry }) : t('intrastat.noOrigin')].filter(Boolean).join(' · ')}</span>
          </span>
        ) : null,
    },
    {
      colId: 'to',
      headerName: t('intrastat.col.to'),
      minWidth: 130,
      flex: 0.8,
      cellRenderer: ({ data }: ICellRendererParams<IntrastatRow>) =>
        data ? (
          <span className="fw-fac-cell">
            <span>{data.destinationCountry ?? '—'}</span>
            <span className="fw-fac-cell-sub">{[data.deliveryTerms ?? t('intrastat.noTerms'), data.transportMode ?? t('intrastat.noTransport')].join(' · ')}</span>
          </span>
        ) : null,
    },
    {
      colId: 'quantity',
      headerName: t('intrastat.col.quantity'),
      minWidth: 130,
      flex: 0.8,
      type: 'rightAligned',
      cellRenderer: ({ data }: ICellRendererParams<IntrastatRow>) =>
        data ? (
          <span className="fw-fac-cell">
            <span>{data.netMassKg ? t('intrastat.mass', { kg: data.netMassKg }) : t('intrastat.noMass')}</span>
            <span className="fw-fac-cell-sub">{t('intrastat.units', { units: data.supplementaryUnits })}</span>
          </span>
        ) : null,
    },
    ...(model.can.price
      ? [
          {
            colId: 'value',
            headerName: t('intrastat.col.value'),
            minWidth: 110,
            flex: 0.7,
            type: 'rightAligned',
            cellRenderer: ({ data }: ICellRendererParams<IntrastatRow>) => (data ? <span className="fw-fac-num">{typeof data.value === 'number' ? moneyOf(data.value, data.currency, locale) : '—'}</span> : null),
          } satisfies ColDef<IntrastatRow>,
        ]
      : []),
    {
      colId: 'flags',
      headerName: t('intrastat.col.flags'),
      minWidth: 220,
      flex: 1.4,
      cellRenderer: ({ data }: ICellRendererParams<IntrastatRow>) => {
        if (!data) return null
        const blocking = data.flags.filter((flag) => flag.severity === 'BLOCKING')
        const warnings = data.flags.filter((flag) => flag.severity === 'WARNING')
        const fixes = new Map<string, { recordType: string; recordId: string; fields: string[] }>()
        for (const flag of data.flags) {
          if (!flag.fix) continue
          const key = `${flag.fix.recordType}|${flag.fix.recordId}`
          const entry = fixes.get(key) ?? { recordType: flag.fix.recordType, recordId: flag.fix.recordId, fields: [] }
          if (flag.fix.field) entry.fields.push(flag.fix.field)
          fixes.set(key, entry)
        }
        return (
          <span className="fw-fac-cell">
            <span className="fw-fac-inline">
              {blocking.length === 0 && warnings.length === 0 && <Pill tone="success">{t('intrastat.complete')}</Pill>}
              {blocking.length > 0 && <Pill tone="danger">{t('intrastat.blocking', { count: blocking.length })}</Pill>}
              {warnings.length > 0 && <Pill tone="warning">{t('intrastat.warnings', { count: warnings.length })}</Pill>}
              <span className="fw-fac-ellipsis">{data.flags.map((flag) => t(`flag.${flag.code}`)).join(' · ')}</span>
            </span>
            <span className="fw-fac-cell-links">
              {[...fixes.values()].map((fix) => {
                const number = fix.recordType === 'Style' ? (data.style?.code ?? '') : fix.recordType === 'Party' ? data.partner.code : data.invoice.number
                const label = fixLabel({ recordType: fix.recordType, number })
                return (
                  <Link key={`${fix.recordType}|${fix.recordId}`} className="fw-fac-link fw-fac-fix-link" href={`${model.prefix}${recordAddress({ type: fix.recordType, id: fix.recordId, label: number }, OFFICE_PAGES)}`} target="_blank" rel="noopener noreferrer">
                    {t('intrastat.fixIn', { record: t(label.key, label.params) })}
                  </Link>
                )
              })}
            </span>
          </span>
        )
      },
    },
  ]
  const state = wizard.intrastat.problem ? (
    <EmptyState title={t('step.failed', { step: t('step.intrastat.title') })} description={t(wizard.intrastat.problem)} action={<Button size="sm" onClick={() => actions?.onRetryIntrastat?.()}>{t('common.retry')}</Button>} />
  ) : intrastat && intrastat.rows.length === 0 ? (
    <EmptyState title={t('intrastat.empty.title', { month: monthWords(answer.period.month, locale) })} description={t('intrastat.empty.body')} />
  ) : undefined
  return (
    <Card padded className="fw-fac-card">
      <div className="fw-fac-card-head">
        <h3 className="fw-fac-h3">{t('step.intrastat.title')}</h3>
        {intrastat && (
          <span className="fw-fac-muted">
            {[t('intrastat.sumRows', { count: intrastat.rows.length }), t('intrastat.sumFileRows', { count: intrastat.fileRows.length }), t('intrastat.blocking', { count: intrastat.blocking }), t('intrastat.warnings', { count: intrastat.warnings })].join(' · ')}
          </span>
        )}
      </div>
      <p className="fw-fac-muted">{t('step.intrastat.lead')}</p>
      <Banner tone="warning" title={t('intrastat.accountant')} />
      <ListFrame<IntrastatRow>
        label={t('step.intrastat.title')}
        rows={state ? [] : (intrastat?.rows ?? null)}
        rowId={(row) => row.line.id}
        columns={columns}
        count={intrastat ? t('intrastat.count', { count: intrastat.rows.length }) : '—'}
        listKey={null}
        state={state}
      />
      {check && !check.passed && <CheckRows checks={[check]} answer={answer} wizard={wizard} model={model} actions={actions} />}
    </Card>
  )
}

// ---- 4 · Review -----------------------------------------------------------------------------------------------------------------

function StepReview({ model, wizard, answer }: { model: AccountingModel; wizard: WizardModel; answer: PeriodAnswer }) {
  const t = useT('finance-accounting')
  const locale = useLocale()
  const chosen = wizard.chosen ?? []
  const going = batchPackages(answer, chosen)
  const contents = chosen.map((pkg) => contentOf(answer, pkg)).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  const sum = (key: 'new' | 'changed' | 'removed' | 'same') => contents.reduce((total, entry) => total + entry.documents[key], 0)
  const checks = checksOf(answer, chosen)
  const explainedCount = checks.filter((check) => !check.passed && (wizard.explanations[check.code]?.trim() ?? '') !== '').length
  return (
    <Card padded className="fw-fac-card">
      <h3 className="fw-fac-h3">{t('step.review.title')}</h3>
      <p className="fw-fac-muted">{answer.reExportOf ? t('review.reExport', { number: answer.reExportOf.number ?? '—' }) : t('review.first')}</p>
      <MetricStrip
        metrics={[
          { label: t('review.new'), value: String(sum('new')), hint: t('review.newHint') },
          { label: t('review.changed'), value: String(sum('changed')), hint: t('review.changedHint') },
          { label: t('review.removed'), value: String(sum('removed')), hint: t('review.removedHint') },
          { label: t('review.same'), value: String(sum('same')), hint: t('review.sameHint') },
        ]}
      />
      <SummaryTable
        label={t('step.review.title')}
        stackOnPhone
        columns={[t('review.col.package'), t('review.col.documents'), t('review.col.new'), t('review.col.changed'), t('review.col.removed'), t('review.col.same'), t('review.col.rows'), t('review.col.totals')]}
        align={[undefined, 'right', 'right', 'right', 'right', 'right', 'right', 'right']}
        widths={['22%', '10%', '8%', '9%', '9%', '11%', '9%', undefined]}
        rows={chosen.map((pkg) => {
          const content = contentOf(answer, pkg)
          const goes = going.includes(pkg)
          return {
            id: pkg,
            cells: [
              <span key="p" className="fw-fac-stack">
                <span>{t(`package.${pkg}.title`)}</span>
                <span className="fw-fac-muted">{goes ? t(PACKAGE_RULES[pkg].scope === 'WHOLE' && answer.reExportOf ? 'review.goesWhole' : 'review.goes') : t('review.leftOut')}</span>
              </span>,
              String(content?.documents.documents ?? 0),
              String(content?.documents.new ?? 0),
              String(content?.documents.changed ?? 0),
              String(content?.documents.removed ?? 0),
              String(content?.documents.same ?? 0),
              String(content?.rows ?? 0),
              content ? sumsText([...content.priceTotals, ...content.costTotals], t, locale) || t('review.noTotals') : '—',
            ],
          }
        })}
      />
      <p className="fw-fac-muted">{t('review.checks', { count: checks.length, failing: checks.filter((check) => !check.passed).length, explained: explainedCount })}</p>
      {!model.can.price || !model.can.cost ? <p className="fw-fac-muted">{t('review.grains')}</p> : null}
    </Card>
  )
}

// ---- 5 · Export and lock ---------------------------------------------------------------------------------------------------------

function StepExport({ model, wizard, answer, actions }: { model: AccountingModel; wizard: WizardModel; answer: PeriodAnswer; actions?: AccountingActions }) {
  const t = useT('finance-accounting')
  const locale = useLocale()
  const chosen = wizard.chosen ?? []
  const going = batchPackages(answer, chosen)
  const done = wizard.exporting.done
  const held = exportHeld({ ...factsOf(wizard, model.can), busy: wizard.exporting.busy })
  const month = monthWords(answer.period.month, locale)
  const nothingToSend = !!answer.reExportOf && going.length === 0
  const lockable = !!done || nothingToSend
  return (
    <div className="fw-fac-stack">
      <Card padded className="fw-fac-card">
        <h3 className="fw-fac-h3">{t('step.export.title')}</h3>
        {done ? (
          <>
            <Banner tone="success" title={t('export.done', { number: done.number ?? '—', month, count: done.files.length })}>
              {t('export.doneBody')}
            </Banner>
            <ul className="fw-fac-files" aria-label={t('export.filesLabel', { number: done.number ?? '—' })}>
              {done.files.map((file) => {
                const fileHold = fileHeld(file, model.can)
                return (
                  <li key={file.id} className="fw-fac-file">
                    <FileRow name={file.file.name} size={file.file.sizeBytes} status={t('files.status', { package: t(`package.${file.package}.title`), count: file.rowCount, format: file.format })} />
                    <Button size="sm" heldReason={fileHold ? t(fileHold.key) : undefined} onClick={() => actions?.onDownload?.(done.id, file)}>
                      <Download size={13} aria-hidden /> {t('files.download')}
                    </Button>
                  </li>
                )
              })}
            </ul>
            <Button asChild size="sm">
              <a href={filesHref(model.prefix, [done.id])} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={13} aria-hidden /> {t('export.openFiles')}
              </a>
            </Button>
          </>
        ) : nothingToSend ? (
          <Banner tone="info" title={t('export.nothing', { number: answer.reExportOf?.number ?? '—', month })}>
            {t('export.nothingBody')}
          </Banner>
        ) : (
          <>
            <KeyValue
              items={[
                { label: t('export.number'), value: answer.nextNumber ?? t('export.noSeries'), hint: answer.nextNumber ? t('export.numberHint') : undefined },
                { label: t('export.period'), value: month },
                { label: t('export.kind'), value: answer.reExportOf ? t('export.reExport', { number: answer.reExportOf.number ?? '—' }) : t('export.first') },
              ]}
            />
            <ul className="fw-fac-files" aria-label={t('export.willMake')}>
              {going.map((pkg) => {
                const content = contentOf(answer, pkg)
                return (
                  <li key={pkg} className="fw-fac-file">
                    <FileSpreadsheet size={16} aria-hidden className="fw-fac-file-icon" />
                    <span className="fw-fac-stack">
                      <span>{t(`package.${pkg}.title`)}</span>
                      <span className="fw-fac-muted">{t(pkg === 'YEAR_END_STOCK' ? 'export.fileYearEnd' : 'export.file', { count: content?.rows ?? 0 })}</span>
                    </span>
                  </li>
                )
              })}
            </ul>
            <div className="fw-fac-form">
              <Field label={t('export.language')} hint={t('export.languageHint')}>
                <Select value={wizard.language} onChange={(event) => actions?.onLanguage?.(event.target.value === 'en' ? 'en' : 'it')}>
                  <option value="it">{t('export.languageIt')}</option>
                  <option value="en">{t('export.languageEn')}</option>
                </Select>
              </Field>
              <Field label={t('export.note')}>
                <Textarea value={wizard.note} maxLength={1000} rows={2} onChange={(event) => actions?.onNote?.(event.target.value)} />
              </Field>
            </div>
            <p className="fw-fac-muted">{t('export.handOver')}</p>
            {wizard.exporting.problem && <Banner tone="danger" title={t(wizard.exporting.problem.key, wizard.exporting.problem.params)} />}
            {wizard.exporting.busy && <JobProgress label={t('export.making', { month })} startedAt={wizard.exporting.startedAt ?? undefined} detail={t('export.makingDetail')} />}
            <div className="fw-fac-actions">
              <Button size="sm" variant="primary" heldReason={held ? t(held.key, held.params) : undefined} onClick={() => actions?.onExport?.()}>
                {answer.nextNumber ? t('export.go', { month, number: answer.nextNumber }) : t('export.goNoNumber', { month })}
              </Button>
            </div>
          </>
        )}
      </Card>
      <Card padded className="fw-fac-card">
        <h3 className="fw-fac-h3">{t('lock.title', { month })}</h3>
        <p className="fw-fac-muted">{t('lock.lead')}</p>
        {lockable ? <LockPanel model={wizard.lock} can={model.can} actions={actions?.stepLock} /> : <p className="fw-fac-muted">{t('lock.afterExport')}</p>}
      </Card>
    </div>
  )
}

// ---- This export (the live side column) ---------------------------------------------------------------------------------------

function Aside({ model, wizard }: { model: AccountingModel; wizard: WizardModel }) {
  const t = useT('finance-accounting')
  const locale = useLocale()
  const answer = wizard.period.value
  const chosen = wizard.chosen ?? []
  const checks = answer ? checksOf(answer, chosen) : []
  const failing = checks.filter((check) => !check.passed).length
  const unexplained = answer ? unexplainedOf(checks, wizard.explanations).length : 0
  return (
    <aside className="fw-fac-aside" aria-label={t('aside.title')}>
      <Card padded className="fw-fac-card">
        <h3 className="fw-fac-h3">{t('aside.title')}</h3>
        <KeyValue
          dense
          items={[
            { label: t('aside.month'), value: wizard.month ? monthWords(wizard.month, locale) : t('aside.noMonth') },
            { label: t('aside.kind'), value: answer ? (answer.reExportOf ? t('export.reExport', { number: answer.reExportOf.number ?? '—' }) : t('export.first')) : '—' },
            { label: t('aside.packages'), value: answer ? (chosen.length > 0 ? chosen.map((pkg) => t(`package.${pkg}.title`)).join(', ') : t('aside.noPackages')) : '—' },
            { label: t('aside.checks'), value: answer ? (failing === 0 ? t('aside.checksPass') : t('aside.checksFail', { failing, unexplained })) : '—' },
            wizard.exporting.done ? { label: t('aside.batch'), value: wizard.exporting.done.number ?? '—' } : { label: t('aside.number'), value: answer?.nextNumber ?? '—' },
            { label: t('aside.lock'), value: answer ? t(`lockState.${lockStateOf(answer.lock)}`) : '—' },
          ]}
        />
        <p className="fw-fac-muted">{t('layout.short')}</p>
        {!model.can.export && <p className="fw-fac-muted">{t('held.noExport')}</p>}
      </Card>
    </aside>
  )
}
