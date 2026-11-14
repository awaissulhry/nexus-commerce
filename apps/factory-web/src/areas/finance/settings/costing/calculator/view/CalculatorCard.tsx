'use client'

import { useState } from 'react'
import { Calculator } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../../lib/i18n/ds-parts'
import { formatDate, formatNumber } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { CalcView, OverheadRuleView, PrefillView } from '../api'
import { applyProblems, calcDraftOf, calcProblems, costPerMinute, CPM_KINDS, CPM_NS, monthName, monthOptions, newHeld, overheadTwice, rowHeld, type CalcDraft, type CpmAbilities } from '../model'
import '../../../../_shared/finance.css'
import '../calculator.css'

type Read<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly problem: string }

export type CalcDialog = { readonly kind: 'new' } | { readonly kind: 'apply'; readonly calc: CalcView } | { readonly kind: 'remove'; readonly calc: CalcView }

export interface CalculatorModel {
  readonly can: CpmAbilities
  readonly today: string
  readonly currency: string | null
  readonly calcs: Read<readonly CalcView[]>
  readonly rules: Read<readonly OverheadRuleView[]>
  readonly dialog: CalcDialog | null
  /** The minutes read for the dialog's department and period. */
  readonly prefill: Read<PrefillView> | null
  readonly busy: boolean
  readonly problem: string | null
  readonly notice: { readonly key: string; readonly params?: Record<string, string | number> } | null
  /** Design cases: what the New calculation dialog starts with. */
  readonly draft?: Partial<CalcDraft>
}

