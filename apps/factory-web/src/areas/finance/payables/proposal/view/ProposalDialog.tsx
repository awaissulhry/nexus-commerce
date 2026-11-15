'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { CalendarCheck2 } from 'lucide-react'
import { Banner, EmptyState, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant, money } from '../../../_shared/model'
import { DialogFrame } from '../../../_shared/parts'
import { PAY_DEPTH, PAY_DEPTH_NAMESPACES, type PayProblem, type Phrase } from '../../../payments/riba/depth'
import { PROPOSAL_LIMITS, type Proposal, type ProposalCandidates, type ProposalRow } from '../api'
import { defaultPicks, DUE_TONE, dualPhrase, fourEyesPhrase, holdPhrase, isoWeek, linesOf, paidHeld, pickable, pickedPayable, PROPOSAL_TONE, weeksFrom, type ProposalCan } from '../model'

export type ProposalStage =
  | { kind: 'start'; weekStart: string; candidates: ProposalCandidates | null; problem: string | null; reading: boolean; picked: readonly string[] | null; existing: ProposalRow[] | null; repick: Proposal | null }
  | { kind: 'proposal'; proposal: Proposal | null; problem: string | null }
  | { kind: 'reason'; move: 'send-back' | 'cancel'; proposal: Proposal }
  | { kind: 'paid'; proposal: Proposal }

export interface ProposalDialogModel {
  prefix: string
  today: string
  can: ProposalCan
  stage: ProposalStage
  busy: boolean
  problem: PayProblem | null
  notice: Phrase | null
  /** Design cases: what is typed. */
  draft?: { discounts?: Record<string, string>; reason?: string; paidOn?: string; reference?: string }
}

export interface ProposalDialogActions {
  onClose?: () => void
  onWeek?: (weekStart: string) => void
  onPicked?: (ids: string[]) => void
  onCreate?: (discounts: Record<string, string>) => void
  onSaveLines?: (discounts: Record<string, string>) => void
  onOpen?: (proposalId: string) => void
  onRepick?: (proposal: Proposal) => void
  onApprove?: () => void
  onStage?: (stage: ProposalStage) => void
  onReason?: (reason: string) => void
  onPaid?: (input: { paidOn: string; paymentRef: string }) => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-515 — the payment proposal (design finance.payables pop:proposal "Payment proposal — week 46", the band's primary): the
 * approved supplier invoices due by the week's Sunday, overdue first, by due date and discount, each with what is paid (its
 * total less the withholding, less an early-payment discount typed here), the supplier's account as usable (masked: country
 * and last four) or held ("No bank account — payments to this supplier are held"); invoices still waiting for approval said
 * apart. A draft is approved by someone who did not make it (a fresh code first), and above the amount by a second person
 * too; it is sent back or cancelled with why; once the transfers left the bank (made in the bank's own site: nothing is paid
 * from here) a person records the day and the bank's reference and every invoice is paid. Amounts only with the cost grain.
 */
export function ProposalDialog({ model, actions }: { model: ProposalDialogModel; actions?: ProposalDialogActions }) {
  return (
    <WithMessages namespaces={PAY_DEPTH_NAMESPACES}>
      <Dialog model={model} actions={actions} />
    </WithMessages>
  )
}

function useWords() {
  const p = useT(PAY_DEPTH)
  const s = useScopedT('finance')
  return { p, s, say: (phrase: Phrase | null) => (phrase ? s(phrase.key, phrase.params) : null) }
}

function Dialog({ model, actions }: { model: ProposalDialogModel; actions?: ProposalDialogActions }) {
  const stage = model.stage
  if (stage.kind === 'start') return <StartStage model={model} stage={stage} actions={actions} />
  if (stage.kind === 'reason') return <ReasonStage model={model} stage={stage} actions={actions} />
  if (stage.kind === 'paid') return <PaidStage model={model} proposal={stage.proposal} actions={actions} />
  return <ProposalStageView model={model} proposal={stage.proposal} problem={stage.problem} actions={actions} />
}

function Notice({ model, actions }: { model: ProposalDialogModel; actions?: ProposalDialogActions }) {
  const { say } = useWords()
  const t = useT('finance')
  if (!model.notice) return null
  return (
    <Banner
      tone="success"
      title={say(model.notice) ?? ''}
      action={
        <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
          {t('common.dismiss')}
        </Button>
      }
    />
  )
}

