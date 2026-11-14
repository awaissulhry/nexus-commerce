'use client'

import Link from 'next/link'
import { CalendarClock } from 'lucide-react'
import { Banner, EmptyState, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Pill, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { ConfirmPhraseField, Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant, DEADLINE_TONE, deadlineWords, money, type FinanceAbilities, type Phrase } from '../../../_shared/model'
import { CheckList } from '../../../_shared/parts'
import { DEPTH, DEPTH_NAMESPACES, monthName, type DepthProblem } from '../../test-mode/depth'
import { RUN_PICK_MAX, type Candidates, type IssuedRun, type Run, type RunRow } from '../api'
import { candidateHeld, changeHeld, checkWordsOf, confirmPhraseOf, CUSTOMER_TONE, customerStateOf, issuedWords, issueHeld, pickHeld, type RunPhase } from '../model'
import '../../../_shared/finance.css'

export interface MonthlyRunModel {
  can: FinanceAbilities
  prefix: string
  /** The months offered and the one chosen (YYYY-MM). */
  months: string[]
  month: string
  phase: RunPhase
  /** The month's customers with deferred invoicing (null value while it loads). */
  candidates: { value: Candidates | null; problem: string | null }
  /** An issued run of the month (said beside the pick). */
  issuedRun: RunRow | null
  picked: string[]
  /** The preview (in `pick` too while its customers are picked again). */
  run: Run | null
  /** Customers the last create or pick left out (nothing to invoice). */
  skipped: number
  /** The customers of an open preview are picked again. */
  repick: boolean
  send: boolean
  typed: string
  result: IssuedRun | null
  busy: boolean
  problem: DepthProblem | null
  /** What the last write did (a preview deleted: its drafts stay drafts). */
  notice: Phrase | null
}

export interface MonthlyRunActions {
  onMonth?: (month: string) => void
  onPicked?: (partyIds: string[]) => void
  onCreate?: () => void
  onRepick?: () => void
  onUsePicked?: () => void
  onDelete?: () => void
  onConfirm?: () => void
  onBack?: () => void
  onSend?: (send: boolean) => void
  onTyped?: (typed: string) => void
  onIssue?: () => void
  onRetry?: () => void
  onClose?: () => void
}

/**
 * Monthly invoice run (design finance.invoices pop:monthly-run, from the page's ⋯; FIN-068): ONE dialog in four steps —
 * pick the customers whose DDTs of the month take a deferred invoice (TD24; each with its DDTs, value and the 15th's
 * deadline; one in another preview is held with why) → the preview, one draft per customer with its totals and its
 * CheckList (ready, held by its checks with where to fix, issued, nothing to invoice); change the customers or delete the
 * preview (the drafts stay drafts) → "Issue and send n invoices" asks the month typed (Owner answer P1) and whether to
 * send at once, then a fresh code → what was issued and sent, and what stayed back. Money only with the price grain.
 */
export function MonthlyRunDialog({ model, actions }: { model: MonthlyRunModel; actions?: MonthlyRunActions }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <RunDialog model={model} actions={actions} />
    </WithMessages>
  )
}

