'use client'

import { useMemo, useRef } from 'react'
import Link from 'next/link'
import { Ban, CheckCheck, CreditCard, MoreHorizontal, Plus, Send, Undo2 } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, Menu, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { Combobox } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayInstant, decimal, money, unitPrice } from '../../../_shared/model'
import type { InvoiceLine, SupplierInvoice } from '../../api'
import { actionHeld, mappingOptions, mappingValue, orderHref, PAYABLES_NAMESPACE, refusalPhrase, unmappedLines, type Phrase } from '../../model'
import type { SupplierInvoiceActions, SupplierInvoiceModel } from '../record-model'
import { MatchPanel } from './MatchPanel'

interface TabProps {
  readonly invoice: SupplierInvoice
  readonly model: SupplierInvoiceModel
  readonly actions?: SupplierInvoiceActions
}

const EMPTY_LINE = { description: '', quantity: '', uom: '', unitPrice: '', net: '', vatRate: '22', vatNature: '' }

/** The words of a held action or permission (null: allowed). */
function useHeld() {
  const t = useT(PAYABLES_NAMESPACE)
  return (phrase: Phrase | null): string | null => (phrase ? t(phrase.key, phrase.params) : null)
}

/**
 * Lines (design rec "Supplier invoice" › Lines: "Lines read from the XML (or typed for foreign PDFs), mapped to PO lines";
 * autosave per cell): each line with what it bills — a PO line or a subcontract order picked in the Combobox, saved at once
 * (or a service, a charge) —, quantity, unit price, VAT and net (the cost grain: the columns are not drawn without it);
 * "Mark it as an invoice without PO" for the goods lines still without an order. A typed invoice's lines are changed,
 * added and removed here; an SDI invoice's figures never change.
 */
