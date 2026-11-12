'use client'

import { Plus, Undo2 } from 'lucide-react'
import { Banner, Card, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, SegmentedControl, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { ActionConfirm, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { money, quantity, unitPrice } from '../../../../_shared/buying/model'
import { say, type Words } from '../../model'
import { KINDS, type CostEntry, type CostKind, type OrderCost } from '../api'
import { bookDraftOf, bookHeld, bookHeldDraft, bookPreview, costRungs, DEPTH, entryWords, ledgerWords, noCostYet, reverseHeld, type BookDraft, type CostActions, type CostModel } from '../model'
import '../depth.css'

/**
 * Subcontract order › Cost (design purchasing.subcontracting rec:cost "Cost to the work order"; SCM-146; "NEW Bridge" +
 * SummaryTable): the fee per piece plus material plus transport, booked to the work order. The bridge (cost grain only):
 * the fee earned for the pieces back good + fees at the workshop's price + transport + material + other = the order's
 * cost → the work order, and what its cost ledger holds (or why nothing posts: another currency). Per operation the pieces
 * back good, waiting for inspection and paid at the workshop's price; every charge with its receipt, whether the work
 * order holds it and "Take back"; the workshop's invoice lines (with payables.view only). "Book a charge" confirms what it
 * books. Without the cost grain no price or amount is drawn (never '—'): one line says so.
 */
export function CostTabView({ model, actions }: { model: CostModel; actions?: CostActions }) {
  return (
    <WithMessages namespaces={[DEPTH]}>
      <Cost model={model} actions={actions} />
    </WithMessages>
  )
}

const useSay = () => {
  const t = useT(DEPTH)
  return (value: Words) => say(t, value)
}

function Cost({ model, actions }: { model: CostModel; actions?: CostActions }) {
  const t = useT(DEPTH)
  const sayWords = useSay()
  const locale = useLocale()
  const loaded = model.cost
  if (loaded.status === 'loading') {
    return (
      <Card padded aria-busy="true">
        <div className="fw-by-stack">
          <p className="fw-by-hint" role="status">
            <Spinner size={14} /> {model.slow ? t('cost.slow') : t('cost.loading')}
          </p>
          <div className="fw-by-ladder">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} height={52} />
            ))}
          </div>
          <Skeleton height={18} width="40%" />
        </div>
      </Card>
    )
  }
  if (loaded.status !== 'ready') {
    return (
      <Card padded>
        <EmptyState
          title={t('cost.failed')}
          description={t(loaded.status === 'error' ? loaded.problem : loaded.status === 'forbidden' ? 'problem.forbidden' : 'problem.gone')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      </Card>
    )
  }
  const cost = loaded.value
  const held = bookHeld(cost, model.can)
  const bookButton = (variant: 'primary' | 'secondary') => (
    <Button size="sm" variant={variant} heldReason={model.busy ? t('held.busy') : held ? sayWords(held) : null} onClick={() => actions?.onDialog?.({ kind: 'book', draft: bookDraftOf(cost) })}>
      <Plus size={14} aria-hidden /> {t('cost.book.open')}
    </Button>
  )
  const currency = cost.order.currency
  const amount = (minor: number | undefined) => money(minor ?? null, currency, locale)
  const ledger = ledgerWords(cost)
  return (
    <div className="fw-by-stack">
      <div className="fw-by-head">
        <span className="fw-by-hint">{t('cost.intro', { workOrder: cost.order.workOrder.number })}</span>
        {bookButton('secondary')}
      </div>
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={sayWords(model.notice.words)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {!model.can.cost && <Banner tone="info" title={t('cost.noGrain')} />}
      {noCostYet(cost) ? (
        <Card padded>
          <EmptyState title={t('cost.empty.title')} description={t('cost.empty.body')} />
        </Card>
      ) : (
        <>
          {model.can.cost && <Bridge cost={cost} />}
          {ledger ? (
            <Banner tone="warning" title={sayWords(ledger)} />
          ) : model.can.cost && cost.workOrder.onLedger !== undefined ? (
            <p className="fw-by-hint">{t('cost.ledger.holds', { workOrder: cost.order.workOrder.number, amount: amount(cost.workOrder.onLedger), count: cost.workOrder.entries })}</p>
          ) : null}
          <Operations cost={cost} model={model} />
          <Entries cost={cost} model={model} actions={actions} />
        </>
      )}
      {cost.invoices !== null && <Invoices cost={cost} model={model} />}
      {model.dialog?.kind === 'book' && <BookDialog draft={model.dialog.draft} cost={cost} model={model} actions={actions} />}
      {model.dialog?.kind === 'reverse' && <ReverseDialog entryId={model.dialog.entryId} reason={model.dialog.reason} cost={cost} model={model} actions={actions} />}
    </div>
  )
}

function Bridge({ cost }: { cost: OrderCost }) {
  const t = useT(DEPTH)
  const locale = useLocale()
  const rungs = costRungs(cost)
  if (!rungs) return null
  const currency = cost.order.currency
  const fees = cost.operations.filter((operation) => operation.piecesBackGood - operation.bookedByFee - operation.waitingForInspection > 0 && operation.pricePerPiece !== undefined)
  return (
    <Card padded>
      <section className="fw-by-stack" aria-label={t('cost.bridge')}>
        <h3 className="fw-by-h3">{t('cost.bridge')}</h3>
        <ol className="fw-by-ladder" aria-label={t('cost.bridge')}>
          {rungs.map((rung, index) => (
            <li key={rung.key} className={rung.key === 'orderCost' ? 'fw-by-rung is-result' : 'fw-by-rung'}>
              <span className="fw-by-rung-label">{rung.key === 'orderCost' ? t('cost.rung.orderCost', { workOrder: cost.order.workOrder.number }) : t(`cost.rung.${rung.key}`)}</span>
              <span className="fw-by-rung-value">
                {rung.key === 'orderCost' ? '= ' : index === 0 ? '' : '+ '}
                {money(rung.amount, currency, locale)}
              </span>
            </li>
          ))}
        </ol>
        {fees.length > 0 && (
          <ul className="fw-by-list">
            {fees.map((operation) => (
              <li key={operation.id} className="fw-by-hint">
                {t('cost.earnedLine', {
                  line: operation.seq,
                  code: operation.code,
                  count: operation.piecesBackGood - operation.bookedByFee - operation.waitingForInspection,
                  fee: unitPrice(operation.pricePerPiece, currency, locale),
                  amount: money(operation.earnedFee ?? null, currency, locale),
                })}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Card>
  )
}

function Operations({ cost, model }: { cost: OrderCost; model: CostModel }) {
  const t = useT(DEPTH)
  const locale = useLocale()
  const currency = cost.order.currency
  const columns = [t('cost.op.operation'), ...(model.can.cost ? [t('cost.op.fee')] : []), t('cost.op.backGood'), t('cost.op.waiting'), t('cost.op.byFee'), ...(model.can.cost ? [t('cost.op.earned')] : [])]
  return (
    <Card padded>
      <section className="fw-by-stack" aria-label={t('cost.op.title')}>
        <h3 className="fw-by-h3">{t('cost.op.title')}</h3>
        <SummaryTable
          label={t('cost.op.title')}
          stackOnPhone
          columns={columns}
          align={columns.map((_, index) => (index === 0 ? 'left' : 'right'))}
          rows={cost.operations.map((operation) => ({
            id: operation.id,
            cells: [
              <span key="op" className="fw-by-cell">
                <span>
                  {t('cost.op.line', { line: operation.seq })} <span className="fw-by-code">{operation.code}</span>
                </span>
                <span className="fw-by-cell-sub">{operation.name}</span>
              </span>,
              ...(model.can.cost ? [unitPrice(operation.pricePerPiece, currency, locale)] : []),
              String(operation.piecesBackGood),
              operation.waitingForInspection > 0 ? <Tag key="w" tone="warning">{String(operation.waitingForInspection)}</Tag> : '0',
              String(operation.bookedByFee),
              ...(model.can.cost ? [money(operation.earnedFee ?? null, currency, locale)] : []),
            ],
          }))}
        />
        {cost.operations.some((operation) => operation.waitingForInspection > 0) && <p className="fw-by-hint">{t('cost.op.waitingHint')}</p>}
      </section>
    </Card>
  )
}

function Entries({ cost, model, actions }: { cost: OrderCost; model: CostModel; actions?: CostActions }) {
  const t = useT(DEPTH)
  const sayWords = useSay()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const columns = [t('cost.entry.when'), t('cost.entry.what'), ...(model.can.cost ? [t('cost.entry.price'), t('cost.entry.amount')] : []), t('cost.entry.receipt'), t('cost.entry.onWorkOrder'), t('cost.entry.why'), t('cost.entry.actions')]
  const row = (entry: CostEntry) => {
    const held = reverseHeld(cost, entry, model.can)
    return {
      id: entry.id,
      cells: [
        formatDate(entry.occurredAt, place),
        <span key="what" className="fw-by-cell">
          <span>{sayWords(entryWords(entry, cost.entries))}</span>
          {entry.reversedById && <span className="fw-by-cell-sub">{t('cost.entry.takenBack')}</span>}
        </span>,
        ...(model.can.cost ? [unitPrice(entry.unitPrice, entry.currency, locale), money(entry.amount ?? null, entry.currency, locale)] : []),
        entry.receipt ? t('cost.entry.receiptSeq', { seq: entry.receipt.seq }) : '—',
        entry.onWorkOrder ? <Tag key="on" tone="success">{t('cost.entry.posted')}</Tag> : <Tag key="on" tone="warning">{t('cost.entry.waiting')}</Tag>,
        entry.reason ?? '—',
        entry.reversalOfId || entry.reversedById ? (
          '—'
        ) : (
          <Button key="back" size="sm" variant="quiet" heldReason={model.busy ? t('held.busy') : held ? sayWords(held) : null} onClick={() => actions?.onDialog?.({ kind: 'reverse', entryId: entry.id, reason: '' })} aria-label={t('cost.reverse.openOf', { what: sayWords(entryWords(entry, cost.entries)) })}>
            <Undo2 size={13} aria-hidden /> {t('cost.reverse.open')}
          </Button>
        ),
      ],
    }
  }
  return (
    <Card padded>
      <section className="fw-by-stack" aria-label={t('cost.entries')}>
        <h3 className="fw-by-h3">{t('cost.entries')}</h3>
        {cost.entries.length === 0 ? (
          <p className="fw-by-hint">{t('cost.entriesNone')}</p>
        ) : (
          <SummaryTable label={t('cost.entries')} density="roomy" stackOnPhone columns={columns} align={columns.map((_, index) => (model.can.cost && (index === 2 || index === 3) ? 'right' : index === columns.length - 1 ? 'right' : 'left'))} rows={cost.entries.map(row)} />
        )}
      </section>
    </Card>
  )
}

function Invoices({ cost, model }: { cost: OrderCost; model: CostModel }) {
  const t = useT(DEPTH)
  const locale = useLocale()
  const invoices = cost.invoices ?? []
  const columns = [t('cost.invoice.number'), t('cost.invoice.line'), t('cost.invoice.description'), ...(model.can.cost ? [t('cost.invoice.net')] : []), t('cost.invoice.match')]
  return (
    <Card padded>
      <section className="fw-by-stack" aria-label={t('cost.invoice.title')}>
        <h3 className="fw-by-h3">{t('cost.invoice.title')}</h3>
        {invoices.length === 0 ? (
          <p className="fw-by-hint">{t('cost.invoice.none')}</p>
        ) : (
          <SummaryTable
            label={t('cost.invoice.title')}
            stackOnPhone
            columns={columns}
            align={columns.map((_, index) => (model.can.cost && index === 3 ? 'right' : 'left'))}
            rows={invoices.map((line) => ({
              id: `${line.invoiceId}:${line.seq}`,
              cells: [line.number, String(line.seq), line.description, ...(model.can.cost ? [money(line.netAmount ?? null, line.currency, locale)] : []), t(`cost.invoice.matchStatus.${MATCH.includes(line.matchStatus) ? line.matchStatus : 'OTHER'}`)],
            }))}
          />
        )}
        <p className="fw-by-hint">{t('cost.invoice.hint')}</p>
      </section>
    </Card>
  )
}

const MATCH = ['PENDING', 'MATCHED', 'DIFFERENCES', 'NO_PO', 'WAITING_GOODS']

function BookDialog({ draft, cost, model, actions }: { draft: BookDraft; cost: OrderCost; model: CostModel; actions?: CostActions }) {
  const t = useT(DEPTH)
  const sayWords = useSay()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const set = (next: Partial<BookDraft>) => actions?.onDialog?.({ kind: 'book', draft: { ...draft, ...next } })
  const held = bookHeldDraft(draft, cost)
  // A refusal from the server is said above (the confirm stays enabled, so the focus stays on it and a retry reads again);
  // only the draft's own holds disable it. A second press while busy is ignored by the container.
  const refusal = held ? sayWords(held) : null
  const preview = bookPreview(draft, cost)
  const currency = cost.order.currency
  const close = () => actions?.onDialog?.(null)
  const feeLines = cost.operations
  return (
    <Modal open onClose={close} title={t('cost.book.title', { number: cost.order.number })} size="md">
      <div className="fw-by-dialog">
        {/* The kind's own name is the radiogroup's (a Field would label nothing: a segmented control takes no id). */}
        <SegmentedControl size="sm" wrap ariaLabel={t('cost.book.kind')} value={draft.kind} onChange={(kind) => actions?.onDialog?.({ kind: 'book', draft: { ...bookDraftOf(cost, kind as CostKind), receiptId: draft.receiptId } })} options={KINDS.map((kind) => ({ value: kind, label: t(`cost.kind.${kind}`) }))} />
        <p className="fw-by-hint">{t(`cost.book.kindHint.${draft.kind}`)}</p>
        <div className="fw-by-fields">
          {draft.kind === 'FEE' && (
            <Field label={t('cost.book.operation')}>
              <Select size="sm" value={draft.operationId} onChange={(event) => {
                const operation = cost.operations.find((row) => row.id === event.target.value)
                set({ operationId: event.target.value, ...(operation ? { quantity: String(operation.bookable) } : {}) })
              }}>
                <option value="">{t('cost.book.pickOperation')}</option>
                {feeLines.map((operation) => (
                  <option key={operation.id} value={operation.id} disabled={operation.bookable === 0}>
                    {t('cost.book.operationOption', { line: operation.seq, code: operation.code, count: operation.bookable })}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={draft.kind === 'FEE' ? t('cost.book.pieces') : t('cost.book.quantity')}>
            <Input size="sm" inputMode={draft.kind === 'FEE' ? 'numeric' : 'decimal'} value={draft.quantity} onChange={(event) => set({ quantity: event.target.value })} />
          </Field>
          <Field label={t('cost.book.price', { currency })}>
            <Input size="sm" inputMode="decimal" value={draft.unitPrice} onChange={(event) => set({ unitPrice: event.target.value })} />
          </Field>
          <Field label={t('cost.book.receipt')}>
            <Select size="sm" value={draft.receiptId} onChange={(event) => set({ receiptId: event.target.value })}>
              <option value="">{t('cost.book.noReceipt')}</option>
              {model.receipts.map((receipt) => (
                <option key={receipt.id} value={receipt.id}>
                  {t('cost.book.receiptOption', { seq: receipt.seq, date: formatDate(receipt.receivedAt, place) })}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={draft.kind === 'OTHER' ? t('cost.book.what') : t('cost.book.reason')} required={draft.kind === 'OTHER'}>
          <Textarea rows={2} maxLength={2000} value={draft.reason} onChange={(event) => set({ reason: event.target.value })} />
        </Field>
        {model.problem && <Banner tone="danger" title={sayWords(model.problem)} />}
        {model.busy && (
          <p className="fw-by-hint" role="status">
            {t('held.busy')}
          </p>
        )}
        <ActionConfirm
          mode="inline"
          impact={{
            level: 'confirm',
            title: t('cost.book.question', { kind: t(`cost.kind.${draft.kind}`), workOrder: preview.workOrder }),
            confirmLabel: t('cost.book.confirm'),
            consequences: [
              t('cost.book.onWorkOrder', { quantity: quantity(preview.quantity, locale, 4), price: unitPrice(preview.price, currency, locale), amount: money(preview.amount, currency, locale), workOrder: preview.workOrder }),
              ...(preview.feeLine !== null ? [t('cost.book.feeOnce', { count: Number(preview.quantity) || 0, line: preview.feeLine })] : []),
            ],
            ...(refusal ? { refusal: { reason: refusal } } : {}),
          }}
          onConfirm={() => actions?.onBook?.()}
          onCancel={close}
        />
      </div>
    </Modal>
  )
}

function ReverseDialog({ entryId, reason, cost, model, actions }: { entryId: string; reason: string; cost: OrderCost; model: CostModel; actions?: CostActions }) {
  const t = useT(DEPTH)
  const sayWords = useSay()
  const locale = useLocale()
  const entry = cost.entries.find((row) => row.id === entryId)
  const close = () => actions?.onDialog?.(null)
  if (!entry) return null
  const what = sayWords(entryWords(entry, cost.entries))
  const held = reverseHeld(cost, entry, model.can)
  // A refusal from the server is said above (the confirm stays enabled, so the focus stays on it and a retry reads again);
  // only the draft's own holds disable it. A second press while busy is ignored by the container.
  const refusal = held ? sayWords(held) : reason.trim() === '' ? t('cost.reverse.held.reason') : reason.trim().length > 2000 ? t('balance.held.reasonLong') : null
  return (
    <Modal open onClose={close} title={t('cost.reverse.title')} size="md">
      <div className="fw-by-dialog">
        <Field label={t('cost.reverse.reason')} required>
          <Textarea rows={2} maxLength={2000} value={reason} onChange={(event) => actions?.onDialog?.({ kind: 'reverse', entryId, reason: event.target.value })} />
        </Field>
        {model.problem && <Banner tone="danger" title={sayWords(model.problem)} />}
        {model.busy && (
          <p className="fw-by-hint" role="status">
            {t('held.busy')}
          </p>
        )}
        <ActionConfirm
          mode="inline"
          impact={{
            level: 'confirm',
            title: t('cost.reverse.question', { what }),
            confirmLabel: t('cost.reverse.confirm'),
            consequences: [t('cost.reverse.minus', { amount: entry.amount === undefined ? t('cost.reverse.itsAmount') : money(-entry.amount, entry.currency, locale), workOrder: cost.order.workOrder.number })],
            sideEffects: [t('cost.reverse.once')],
            ...(refusal ? { refusal: { reason: refusal } } : {}),
          }}
          onConfirm={() => actions?.onReverse?.()}
          onCancel={close}
        />
      </div>
    </Modal>
  )
}