function RunDialog({ model, actions }: { model: MonthlyRunModel; actions?: MonthlyRunActions }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const s = useScopedT('finance')
  const run = model.run
  const ready = run?.counts.ready ?? 0
  const footer = (() => {
    const close = (
      <Button size="sm" onClick={() => actions?.onClose?.()}>
        {model.phase === 'done' ? t('common.done') : t('common.cancel')}
      </Button>
    )
    if (model.phase === 'pick') {
      const held = model.candidates.value ? pickHeld({ picked: model.picked.length, can: model.can, busy: model.busy, max: RUN_PICK_MAX }) : { key: 'run.held.reading' }
      return (
        <>
          <span className="grow" />
          {model.repick && run ? (
            <Button size="sm" onClick={() => actions?.onBack?.()}>
              {w('run.backToPreview')}
            </Button>
          ) : (
            close
          )}
          <Button size="sm" variant="primary" heldReason={held ? w(held.key, held.params) : null} onClick={() => (model.repick ? actions?.onUsePicked?.() : actions?.onCreate?.())}>
            {model.busy ? t('common.working') : w(model.repick ? 'run.usePicked' : 'run.create', { count: model.picked.length })}
          </Button>
        </>
      )
    }
    if (model.phase === 'preview' && run) {
      const issue = issueHeld(run, model.can, model.busy)
      const pick = changeHeld(run, model.can, 'pick')
      const remove = changeHeld(run, model.can, 'delete')
      return (
        <>
          <Button size="sm" variant="danger-outline" heldReason={remove ? w(remove.key) : model.busy ? w('held.busy') : null} onClick={() => actions?.onDelete?.()}>
            {w('run.delete')}
          </Button>
          <span className="grow" />
          {close}
          <Button size="sm" heldReason={pick ? w(pick.key) : model.busy ? w('held.busy') : null} onClick={() => actions?.onRepick?.()}>
            {w('run.repick')}
          </Button>
          <Button size="sm" variant="primary" heldReason={issue ? w(issue.key, issue.params) : null} onClick={() => actions?.onConfirm?.()}>
            {w('run.issue', { count: ready })}
          </Button>
        </>
      )
    }
    if (model.phase === 'confirm' && run) {
      const phrase = confirmPhraseOf(run)
      const held = model.busy ? w('held.busy') : model.typed !== phrase ? w('run.held.typePhrase', { phrase }) : null
      return (
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onBack?.()}>
            {w('run.back')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onIssue?.()}>
            {model.busy ? t('common.working') : w(model.send ? 'run.issue' : 'run.issueOnly', { count: ready })}
          </Button>
        </>
      )
    }
    return (
      <>
        <span className="grow" />
        {close}
      </>
    )
  })()

  return (
    <Modal open onClose={() => actions?.onClose?.()} title={w('run.title')} size="lg" footer={footer}>
      <div className="fw-fin-dialog">
        {model.problem && <Banner tone="danger" title={s(model.problem.key, model.problem.params)} />}
        {model.notice && <Banner tone="info" title={w(model.notice.key, model.notice.params)} />}
        {model.phase === 'pick' && <PickStep model={model} actions={actions} />}
        {model.phase === 'preview' && run && <PreviewStep model={model} run={run} />}
        {model.phase === 'confirm' && run && <ConfirmStep model={model} run={run} actions={actions} />}
        {model.phase === 'done' && model.result && <DoneStep model={model} result={model.result} />}
        {(model.phase === 'preview' || model.phase === 'confirm') && !run && (
          <p className="fw-fin-hint" role="status">
            <Spinner size={12} /> {w('run.reading')}
          </p>
        )}
      </div>
    </Modal>
  )
}

