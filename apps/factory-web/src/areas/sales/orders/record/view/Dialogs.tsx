'use client'

import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { money } from '../../../quotes/model'
import type { Order } from '../../api'
import { amountText, closeHeld, closeNeedsReason, dayInstant, linePromisesAllowed, mayIssueDepositInvoice, parseAmount, paymentProblems, promiseProblems, settlementWords, stillToPay } from '../../model'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { CancelDialog, CloseLinesDialog, CompareDialog, CopyQuoteDialog, ReopenLinesDialog } from './DailyDialogs'
import { SplitOrderDialog } from './SplitOrderDialog' // F-OP-111
import { RequestedDateDialog } from './RequestedDateDialog' // F-OO-144
import { OrderNoteDialog } from './OrderNoteDialog' // F-OO-210
import { CustomerRefDialog, ShipToDialog } from './OrderFactsDialogs' // F-OL-04: Order facts' Customer PO and Ship to windows
import { StageHandDialogs } from './overview/StageByHandDialog' // F-SC-W2: the stage set by hand — one dialog for Overview and Production
import { followUpOf } from '../overview/dates' // F-OO-143: the promise dialog opened by Decide… names the customer's refusal
// F-OO-142 (order overview §4.3; B-OO-009): the reason list — what the customer reads, in Italian and English; the office's own note.
import { isPromiseReasonCode, promiseReasonChoices, promiseReasonPreview } from '../../model'
import { languageName } from '../../../../_shared/reasons/model'

// ---- F-CP-108 (customer page plan C2b; lane agreement (a), the order lead's yes): TYPE ONLY — Mark ready, Close order (and the Cancel
// in DailyDialogs) are exported with the narrow part of the record's model and actions they read, so the Orders sheet's row mounts
// THESE dialogs in place (never a copy). The record passes its whole model and actions, as before: nothing here changes what they do.
export type CommandDialogModel = Pick<OrderRecordModel, 'busy' | 'draft' | 'can' | 'dialogProblem' | 'cancelCheck' | 'prefix'>
export type CommandDialogActions = Pick<OrderRecordActions, 'onDialog' | 'onReady' | 'onClose' | 'onCancelOrder' | 'onRetryPart'>
// ---- end F-CP-108

/**
 * The order studio's dialogs: Change promise date (the order or chosen lines, the reason; the first promise never
 * changes), Mark ready (a reason; F-OO-112: only once quality released every piece), Close order (settled: a confirm; not settled:
 * what is missing and a reason), Send the bank-details page (the DEPOSIT_INFO link to the quote's contact, an optional
 * message), Record the payment (amount, day, bank reference; "Issue the deposit invoice (TD02) now" when the rule asks
 * one — a fresh authenticator code then), Send the TD02 to SDI. Esc closes; the focus returns to the opener (DS Modal);
 * ⌘↵ confirms. A refused write is said inside its dialog, what was typed stays.
 */