function StartStage({ model, stage, actions }: { model: ProposalDialogModel; stage: Extract<ProposalStage, { kind: 'start' }>; actions?: ProposalDialogActions }) {
  const { p, say } = useWords()
  const t = useT('finance')
  const locale = useLocale()
  const [discounts, setDiscounts] = useState<Record<string, string>>(model.draft?.discounts ?? {})
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : p('proposal.noDueDate'))
  const candidates = stage.candidates
  const rows = candidates?.items ?? []
  const picked = new Set(stage.picked ?? defaultPicks(rows))
  const free = rows.filter(pickable).map((row) => row.invoiceId)
  const pickedFree = free.filter((id) => picked.has(id))
  const lines = linesOf(rows, picked, discounts)
  const total = pickedPayable(rows, picked, discounts)
  const repick = stage.repick
  const sameWeek = (stage.existing ?? []).filter((row) => row.weekStart === stage.weekStart && row.status !== 'CANCELLED')
  const held = !model.can.manage ? p('proposal.held.manage') : !candidates || stage.reading ? p('proposal.held.reading') : (say(lines.problem) ?? (model.busy ? t('common.working') : null))
  const currency = candidates?.currency ?? 'EUR'
  return (
    <DialogFrame
      title={p('proposal.titleWeek', { week: isoWeek(stage.weekStart) })}
      held={held}
      go={() => (repick ? actions?.onSaveLines?.(discounts) : actions?.onCreate?.(discounts))}
      goLabel={repick ? p('proposal.saveLines', { count: lines.lines.length }) : p('proposal.create', { count: lines.lines.length })}
      onClose={() => actions?.onClose?.()}
      problem={model.problem}
      size="lg"
    >
      <Notice model={model} actions={actions} />
      <p className="fw-fin-hint">{p('proposal.body')}</p>
      {!repick && (
        <div className="fw-fin-two">
          <Field label={p('proposal.week')}>
            <Select value={stage.weekStart} onChange={(event) => actions?.onWeek?.(event.target.value)}>
              {weeksFrom(model.today).map((monday) => (
                <option key={monday} value={monday}>
                  {p('proposal.weekOption', { week: isoWeek(monday), from: formatDate(dayInstant(monday), { locale }) })}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      {!repick && sameWeek.length > 0 && (
        <Banner tone="info" title={p('proposal.existing', { count: sameWeek.length, week: isoWeek(stage.weekStart) })}>
          <span className="fw-fin-inline">
            {sameWeek.map((row) => (
              <Button key={row.id} size="sm" variant="link" onClick={() => actions?.onOpen?.(row.id)}>
                {p('proposal.openExisting', { state: p(`proposal.status.${row.status}`), count: row.lines })}
              </Button>
            ))}
          </span>
        </Banner>
      )}
      {stage.problem ? (
        <EmptyState
          title={p('proposal.candidates.failed')}
          description={t(stage.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : !candidates || stage.reading ? (
        <p className="fw-fin-hint" role="status">
          <Spinner size={12} /> {p('proposal.candidates.reading')}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState icon={<CalendarCheck2 size={24} aria-hidden />} title={p('proposal.candidates.none.title', { week: candidates.week })} description={p('proposal.candidates.none.body')} />
      ) : (
        <fieldset className="fw-fin-choices">
          <legend className="fw-fin-legend">{p('proposal.candidates.legend', { week: candidates.week })}</legend>
          <Checkbox checked={free.length > 0 && pickedFree.length === free.length} disabled={free.length === 0} onChange={(event) => actions?.onPicked?.(event.target.checked ? free : [])} label={p('proposal.candidates.all', { count: free.length })} />
          {rows.map((row) => {
            const on = pickable(row) && picked.has(row.invoiceId)
            return (
              <div key={row.invoiceId} className="fw-fin-stack-tight">
                <div className="fw-fin-check">
                  <Checkbox
                    checked={on}
                    disabled={!pickable(row)}
                    onChange={(event) => actions?.onPicked?.(event.target.checked ? [...pickedFree, row.invoiceId] : pickedFree.filter((id) => id !== row.invoiceId))}
                    label={
                      <span className="fw-fin-cell">
                        <span>
                          {row.supplier.name} <span className="fw-fin-title-sub">· {row.number}</span>
                        </span>
                        <span className="fw-fin-cell-sub">
                          {p(`proposal.due.${row.due}`, { date: day(row.dueDate) })}
                          {model.can.cost && row.payable !== undefined ? ` · ${p('proposal.payable', { amount: money(row.payable, currency, locale) })}` : ''}
                          {' · '}
                          {row.held || !row.account ? p('refusal.proposal.HELD') : row.account.usable ? p('proposal.account.usable', { account: row.account.masked }) : p('proposal.account.notUsable', { account: row.account.masked })}
                          {row.inProposal ? ` · ${p('refusal.proposal.IN_ANOTHER_PROPOSAL')}` : ''}
                        </span>
                      </span>
                    }
                  />
                  <Pill tone={DUE_TONE[row.due]}>{p(`proposal.dueShort.${row.due}`)}</Pill>
                </div>
                {on && model.can.cost && (
                  <Field label={p('proposal.discount', { number: row.number })} hint={p('proposal.discountHint')}>
                    <Input inputMode="decimal" value={discounts[row.invoiceId] ?? ''} onChange={(event) => setDiscounts((current) => ({ ...current, [row.invoiceId]: event.target.value }))} autoComplete="off" />
                  </Field>
                )}
              </div>
            )
          })}
        </fieldset>
      )}
      {candidates && candidates.waiting.length > 0 && (
        <section aria-label={p('proposal.waiting.title')} className="fw-fin-stack-tight">
          <h3 className="fw-fin-h3">{p('proposal.waiting.title')}</h3>
          <ul className="fw-fin-list">
            {candidates.waiting.map((row) => (
              <li key={row.invoiceId}>
                <Link className="fw-fin-link" href={`${model.prefix}/finance/payables/${row.invoiceId}?tab=approval`}>
                  {row.supplier.name} · {row.number}
                </Link>{' '}
                — {p(`proposal.waiting.${row.status === 'DISPUTED' ? 'disputed' : 'received'}`)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {candidates && rows.length > 0 && (
        <p className="fw-fin-hint" role="status">
          {model.can.cost && total !== null ? p('proposal.total', { count: lines.lines.length, amount: money(total, currency, locale) }) : p('proposal.totalPlain', { count: lines.lines.length })}
        </p>
      )}
    </DialogFrame>
  )
}

function ProposalStageView({ model, proposal, problem, actions }: { model: ProposalDialogModel; proposal: Proposal | null; problem: string | null; actions?: ProposalDialogActions }) {
  const { p, say } = useWords()
  const t = useT('finance')
  const locale = useLocale()
  if (!proposal) {
    return (
      <DialogFrame title={p('proposal.title')} held={problem ? p('proposal.held.failed') : p('proposal.held.reading')} go={() => undefined} goLabel={p('proposal.approve')} onClose={() => actions?.onClose?.()} size="lg">
        {problem ? (
          <EmptyState
            title={p('proposal.failed')}
            description={t(problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : (
          <p className="fw-fin-hint" role="status">
            <Spinner size={12} /> {p('proposal.reading')}
          </p>
        )}
      </DialogFrame>
    )
  }
  const m = (value: number | undefined) => money(value, proposal.currency, locale)
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : p('proposal.noDueDate'))
  const threshold = model.can.cost && proposal.approval.dual.threshold !== undefined ? m(proposal.approval.dual.threshold) : null
  const approveHeld = say(holdPhrase(proposal.may.approve)) ?? (model.busy ? t('common.working') : null)
  const draft = proposal.status === 'DRAFT'
  const approved = proposal.status === 'APPROVED'
  const facts = [
    { label: p('proposal.col.state'), value: <Pill tone={PROPOSAL_TONE[proposal.status]}>{p(`proposal.status.${proposal.status}`)}</Pill> },
    { label: p('proposal.week'), value: p('proposal.weekRange', { from: day(proposal.weekStart), to: day(proposal.weekEnd) }) },
    { label: p('proposal.col.lines'), value: p('proposal.linesCount', { count: proposal.totals.lines, suppliers: proposal.totals.suppliers }) },
    ...(model.can.cost ? [{ label: p('proposal.col.total'), value: m(proposal.totals.amount) }, ...(proposal.totals.discount ? [{ label: p('proposal.col.discount'), value: m(proposal.totals.discount) }] : [])] : []),
    { label: p('proposal.madeBy'), value: p('proposal.byOn', { name: proposal.createdBy?.name ?? p('riba.someone'), date: formatDateTime(proposal.createdAt, { locale }) }) },
    ...(proposal.approvedAt ? [{ label: p('proposal.approvedBy'), value: p('proposal.byOn', { name: proposal.approvedBy?.name ?? p('riba.someone'), date: formatDateTime(proposal.approvedAt, { locale }) }) }] : []),
    ...(proposal.paidAt ? [{ label: p('proposal.paidAt'), value: formatDateTime(proposal.paidAt, { locale }) }] : []),
  ]
  const main = draft
    ? { label: p('proposal.approve'), held: approveHeld, go: () => actions?.onApprove?.() }
    : approved
      ? { label: p('proposal.recordPaid'), held: say(holdPhrase(proposal.may.pay)), go: () => actions?.onStage?.({ kind: 'paid', proposal }) }
      : null
  return (
    <DialogFrame
      title={p('proposal.titleWeek', { week: proposal.week })}
      held={main ? main.held : null}
      go={main ? main.go : () => undefined}
      goLabel={main ? main.label : ''}
      onClose={() => actions?.onClose?.()}
      problem={model.problem}
      size="lg"
      done={
        main ? undefined : (
          <>
            {/* A paid proposal says what reached the suppliers (the paid answer's remittances), a cancelled one its notice. */}
            <Notice model={model} actions={actions} />
            <ClosedBody proposal={proposal} facts={facts} />
          </>
        )
      }
    >
      <Notice model={model} actions={actions} />
      <KeyValue dense labelCase="sentence" columns={2} items={facts} />
      <span className="fw-fin-inline">
        {draft && (
          <Button size="sm" variant="link" heldReason={say(holdPhrase(proposal.may.change))} onClick={() => actions?.onRepick?.(proposal)}>
            {p('proposal.changeLines')}
          </Button>
        )}
        {approved && (
          <Button size="sm" variant="link" heldReason={say(holdPhrase(proposal.may.sendBack))} onClick={() => actions?.onStage?.({ kind: 'reason', move: 'send-back', proposal })}>
            {p('proposal.sendBack')}
          </Button>
        )}
        <Button size="sm" variant="link" heldReason={say(holdPhrase(proposal.may.cancel))} onClick={() => actions?.onStage?.({ kind: 'reason', move: 'cancel', proposal })}>
          {p('proposal.cancel')}
        </Button>
      </span>
      <SummaryTable
        label={p('proposal.lines')}
        columns={[p('proposal.col.supplier'), p('proposal.col.invoice'), ...(model.can.cost ? [p('proposal.col.amount')] : []), p('proposal.col.account')]}
        align={['left', 'left', ...(model.can.cost ? (['right'] as const) : []), 'left']}
        stackOnPhone
        rows={proposal.lines.map((line) => ({
          id: line.id,
          cells: [
            line.supplier.name,
            <span key="i" className="fw-fin-cell">
              {line.invoice ? (
                <Link className="fw-fin-link" href={`${model.prefix}/finance/payables/${line.invoice.id}?tab=payment`}>
                  {line.invoice.number}
                </Link>
              ) : (
                '—'
              )}
              {line.invoice && <span className="fw-fin-cell-sub">{p(`proposal.due.${line.invoice.due}`, { date: day(line.invoice.dueDate) })}</span>}
              {line.problems.length > 0 && <span className="fw-fin-cell-sub">{line.problems.map((code) => p(`refusal.proposal.${code}`)).join(' ')}</span>}
            </span>,
            ...(model.can.cost
              ? [
                  <span key="a" className="fw-fin-cell">
                    <span className="fw-fin-num">{m(line.amount)}</span>
                    {line.discountAmount ? <span className="fw-fin-cell-sub">{p('proposal.lessDiscount', { amount: m(line.discountAmount) })}</span> : null}
                  </span>,
                ]
              : []),
            line.held || !line.account ? (
              <Pill key="c" tone="danger">
                {p('proposal.account.held')}
              </Pill>
            ) : (
              <span key="c" className="fw-fin-cell">
                <span className="fw-fin-code">{line.account.masked}</span>
                <Pill tone={line.account.usable ? 'success' : 'warning'}>{line.account.usable ? p('proposal.account.ok') : p('proposal.account.check')}</Pill>
              </span>
            ),
          ],
        }))}
      />
      {proposal.totals.held > 0 && <Banner tone="warning" title={p('proposal.heldLines', { count: proposal.totals.held })}>{p('refusal.proposal.HELD')}</Banner>}
      <div className="fw-fin-stack-tight">
        <h3 className="fw-fin-h3">{p('proposal.approval')}</h3>
        <p className="fw-fin-hint">{say(fourEyesPhrase(proposal))}</p>
        <p className="fw-fin-hint">{say(dualPhrase(proposal, threshold))}</p>
        {!proposal.approval.dual.decided && <p className="fw-fin-hint">{p('proposal.dual.undecided')}</p>}
        <p className="fw-fin-hint">{proposal.remittance.on ? p('proposal.remittance.on') : p('proposal.remittance.off')}</p>
        {draft && <p className="fw-fin-hint">{p('proposal.stepUpSaid')}</p>}
        {approved && <p className="fw-fin-hint">{p('proposal.payInBank')}</p>}
      </div>
    </DialogFrame>
  )
}

function ClosedBody({ proposal, facts }: { proposal: Proposal; facts: { label: string; value: ReactNode }[] }) {
  const { p } = useWords()
  const locale = useLocale()
  return (
    <div className="fw-fin-stack">
      <KeyValue dense labelCase="sentence" columns={2} items={facts} />
      {proposal.status === 'CANCELLED' ? (
        <Banner tone="info" title={p('proposal.cancelled', { date: proposal.cancelledAt ? formatDate(proposal.cancelledAt, { locale }) : '—' })}>
          {proposal.cancelReason ?? '—'}
        </Banner>
      ) : (
        <Banner tone="success" title={p('proposal.paidDone', { count: proposal.totals.lines })} />
      )}
    </div>
  )
}

function ReasonStage({ model, stage, actions }: { model: ProposalDialogModel; stage: Extract<ProposalStage, { kind: 'reason' }>; actions?: ProposalDialogActions }) {
  const { p } = useWords()
  const t = useT('finance')
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  const held = model.busy ? t('common.working') : reason.trim().length < 3 ? p('proposal.reason.short') : null
  return (
    <DialogFrame
      title={p(`proposal.reason.${stage.move === 'cancel' ? 'cancelTitle' : 'sendBackTitle'}`, { week: stage.proposal.week })}
      held={held}
      go={() => actions?.onReason?.(reason.trim())}
      goLabel={p(`proposal.reason.${stage.move === 'cancel' ? 'cancelGo' : 'sendBackGo'}`)}
      tone={stage.move === 'cancel' ? 'danger' : 'primary'}
      onClose={() => actions?.onStage?.({ kind: 'proposal', proposal: stage.proposal, problem: null })}
      problem={model.problem}
    >
      <p className="fw-fin-hint">{p(`proposal.reason.${stage.move === 'cancel' ? 'cancelBody' : 'sendBackBody'}`)}</p>
      <Field label={p('proposal.reason.label')}>
        <Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={PROPOSAL_LIMITS.reason} rows={3} />
      </Field>
    </DialogFrame>
  )
}

function PaidStage({ model, proposal, actions }: { model: ProposalDialogModel; proposal: Proposal; actions?: ProposalDialogActions }) {
  const { p, say } = useWords()
  const t = useT('finance')
  const locale = useLocale()
  const [paidOn, setPaidOn] = useState(model.draft?.paidOn ?? model.today)
  const [reference, setReference] = useState(model.draft?.reference ?? '')
  const held = say(holdPhrase(proposal.may.pay)) ?? say(paidHeld({ paidOn, reference, today: model.today })) ?? (model.busy ? t('common.working') : null)
  return (
    <DialogFrame title={p('proposal.paid.title', { week: proposal.week })} held={held} go={() => actions?.onPaid?.({ paidOn, paymentRef: reference.trim() })} goLabel={p('proposal.paid.go', { count: proposal.totals.lines })} onClose={() => actions?.onStage?.({ kind: 'proposal', proposal, problem: null })} problem={model.problem}>
      <p className="fw-fin-hint">{p('proposal.paid.body')}</p>
      <div className="fw-fin-two">
        <Field label={p('proposal.paid.on')}>
          <DateField value={paidOn} onChange={setPaidOn} max={model.today} locale={INTL_LOCALE[locale]} ariaLabel={p('proposal.paid.on')} />
        </Field>
        <Field label={p('proposal.paid.ref')} hint={p('proposal.paid.refHint')}>
          <Input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={PROPOSAL_LIMITS.paymentRef} autoComplete="off" />
        </Field>
      </div>
      <p className="fw-fin-hint">{proposal.remittance.on ? p('proposal.remittance.on') : p('proposal.remittance.off')}</p>
    </DialogFrame>
  )
}
