'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Grid3x3, Plus, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { SizeGridView, type SizeGridCopy } from '@nexus/ui/grid'
import { Button, Input } from '@nexus/ui/primitives'
import { DateField, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayAt, money, unitPrice } from '../../../../_shared/buying/model'
import type { Operation, SubcontractOrder } from '../../api'
import { sizeRun, somethingOut } from '../../model'
import { cellKey, type CellField, type SubcontractRecordActions, type SubcontractRecordModel } from '../record-model'
import { SaveMarkText } from './parts'

/** The DS size grid's words in the page's language (`subcontract-order`, `grid.*`). */
export function gridCopy(t: (key: string, params?: Record<string, string | number>) => string): Partial<SizeGridCopy> {
  return {
    caption: t('grid.caption'),
    colourHeader: t('grid.colour'),
    totalHeader: t('grid.total'),
    cellName: (colour, size) => t('grid.cellName', { colour, size }),
    notOffered: t('grid.notOffered'),
    empty: t('grid.empty'),
    totalsAnnouncement: ({ colour, rowTotal, size, columnTotal, grand }) => t('grid.totals', { colour, rowTotal, size, columnTotal, grand }),
    notWhole: (cell, max) => t('grid.notWhole', { cell, max }),
    cutToMax: (cell, max) => t('grid.cutToMax', { cell, max }),
    pasteResult: ({ applied, notOffered, outside, invalid, clamped }) => t('grid.pasted', { applied, skipped: notOffered + outside + invalid + clamped }),
    issuesHeading: t('grid.issues'),
  }
}

export const dateLocale = (locale: string) => (locale === 'it' ? 'it-IT' : 'en-GB')

/**
 * Operations & quantities (design rec ops "What the workshop does"): one card per operation sent out — the routing's
 * operation, its pieces per size (the DS size grid), the fee per piece and its amount (cost grain only: not drawn
 * without it), the return date, and sent · back good · back defective · scrapped · at the workshop. A draft saves each
 * cell when it is left (Enter or Tab) with the order's version, its save said beside it; pieces per size open the size
 * grid editor. After the draft only the counts move: Back to draft while nothing is out.
 */