export function OrderDialogs({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  // F-OP-134: the dialogs by the tab acts hook that owns them (record-model.ts BandDialog · LinesDialog · MoneyDialog · ChangesDialog).
  switch (dialog.kind) {
    // The band (use-band-acts).
    case 'promise':
      return <PromiseDialog order={order} model={model} actions={actions} />
    case 'ready':
      return <ReadyDialog order={order} model={model} actions={actions} />
    case 'close':
      return <CloseDialog order={order} model={model} actions={actions} />
    case 'copyQuote':
      return <CopyQuoteDialog order={order} model={model} actions={actions} />
    // Lines (use-lines-acts; F-OP-106: the amendment has no dialog — its strip is the Lines tab's).
    case 'closeLines':
      return <CloseLinesDialog order={order} model={model} actions={actions} />
    case 'reopenLines':
      return <ReopenLinesDialog order={order} model={model} actions={actions} />
    case 'cancel':
      return <CancelDialog order={order} model={model} actions={actions} />
    case 'split': // F-OP-111
      return <SplitOrderDialog order={order} model={model} actions={actions} />
    case 'requested': // F-OO-144: Next dates' "Requested by customer" — one amendment (every line as it is + the new date)
      return <RequestedDateDialog order={order} model={model} actions={actions} />
    case 'customerRef': // F-OL-04: Order facts' Customer PO — the amendment with no lines
      return <CustomerRefDialog order={order} model={model} actions={actions} />
    case 'shipTo': // F-OL-04: Order facts' Ship to (and the band's ⋯ Change ship-to…) — the address alone
      return <ShipToDialog order={order} model={model} actions={actions} />
    // Money (use-money-acts).
    case 'depositLink':
      return <LinkDialog order={order} requestId={dialog.requestId} model={model} actions={actions} />
    case 'depositPayment':
      return <PaymentDialog order={order} requestId={dialog.requestId} model={model} actions={actions} />
    case 'sdiSend':
      return <SdiDialog order={order} invoiceId={dialog.invoiceId} model={model} actions={actions} />
    // Overview (use-overview-acts; F-OO-210: Order facts' office note — the Orders sheet's own write).
    case 'note':
      return <OrderNoteDialog order={order} model={model} actions={actions} />
    // F-SC-W2 (stage control B): the stage set by hand (use-overview-acts opens it) — Set / Change (one dialog, `pick`) and Clear… —
    // mounted ONCE here, so Overview's strip and door and Production's stage bar open the same one.
    case 'stageByHand':
    case 'stageClear':
      return <StageHandDialogs order={order} model={model} actions={actions} />
    // Changes (the container's own read).
    case 'compare':
      return <CompareDialog order={order} amendmentId={dialog.amendmentId} model={model} actions={actions} />
    default:
      return null
  }
}

/** ⌘↵ inside a dialog's form confirms it when nothing holds it. */
const confirmKeys = (held: string | null, go: () => void) => (event: KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
    event.preventDefault()
    go()
  }
}

export function Frame({ title, held, go, goLabel, onClose, children, problem, size = 'md', tone = 'primary', done, closeLabel }: { title: string; held: string | null; go: () => void; goLabel: string; onClose: () => void; children: ReactNode; problem: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl'; tone?: 'primary' | 'danger'; done?: ReactNode; closeLabel?: string }) {
  const t = useT('orders')
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size={size}
      footer={
        done ? (
          <>
            <span className="grow" />
            <Button size="sm" variant="primary" onClick={onClose}>
              {t('common.done')}
            </Button>
          </>
        ) : (
          <>
            <span className="grow" />
            <Button size="sm" onClick={onClose}>
              {closeLabel ?? t('common.cancel')}
            </Button>
            <Button size="sm" variant={tone} heldReason={held} onClick={go} aria-keyshortcuts="Meta+Enter Control+Enter">
              {goLabel}
            </Button>
          </>
        )
      }
    >
      <form
        className="fw-so-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held && !done) go()
        }}
        onKeyDown={done ? undefined : confirmKeys(held, go)}
      >
        {problem}
        {done ?? children}
      </form>
    </Modal>
  )
}

export function DialogProblem({ model }: { model: Pick<OrderRecordModel, 'dialogProblem'> /* F-CP-108: type only */ }) {
  const t = useT('orders')
  return model.dialogProblem ? <Banner tone="danger" title={t(model.dialogProblem.key, model.dialogProblem.params)} /> : null
}

