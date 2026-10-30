'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Banner, DateField, Field, KeyValue } from '@nexus/ui/components'
import { Checkbox, Input, RadioCard, Select, Spinner, Textarea } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { hasRecordPage, recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { CREDIT_REASONS, type CreditReason, type Invoice } from '../../../_shared/api'
import {
  checkOf,
  creditableOf,
  creditProblems,
  dayInstant,
  dueDateOf,
  lineDraftsOf,
  lineProblems,
  linesChanged,
  money,
  parseAmount,
  parsePrice,
  parseQuantity,
  rejectionOf,
  sdiErrorKey,
  type CreditMode,
  type LineDraft,
} from '../../../_shared/model'
import { CheckList, DialogFrame } from '../../../_shared/parts'
import type { InvoiceRecordActions, InvoiceRecordModel } from '../record-model'

/**
 * The invoice record's dialogs: Check and issue (Owner P1: a confirm dialog once the checks pass — the number it will
 * get, today's date, what happens; it cannot change after), Send to SDI, Fix and resend (SDI's reason in our words with
 * the code; the lines and text to correct right here, the customer's or our data where they live; same number and date;
 * the deadline), Credit note (the whole invoice, some lines or an amount, never above what is creditable; a reason;
 * positive amounts), a draft's lines and text, Delete draft. Esc closes; the focus returns to the opener (DS Modal); ⌘↵
 * confirms. A refused write is said inside its dialog, what was typed stays.
 */
export function InvoiceDialogs({ invoice, model, actions }: { invoice: Invoice; model: InvoiceRecordModel; actions?: InvoiceRecordActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  switch (dialog.kind) {
    case 'issue':
      return <IssueDialog invoice={invoice} model={model} actions={actions} />
    case 'send':
      return <SendDialog invoice={invoice} model={model} actions={actions} />
    case 'fix':
      return <FixDialog invoice={invoice} model={model} actions={actions} />
    case 'credit':
      return <CreditDialog invoice={invoice} model={model} actions={actions} />
    case 'lines':
      return <LinesDialog invoice={invoice} model={model} actions={actions} />
    case 'details':
      return <DetailsDialog invoice={invoice} model={model} actions={actions} />
    case 'delete':
      return <DeleteDialog invoice={invoice} model={model} actions={actions} />
    default:
      return null
  }
}

const close = (actions?: InvoiceRecordActions) => () => actions?.onDialog?.(null)

function IssueDialog({ invoice, model, actions }: { invoice: Invoice; model: InvoiceRecordModel; actions?: InvoiceRecordActions }) {
  const t = useT('finance')
  const locale = useLocale()
  const checks = model.checks?.value ?? null
  const [send, setSend] = useState(true)
  const held = model.busy ? t('held.busy') : !model.can.issueInvoices ? t('held.noIssue') : !checks ? t('held.checksReading') : !checks.ready ? t('held.checksFail', { count: checks.problems.length }) : null
  return (
    <DialogFrame title={t(send ? 'issue.title' : 'issue.titleOnly')} held={held} go={() => actions?.onIssue?.({ send })} goLabel={model.busy ? t('common.working') : t(send ? 'issue.go' : 'issue.goOnly')} onClose={close(actions)} problem={model.dialogProblem}>
      <KeyValue
        dense
        labelCase="sentence"
        columns={2}
        items={[
          { label: t('issue.number'), value: checks?.numberPreview ?? '—', hint: t('issue.numberHint') },
          { label: t('issue.date'), value: checks ? formatDate(dayInstant(checks.issueDate), { locale }) : '—' },
          { label: t('issue.customer'), value: invoice.party.legalName },
          ...(model.can.price ? [{ label: t('issue.total'), value: money(invoice.grossTotal, invoice.currency, locale) }] : []),
        ]}
      />
      {checks && (
        <CheckList
          label={t('checks.title')}
          items={checks.ready ? [{ id: 'ok', ok: true, words: t('issue.checksPass') }] : checks.problems.map((problem, index) => ({ id: `${problem.code}-${index}`, ok: false, words: t(checkOf(problem).key) }))}
        />
      )}
      <ul className="fw-fin-list">
        <li>{t('issue.what.locked')}</li>
        {send && <li>{t('issue.what.sdi')}</li>}
        {send && <li>{t('issue.what.copy')}</li>}
      </ul>
      <Checkbox checked={send} onChange={(event) => setSend(event.target.checked)} label={t('issue.alsoSend')} />
      <Banner tone="warning" title={t('issue.final')} />
      {model.busy && (
        <p className="fw-fin-hint" role="status">
          <Spinner size={12} /> {t(send ? 'issue.working' : 'issue.workingOnly')}
        </p>
      )}
    </DialogFrame>
  )
}

function SendDialog({ invoice, model, actions }: { invoice: Invoice; model: InvoiceRecordModel; actions?: InvoiceRecordActions }) {
  const t = useT('finance')
  const locale = useLocale()
  const sdi = model.sdi?.value ?? null
  const again = invoice.status === 'ERROR'
  const held = model.busy ? t('held.busy') : !model.can.issueInvoices ? t('held.noIssue') : sdi && !sdi.canSend ? t('held.sdiNotNow') : null
  return (
    <DialogFrame title={t(again ? 'send.titleAgain' : 'send.title', { number: invoice.number ?? '—' })} held={held} go={() => actions?.onSend?.()} goLabel={model.busy ? t('common.working') : t(again ? 'step.sendAgain' : 'step.send')} onClose={close(actions)} problem={model.dialogProblem} size="sm">
      <p className="fw-fin-hint">{t(again ? 'send.bodyAgain' : 'send.body', { date: invoice.issueDate ? formatDate(dayInstant(invoice.issueDate), { locale }) : '—' })}</p>
      {model.busy && (
        <p className="fw-fin-hint" role="status">
          <Spinner size={12} /> {t('send.sending')}
        </p>
      )}
    </DialogFrame>
  )
}

/** The lines as a form: description, quantity, unit price, discount per line (the deposit deductions stay as they are). */
function LineFields({ drafts, setDrafts, invoice, problems }: { drafts: LineDraft[]; setDrafts: (next: LineDraft[]) => void; invoice: Invoice; problems: Record<string, string> }) {
  const t = useT('finance')
  const change = (id: string, field: keyof LineDraft, value: string) => setDrafts(drafts.map((draft) => (draft.id === id ? { ...draft, [field]: value } : draft)))
  return (
    <ol className="fw-fin-rows" aria-label={t('lines.title')}>
      {drafts.map((draft, index) => {
        const line = invoice.lines.find((entry) => entry.id === draft.id)
        return (
          <li key={draft.id} className="fw-fin-row is-line">
            <Field label={t('lines.field.description', { n: index + 1 })} error={problems[draft.id] === 'lines.problem.description' || problems[draft.id] === 'lines.problem.long' ? t(problems[draft.id]!) : undefined} hint={line?.size ? t('lines.field.size', { size: line.size }) : undefined}>
              <Input value={draft.description} maxLength={1000} onChange={(event) => change(draft.id, 'description', event.target.value)} autoComplete="off" />
            </Field>
            <Field label={t('lines.field.quantity')} error={problems[draft.id] === 'lines.problem.quantity' ? t('lines.problem.quantity') : undefined}>
              <Input inputMode="decimal" value={draft.quantity} onChange={(event) => change(draft.id, 'quantity', event.target.value)} autoComplete="off" />
            </Field>
            <Field label={t('lines.field.unitPrice')} error={problems[draft.id] === 'lines.problem.price' ? t('lines.problem.price') : undefined}>
              <Input inputMode="decimal" value={draft.unitPrice} onChange={(event) => change(draft.id, 'unitPrice', event.target.value)} autoComplete="off" />
            </Field>
            <Field label={t('lines.field.discount')} error={problems[draft.id] === 'lines.problem.discount' ? t('lines.problem.discount') : undefined}>
              <Input inputMode="decimal" value={draft.discountPct} onChange={(event) => change(draft.id, 'discountPct', event.target.value)} autoComplete="off" />
            </Field>
          </li>
        )
      })}
    </ol>
  )
}

function FixDialog({ invoice, model, actions }: { invoice: Invoice; model: InvoiceRecordModel; actions?: InvoiceRecordActions }) {
  const t = useT('finance')
  const locale = useLocale()
  const sdi = model.sdi?.value ?? null
  const rejection = sdi ? rejectionOf(sdi) : null
  const [drafts, setDrafts] = useState<LineDraft[]>(model.draft?.lines ?? lineDraftsOf(invoice.lines, locale))
  const [causale, setCausale] = useState(model.draft?.causale ?? invoice.causale ?? '')
  const problems = lineProblems(drafts)
  const changedLines = linesChanged(invoice.lines, drafts, locale)
  const changedText = causale !== (invoice.causale ?? '')
  const held = model.busy ? t('held.busy') : !model.can.issueInvoices ? t('held.noIssue') : Object.keys(problems).length > 0 ? t('fix.problemLines') : null
  const partyHref = hasRecordPage('Party', OFFICE_PAGES) && model.can.viewParties ? `${model.prefix}${recordAddress({ type: 'Party', id: invoice.buyerPartyId }, OFFICE_PAGES)}` : null
  const fixes = new Set(rejection?.errors.map((error) => error.fix) ?? [])
  const resend = model.resendProblems ?? sdi?.resend?.problems ?? []
  return (
    <DialogFrame
      title={t('fix.title', { number: invoice.number ?? '—' })}
      held={held}
      go={() => actions?.onFixAndResend?.({ lines: changedLines ? drafts : null, causale: changedText ? causale : null })}
      goLabel={model.busy ? t('common.working') : t('fix.go')}
      onClose={close(actions)}
      problem={model.dialogProblem}
      size="lg"
    >
      <Banner tone="warning" title={sdi?.deadline ? t('fix.same', { date: formatDate(dayInstant(sdi.deadline.deadline), { locale }) }) : t('fix.sameNoDate')} />
      <h3 className="fw-fin-h3">{t('sdi.reason')}</h3>
      <ul className="fw-fin-list">
        {(rejection?.errors ?? []).map((error, index) => {
          const key = sdiErrorKey(error.code)
          return (
            <li key={`${error.code}-${index}`}>
              {key ? t(key) : error.description || t('sdi.unknownError')} <span className="fw-fin-code">({error.code})</span> — {t(`sdi.fixWhere.${error.fix}`)}
            </li>
          )
        })}
        {(rejection?.errors.length ?? 0) === 0 && <li>{t('sdi.noErrorList')}</li>}
      </ul>
      {(fixes.has('party') || fixes.has('company')) && (
        <p className="fw-fin-hint">
          {t('fix.elsewhere')}{' '}
          {fixes.has('party') && partyHref && (
            <Link className="fw-fin-link" href={partyHref} target="_blank">
              {t('checks.fix.party')}
            </Link>
          )}{' '}
          {fixes.has('company') && (
            <Link className="fw-fin-link" href={`${model.prefix}/finance/settings`} target="_blank">
              {t('checks.fix.company')}
            </Link>
          )}
        </p>
      )}
      {resend.length > 0 && (
        <CheckList label={t('fix.resendChecks')} items={resend.map((problem, index) => ({ id: `${problem.code}-${index}`, ok: false, words: t(checkOf(problem).key) }))} />
      )}
      <h3 className="fw-fin-h3">{t('fix.lines')}</h3>
      <LineFields drafts={drafts} setDrafts={setDrafts} invoice={invoice} problems={problems} />
      <Field label={t('lines.causale')} hint={t('fix.causaleHint')}>
        <Textarea value={causale} rows={2} maxLength={2000} onChange={(event) => setCausale(event.target.value)} />
      </Field>
      <p className="fw-fin-hint">{t(changedLines || changedText ? 'fix.willCorrect' : 'fix.willResend')}</p>
    </DialogFrame>
  )
}

function CreditDialog({ invoice, model, actions }: { invoice: Invoice; model: InvoiceRecordModel; actions?: InvoiceRecordActions }) {
  const t = useT('finance')
  const locale = useLocale()
  const creditedBefore = invoice.creditedAmount ?? 0
  const creditable = creditableOf(invoice)
  const goods = invoice.lines.filter((line) => line.kind !== 'DEPOSIT_DEDUCTION')
  const [mode, setMode] = useState<CreditMode>(model.draft?.mode ?? (creditedBefore > 0 ? 'amount' : 'full'))
  const [reason, setReason] = useState<CreditReason | ''>(model.draft?.reason ?? '')
  const [text, setText] = useState(model.draft?.text ?? '')
  const [amount, setAmount] = useState(model.draft?.amount ?? '')
  const [picked, setPicked] = useState<Record<string, { quantity: string; unitPrice: string }>>({})
  const problems = creditProblems({ mode, reason, text, amount, picked: Object.keys(picked).length, creditedBefore, creditable })
  const first = problems.reason ?? problems.full ?? problems.lines ?? problems.amount ?? null
  const lineBad = Object.values(picked).some((entry) => parseQuantity(entry.quantity) === null || parsePrice(entry.unitPrice) === null)
  const held = model.busy ? t('held.busy') : !model.can.manageInvoices ? t('held.noManage') : first ? t(first) : lineBad ? t('credit.problem.lineValues') : null
  const go = () => {
    if (reason === '') return
    const base = { reason, reasonText: text.trim() || null }
    if (mode === 'full') actions?.onCreditNote?.({ ...base, full: true })
    else if (mode === 'lines') actions?.onCreditNote?.({ ...base, lines: Object.entries(picked).map(([lineId, entry]) => ({ lineId, quantity: parseQuantity(entry.quantity) ?? undefined, unitPrice: parsePrice(entry.unitPrice) ?? '0' })) })
    else {
      const value = parseAmount(amount)
      const treatment = invoice.vatSummary?.[0]
      if (value !== null) actions?.onCreditNote?.({ ...base, amount: value, amountBasis: 'GROSS', ...(treatment ? { vatRatePct: treatment.rate ?? '0', vatNature: treatment.nature, vatLegalRef: treatment.legalRef } : {}) })
    }
  }
  return (
    <DialogFrame title={t('credit.title', { number: invoice.number ?? '—' })} held={held} go={go} goLabel={model.busy ? t('common.working') : t('credit.go')} onClose={close(actions)} problem={model.dialogProblem} size="lg">
      <p className="fw-fin-hint">{t('credit.body')}</p>
      {model.can.price && creditable !== null && <p className="fw-fin-hint">{t('credit.creditable', { amount: money(creditable, invoice.currency, locale) })}</p>}
      <fieldset className="fw-fin-choices">
        <legend className="fw-fin-legend">{t('credit.mode')}</legend>
        {(['full', 'lines', 'amount'] as const).map((option) => (
          <RadioCard
            key={option}
            name="fw-fin-credit-mode"
            value={option}
            checked={mode === option}
            selected={mode === option}
            disabled={option === 'full' && creditedBefore > 0}
            onChange={() => setMode(option)}
            title={t(`credit.modes.${option}`)}
            description={option === 'full' && creditedBefore > 0 ? t('credit.problem.fullAfterPart') : t(`credit.modes.${option}Hint`)}
          />
        ))}
      </fieldset>
      {mode === 'lines' && (
        <ol className="fw-fin-rows" aria-label={t('credit.linesLabel')}>
          {goods.map((line) => {
            const on = !!picked[line.id]
            return (
              <li key={line.id} className="fw-fin-row">
                <Checkbox
                  checked={on}
                  onChange={(event) =>
                    setPicked((current) => {
                      const next = { ...current }
                      if (event.target.checked) next[line.id] = { quantity: String(Number(line.quantity)), unitPrice: line.unitPrice ? String(Number(line.unitPrice)) : '' }
                      else delete next[line.id]
                      return next
                    })
                  }
                  label={line.description}
                />
                {on && (
                  <div className="fw-fin-two">
                    <Field label={t('credit.quantity', { max: String(Number(line.quantity)) })}>
                      <Input inputMode="decimal" value={picked[line.id]!.quantity} onChange={(event) => setPicked((current) => ({ ...current, [line.id]: { ...current[line.id]!, quantity: event.target.value } }))} />
                    </Field>
                    {model.can.price && (
                      <Field label={t('credit.unitPrice')} hint={t('credit.unitPriceHint')}>
                        <Input inputMode="decimal" value={picked[line.id]!.unitPrice} onChange={(event) => setPicked((current) => ({ ...current, [line.id]: { ...current[line.id]!, unitPrice: event.target.value } }))} />
                      </Field>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {mode === 'amount' && (
        <Field label={t('credit.amount')} hint={t('credit.amountHint')} error={amount && problems.amount ? t(problems.amount) : undefined}>
          <Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} autoComplete="off" />
        </Field>
      )}
      <div className="fw-fin-two">
        <Field label={t('credit.reason')}>
          <Select value={reason} onChange={(event) => setReason(event.target.value as CreditReason)}>
            <option value="">{t('credit.pickReason')}</option>
            {CREDIT_REASONS.map((entry) => (
              <option key={entry} value={entry}>
                {t(`creditReason.${entry}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('credit.text')} hint={t('credit.textHint')}>
          <Input value={text} maxLength={500} onChange={(event) => setText(event.target.value)} />
        </Field>
      </div>
      <p className="fw-fin-hint">{t('credit.after')}</p>
    </DialogFrame>
  )
}

function LinesDialog({ invoice, model, actions }: { invoice: Invoice; model: InvoiceRecordModel; actions?: InvoiceRecordActions }) {
  const t = useT('finance')
  const locale = useLocale()
  const [drafts, setDrafts] = useState<LineDraft[]>(model.draft?.lines ?? lineDraftsOf(invoice.lines, locale))
  const problems = lineProblems(drafts)
  const changed = linesChanged(invoice.lines, drafts, locale)
  const held = model.busy ? t('held.busy') : !model.can.manageInvoices ? t('held.noManage') : Object.keys(problems).length > 0 ? t('fix.problemLines') : !changed ? t('held.nothingChanged') : null
  return (
    <DialogFrame title={t('linesDialog.title')} held={held} go={() => actions?.onSaveLines?.(drafts)} goLabel={model.busy ? t('common.working') : t('linesDialog.go')} onClose={close(actions)} problem={model.dialogProblem} size="lg">
      <p className="fw-fin-hint">{t('linesDialog.body')}</p>
      <LineFields drafts={drafts} setDrafts={setDrafts} invoice={invoice} problems={problems} />
    </DialogFrame>
  )
}

function DetailsDialog({ invoice, model, actions }: { invoice: Invoice; model: InvoiceRecordModel; actions?: InvoiceRecordActions }) {
  const t = useT('finance')
  const locale = useLocale()
  const [causale, setCausale] = useState(model.draft?.causale ?? invoice.causale ?? '')
  const [dueDate, setDueDate] = useState(model.draft?.dueDate ?? dueDateOf(invoice) ?? '')
  const dateBad = dueDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)
  const held = model.busy ? t('held.busy') : !model.can.manageInvoices ? t('held.noManage') : dateBad ? t('details.problem.date') : null
  return (
    <DialogFrame title={t('details.title')} held={held} go={() => actions?.onSaveDetails?.({ causale: causale || null, dueDate: dueDate || null })} goLabel={model.busy ? t('common.working') : t('details.go')} onClose={close(actions)} problem={model.dialogProblem}>
      <Field label={t('lines.causale')} hint={t('details.causaleHint')}>
        <Textarea value={causale} rows={3} maxLength={2000} onChange={(event) => setCausale(event.target.value)} />
      </Field>
      <Field label={t('lines.due')} hint={t('details.dueHint')}>
        <DateField value={dueDate} onChange={setDueDate} min={model.today} locale={INTL_LOCALE[locale]} ariaLabel={t('lines.due')} />
      </Field>
    </DialogFrame>
  )
}

function DeleteDialog({ invoice, model, actions }: { invoice: Invoice; model: InvoiceRecordModel; actions?: InvoiceRecordActions }) {
  const t = useT('finance')
  const held = model.busy ? t('held.busy') : !model.can.manageInvoices ? t('held.noManage') : null
  return (
    <DialogFrame title={t('delete.title')} held={held} go={() => actions?.onDelete?.()} goLabel={model.busy ? t('common.working') : t('delete.go')} onClose={close(actions)} problem={model.dialogProblem} size="sm" tone="danger">
      <p className="fw-fin-hint">{t('delete.body', { customer: invoice.party.legalName })}</p>
    </DialogFrame>
  )
}