export function OperationsTab({ order, model, actions }: { order: SubcontractOrder; model: SubcontractRecordModel; actions?: SubcontractRecordActions }) {
  const t = useT('subcontract-order')
  const locale = useLocale()
  const editable = order.status === 'DRAFT' && model.can.manage
  return (
    <div className="fw-by-stack">
      {editable ? (
        <div className="fw-by-head">
          <span className="fw-by-hint">{t('ops.draftHint')}</span>
          <Button size="sm" variant="secondary" onClick={() => actions?.onOpenAddOperation?.()} heldReason={model.busy ? t('held.busy') : null}>
            <Plus size={14} aria-hidden /> {t('ops.add')}
          </Button>
        </div>
      ) : order.status !== 'DRAFT' && order.status !== 'CANCELLED' && order.operations.length > 0 ? (
        <Banner tone="info" title={order.status === 'ISSUED' && !somethingOut(order) ? t('ops.frozenReopen') : t('ops.frozen')} />
      ) : null}
      {order.operations.length === 0 ? (
        <Card padded>
          <EmptyState
            title={t('ops.empty.title')}
            description={t('ops.empty.body')}
            action={
              editable ? (
                <Button size="sm" variant="primary" onClick={() => actions?.onOpenAddOperation?.()}>
                  <Plus size={14} aria-hidden /> {t('ops.add')}
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="fw-sco-ops">
          {order.operations.map((operation) => (
            <OperationCard key={operation.id} order={order} operation={operation} model={model} actions={actions} editable={editable} />
          ))}
        </div>
      )}
      {model.can.cost && order.netAmount !== undefined && order.operations.length > 0 && (
        <p className="fw-by-hint fw-sco-total">{t('ops.total', { amount: money(order.netAmount, order.currency, locale) })}</p>
      )}
    </div>
  )
}

function OperationCard({ order, operation, model, actions, editable }: { order: SubcontractOrder; operation: Operation; model: SubcontractRecordModel; actions?: SubcontractRecordActions; editable: boolean }) {
  const t = useT('subcontract-order')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const run = sizeRun(operation.sizes)
  const mark = (field: CellField | 'sizes') => model.marks[cellKey(operation.id, field)]
  const op = operation.workOrderOperation
  return (
    <Card padded>
      <div className="fw-by-stack">
        <div className="fw-by-card-head">
          <h3 className="fw-by-h3">{t('ops.card.title', { line: operation.seq, seq: op.seq, code: op.code, name: op.name })}</h3>
          {editable && (
            <Button size="sm" variant="quiet" tone="danger" onClick={() => actions?.onDialog?.({ kind: 'removeOperation', operationId: operation.id })} aria-label={t('ops.remove', { line: operation.seq })}>
              <Trash2 size={13} aria-hidden /> {t('ops.removeShort')}
            </Button>
          )}
        </div>
        <p className="fw-by-hint">{t('ops.card.from', { number: order.workOrder.number, style: `${order.workOrder.style.code} ${order.workOrder.style.name}` })}</p>
        {editable ? (
          <div className="fw-sco-cells">
            {operation.sizes.length === 0 && (
              <Cell label={t('ops.pieces')} mark={mark('pieces')}>
                <TypedCell value={String(operation.pieces)} inputMode="numeric" ariaLabel={t('ops.piecesOf', { line: operation.seq })} onCommit={(value) => actions?.onCell?.(operation.id, 'pieces', value)} />
              </Cell>
            )}
            {model.can.cost && operation.pricePerPiece !== undefined && (
              <Cell label={t('ops.fee', { currency: order.currency })} mark={mark('pricePerPiece')} hint={operation.netAmount !== undefined ? t('ops.amount', { amount: money(operation.netAmount, order.currency, locale) }) : undefined}>
                <TypedCell value={plainFee(operation.pricePerPiece)} inputMode="decimal" ariaLabel={t('ops.feeOf', { line: operation.seq })} onCommit={(value) => actions?.onCell?.(operation.id, 'pricePerPiece', value)} />
              </Cell>
            )}
            <Cell label={t('ops.back')} mark={mark('expectedBackDate')}>
              <DateField value={operation.expectedBackDate ?? ''} onChange={(value) => actions?.onCell?.(operation.id, 'expectedBackDate', value)} locale={dateLocale(locale)} clearable clearLabel={t('common.clear')} placeholder={t('ops.noDate')} ariaLabel={t('ops.backOf', { line: operation.seq })} />
            </Cell>
            <Cell label={t('ops.note')} mark={mark('note')} wide>
              <TypedCell value={operation.note ?? ''} multiline ariaLabel={t('ops.noteOf', { line: operation.seq })} onCommit={(value) => actions?.onCell?.(operation.id, 'note', value)} />
            </Cell>
          </div>
        ) : (
          <KeyValue
            dense
            columns={3}
            labelCase="sentence"
            items={[
              { label: t('ops.pieces'), value: String(operation.pieces) },
              ...(model.can.cost && operation.pricePerPiece !== undefined
                ? [{ label: t('ops.fee', { currency: order.currency }), value: <span className="fw-by-num">{unitPrice(operation.pricePerPiece, order.currency, locale)}</span>, hint: operation.netAmount !== undefined ? t('ops.amount', { amount: money(operation.netAmount, order.currency, locale) }) : undefined }]
                : []),
              { label: t('ops.back'), value: operation.expectedBackDate ? formatDate(dayAt(operation.expectedBackDate), place) : t('ops.noDate') },
              ...(operation.note ? [{ label: t('ops.note'), value: operation.note }] : []),
            ]}
          />
        )}
        <div className="fw-sco-grid">
          <div className="fw-by-card-head">
            <h4 className="fw-by-h3">{t('ops.sizes')}</h4>
            <span className="fw-by-inline">
              <SaveMarkText mark={mark('sizes')} />
              {editable && (
                <Button size="sm" variant="quiet" onClick={() => actions?.onOpenSizes?.(operation.id)}>
                  <Grid3x3 size={13} aria-hidden /> {t('ops.editSizes')}
                </Button>
              )}
            </span>
          </div>
          {operation.sizes.length === 0 ? <p className="fw-by-hint">{t('ops.notSplit', { count: operation.pieces })}</p> : <SizeGridView colours={run.colours} sizes={run.sizes} value={run.value} locale={dateLocale(locale)} copy={gridCopy(t)} caption={t('ops.sizesOf', { line: operation.seq })} />}
        </div>
        <ul className="fw-sco-counts" aria-label={t('ops.countsLabel')}>
          <li>
            <span className="fw-sco-count-label">{t('ops.count.sent')}</span>
            <span className="fw-by-num">{t('ops.count.of', { done: operation.piecesSent, total: operation.pieces })}</span>
          </li>
          <li>
            <span className="fw-sco-count-label">{t('ops.count.good')}</span>
            <span className="fw-by-num">{operation.piecesBackGood}</span>
          </li>
          <li>
            <span className="fw-sco-count-label">{t('ops.count.defective')}</span>
            <span className="fw-by-num">{operation.piecesBackDefective}</span>
          </li>
          <li>
            <span className="fw-sco-count-label">{t('ops.count.scrapped')}</span>
            <span className="fw-by-num">{operation.piecesScrapped}</span>
          </li>
          <li>
            <span className="fw-sco-count-label">{t('ops.count.atWorkshop')}</span>
            <span className="fw-by-num">{operation.atWorkshop}</span>
          </li>
        </ul>
      </div>
    </Card>
  )
}

/** "7.000000" → "7.00" (at least two decimals, the rest only when typed). */
const plainFee = (text: string): string => {
  const [whole, fraction = ''] = text.split('.')
  const kept = fraction.replace(/0+$/, '')
  return `${whole}.${kept.padEnd(2, '0')}`
}

function Cell({ label, mark, hint, wide, children }: { label: string; mark: Parameters<typeof SaveMarkText>[0]['mark']; hint?: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? 'fw-sco-cell is-wide' : 'fw-sco-cell'}>
      <Field label={label} hint={hint}>
        {children}
      </Field>
      <SaveMarkText mark={mark} />
    </div>
  )
}

/** A typed cell: its own text while typing; leaving it (blur, Enter; Esc puts the stored value back) commits it once. */
function TypedCell({ value, onCommit, ariaLabel, inputMode, multiline }: { value: string; onCommit: (value: string) => void; ariaLabel: string; inputMode?: 'numeric' | 'decimal'; multiline?: boolean }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = () => {
    if (text !== value) onCommit(text)
  }
  if (multiline)
    return (
      <Textarea
        rows={2}
        maxLength={1000}
        aria-label={ariaLabel}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setText(value)
        }}
      />
    )
  return (
    <Input
      size="sm"
      aria-label={ariaLabel}
      inputMode={inputMode}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') setText(value)
      }}
    />
  )
}