export interface CalculatorActions {
  onDialog?: (dialog: CalcDialog | null) => void
  onPrefill?: (draft: CalcDraft) => void
  onCreate?: (draft: CalcDraft) => void
  onApply?: (calc: CalcView, input: { validFrom: string; efficiency: string; note: string }) => void
  onRemove?: (calc: CalcView) => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-506 — Finance › Settings › Costing: the cost per minute and overhead (design finance.settings sec:costing, W2b): the
 * cost-per-minute calculator (labour ÷ available minutes + overhead, per department and period; the minutes from the
 * calendars × the planned seats, never a headcount; a department planned with one seat is refused: it would be one person's
 * pay) — kept, applied as the department's labour rate from a day (today or later), or removed while not applied — and the
 * overhead rules in force. Everything about overhead waits for the accountant (said). Figures only with the cost grain.
 */
export function CalculatorCard({ model, actions }: { model: CalculatorModel; actions?: CalculatorActions }) {
  return (
    <WithMessages namespaces={[CPM_NS]}>
      <Calc model={model} actions={actions} />
    </WithMessages>
  )
}

function Calc({ model, actions }: { model: CalculatorModel; actions?: CalculatorActions }) {
  const t = useT(CPM_NS)
  const locale = useLocale()
  const money = (value: string | null | undefined, currency: string | null) =>
    model.can.cost && value !== undefined && value !== null ? formatNumber(Number(value), locale, currency ? { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4 } : { maximumFractionDigits: 4 }) : null
  const minutes = (value: string) => formatNumber(Number(value), locale, { maximumFractionDigits: 0 })
  const held = newHeld(model.can, model.busy)
  if (!model.can.view)
    return (
      <Card padded className="fw-fin-card">
        <h2 className="fw-fin-h2">{t('cpm.title')}</h2>
        <p className="fw-fin-hint">{t('cpm.noRight')}</p>
      </Card>
    )
  return (
    <Card padded className="fw-fin-card fw-cpm">
      <div className="fw-fin-card-head">
        <h2 className="fw-fin-h2">
          <Calculator size={16} aria-hidden /> {t('cpm.title')}
        </h2>
        <Button size="sm" variant="secondary" heldReason={held ? t(held) : null} onClick={() => actions?.onDialog?.({ kind: 'new' })}>
          {t('cpm.new')}
        </Button>
      </div>
      <p className="fw-fin-hint">{t('cpm.explain')}</p>
      <Banner tone="info" title={t('cpm.accountant')} />
      {model.notice && (
        <Banner
          tone="success"
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('csCommon.dismiss')}
            </Button>
          }
        />
      )}
      {!model.can.cost && <p className="fw-fin-hint">{t('cpm.noGrain')}</p>}
      {model.calcs.status === 'loading' ? (
        <p className="fw-fin-hint" role="status">
          <Spinner size={12} /> {t('cpm.loading')}
        </p>
      ) : model.calcs.status === 'error' ? (
        <EmptyState title={t('cpm.failed')} description={t(model.calcs.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('csCommon.retry')}</Button>} />
      ) : model.calcs.value.length === 0 ? (
        <EmptyState title={t('cpm.empty')} description={t('cpm.emptyBody')} />
      ) : (
        <SummaryTable
          label={t('cpm.listLabel')}
          density="roomy"
          stackOnPhone
          columns={[t('cpm.col.department'), t('cpm.col.period'), ...(model.can.cost ? [t('cpm.col.rate')] : []), t('cpm.col.applied'), t('cpm.col.actions')]}
          align={[undefined, undefined, ...(model.can.cost ? (['right'] as const) : []), undefined, 'right']}
          rows={model.calcs.value.map((calc) => {
            const rowWait = rowHeld(calc, model.can, model.busy)
            return {
              id: calc.id,
              cells: [
                <span key="d" className="fw-cpm-cell">
                  <b>{t(`dept.${calc.workCentreKind}`)}</b>
                  <span className="nds-summary-sub">{calc.workCentre ? t('cpm.oneCentre', { code: calc.workCentre.code, name: calc.workCentre.name }) : t('cpm.wholeDepartment')}</span>
                </span>,
                t('cpm.periodValue', { from: formatDate(`${calc.periodStart}T12:00:00Z`, { locale }), to: formatDate(`${calc.periodEnd}T12:00:00Z`, { locale }) }),
                ...(model.can.cost
                  ? [
                      <span key="r" className="fw-cpm-cell">
                        <b>{money(calc.costPerMinute, calc.currency) ?? '·'}</b>
                        <span className="nds-summary-sub">{t('cpm.minutesOf', { minutes: minutes(calc.availableMinutes) })}</span>
                      </span>,
                    ]
                  : []),
                calc.labourRateId ? <Tag key="a" tone="success">{t('cpm.appliedOn', { date: calc.appliedAt ? formatDate(calc.appliedAt, { locale }) : '—' })}</Tag> : <Tag key="a" tone="neutral">{t('cpm.notApplied')}</Tag>,
                <span key="x" className="fw-fin-actions fw-cpm-actions">
                  <Button size="sm" heldReason={rowWait ? t(rowWait) : null} onClick={() => actions?.onDialog?.({ kind: 'apply', calc })}>
                    {t('cpm.apply')}
                  </Button>
                  <Button size="sm" variant="quiet" heldReason={rowWait ? t(rowWait) : null} onClick={() => actions?.onDialog?.({ kind: 'remove', calc })}>
                    {t('cpm.remove')}
                  </Button>
                </span>,
              ],
            }
          })}
        />
      )}
      <OverheadRules model={model} money={money} />
      {model.dialog?.kind === 'new' && <NewCalcDialog model={model} actions={actions} money={money} minutes={minutes} />}
      {model.dialog?.kind === 'apply' && <ApplyDialog calc={model.dialog.calc} model={model} actions={actions} money={money} />}
      {model.dialog?.kind === 'remove' && <RemoveDialog calc={model.dialog.calc} model={model} actions={actions} />}
    </Card>
  )
}