function PromiseDialog({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const linesAllowed = linePromisesAllowed(order)
  // F-OL-04: a line's ⋯ "Ready-by date…" opens the dialog on that line (Chosen lines, it ticked).
  const asked = model.dialog?.kind === 'promise' ? (model.dialog.lineIds ?? null) : null
  const [scope, setScope] = useState<'order' | 'lines'>(model.draft?.scope ?? (asked && asked.length > 0 ? 'lines' : 'order'))
  const [date, setDate] = useState(model.draft?.date ?? '')
  // F-OO-142: why is picked from the curated reasons (the customer reads its words); the note is the office's own.
  const draftCode = model.draft?.reasonCode
  const [reasonCode, setReasonCode] = useState<string>(isPromiseReasonCode(draftCode) ? draftCode : '')
  const [note, setNote] = useState(model.draft?.reason ?? '')
  const [lineIds, setLineIds] = useState<string[]>(model.draft?.lineIds ?? (asked ? [...asked] : [])) // F-OL-04
  // F-PT-201 (B9): a charge line (FEE) has no date: it is never offered as a line to promise.
  const promiseLines = order.lines.filter((line) => line.kind !== 'FEE')
  const problems = promiseProblems({ date, reasonCode, today: model.today, current: order.promiseDate, lineIds, allLines: scope === 'order' })
  const firstProblem = problems.date ?? problems.lines ?? problems.reasonCode ?? null
  const held = model.busy ? t('held.busy') : firstProblem ? t(firstProblem) : null
  // F-OL-04: the reason is optional (none picked: the server's automatic words).
  const go = () => actions?.onPromise?.({ date, reasonCode: isPromiseReasonCode(reasonCode) ? reasonCode : null, note, lineIds: scope === 'lines' ? lineIds : null })
  const preview = promiseReasonPreview(reasonCode, order.language)
  // F-OO-143 (replaces F-OP-105): opened by Next dates' Decide… — the customer's refusal said first; the new date closes its follow-up in
  // the same command (B-OP-025: the whole order's, or with chosen lines only the refused line's). The ONE dialog: no second editor.
  const followUp = followUpOf(model.dialog)
  const promised = order.promiseDate ? formatDate(dayInstant(order.promiseDate), { locale }) : '—'
  return (
    <Frame title={t('promise.title', { number: order.number })} held={held} go={go} goLabel={model.busy ? t('common.working') : t('promise.go')} onClose={() => actions?.onDialog?.(null)} problem={<DialogProblem model={model} />}>
      {followUp && <Banner tone="warning" title={t(scope === 'lines' ? 'dates.refusedDialogLines' : 'dates.refusedDialog', { customer: order.party?.legalName ?? '', current: promised })} />}
      <KeyValue
        dense
        labelCase="sentence"
        items={[
          { label: t('dates.promised'), value: promised },
          { label: t('dates.firstPromised'), value: order.originalPromiseDate ? formatDate(dayInstant(order.originalPromiseDate), { locale }) : '—' },
        ]}
      />
      {linesAllowed && promiseLines.length > 1 && (
        <fieldset className="fw-so-choices">
          <legend className="fw-so-legend">{t('promise.scope')}</legend>
          <RadioCard variant="row" name="fw-so-scope" value="order" checked={scope === 'order'} selected={scope === 'order'} onChange={() => setScope('order')} title={t('promise.scopeOrder')} description={t('promise.scopeOrderHint')} />
          <RadioCard variant="row" name="fw-so-scope" value="lines" checked={scope === 'lines'} selected={scope === 'lines'} onChange={() => setScope('lines')} title={t('promise.scopeLines')} description={t('promise.scopeLinesHint')} />
        </fieldset>
      )}
      {scope === 'lines' && (
        <fieldset className="fw-so-choices">
          <legend className="fw-so-legend">{t('promise.lines')}</legend>
          {promiseLines.map((line) => (
            <Checkbox
              key={line.id}
              checked={lineIds.includes(line.id)}
              onChange={(event) => setLineIds((current) => (event.target.checked ? [...current, line.id] : current.filter((id) => id !== line.id)))}
              label={`${line.style?.code ?? '—'} · ${line.colourway ? `${line.colourway.code} ${line.colourway.name}` : '—'} (${t('list.units', { count: line.quantity })})`}
            />
          ))}
          {problems.lines && <p className="fw-so-hint">{t(problems.lines)}</p>}
        </fieldset>
      )}
      <Field label={t('promise.date')} hint={t('promise.dateHint')} error={date && problems.date ? t(problems.date) : undefined}>
        <DateField value={date} onChange={setDate} min={model.today} locale={INTL_LOCALE[locale]} ariaLabel={t('promise.date')} />
      </Field>
      {/* ---- F-OO-142: why, from the curated list (the customer reads its words, shown in Italian and English); the office's own note.
          Walk follow-up (Z01): the list says each reason in office words; the customer's own words only in "The customer reads:". ---- */}
      {/* F-OL-04: optional (ol-s1, B-OL-004) — the label says so. */}
      <Field label={`${t('promise.why')} · ${t('lineMenu.optional')}`}>
        <Select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)}>
          <option value="">{t('promise.pick')}</option>
          {promiseReasonChoices(locale, (key) => t(key)).map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </Select>
      </Field>
      {preview && (
        <>
          <p className="fw-so-hint">{t('promise.customerReads')}</p>
          <KeyValue dense labelCase="sentence" items={preview.map((entry) => ({ label: languageName(entry.locale, INTL_LOCALE[locale]), value: `“${entry.words}”` }))} />
        </>
      )}
      <Field label={t('promise.note')} hint={t('promise.reasonHint')}>
        <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={1000} />
      </Field>
      {/* ---- end F-OO-142 */}
      {/* F-PT-201 (B14): what really happens — the portal tells the customer; the floor is not told. */}
      <p className="fw-so-hint">{t('productionTab.promise.hint')}</p>
    </Frame>
  )
}

