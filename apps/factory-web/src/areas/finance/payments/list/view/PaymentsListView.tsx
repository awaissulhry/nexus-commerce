'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, Download, MoreHorizontal, Plus, Search } from 'lucide-react'
import { Banner, EmptyState, Field, KeyValue, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, Input, Pill, Select, Tag } from '@nexus/ui/primitives'
import { DateField, Modal, StepUpModal } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { PaymentRow } from '../../../_shared/api'
import { allocationsOf, dayInstant, leftToPlace, money, parseAmount, paymentProblems, PLACED_TONE, placedLabel, placedStateOf, placementProblems } from '../../../_shared/model'
import { DialogFrame } from '../../../_shared/parts'
import { Placement, planOf } from '../../../_shared/placement'
import { refundHeld, refundsTile } from '../../refunds/model'
import { RefundDialog, RefundMoveDialog } from '../../refunds/view/RefundDialogs'
import { RefundsList } from '../../refunds/view/RefundsList'
import { PAYMENT_ROWS_VIEWS, type PaymentRowsView, type PaymentsListActions, type PaymentsListModel } from '../list-model'
import '../../../_shared/finance.css'

export type { PaymentsListActions, PaymentsListModel } from '../list-model'

/**
 * SCR-082 — Payments (Finance; design finance.payments): money in this month and what is not placed yet (tiles), then
 * every payment — the day it arrived, the customer, the method, the amount, the bank reference (unique: a transfer counts
 * once), where it is placed (chips: a deposit, an invoice), what is left, its state — on the shared list frame (select-all,
 * shift range, x; Export N; keys only in the footer's info icon). Record payment: who paid, when, how much, the bank
 * reference (step 1), then where it goes, oldest first, with what is left always in view (step 2); a deposit paid in full
 * may issue its deposit invoice (TD02) in the same step (a fresh authenticator code). Money only with the price grain.
 */
export function PaymentsListView({ model, actions }: { model: PaymentsListModel; actions?: PaymentsListActions }) {
  return (
    <WithMessages namespaces={['finance', 'finance-daily', 'lists']}>
      <PaymentsList model={model} actions={actions} />
    </WithMessages>
  )
}