function OverheadRules({ model, money }: { model: CalculatorModel; money: (value: string | null | undefined, currency: string | null) => string | null }) {
  const t = useT(CPM_NS)
  const locale = useLocale()
  const rules = model.rules
  return (
    <div className="fw-fin-stack-tight">
      <h3 className="fw-cpm-h3">{t('ohr.title')}</h3>
      <p className="fw-fin-hint">{t('ohr.explain')}</p>
      {rules.status === 'loading' ? (
        <p className="fw-fin-hint" role="status">
          <Spinner size={12} /> {t('ohr.loading')}
        </p>
      ) : rules.status === 'error' ? (
        <Banner tone="danger" title={t('ohr.failed')}>
          {t(rules.problem)}
        </Banner>
      ) : rules.value.length === 0 ? (
        <p className="fw-fin-hint">{t('ohr.none')}</p>
      ) : (
        <SummaryTable
          label={t('ohr.title')}
          stackOnPhone
          columns={[t('ohr.col.basis'), t('ohr.col.department'), ...(model.can.cost ? [t('ohr.col.value')] : []), t('ohr.col.period'), t('ohr.col.company')]}
          align={[undefined, undefined, ...(model.can.cost ? (['right'] as const) : []), undefined, undefined]}
          rows={rules.value.map((rule) => ({
            id: rule.id,
            cells: [
              <span key="b" className="fw-cpm-cell">
                <span>{t(`ohrBasis.${rule.basis}`)}</span>
                {rule.inForce && <span className="nds-summary-sub">{t('ohr.inForce')}</span>}
              </span>,
              rule.workCentreKind ? t(`dept.${rule.workCentreKind}`) : t('ohr.everyDepartment'),
              ...(model.can.cost ? [rule.basis === 'PERCENT_OF_LABOUR' ? `${formatNumber(Number(rule.value ?? 0), locale, { maximumFractionDigits: 4 })} %` : t(`ohrPer.${rule.basis}`, { amount: money(rule.value, rule.currency) ?? '·' })] : []),
              rule.periodEnd ? t('cpm.periodValue', { from: formatDate(`${rule.periodStart}T12:00:00Z`, { locale }), to: formatDate(`${rule.periodEnd}T12:00:00Z`, { locale }) }) : t('ohr.from', { from: formatDate(`${rule.periodStart}T12:00:00Z`, { locale }) }),
              rule.companyId ? t('ohr.thisCompany') : t('ohr.everyCompany'),
            ],
          }))}
        />
      )}
    </div>
  )
}