export function LinesTab({ invoice, model, actions }: TabProps) {
  const t = useT(PAYABLES_NAMESPACE)
  const locale = useLocale()
  const held = useHeld()
  const can = model.can
  const mapHeld = !can.manage ? { key: 'held.manage' } : actionHeld(invoice, 'map')
  const editHeld = !can.manage ? { key: 'held.manage' } : actionHeld(invoice, 'edit')
  const typed = invoice.source !== 'SDI'
  const live = useRef({ actions, model })
  live.current = { actions, model }
  const options = useMemo(
    () => (line: InvoiceLine) =>
      mappingOptions(model.candidates?.value ?? null, line, {
        poLine: (order, seq, item, quantity) => t('lines.optionPo', { order, seq, item, quantity }),
        subcontract: (order) => t('lines.optionSubcontract', { order }),
        service: t('lines.optionService'),
        charge: t('lines.optionCharge'),
      }),
    [model.candidates, t],
  )

  const columns = useMemo<ColDef<InvoiceLine>[]>(() => {
    const DescriptionCell = ({ data }: ICellRendererParams<InvoiceLine>) =>
      data ? (
        <span className="fw-fpy-cell">
          <span className="fw-fpy-ellipsis">{data.description}</span>
          <span className="fw-fpy-cell-sub">{[data.itemCode, t(`kind.line.${data.kind}`)].filter(Boolean).join(' · ')}</span>
        </span>
      ) : null
    const QuantityCell = ({ data }: ICellRendererParams<InvoiceLine>) =>
      data ? <span className="fw-fpy-num">{data.quantity ? `${decimal(data.quantity, locale)} ${data.uom ?? ''}` : '—'}</span> : null
    const PriceCell = ({ data }: ICellRendererParams<InvoiceLine>) => (data ? <span className="fw-fpy-num">{unitPrice(data.unitPrice ?? null, invoice.currency, locale)}</span> : null)
    const VatCell = ({ data }: ICellRendererParams<InvoiceLine>) =>
      data ? <span className="fw-fpy-num">{Number(data.vatRatePct) === 0 && data.vatNature ? data.vatNature : `${decimal(data.vatRatePct, locale, 2)} %`}</span> : null
    const NetCell = ({ data }: ICellRendererParams<InvoiceLine>) => (data ? <span className="fw-fpy-num">{money(data.netAmount ?? null, invoice.currency, locale)}</span> : null)
    const MapCell = ({ data }: ICellRendererParams<InvoiceLine>) => {
      if (!data) return null
      const current = live.current
      const saving = current.model.savingLine === data.id
      const problem = current.model.lineProblem?.lineId === data.id ? current.model.lineProblem.phrases : null
      const label = data.purchaseOrderLine
        ? t('lines.mappedPo', { order: data.purchaseOrderLine.orderNumber, seq: data.purchaseOrderLine.seq })
        : data.subcontractOrder
          ? t('lines.mappedSubcontract', { order: data.subcontractOrder.number })
          : data.kind === 'SERVICE' || data.kind === 'CHARGE'
            ? t(`kind.line.${data.kind}`)
            : t('lines.notMapped')
      if (mapHeld || current.model.candidates === null) {
        return (
          <span className="fw-fpy-cell">
            {data.purchaseOrderLine && can.purchasing ? (
              <Link className="fw-fpy-link" href={orderHref(model.prefix, data.purchaseOrderLine.orderId)}>
                {label}
              </Link>
            ) : (
              <span>{label}</span>
            )}
          </span>
        )
      }
      return (
        <span className="fw-fpy-map">
          <span className="fw-fpy-map-row">
            <Combobox
              className="fw-fpy-combo"
              options={options(data)}
              value={mappingValue(data)}
              placeholder={t('lines.mapPlaceholder')}
              labelledBy="fw-fpy-map-label"
              onChange={(value) => current.actions?.onMap?.(data.id, value)}
            />
            {saving && <Spinner size={12} />}
          </span>
          {problem && <span className="fw-fpy-cell-sub fw-fpy-tone is-danger">{problem.map((phrase) => t(phrase.key, phrase.params)).join(' ')}</span>}
        </span>
      )
    }
    const RowCell = ({ data }: ICellRendererParams<InvoiceLine>) => {
      if (!data) return null
      const items: MenuItemDef[] = [
        {
          id: 'edit',
          label: t('lines.edit'),
          disabled: !!editHeld,
          description: held(editHeld) ?? undefined,
          onSelect: () => live.current.actions?.onDialog?.({ kind: 'line', lineId: data.id, draft: draftOf(data) }),
        },
        {
          id: 'remove',
          label: t('lines.remove'),
          tone: 'danger',
          disabled: !!editHeld || invoice.lines.length <= 1,
          description: editHeld ? (held(editHeld) ?? undefined) : invoice.lines.length <= 1 ? t('held.lastLine') : undefined,
          onSelect: () => live.current.actions?.onDialog?.({ kind: 'removeLine', lineId: data.id }),
        },
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('lines.menu', { seq: data.seq }) }} items={items} />
    }
    return [
      { colId: 'seq', headerName: t('lines.col.seq'), field: 'seq', width: 70, minWidth: 64 },
      { colId: 'description', headerName: t('lines.col.description'), minWidth: 220, flex: 1.6, cellRenderer: DescriptionCell },
      { colId: 'quantity', headerName: t('lines.col.quantity'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: QuantityCell },
      ...(can.cost ? [{ colId: 'price', headerName: t('lines.col.price'), minWidth: 120, flex: 0.7, type: 'rightAligned', cellRenderer: PriceCell } satisfies ColDef<InvoiceLine>] : []),
      { colId: 'vat', headerName: t('lines.col.vat'), minWidth: 80, flex: 0.5, type: 'rightAligned', cellRenderer: VatCell },
      ...(can.cost ? [{ colId: 'net', headerName: t('lines.col.net'), minWidth: 120, flex: 0.7, type: 'rightAligned', cellRenderer: NetCell } satisfies ColDef<InvoiceLine>] : []),
      { colId: 'map', headerName: t('lines.col.map'), minWidth: 280, flex: 1.8, cellRenderer: MapCell, autoHeight: true },
      ...(typed ? [{ colId: 'menu', headerName: t('lines.col.menu'), width: 80, minWidth: 80, cellRenderer: RowCell, suppressHeaderMenuButton: true } satisfies ColDef<InvoiceLine>] : []),
    ]
  }, [t, locale, invoice, can, typed, mapHeld, editHeld, options, model.prefix, model.savingLine, model.lineProblem, model.candidates])

  const unmapped = unmappedLines(invoice)
  return (
    <div className="fw-fpy-stack">
      <span id="fw-fpy-map-label" className="fw-fpy-file">
        {t('lines.col.map')}
      </span>
      <div className="fw-fpy-head">
        <span className="fw-fpy-muted">{typed ? t('lines.typedHint') : t('lines.sdiHint')}</span>
        <span className="fw-fpy-inline">
          {typed && (
            <Button size="sm" heldReason={held(editHeld)} onClick={() => actions?.onDialog?.({ kind: 'line', lineId: null, draft: EMPTY_LINE })}>
              <Plus size={14} aria-hidden /> {t('lines.add')}
            </Button>
          )}
          {unmapped > 0 && (
            <Button size="sm" heldReason={held(mapHeld) ?? (model.busy ? t('held.busy') : null)} onClick={() => actions?.onDialog?.({ kind: 'withoutOrder' })}>
              {t('lines.withoutOrder', { count: unmapped })}
            </Button>
          )}
        </span>
      </div>
      {model.candidates?.problem && (
        <Banner
          tone="warning"
          title={t('lines.candidatesFailed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetryCandidates?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      <ListFrame<InvoiceLine>
        label={t('lines.title')}
        rows={invoice.lines}
        rowId={(line) => line.id}
        columns={columns}
        count={t('lines.count', { count: invoice.lines.length })}
        listKey={null}
        state={invoice.lines.length === 0 ? <EmptyState title={t('lines.empty.title')} description={t('lines.empty.body')} /> : undefined}
      />
      {can.cost && invoice.vatSummary && (
        <Card padded>
          <div className="fw-fpy-stack">
            <h3 className="fw-fpy-h3">{t('lines.totals')}</h3>
            <SummaryTable
              label={t('lines.totals')}
              columns={[t('lines.vatCol.rate'), t('lines.vatCol.taxable'), t('lines.vatCol.vat')]}
              align={['left', 'right', 'right']}
              stackOnPhone
              rows={[
                ...invoice.vatSummary.map((row, index) => ({
                  id: `vat-${index}`,
                  cells: [
                    row.nature && Number(row.rate ?? 0) === 0 ? row.nature : `${decimal(row.rate ?? '0', locale, 2)} %`,
                    money(row.taxable, invoice.currency, locale),
                    money(row.vat, invoice.currency, locale),
                  ],
                })),
                { id: 'total', cells: [t('lines.total'), money(invoice.netTotal ?? null, invoice.currency, locale), money(invoice.vatTotal ?? null, invoice.currency, locale)] },
              ]}
            />
            <p className="fw-fpy-muted">{t('lines.gross', { amount: money(invoice.grossTotal ?? null, invoice.currency, locale) })}</p>
            {typeof invoice.withholdingAmount === 'number' && <p className="fw-fpy-muted">{t('lines.withholding', { amount: money(invoice.withholdingAmount, invoice.currency, locale) })}</p>}
            {typeof invoice.stampDutyAmount === 'number' && <p className="fw-fpy-muted">{t('lines.stamp', { amount: money(invoice.stampDutyAmount, invoice.currency, locale) })}</p>}
          </div>
        </Card>
      )}
      {!can.cost && <p className="fw-fpy-muted">{t('lines.noCost')}</p>}
    </div>
  )
}

function draftOf(line: InvoiceLine) {
  return {
    description: line.description,
    quantity: line.quantity ?? '',
    uom: line.uom ?? '',
    unitPrice: line.unitPrice ?? '',
    net: typeof line.netAmount === 'number' ? (line.netAmount / 100).toFixed(2) : '',
    vatRate: line.vatRatePct,
    vatNature: line.vatNature ?? '',
  }
}

/**
 * Match (design "Ordered, received, invoiced"): the MatchPanel per mapped line, the tolerance in words (not decided with
 * the accountant yet), "Send to buyer" when lines are outside it, and the empty state "No PO linked — choose the PO or
 * mark it as an invoice without PO". A credit note is never matched against receipts.
 */
export function MatchTab({ invoice, model, actions }: TabProps) {
  const t = useT(PAYABLES_NAMESPACE)
  const locale = useLocale()
  const held = useHeld()
  const can = model.can
  const open = invoice.status === 'RECEIVED' || invoice.status === 'DISPUTED'
  const acceptHeld: Phrase | null = !can.accept ? { key: 'held.accept' } : !open ? { key: 'held.map' } : model.busy ? { key: 'held.busy' } : null
  const manageHeld: Phrase | null = !can.manage ? { key: 'held.manage' } : !open ? { key: 'held.map' } : model.busy ? { key: 'held.busy' } : null
  const outside = invoice.matches.filter((entry) => entry.verdict !== 'WITHIN' && !entry.accepted)
  const unmapped = unmappedLines(invoice)
  return (
    <div className="fw-fpy-stack">
      <Banner tone={invoice.tolerance.decided ? 'info' : 'warning'} title={t('match.tolerance')}>
        {locale === 'it' ? invoice.tolerance.words.it : invoice.tolerance.words.en}
      </Banner>
      <p className="fw-fpy-muted">{t('match.explain')}</p>
      {invoice.kind === 'CREDIT_NOTE' ? (
        <Card padded>
          <EmptyState title={t('match.creditNote.title')} description={t('match.creditNote.body')} />
        </Card>
      ) : invoice.matches.length === 0 ? (
        <Card padded>
          <EmptyState
            title={t('match.empty.title')}
            description={t('match.empty.body')}
            action={
              <span className="fw-fpy-inline">
                <Button size="sm" asChild>
                  <Link href={`${model.prefix}/finance/payables/${invoice.id}?tab=lines`}>{t('match.empty.map')}</Link>
                </Button>
                {unmapped > 0 && (
                  <Button size="sm" heldReason={held(manageHeld)} onClick={() => actions?.onDialog?.({ kind: 'withoutOrder' })}>
                    {t('lines.withoutOrder', { count: unmapped })}
                  </Button>
                )}
              </span>
            }
          />
        </Card>
      ) : (
        <>
          <div className="fw-fpy-head">
            <span className="fw-fpy-muted">{outside.length > 0 ? t('match.outside', { count: outside.length }) : t('match.allWithin')}</span>
            {outside.length > 0 && (
              <Button size="sm" heldReason={held(manageHeld)} onClick={() => actions?.onDialog?.({ kind: 'sendToBuyer', message: '' })}>
                <Send size={14} aria-hidden /> {t('match.sendToBuyer')}
              </Button>
            )}
          </div>
          <MatchPanel
            matches={invoice.matches}
            currency={invoice.currency}
            cost={can.cost}
            prefix={model.prefix}
            purchasing={can.purchasing}
            acceptHeld={acceptHeld}
            onAccept={(matchId) => actions?.onDialog?.({ kind: 'accept', matchId, note: '' })}
            matchAgainHeld={manageHeld}
            onMatchAgain={() => actions?.onMatchAgain?.()}
          />
          {unmapped > 0 && <p className="fw-fpy-muted">{t('match.someUnmapped', { count: unmapped })}</p>}
        </>
      )}
      <p className="fw-fpy-muted">{t('match.areaLater')}</p>
    </div>
  )
}

/** Approval (design "Approval": who approves; separation of duties — "You entered this invoice, so someone else approves it"). */
export function ApprovalTab({ invoice, model, actions }: TabProps) {
  const t = useT(PAYABLES_NAMESPACE)
  const locale = useLocale()
  const held = useHeld()
  const can = model.can
  const approval = invoice.approval
  const approveHeld = approveHeldOf(invoice, model)
  const disputeHeld: Phrase | null = !can.manage ? { key: 'held.manage' } : actionHeld(invoice, 'dispute')
  const withdrawHeld: Phrase | null = !can.approve ? { key: 'held.approve' } : actionHeld(invoice, 'withdraw')
  const reopenHeld: Phrase | null = !can.manage ? { key: 'held.manage' } : actionHeld(invoice, 'reopen')
  const problems = invoice.status === 'RECEIVED' ? approval.problems : []
  return (
    <div className="fw-fpy-pair">
      <Card padded>
        <div className="fw-fpy-stack">
          <h3 className="fw-fpy-h3">{t('approval.title')}</h3>
          <KeyValue
            columns={1}
            labelCase="sentence"
            items={[
              {
                label: t('approval.state'),
                value: (
                  <Pill tone={invoice.status === 'APPROVED' || invoice.status === 'PAID' ? 'success' : invoice.status === 'DISPUTED' ? 'warning' : 'neutral'}>{t(`status.${invoice.status}`)}</Pill>
                ),
              },
              {
                label: t('approval.approver'),
                value: approval.approvedBy ? `${approval.approvedBy.name ?? t('match.someone')} · ${formatDateTime(approval.approvedAt!, { locale })}` : t('approval.notYet'),
              },
              ...(approval.note ? [{ label: t('approval.note'), value: approval.note }] : []),
              { label: t('approval.registered'), value: invoice.registeredBy ? t('approval.registeredBy', { name: invoice.registeredBy.name ?? t('match.someone') }) : t('approval.registeredSdi') },
            ]}
          />
          {invoice.status === 'RECEIVED' &&
            (approval.ready ? <Banner tone="success" title={t('approval.ready')} /> : problems.length === 0 ? <p className="fw-fpy-muted">{t('approval.empty')}</p> : null)}
          {problems.length > 0 && (
            <ul className="fw-fpy-list" aria-label={t('approval.problems')}>
              {problems.map((problem) => (
                <li key={problem.code}>
                  <Banner tone={problem.code === 'OWN_INVOICE' ? 'info' : 'warning'} title={t(refusalPhrase(problem.code).key)} />
                </li>
              ))}
            </ul>
          )}
          {invoice.dispute && (
            <Banner tone="warning" title={t('approval.disputed', { date: formatDate(invoice.dispute.at, { locale }) })}>
              {invoice.dispute.reason}
            </Banner>
          )}
          {invoice.voided && (
            <Banner tone="neutral" title={t('approval.voided', { date: formatDate(invoice.voided.at, { locale }) })}>
              {invoice.voided.reason}
            </Banner>
          )}
          <span className="fw-fpy-inline">
            {invoice.status === 'RECEIVED' && (
              <>
                <Button size="sm" variant="primary" heldReason={held(approveHeld)} onClick={() => actions?.onDialog?.({ kind: 'approve', note: '' })} aria-keyshortcuts="a">
                  <CheckCheck size={14} aria-hidden /> {t('approval.approve')}
                </Button>
                <Button size="sm" heldReason={held(disputeHeld)} onClick={() => actions?.onDialog?.({ kind: 'dispute', reason: '' })}>
                  <Ban size={14} aria-hidden /> {t('approval.reject')}
                </Button>
              </>
            )}
            {invoice.status === 'APPROVED' && (
              <Button size="sm" heldReason={held(withdrawHeld)} onClick={() => actions?.onDialog?.({ kind: 'withdraw', reason: '' })}>
                <Undo2 size={14} aria-hidden /> {t('approval.withdraw')}
              </Button>
            )}
            {invoice.status === 'DISPUTED' && (
              <Button size="sm" heldReason={held(reopenHeld)} onClick={() => actions?.onDialog?.({ kind: 'reopen', reason: '' })}>
                {t('approval.reopen')}
              </Button>
            )}
          </span>
        </div>
      </Card>
      <Card padded>
        <div className="fw-fpy-stack">
          <h3 className="fw-fpy-h3">{t('approval.rulesTitle')}</h3>
          <p className="fw-fpy-muted">{t('approval.rules')}</p>
          <p className="fw-fpy-muted">{t('approval.dualLater')}</p>
        </div>
      </Card>
    </div>
  )
}

/** Why the invoice may not be approved by this person now (null: it may): the permission, the API's problems, busy. */
export function approveHeldOf(invoice: SupplierInvoice, model: Pick<SupplierInvoiceModel, 'can' | 'busy'>): Phrase | null {
  if (!model.can.approve) return { key: 'held.approve' }
  if (invoice.status !== 'RECEIVED') return { key: 'refusal.NOT_RECEIVED' }
  const first = invoice.approval.problems[0]
  if (first) return refusalPhrase(first.code)
  if (model.busy) return { key: 'held.busy' }
  return null
}

/** Payment (design "Payment": due, terms, paid on; the payment batch and the IBAN check are W2b). */
export function PaymentTab({ invoice, model, actions }: TabProps) {
  const t = useT(PAYABLES_NAMESPACE)
  const locale = useLocale()
  const held = useHeld()
  const payHeld: Phrase | null = !model.can.pay ? { key: 'held.pay' } : actionHeld(invoice, 'pay')
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const installments = invoice.paymentTerms?.installments ?? []
  return (
    <div className="fw-fpy-pair">
      <Card padded>
        <div className="fw-fpy-stack">
          <h3 className="fw-fpy-h3">{t('payment.title')}</h3>
          <KeyValue
            columns={1}
            labelCase="sentence"
            items={[
              { label: t('payment.due'), value: day(invoice.payment.dueDate) },
              { label: t('payment.paidOn'), value: invoice.payment.paidOn ? day(invoice.payment.paidOn) : t('payment.notPaid') },
              { label: t('payment.ref'), value: invoice.payment.paymentRef ?? '—' },
              ...(model.can.cost ? [{ label: t('payment.amount'), value: money(invoice.grossTotal ?? null, invoice.currency, locale) }] : []),
              { label: t('payment.batch'), value: t('payment.batchLater') },
            ]}
          />
          <span className="fw-fpy-inline">
            {invoice.status !== 'PAID' && invoice.status !== 'VOIDED' && (
              <Button
                size="sm"
                variant="primary"
                heldReason={held(payHeld) ?? (model.busy ? t('held.busy') : null)}
                onClick={() => actions?.onDialog?.({ kind: 'pay', paidOn: model.today, paymentRef: '' })}
              >
                <CreditCard size={14} aria-hidden /> {t('payment.markPaid')}
              </Button>
            )}
          </span>
        </div>
      </Card>
      <Card padded>
        <div className="fw-fpy-stack">
          <h3 className="fw-fpy-h3">{t('payment.terms')}</h3>
          {installments.length === 0 ? (
            <p className="fw-fpy-muted">{t('payment.noTerms')}</p>
          ) : (
            <SummaryTable
              label={t('payment.terms')}
              columns={[t('payment.col.due'), t('payment.col.method'), ...(model.can.cost ? [t('payment.col.amount')] : []), t('payment.col.iban')]}
              align={['left', 'left', ...(model.can.cost ? (['right'] as const) : []), 'left']}
              stackOnPhone
              rows={installments.map((entry, index) => ({
                id: `inst-${index}`,
                cells: [
                  day(entry.dueDate),
                  entry.method ? t('payment.method', { code: entry.method }) : '—',
                  ...(model.can.cost ? [money(entry.amount ?? null, invoice.currency, locale)] : []),
                  entry.iban ? maskIban(entry.iban) : '—',
                ],
              }))}
            />
          )}
          {invoice.paymentTerms?.condition && <p className="fw-fpy-muted">{t('payment.condition', { code: invoice.paymentTerms.condition })}</p>}
          <p className="fw-fpy-muted">{t('payment.ibanLater')}</p>
        </div>
      </Card>
    </div>
  )
}

/** An IBAN masked but its country, check digits and last four (design "IBAN used (masked…)"). */
export function maskIban(iban: string): string {
  const compact = iban.replace(/\s/g, '')
  if (compact.length <= 8) return compact
  return `${compact.slice(0, 4)} •••• ${compact.slice(-4)}`
}