function PaymentsList({ model, actions }: { model: PaymentsListModel; actions?: PaymentsListActions }) {
  const t = useT('finance')
  const d = useT('finance-daily')
  const lists = useT('lists')
  const locale = useLocale()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(!!model.helpOpen)
  const items = model.list.items
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const recordHeld = !model.can.recordPayments ? t('held.noRecord') : !model.companyId ? t('held.noCompany') : null

  // c: Record payment (the design's key) — never while typing or inside a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || help || model.dialog) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === 'c' && !recordHeld) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'record', step: 1, customer: null, invoiceId: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('payments.keyRecord') }]

  const columns = useMemo<ColDef<PaymentRow>[]>(() => {
    const href = (row: PaymentRow) => `${model.prefix}/finance/payments/${row.id}`
    const DateCell = ({ data }: ICellRendererParams<PaymentRow>) =>
      data ? (
        <span className="fw-fin-cell">
          <Link className="fw-fin-link" href={href(data)}>
            {day(data.receivedOn)}
          </Link>
          <span className="fw-fin-cell-sub">{t('payments.method.BANK_TRANSFER')}</span>
        </span>
      ) : null
    const CustomerCell = ({ data }: ICellRendererParams<PaymentRow>) => (data ? <span className="fw-fin-ellipsis">{data.partyName}</span> : null)
    const RefCell = ({ data }: ICellRendererParams<PaymentRow>) => (data ? <span className="fw-fin-code">{data.externalRef}</span> : null)
    const AmountCell = ({ data }: ICellRendererParams<PaymentRow>) => (data ? <span className="fw-fin-num">{money(data.amount, data.currency, locale)}</span> : null)
    const LeftCell = ({ data }: ICellRendererParams<PaymentRow>) => (data ? <span className="fw-fin-num">{data.status === 'VOIDED' ? '—' : money(data.unallocated, data.currency, locale)}</span> : null)
    const PlacedCell = ({ data }: ICellRendererParams<PaymentRow>) =>
      data ? (
        data.placedOn.length === 0 ? (
          <span>{t(data.status === 'VOIDED' ? 'payments.voided' : 'payments.nothingPlaced')}</span>
        ) : (
          <span className="fw-fin-chips">
            {data.placedOn.map((entry) => {
              const label = placedLabel(entry)
              return entry.target === 'INVOICE' ? (
                <Link key={entry.targetId} className="fw-fin-link" href={`${model.prefix}/finance/invoices/${entry.targetId}`}>
                  <Tag tone="info">{t(label.key, label.params)}</Tag>
                </Link>
              ) : (
                <Tag key={entry.targetId} tone="neutral">
                  {t(label.key, label.params)}
                </Tag>
              )
            })}
          </span>
        )
      ) : null
    const StateCell = ({ data }: ICellRendererParams<PaymentRow>) => {
      if (!data) return null
      const state = placedStateOf(data)
      return state ? <Pill tone={PLACED_TONE[state]}>{t(`placed.${state}`)}</Pill> : <span>{t(`paymentStatus.${data.status}`)}</span>
    }
    const MoreCell = ({ data }: ICellRendererParams<PaymentRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('payments.rowMenu', { reference: data.externalRef }) }}
          items={[
            { id: 'open', label: t('list.open'), href: href(data) },
            { id: 'tab', label: t('list.openNewTab'), href: href(data), target: '_blank' },
          ]}
        />
      ) : null
    return [
      { colId: 'date', headerName: t('col.receivedOn'), field: 'receivedOn', minWidth: 120, flex: 0.8, cellRenderer: DateCell },
      { colId: 'customer', headerName: t('col.customer'), field: 'partyName', minWidth: 160, flex: 1.3, cellRenderer: CustomerCell },
      { colId: 'ref', headerName: t('col.reference'), field: 'externalRef', minWidth: 150, flex: 1, cellRenderer: RefCell },
      ...(model.can.price ? [{ colId: 'amount', headerName: t('col.amount'), minWidth: 110, flex: 0.8, type: 'rightAligned', cellRenderer: AmountCell }] : []),
      { colId: 'placed', headerName: t('col.placedOn'), minWidth: 200, flex: 1.6, cellRenderer: PlacedCell },
      ...(model.can.price ? [{ colId: 'left', headerName: t('col.notPlaced'), minWidth: 110, flex: 0.8, type: 'rightAligned', cellRenderer: LeftCell }] : []),
      { colId: 'state', headerName: t('col.state'), minWidth: 130, flex: 0.8, cellRenderer: StateCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.prefix, model.can.price])

  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const state = model.list.problem ? (
    <EmptyState title={t('payments.failed')} description={t(model.list.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    model.rows !== 'all' ? (
      <EmptyState title={t('list.noMatch.title')} description={t('list.noMatch.body')} action={<Button size="sm" onClick={() => actions?.onRows?.('all')}>{t('list.clearFilters')}</Button>} />
    ) : (
      <EmptyState
        title={t('payments.empty.title')}
        description={t('payments.empty.body')}
        action={
          <Button size="sm" heldReason={recordHeld} onClick={() => actions?.onDialog?.({ kind: 'record', step: 1, customer: null, invoiceId: null })}>
            {t('step.recordPayment')}
          </Button>
        }
      />
    )
  ) : undefined

  const rowsSelect = (
    <Select size="sm" aria-label={t('list.rowsLabel')} value={model.rows} onChange={(event) => actions?.onRows?.(event.target.value as PaymentRowsView)}>
      {PAYMENT_ROWS_VIEWS.map((view) => (
        <option key={view} value={view}>
          {t(`payRows.${view}`)}
        </option>
      ))}
    </Select>
  )
  const tiles = model.tiles
  // B-W2a-80: "Refunds to make" (a saved filter: Rows ▾ Refunds) and the band's Refund (design page.h: secondary).
  const refundTile = refundsTile(model.openRefunds ?? null)
  const refundCan = model.refundCan ?? { view: model.can.viewPayments, refund: false, void: model.can.voidPayments, price: model.can.price }
  const refundWait = refundHeld(refundCan, model.live === 'offline')

  return (
    <div className="fw-fin">
      <div className="fw-fin-head">
        <span className="fw-fin-status" role="status">
          {model.asOf ? t('list.updated', { time: formatTime(model.asOf, { locale }) }) : t('list.notYet')}
          {' · '}
          {t(`live.${model.live}`)}
        </span>
        <span className="fw-fin-actions">
          <Button size="sm" heldReason={refundWait ? d(refundWait.key, refundWait.params) : null} onClick={() => actions?.onOpenRefund?.(null)}>
            {d('refund.open')}
          </Button>
          <Button size="sm" variant="primary" heldReason={recordHeld} onClick={() => actions?.onDialog?.({ kind: 'record', step: 1, customer: null, invoiceId: null })} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> {t('step.recordPayment')}
          </Button>
        </span>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.words.key, model.notice.words.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}

      <MetricStrip
        metrics={[
          { label: t('payTile.month'), value: tiles ? (model.can.price ? money(tiles.monthAmount, 'EUR', locale) : String(tiles.monthCount)) : '—', hint: tiles ? t('payTile.monthCount', { count: tiles.monthCount }) : undefined },
          { label: t('payTile.notPlaced'), value: tiles ? (model.can.price ? money(tiles.notPlacedAmount, 'EUR', locale) : String(tiles.notPlacedCount)) : '—', hint: tiles ? t(tiles.capped ? 'payTile.notPlacedCapped' : 'payTile.notPlacedCount', { count: tiles.notPlacedCount }) : undefined },
          {
            label: d('refunds.tile'),
            value: refundTile.value,
            hint: refundTile.hint ? d(refundTile.hint.key, refundTile.hint.params) : undefined,
            onClick: () => actions?.onRows?.(model.rows === 'refunds' ? 'all' : 'refunds'),
            active: model.rows === 'refunds',
          },
        ]}
      />

      {model.rows === 'refunds' && model.refunds && (
        <RefundsList
          model={model.refunds}
          tools={rowsSelect}
          keys={ownKeys}
          onHelp={() => setHelp(true)}
          actions={{
            onRows: actions?.onRefundRows,
            onMore: actions?.onRefundMore,
            onRetry: actions?.onRetryRefunds,
            onRefund: (note) => actions?.onOpenRefund?.(note),
            onMove: actions?.onMoveRefund,
            onExport: actions?.onExportRefunds,
          }}
        />
      )}
      {model.rows !== 'refunds' && (
      <ListFrame<PaymentRow>
        label={t('payments.title')}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t(model.list.more ? 'payments.countMore' : 'payments.count', { count: items.length }) : '—'}
        tools={rowsSelect}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" variant="primary" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.list.more && items && items.length > 0 ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
      />
      )}

      {model.dialog?.kind === 'record' && <RecordDialog model={model} actions={actions} />}
      {model.refundDialog && <RefundDialog model={model.refundDialog} onRecord={(target, draft) => actions?.onRecordRefund?.(target, draft)} onRetry={() => actions?.onRetryRefunds?.()} onClose={() => actions?.onCloseRefund?.()} />}
      {model.refundMove && (
        <RefundMoveDialog
          key={`${model.refundMove.refund.id}-${model.refundMove.move}`}
          refund={model.refundMove.refund}
          move={model.refundMove.move}
          can={refundCan}
          today={model.today}
          busy={model.refundMove.busy}
          problem={model.refundMove.problem}
          start={model.refundMove.start}
          onMove={(input) => actions?.onDoMove?.(input)}
          onClose={() => actions?.onCloseMove?.()}
        />
      )}

      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('list.keysTitle')} size="sm">
          <ul className="fw-fin-list">
            {listKeys(ownKeys, true).map((entry) => (
              <li key={entry.does}>
                <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
      <StepUpModal
        open={model.stepUp.open}
        title={t('stepUp.title')}
        sentence={model.stepUp.sentence ? t(model.stepUp.sentence) : ''}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? t(model.stepUp.problem) : null}
        onSubmit={(code) => actions?.onStepUpSubmit?.(code)}
        onClose={() => actions?.onStepUpCancel?.()}
        confirmLabel={t('stepUp.confirm')}
      />
    </div>
  )
}

/**
 * "Record a payment" (design popup record): step 1 — the customer, the day it arrived, the amount, the bank reference
 * (unique: "this reference was recorded already" is held), a note; Enter moves to step 2 — where it goes (Placement),
 * and, when the only placement is a deposit request it pays in full, "Issue the deposit invoice (TD02) now" (on by
 * default when the request's document is TD02 and the person may issue). The primary says what it does.
 */
function RecordDialog({ model, actions }: { model: PaymentsListModel; actions?: PaymentsListActions }) {
  const t = useT('finance')
  const locale = useLocale()
  const dialog = model.dialog!
  const [q, setQ] = useState(model.customers.q)
  const [amount, setAmount] = useState(model.draft?.amount ?? '')
  const [receivedOn, setReceivedOn] = useState(model.draft?.receivedOn ?? model.today)
  const [reference, setReference] = useState(model.draft?.reference ?? '')
  const [note, setNote] = useState('')
  const [typed, setTyped] = useState<Record<string, string>>(model.draft?.plan ?? {})
  const [issue, setIssue] = useState(model.draft?.issue ?? true)
  const typedQ = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typedQ.current) return
    const timer = setTimeout(() => latest.current?.onSearchCustomers?.(q), 300)
    return () => clearTimeout(timer)
  }, [q])
  // Opened from an invoice: that invoice takes the amount it asks, once the items are read.
  const preset = useRef(false)
  useEffect(() => {
    if (preset.current || !dialog.invoiceId || !model.items.value) return
    const item = model.items.value.find((entry) => entry.id === dialog.invoiceId)
    if (!item) return
    preset.current = true
    setTyped({ [item.id]: ((item.openAmount ?? 0) / 100).toFixed(2).replace('.', locale === 'it' ? ',' : '.') })
    if (amount === '') setAmount(((item.openAmount ?? 0) / 100).toFixed(2).replace('.', locale === 'it' ? ',' : '.'))
  }, [dialog.invoiceId, model.items.value, amount, locale])

  const parsed = parseAmount(amount)
  const problems = paymentProblems({ partyId: dialog.customer?.id ?? null, amount, receivedOn, reference, today: model.today })
  const firstProblem = problems.party ?? problems.amount ?? problems.receivedOn ?? problems.reference ?? null
  const plan = planOf(typed)
  const placement = model.items.value ? placementProblems(model.items.value, plan, parsed ?? 0) : { items: {}, total: null }
  const allocations = model.items.value ? allocationsOf(model.items.value, plan) : []
  const onlyDeposit = allocations.length === 1 && allocations[0]!.depositRequestId ? model.items.value!.find((item) => item.id === allocations[0]!.depositRequestId)! : null
  const coversDeposit = onlyDeposit ? (plan[onlyDeposit.id] ?? 0) >= (onlyDeposit.openAmount ?? Number.POSITIVE_INFINITY) : false
  const asksTd02 = !!onlyDeposit && onlyDeposit.fiscalDocument === 'TD02' && coversDeposit
  const currency = dialog.customer ? (model.customers.items?.find((entry) => entry.id === dialog.customer!.id)?.currency ?? 'EUR') : 'EUR'
  const recorded = model.recorded

  if (recorded) {
    const payment = recorded.payment
    return (
      <DialogFrame title={t('recordPay.titleDone')} held={null} go={() => undefined} goLabel="" onClose={() => actions?.onDialog?.(null)} done={<RecordedDone model={model} />}>
        <span>{payment.externalRef}</span>
      </DialogFrame>
    )
  }

  if (dialog.step === 1) {
    const held = model.busy ? t('held.busy') : firstProblem ? t(firstProblem) : null
    return (
      <DialogFrame title={t('recordPay.title')} held={held} go={() => actions?.onDialog?.({ ...dialog, step: 2 })} goLabel={t('recordPay.next')} onClose={() => actions?.onDialog?.(null)} problem={model.dialogProblem}>
        <p className="fw-fin-hint">{t('recordPay.body')}</p>
        {dialog.customer ? (
          <KeyValue dense labelCase="sentence" items={[{ label: t('recordPay.customer'), value: dialog.customer.name }]} />
        ) : (
          <Field label={t('recordPay.customer')} hint={t('recordPay.customerHint')}>
            <Input
              type="search"
              leadingIcon={<Search size={13} aria-hidden />}
              value={q}
              onChange={(event) => {
                typedQ.current = true
                setQ(event.target.value)
              }}
              autoComplete="off"
            />
          </Field>
        )}
        {!dialog.customer && (
          <ul className="fw-fin-rows" aria-label={t('recordPay.customers')}>
            {model.customers.problem ? (
              <li>{t(model.customers.problem)}</li>
            ) : model.customers.items === null ? (
              <li className="fw-fin-hint">{t('recordPay.searching')}</li>
            ) : model.customers.items.length === 0 ? (
              <li className="fw-fin-hint">{t('recordPay.noCustomer')}</li>
            ) : (
              model.customers.items.slice(0, 8).map((customer) => (
                <li key={customer.id} className="fw-fin-row is-item">
                  <span className="fw-fin-cell">
                    <span>{customer.legalName}</span>
                    <span className="fw-fin-cell-sub">{[customer.code, customer.vatNumber].filter(Boolean).join(' · ')}</span>
                  </span>
                  <Button size="sm" onClick={() => model.companyId && actions?.onPickCustomer?.({ id: customer.id, name: customer.legalName, companyId: customer.companyId ?? model.companyId })}>
                    {t('recordPay.pick')}
                  </Button>
                </li>
              ))
            )}
          </ul>
        )}
        <div className="fw-fin-two">
          <Field label={t('recordPay.receivedOn')} error={problems.receivedOn ? t(problems.receivedOn) : undefined}>
            <DateField value={receivedOn} onChange={setReceivedOn} max={model.today} locale={INTL_LOCALE[locale]} ariaLabel={t('recordPay.receivedOn')} />
          </Field>
          <Field label={t('recordPay.amount')} error={amount && problems.amount ? t(problems.amount) : undefined}>
            <Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} autoComplete="off" />
          </Field>
        </div>
        <div className="fw-fin-two">
          <Field label={t('recordPay.method')}>
            <Input value={t('payments.method.BANK_TRANSFER')} readOnly />
          </Field>
          <Field label={t('recordPay.reference')} hint={t('recordPay.referenceHint')} error={reference && problems.reference ? t(problems.reference) : undefined}>
            <Input value={reference} onChange={(event) => setReference(event.target.value)} autoComplete="off" />
          </Field>
        </div>
        <Field label={t('recordPay.note')}>
          <Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} autoComplete="off" />
        </Field>
      </DialogFrame>
    )
  }

  const placementHeld = Object.keys(placement.items).length > 0 ? t('match.problem.fix') : placement.total ? t(placement.total) : null
  const held = model.busy ? t('held.busy') : firstProblem ? t(firstProblem) : placementHeld
  const go = () => {
    if (!dialog.customer || parsed === null) return
    actions?.onRecord?.({ customer: dialog.customer, amount: parsed, receivedOn, reference: reference.trim(), note: note.trim(), plan, issueDepositInvoice: asksTd02 && issue && model.can.issueInvoices })
  }
  const left = parsed === null ? 0 : leftToPlace(parsed, plan)
  return (
    <DialogFrame
      title={t('recordPay.titleStep2', { customer: dialog.customer?.name ?? '—' })}
      held={held}
      go={go}
      goLabel={model.busy ? t('common.working') : parsed !== null ? t(allocations.length > 0 ? 'recordPay.go' : 'recordPay.goOnAccount', { amount: money(parsed, currency, locale) }) : t('recordPay.goEmpty')}
      onClose={() => actions?.onDialog?.(null)}
      problem={model.dialogProblem}
      size="lg"
    >
      <KeyValue
        dense
        labelCase="sentence"
        columns={2}
        items={[
          { label: t('recordPay.amount'), value: parsed === null ? '—' : money(parsed, currency, locale) },
          { label: t('recordPay.receivedOn'), value: formatDate(dayInstant(receivedOn), { locale }) },
          { label: t('recordPay.reference'), value: reference || '—' },
          { label: t('recordPay.method'), value: t('payments.method.BANK_TRANSFER') },
        ]}
      />
      <span className="fw-fin-inline">
        <Button size="sm" variant="link" onClick={() => actions?.onDialog?.({ ...dialog, step: 1 })}>
          {t('recordPay.back')}
        </Button>
      </span>
      <h3 className="fw-fin-h3">{t('match.title')}</h3>
      <Placement items={model.items.value} problem={model.items.problem} amount={parsed ?? 0} currency={currency} typed={typed} setTyped={setTyped} onRetry={() => actions?.onRetryItems?.()} price={model.can.price} />
      {left > 0 && allocations.length > 0 && <p className="fw-fin-hint">{t('recordPay.restOnAccount', { amount: money(left, currency, locale) })}</p>}
      {asksTd02 &&
        (model.can.issueInvoices ? (
          <div className="fw-fin-stack-tight">
            <Checkbox checked={issue} onChange={(event) => setIssue(event.target.checked)} label={t('recordPay.issueTd02')} />
            <p className="fw-fin-hint">{t(issue ? 'recordPay.issueTd02Hint' : 'recordPay.issueTd02Off')}</p>
          </div>
        ) : (
          <p className="fw-fin-hint">{t('recordPay.td02ByFinance')}</p>
        ))}
    </DialogFrame>
  )
}