export /* F-CP-108 */ function ReadyDialog({ order, model, actions }: { order: Order; model: CommandDialogModel; actions?: CommandDialogActions } /* F-CP-108: type only */) {
  const t = useT('orders')
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  const held = model.busy ? t('held.busy') : reason.trim() === '' ? t('ready.reasonNeeded') : null
  return (
    <Frame title={t('ready.title', { number: order.number })} held={held} go={() => actions?.onReady?.(reason.trim())} goLabel={t('ready.go')} onClose={() => actions?.onDialog?.(null)} problem={<DialogProblem model={model} />}>
      <p className="fw-so-hint">{t('ready.body')}</p>
      <Field label={t('ready.reason')}>
        <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={1000} />
      </Field>
    </Frame>
  )
}

export /* F-CP-108 */ function CloseDialog({ order, model, actions }: { order: Order; model: CommandDialogModel; actions?: CommandDialogActions } /* F-CP-108: type only */) {
  const t = useT('orders')
  const needsReason = closeNeedsReason(order)
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  const rightHeld = closeHeld(order, model.can)
  const held = model.busy ? t('held.busy') : rightHeld ? t(rightHeld.key) : needsReason && reason.trim() === '' ? t('close.reasonNeeded') : null
  return (
    <Frame
      title={t('close.title', { number: order.number })}
      held={held}
      go={() => actions?.onClose?.(needsReason ? reason.trim() : null)}
      goLabel={t('close.go')}
      onClose={() => actions?.onDialog?.(null)}
      problem={<DialogProblem model={model} />}
      tone={needsReason ? 'danger' : 'primary'}
    >
      {needsReason ? (
        <>
          <Banner tone="warning" title={t('close.notSettled')} />
          <ul className="fw-so-list">
            {settlementWords(order).map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
          <Field label={t('close.reason')} hint={t('close.reasonHint')}>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={1000} />
          </Field>
        </>
      ) : (
        <p className="fw-so-hint">{t('close.settled')}</p>
      )}
      <p className="fw-so-hint">{t('close.final')}</p>
    </Frame>
  )
}

function LinkDialog({ order, requestId, model, actions }: { order: Order; requestId: string; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const request = order.chain.depositRequests.find((entry) => entry.id === requestId)
  const [message, setMessage] = useState(model.draft?.message ?? '')
  // ---- F-OM-202 (M3-B10): the customer's contact the page goes to (active, with an e-mail; '' = the usual one) ----
  const [contactId, setContactId] = useState('')
  const contacts = model.moneyPlan?.contacts ?? null
  const reachable = (contacts?.value ?? []).filter((contact) => contact.status === 'ACTIVE' && !!contact.email)
  // ---- end F-OM-202
  const sent = model.sentLink
  const held = model.busy ? t('held.busy') : null
  if (!request) return null
  const done = sent ? (
    <div className="fw-so-done" role="status">
      <CheckCircle2 size={20} className="fw-so-ico is-ok" aria-hidden />
      <span>
        {t(sent.delivery === 'failed' ? 'link.sentFailed' : 'link.sentTo', { to: sent.link.to, until: formatDate(sent.link.expiresAt, { locale }) })}
        {sent.link.revokedLinkIds.length > 0 ? ` ${t('link.revoked', { count: sent.link.revokedLinkIds.length })}` : ''}
      </span>
    </div>
  ) : undefined
  return (
    <Frame title={t('link.title')} held={held} go={() => actions?.onSendLink?.(requestId, message, contactId || null)} goLabel={model.busy ? t('common.working') : t('link.go')} onClose={() => actions?.onDialog?.(null)} problem={<DialogProblem model={model} />} done={done}>
      <p className="fw-so-hint">{t('link.body')}</p>
      <KeyValue
        dense
        labelCase="sentence"
        items={[
          { label: t('link.to'), value: request.link?.to ?? t(request.quoteVersionId ? 'link.contact' : 'link.contactTyped') },
          ...(model.can.price ? [{ label: t('deposit.amount'), value: money(stillToPay(request) ?? request.amount, request.currency, locale) }] : []),
          { label: t('deposit.due'), value: formatDate(dayInstant(request.dueDate), { locale }) },
          { label: t('link.valid'), value: t('link.validValue') },
        ]}
      />
      {/* F-OM-202: pick who gets it (the customer's contacts, parties.view); without the list: the usual contact, as above. */}
      {reachable.length > 0 ? (
        <Field label={t('moneyTab.link.contact')} hint={t('moneyTab.link.contactHint')}>
          <Select value={contactId} onChange={(event) => setContactId(event.target.value)}>
            <option value="">{t('moneyTab.link.usual', { who: request.link?.to ?? t(request.quoteVersionId ? 'link.contact' : 'link.contactTyped') })}</option>
            {reachable.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {t('moneyTab.link.option', { name: contact.name, email: contact.email ?? '' })}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {request.link?.state === 'LIVE' && <Banner tone="info" title={t('link.replaces')} />}
      <Field label={t('link.message')} hint={t('link.messageHint')}>
        <Textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={3} maxLength={2000} />
      </Field>
    </Frame>
  )
}

function PaymentDialog({ order, requestId, model, actions }: { order: Order; requestId: string; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const request = order.chain.depositRequests.find((entry) => entry.id === requestId)
  const left = request ? stillToPay(request) : null
  const [amount, setAmount] = useState(model.draft?.amount ?? (left !== null ? amountText(left, locale) : ''))
  const [receivedOn, setReceivedOn] = useState(model.draft?.receivedOn ?? model.today)
  const [reference, setReference] = useState(model.draft?.reference ?? '')
  const [note, setNote] = useState('')
  // F-OM-202 (P1-B1): the month is SOFT-locked (the API said so): why the payment goes into it anyway (3–500).
  const [lockReason, setLockReason] = useState('')
  const lockAsked = model.moneyPlan?.lockAsked ?? false
  const lockHeld = lockAsked && (lockReason.trim().length < 3 || lockReason.trim().length > 500)
  const asksInvoice = request?.fiscalDocument === 'TD02'
  const mayIssue = request ? mayIssueDepositInvoice(request, model.can) : false
  const [issue, setIssue] = useState(model.draft?.issue ?? mayIssue)
  const recorded = model.recorded
  if (!request) return null
  const problems = paymentProblems({ amount, receivedOn, reference, today: model.today, left })
  const firstProblem = problems.amount ?? problems.receivedOn ?? problems.reference ?? null
  const held = model.busy ? t('held.busy') : firstProblem ? t(firstProblem) : lockHeld ? t('moneyTab.lock.problem') : null
  const parsed = parseAmount(amount)
  const go = () => {
    if (parsed === null) return
    actions?.onRecordPayment?.(requestId, { amount: parsed, receivedOn, reference: reference.trim(), note: note.trim(), issue: asksInvoice && mayIssue && issue, ...(lockAsked ? { lockReason } : {}) })
  }
  const done = recorded ? (
    <div className="fw-so-done" role="status">
      <CheckCircle2 size={20} className="fw-so-ico is-ok" aria-hidden />
      <span className="fw-so-stack">
        <span>{t(recorded.depositRequest.status === 'PAID' ? 'payment.doneFull' : 'payment.donePart', { amount: money(recorded.payment.amount, request.currency, locale), reference: recorded.payment.externalRef })}</span>
        {recorded.depositInvoice.invoice ? (
          <span>{t(recorded.depositInvoice.filesPending ? 'payment.td02FilesPending' : 'payment.td02Issued', { number: recorded.depositInvoice.invoice.number ?? '—' })}</span>
        ) : recorded.depositInvoice.required ? (
          <span>{t('payment.td02Later')}</span>
        ) : (
          <span>{t('payment.td02NotNeeded')}</span>
        )}
      </span>
    </div>
  ) : undefined
  return (
    <Frame
      title={t('payment.title', { number: order.number })}
      held={held}
      go={go}
      goLabel={model.busy ? t('common.working') : parsed !== null ? t('payment.go', { amount: money(parsed, request.currency, locale) }) : t('payment.goEmpty')}
      onClose={() => actions?.onDialog?.(null)}
      problem={<DialogProblem model={model} />}
      done={done}
    >
      <p className="fw-so-hint">{t('payment.body')}</p>
      <div className="fw-so-two">
        <Field label={t('payment.amount')} hint={left !== null ? t('payment.amountHint', { left: money(left, request.currency, locale) }) : undefined} error={amount && problems.amount ? t(problems.amount) : undefined}>
          <Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} autoComplete="off" />
        </Field>
        <Field label={t('payment.receivedOn')} error={problems.receivedOn ? t(problems.receivedOn) : undefined}>
          <DateField value={receivedOn} onChange={setReceivedOn} max={model.today} locale={INTL_LOCALE[locale]} ariaLabel={t('payment.receivedOn')} />
        </Field>
      </div>
      {problems.over && <Banner tone="info" title={t('payment.over', { left: money(left, request.currency, locale) })} />}
      <Field label={t('payment.reference')} hint={t('payment.referenceHint')} error={reference !== '' && problems.reference ? t(problems.reference) : undefined}>
        <Input value={reference} onChange={(event) => setReference(event.target.value)} autoComplete="off" />
      </Field>
      <Field label={t('payment.note')}>
        <Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} autoComplete="off" />
      </Field>
      {/* F-OM-202 (P1-B1): asked once the API says the month is SOFT-locked; the payment then goes in with the reason. */}
      {lockAsked ? (
        <Field label={t('moneyTab.lock.label')} hint={t('moneyTab.lock.hint')} required>
          <Textarea value={lockReason} onChange={(event) => setLockReason(event.target.value)} rows={2} maxLength={500} />
        </Field>
      ) : null}
      {asksInvoice ? (
        mayIssue ? (
          <div className="fw-so-stack-tight">
            <Checkbox checked={issue} onChange={(event) => setIssue(event.target.checked)} label={t('payment.issue')} />
            <p className="fw-so-hint">{t(issue ? 'payment.issueHint' : 'payment.issueOff')}</p>
          </div>
        ) : (
          <p className="fw-so-hint">{t('payment.issueByFinance')}</p>
        )
      ) : (
        <p className="fw-so-hint">{t('payment.noInvoice')}</p>
      )}
    </Frame>
  )
}

function SdiDialog({ order, invoiceId, model, actions }: { order: Order; invoiceId: string; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const invoice = order.chain.invoices.find((entry) => entry.id === invoiceId)
  const held = model.busy ? t('held.busy') : null
  if (!invoice) return null
  return (
    <Frame title={t('sdiSend.title', { number: invoice.number ?? '—' })} held={held} go={() => actions?.onSendSdi?.(invoiceId)} goLabel={model.busy ? t('common.working') : t('sdiSend.go')} onClose={() => actions?.onDialog?.(null)} problem={<DialogProblem model={model} />} size="sm">
      <p className="fw-so-hint">{t('sdiSend.body', { date: invoice.issueDate ? formatDate(dayInstant(invoice.issueDate), { locale }) : '—' })}</p>
      {model.busy && (
        <p className="fw-so-hint" role="status">
          <Spinner size={12} /> {t('sdiSend.sending')}
        </p>
      )}
    </Frame>
  )
}