function PickStep({ model, actions }: { model: MonthlyRunModel; actions?: MonthlyRunActions }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const locale = useLocale()
  const candidates = model.candidates.value
  const runId = model.run?.id ?? null
  const pickable = candidates?.customers.filter((candidate) => candidateHeld(candidate, runId) === null) ?? []
  const all = pickable.length > 0 && pickable.every((candidate) => model.picked.includes(candidate.partyId))
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  return (
    <>
      <div className="fw-fin-head">
        <p className="fw-fin-hint">{w('run.pick.explain', { month: monthName(model.month, locale) })}</p>
        <Select size="sm" aria-label={w('run.month')} value={model.month} disabled={model.repick} onChange={(event) => actions?.onMonth?.(event.target.value)}>
          {model.months.map((month) => (
            <option key={month} value={month}>
              {monthName(month, locale)}
            </option>
          ))}
        </Select>
      </div>
      {model.issuedRun && <Tag tone="info">{w('run.pick.issuedRun', { month: monthName(model.month, locale), count: model.issuedRun.invoices })}</Tag>}
      {model.candidates.problem ? (
        <EmptyState
          title={w('run.pick.failed')}
          description={t(model.candidates.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : !candidates ? (
        <p className="fw-fin-hint" role="status">
          <Spinner size={12} /> {w('run.pick.reading')}
        </p>
      ) : candidates.customers.length === 0 ? (
        <EmptyState icon={<CalendarClock size={24} aria-hidden />} title={w('run.pick.none.title', { month: monthName(model.month, locale) })} description={w('run.pick.none.body')} />
      ) : (
        <fieldset className="fw-fin-choices">
          <legend className="fw-fin-legend">{w('run.pick.customers')}</legend>
          <Checkbox checked={all} disabled={pickable.length === 0} onChange={(event) => actions?.onPicked?.(event.target.checked ? pickable.map((candidate) => candidate.partyId) : [])} label={w('run.pick.all', { count: pickable.length })} />
          {candidates.customers.map((candidate) => {
            const held = candidateHeld(candidate, runId)
            const deadline = candidate.deadline ? deadlineWords(candidate.deadline) : null
            return (
              <div key={candidate.partyId} className="fw-fin-check">
                <Checkbox
                  checked={model.picked.includes(candidate.partyId)}
                  disabled={!!held}
                  onChange={(event) => actions?.onPicked?.(event.target.checked ? [...model.picked, candidate.partyId] : model.picked.filter((id) => id !== candidate.partyId))}
                  label={
                    <span className="fw-fin-cell">
                      <span>
                        {candidate.legalName} <span className="fw-fin-title-sub">· {candidate.code}</span>
                      </span>
                      <span className="fw-fin-cell-sub">
                        {w('run.pick.ddts', { count: candidate.ddts })}
                        {model.can.price && candidate.valueAmount !== undefined ? ` · ${money(candidate.valueAmount, 'EUR', locale)}` : ''}
                        {candidate.drafts.length > 0 ? ` · ${w('run.pick.drafts', { count: candidate.drafts.length })}` : ''}
                        {held ? ` · ${w(held.key)}` : ''}
                      </span>
                    </span>
                  }
                />
                {deadline && candidate.deadline && (
                  <Pill tone={DEADLINE_TONE[candidate.deadline.state]}>
                    {t(deadline.key, deadline.params)} · {day(candidate.deadline.dueBy)}
                  </Pill>
                )}
              </div>
            )
          })}
        </fieldset>
      )}
      <p className="fw-fin-hint">{w('run.pick.after')}</p>
    </>
  )
}

function PreviewStep({ model, run }: { model: MonthlyRunModel; run: Run }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const locale = useLocale()
  return (
    <>
      <p className="fw-fin-hint">{w('run.preview.explain', { month: monthName(run.month, locale) })}</p>
      <MetricStrip
        minTileWidth={120}
        metrics={[
          { label: w('run.count.customers'), value: String(run.counts.customers) },
          { label: w('run.count.drafts'), value: String(run.counts.drafts) },
          { label: w('run.count.ready'), value: String(run.counts.ready) },
          { label: w('run.count.issued'), value: String(run.counts.issued) },
        ]}
      />
      {model.skipped > 0 && <Tag tone="info">{w('run.preview.skipped', { count: model.skipped })}</Tag>}
      <ul className="fw-fin-steps" aria-label={w('run.preview.title')}>
        {run.customers.map((customer) => {
          const state = customerStateOf(customer)
          const invoice = customer.invoice
          return (
            <li key={customer.partyId} className="fw-fin-stack-tight">
              <div className="fw-fin-card-head">
                <span className="fw-fin-cell">
                  <b>{customer.legalName}</b>
                  <span className="fw-fin-cell-sub">
                    {customer.code}
                    {invoice ? ` · ${w('run.pick.ddts', { count: invoice.ddts })}` : ''}
                    {invoice && model.can.price && invoice.netTotal !== undefined ? ` · ${w('run.preview.totals', { net: money(invoice.netTotal, invoice.currency, locale), gross: money(invoice.grossTotal, invoice.currency, locale) })}` : ''}
                  </span>
                </span>
                <span className="fw-fin-inline">
                  <Pill tone={CUSTOMER_TONE[state]}>{state === 'HELD' && invoice ? w('run.state.HELD', { count: invoice.problems.length }) : w(`run.state.${state}`, { number: invoice?.number ?? '—' })}</Pill>
                  {invoice && (
                    <Link className="fw-fin-link fw-fin-hint" href={`${model.prefix}/finance/invoices/${invoice.id}`}>
                      {w(invoice.status === 'DRAFT' ? 'run.openDraft' : 'run.openInvoice')}
                    </Link>
                  )}
                </span>
              </div>
              {state === 'HELD' && invoice && (
                <CheckList label={w('run.preview.checks', { customer: customer.legalName })} items={checkWordsOf(invoice.problems).map((key) => ({ id: key, ok: false, words: t(key) }))} />
              )}
              {state === 'NONE' && <p className="fw-fin-hint">{w('run.preview.none')}</p>}
            </li>
          )
        })}
      </ul>
    </>
  )
}

function ConfirmStep({ model, run, actions }: { model: MonthlyRunModel; run: Run; actions?: MonthlyRunActions }) {
  const w = useT(DEPTH)
  const locale = useLocale()
  const held = run.counts.drafts - run.counts.ready
  const phrase = confirmPhraseOf(run)
  return (
    <>
      <p className="fw-fin-hint">{w('run.confirm.explain', { month: monthName(run.month, locale) })}</p>
      <ul className="fw-fin-list">
        <li>{w('run.confirm.numbers', { count: run.counts.ready })}</li>
        <li>{w(model.send ? 'run.confirm.send' : 'run.confirm.noSend')}</li>
        {held > 0 && <li>{w('run.confirm.held', { count: held })}</li>}
        <li>{w('run.confirm.never')}</li>
      </ul>
      <Checkbox checked={model.send} onChange={(event) => actions?.onSend?.(event.target.checked)} label={w('run.confirm.sendNow')} />
      <ConfirmPhraseField phrase={phrase} value={model.typed} onChange={(value) => actions?.onTyped?.(value)} label={w('run.confirm.type', { phrase })} />
      <p className="fw-fin-hint">{w('run.confirm.stepUp')}</p>
    </>
  )
}

function DoneStep({ model, result }: { model: MonthlyRunModel; result: IssuedRun }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const names = new Map(result.run.customers.map((customer) => [customer.partyId, customer.legalName]))
  return (
    <>
      <Banner tone={result.held.length > 0 || result.issued.some((entry) => !entry.sent) ? 'warning' : 'success'} title={issuedWords(result).map((entry) => w(entry.key, entry.params)).join(' ')} />
      {result.issued.length > 0 && (
        <SummaryTable
          label={w('run.done.issuedTitle')}
          columns={[w('run.col.invoice'), w('run.col.sdi')]}
          rows={result.issued.map((entry) => ({
            id: entry.invoiceId,
            cells: [
              <Link key="n" className="fw-fin-link" href={`${model.prefix}/finance/invoices/${entry.invoiceId}`}>
                {entry.number}
              </Link>,
              entry.sent ? w('run.done.rowSent') : w(entry.filesPending ? 'run.done.rowFilesPending' : 'run.done.rowNotSent'),
            ],
          }))}
          stackOnPhone
        />
      )}
      {result.held.length > 0 && (
        <SummaryTable
          label={w('run.done.heldTitle')}
          columns={[w('run.col.customer'), w('run.col.why')]}
          rows={result.held.map((entry) => ({
            id: entry.invoiceId,
            cells: [
              <Link key="n" className="fw-fin-link" href={`${model.prefix}/finance/invoices/${entry.invoiceId}`}>
                {names.get(entry.partyId) ?? '—'}
              </Link>,
              checkWordsOf(entry.problems).map((key) => t(key)).join(' · ') || w('run.done.heldNoWords'),
            ],
          }))}
          stackOnPhone
        />
      )}
    </>
  )
}