function RecordedDone({ model }: { model: PaymentsListModel }) {
  const t = useT('finance')
  const locale = useLocale()
  const recorded = model.recorded!
  const payment = recorded.payment
  return (
    <div className="fw-fin-done" role="status">
      <CheckCircle2 size={20} className="fw-fin-ico is-ok" aria-hidden />
      <span className="fw-fin-stack-tight">
        <span>{t('recordPay.done', { amount: money(payment.amount, payment.currency, locale), reference: payment.externalRef })}</span>
        {payment.placedOn.length > 0 ? (
          <span>
            {t('recordPay.placedOn', {
              list: payment.placedOn
                .map((entry) => {
                  const label = placedLabel(entry)
                  return t(label.key, label.params)
                })
                .join(', '),
            })}
          </span>
        ) : (
          <span>{t('recordPay.notPlaced')}</span>
        )}
        {(payment.unallocated ?? 0) > 0 && <span>{t('recordPay.leftOnAccount', { amount: money(payment.unallocated, payment.currency, locale) })}</span>}
        {recorded.depositInvoice?.number && <span>{t(recorded.depositInvoice.filesPending ? 'recordPay.td02FilesPending' : 'recordPay.td02Issued', { number: recorded.depositInvoice.number })}</span>}
        {recorded.depositInvoice && !recorded.depositInvoice.number && recorded.depositInvoice.required && <span>{t('recordPay.td02Later')}</span>}
        <Link className="fw-fin-link" href={`${model.prefix}/finance/payments/${payment.id}`}>
          {t('recordPay.openPayment')}
        </Link>
      </span>
    </div>
  )
}