function NewCalcDialog({ model, actions, money, minutes }: { model: CalculatorModel; actions?: CalculatorActions; money: (value: string | null | undefined, currency: string | null) => string | null; minutes: (value: string) => string }) {
  const t = useT(CPM_NS)
  const locale = useLocale()
  const months = monthOptions(model.today)
  const [draft, setDraft] = useState<CalcDraft>(() => calcDraftOf(model.today, model.draft))
  const set = <K extends keyof CalcDraft>(key: K, value: CalcDraft[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const problems = calcProblems(draft)
  const first = Object.values(problems)[0]
  const rate = costPerMinute(draft)
  const prefilled = model.prefill?.status === 'ready' ? model.prefill.value : null
  const twice = overheadTwice(draft, prefilled)
  const close = () => actions?.onDialog?.(null)
  const readHeld = problems.period ? t(problems.period) : model.busy ? t('cpm.held.busy') : null
  return (
    <Modal
      open
      onClose={close}
      size="lg"
      title={t('cpm.newTitle')}
      footer={
        <>
          <Button onClick={close}>{t('csCommon.cancel')}</Button>
          <Button variant="primary" heldReason={first ? t(first) : model.busy ? t('cpm.held.busy') : null} onClick={() => actions?.onCreate?.(draft)}>
            {model.busy ? t('csCommon.working') : t('cpm.keep')}
          </Button>
        </>
      }
    >
      <div className="fw-fin-stack-tight fw-cpm-form">
        <p className="fw-fin-hint">{t('cpm.newIntro')}</p>
        <div className="fw-cpm-grid">
          <Field label={t('cpm.department')}>
            <Select value={draft.workCentreKind} onChange={(event) => setDraft((current) => ({ ...current, workCentreKind: event.target.value as CalcDraft['workCentreKind'], workCentreId: '' }))}>
              {CPM_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`dept.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('cpm.fromMonth')} error={problems.period ? t(problems.period) : undefined}>
            <Select value={draft.fromMonth} onChange={(event) => set('fromMonth', event.target.value)}>
              {months.map((month) => (
                <option key={month} value={month}>
                  {monthName(month, locale)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('cpm.toMonth')}>
            <Select value={draft.toMonth} onChange={(event) => set('toMonth', event.target.value)}>
              {months.map((month) => (
                <option key={month} value={month}>
                  {monthName(month, locale)}
                </option>
              ))}
            </Select>
          </Field>
          {prefilled && prefilled.workCentres.length > 1 && (
            <Field label={t('cpm.centre')} hint={t('cpm.centreHint')}>
              <Select value={draft.workCentreId} onChange={(event) => set('workCentreId', event.target.value)}>
                <option value="">{t('cpm.wholeDepartment')}</option>
                {prefilled.workCentres.map((centre) => (
                  <option key={centre.id} value={centre.id}>
                    {centre.code} · {centre.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <span className="fw-fin-actions">
          <Button size="sm" heldReason={readHeld} onClick={() => actions?.onPrefill?.(draft)}>
            {t('cpm.readMinutes')}
          </Button>
        </span>
        {model.prefill?.status === 'loading' && (
          <p className="fw-fin-hint" role="status">
            <Spinner size={12} /> {t('cpm.reading')}
          </p>
        )}
        {model.prefill?.status === 'error' && <Banner tone="danger" title={t(model.prefill.problem)} />}
        {prefilled && (
          <div className="fw-fin-stack-tight">
            <KeyValue
              dense
              labelCase="sentence"
              columns={2}
              items={[
                { label: t('cpm.minutesRead'), value: minutes(prefilled.availableMinutes), hint: t('cpm.minutesFrom') },
                ...(model.can.cost ? [{ label: t('cpm.overheadRules'), value: money(prefilled.overheadPerMinuteFromRules, prefilled.currency) ?? '·', hint: t('cpm.overheadRulesHint', { count: prefilled.overheadRules.length }) }] : []),
              ]}
            />
            {prefilled.workCentres.length > 0 && (
              <SummaryTable
                label={t('cpm.centres')}
                stackOnPhone
                columns={[t('cpm.col.centre'), t('cpm.col.days'), t('cpm.col.minutes'), t('cpm.col.seatsFrom')]}
                align={[undefined, 'right', 'right', undefined]}
                rows={prefilled.workCentres.map((centre) => ({
                  id: centre.id,
                  cells: [`${centre.code} · ${centre.name}`, String(centre.workingDays), minutes(centre.availableMinutes), t(`cpm.seatsFrom.${centre.seatsFrom}`, { count: centre.calendarIds.length })],
                }))}
              />
            )}
            {prefilled.workCentres.length === 0 && <Banner tone="warning" title={t('cpm.noCentres')} />}
            <span>
              <Button size="sm" variant="quiet" onClick={() => set('availableMinutes', String(Math.round(Number(prefilled.availableMinutes))))}>
                {t('cpm.useMinutes')}
              </Button>
            </span>
          </div>
        )}
        <div className="fw-cpm-grid">
          <Field label={t('cpm.direct', { currency: model.currency ?? '' })} hint={t('cpm.directHint')} error={draft.directLabourCost.trim() !== '' && problems.directLabourCost ? t(problems.directLabourCost) : undefined}>
            <Input inputMode="decimal" value={draft.directLabourCost} onChange={(event) => set('directLabourCost', event.target.value)} />
          </Field>
          <Field label={t('cpm.minutes')} hint={t('cpm.minutesHint')} error={draft.availableMinutes.trim() !== '' && problems.availableMinutes ? t(problems.availableMinutes) : undefined}>
            <Input inputMode="decimal" value={draft.availableMinutes} onChange={(event) => set('availableMinutes', event.target.value)} />
          </Field>
          <Field label={t('cpm.indirect')} hint={t('cpm.indirectHint')} error={problems.indirectPerMinute ? t(problems.indirectPerMinute) : undefined}>
            <Input inputMode="decimal" value={draft.indirectPerMinute} onChange={(event) => set('indirectPerMinute', event.target.value)} />
          </Field>
          <Field label={t('cpm.overhead')} hint={t('cpm.overheadHint')} error={problems.overheadPerMinute ? t(problems.overheadPerMinute) : undefined}>
            <Input inputMode="decimal" value={draft.overheadPerMinute} onChange={(event) => set('overheadPerMinute', event.target.value)} />
          </Field>
        </div>
        {twice && <Banner tone="warning" title={t('cpm.twice')} />}
        <KeyValue dense labelCase="sentence" items={[{ label: t('cpm.result'), value: rate ? (money(rate, model.currency) ?? '·') : t('cpm.resultWaits'), hint: t('cpm.resultHow') }]} />
        <Field label={t('cpm.note')} error={problems.note ? t(problems.note) : undefined}>
          <Textarea rows={2} maxLength={1000} value={draft.note} onChange={(event) => set('note', event.target.value)} />
        </Field>
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      </div>
    </Modal>
  )
}

function ApplyDialog({ calc, model, actions, money }: { calc: CalcView; model: CalculatorModel; actions?: CalculatorActions; money: (value: string | null | undefined, currency: string | null) => string | null }) {
  const t = useT(CPM_NS)
  const [validFrom, setValidFrom] = useState(model.today)
  const [efficiency, setEfficiency] = useState('')
  const [note, setNote] = useState('')
  const problems = applyProblems({ validFrom, efficiency }, model.today)
  const first = problems.validFrom ?? problems.efficiency
  const held = rowHeld(calc, model.can, model.busy)
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={t('cpm.applyTitle', { department: t(`dept.${calc.workCentreKind}`) })}
      footer={
        <>
          <Button onClick={close}>{t('csCommon.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : first ? t(first) : null} onClick={() => actions?.onApply?.(calc, { validFrom, efficiency, note })}>
            {model.busy ? t('csCommon.working') : t('cpm.apply')}
          </Button>
        </>
      }
    >
      <div className="fw-fin-stack-tight">
        <p className="fw-fin-hint">{t('cpm.applyIntro', { rate: money(calc.costPerMinute, calc.currency) ?? '·' })}</p>
        <Field label={t('cpm.validFrom')} hint={t('cpm.validFromHint')} error={problems.validFrom ? t(problems.validFrom) : undefined}>
          <DateField value={validFrom} min={model.today} onChange={setValidFrom} />
        </Field>
        <Field label={t('cpm.efficiency')} hint={t('cpm.efficiencyHint')} error={problems.efficiency ? t(problems.efficiency) : undefined}>
          <Input inputMode="decimal" value={efficiency} onChange={(event) => setEfficiency(event.target.value)} />
        </Field>
        <Field label={t('cpm.rateNote')}>
          <Textarea rows={2} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      </div>
    </Modal>
  )
}

function RemoveDialog({ calc, model, actions }: { calc: CalcView; model: CalculatorModel; actions?: CalculatorActions }) {
  const t = useT(CPM_NS)
  const held = rowHeld(calc, model.can, model.busy)
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={t('cpm.removeTitle', { department: t(`dept.${calc.workCentreKind}`) })}
      footer={
        <>
          <Button onClick={close}>{t('csCommon.cancel')}</Button>
          <Button variant="danger" heldReason={held ? t(held) : null} onClick={() => actions?.onRemove?.(calc)}>
            {model.busy ? t('csCommon.working') : t('cpm.removeConfirm')}
          </Button>
        </>
      }
    >
      <div className="fw-fin-stack-tight">
        <p className="fw-fin-hint">{t('cpm.removeIntro')}</p>
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      </div>
    </Modal>
  )
}
