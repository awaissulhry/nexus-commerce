'use client'

import { Card, Disclosure, SummaryTable } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../lib/i18n/ds-parts'
import { OrderLinesTable, ownColumnsOfRecord } from '../../../../lib/order-lines'
import type { OrderRecord } from '../api'
import { shownLinesOf, totalsOf, unitPriceText } from '../model'
import { linesModeOf, NO_ASKS, orderLinePricesOf, orderLineRowsOf } from '../order-lines'
import { usePageWords } from '../page-words'
import { useOrderWords } from '../words'
import { PricesNote, SizeRunTable } from './parts'
import type { OrderRecordActions, OrderRecordViewModel } from './OrderRecordView'

/**
 * owb-po6.1 (plan § 5j; design `linesTab`, `lineMay`) — Order › Lines on the ONE lines table (lib/order-lines, web A's: mounted, never
 * edited). After Confirm typing a line's pieces makes an ASK (nothing changes before the factory answers): the save bar says "n changes
 * not saved · Undo · Discard · Review and ask…" (⌘ S), and Review opens today's Ask window at its change step with the asks in its note
 * (today's change-request path: sizes / pieces, colourway, date, address, note — a material change is a note ask). The customer's own
 * columns apply at once (no price, no promise moves). After shipping: read only ("It left the factory. A change now is a return.").
 * Below: each line's size run with its doors (ask on this line, reorder it), the lines' options and artwork, the totals (money only).
 */
export function LinesTab({ model, record, actions }: { model: OrderRecordViewModel; record: OrderRecord; actions?: OrderRecordActions }) {
  const words = useOrderWords()
  const page = usePageWords()
  const { t, locale } = words
  const seesPrices = record.seesPrices
  const currency = record.order.currency
  const rows = orderLineRowsOf(record)
  const mode = linesModeOf(record.order.status)
  const asks = model.lineAsks ?? NO_ASKS
  const asked = asks.order.length
  const totals = seesPrices ? totalsOf(record) : null
  const lines = shownLinesOf(record.lines)
  return (
    <div className="fw-pord-tab">
      <h2 className="fw-pord-h2">{t('lines.title')}</h2>
      {!seesPrices ? <PricesNote /> : null}
      <OrderLinesTable
        model={{
          rows,
          mode,
          columns: ownColumnsOfRecord(record.ownColumns),
          styles: [],
          kinds: [],
          prices: orderLinePricesOf(record),
          pending: false,
          removed: [],
          // Asking is the band's right too: who may not ask reads the lines, with why.
          writeHeld: mode === 'confirmed' ? model.changeHeld : null,
          saving: [],
          columnsDoor: false,
          door: 'portal',
        }}
        actions={{
          onAsk: (rowId, field, value) => (field === 'pieces' ? actions?.onLineAsk?.(rowId, value) : undefined),
          onOwnValue: (rowId, columnId, value, version) => actions?.onOwnValue?.(rowId, columnId, value, version),
        }}
      />
      <p className="fw-pord-quiet">{page('lines.notes')}</p>
      {asked > 0 ? (
        <EditModeBar
          count={asked}
          message={
            <span className="fw-pord-asks">
              {page('lines.asked', { count: asked })}{' '}
              <Button size="sm" variant="quiet" onClick={() => actions?.onUndoAsk?.()}>
                {page('lines.undo')}
              </Button>
            </span>
          }
          onDiscard={() => actions?.onDiscardAsks?.()}
          onApply={() => actions?.onReviewAsks?.()}
          applyLabel={page('lines.review')}
          applyHeldReason={model.changeHeld}
          saveShortcut
        />
      ) : null}
      <section className="fw-pord-section" aria-labelledby="fw-pord-sizes">
        <h2 id="fw-pord-sizes" className="fw-pord-h2">
          {t('lines.sizesTitle')}
        </h2>
        {lines.map((line) => (
          <Disclosure key={line.id} id={`line-${line.id}`} open={model.openLine === line.id ? true : undefined} summary={t('lines.sizesOf', { seq: line.seq, style: line.style?.code ?? line.description ?? '—', colour: line.colourway?.name ?? '' })}>
            {line.kind === 'MADE_TO_MEASURE' ? (
              <p className="fw-pord-hint">{line.measurement ? t('lines.mtmUnit', { rider: line.measurement.riderName, revision: line.measurement.revision, size: line.baseSize ?? '—' }) : t('lines.mtmUnitNone')}</p>
            ) : (
              <SizeRunTable
                label={t('lines.sizesOf', { seq: line.seq, style: line.style?.code ?? '—', colour: line.colourway?.name ?? '' })}
                run={{
                  heads: [t('sizes.ordered'), t('sizes.shipped'), t('sizes.open'), ...(line.sizes.some((size) => size.closedShort > 0) ? [t('sizes.closedShort')] : []), ...(seesPrices && line.sizes.some((size) => size.unitPrice && size.unitPrice !== line.unitPrice) ? [t('sizes.price')] : [])],
                  rows: line.sizes.map((size) => ({
                    size: size.size ?? '—',
                    cells: [
                      size.ordered,
                      size.shipped,
                      size.open,
                      ...(line.sizes.some((entry) => entry.closedShort > 0) ? [size.closedShort] : []),
                      ...(seesPrices && line.sizes.some((entry) => entry.unitPrice && entry.unitPrice !== line.unitPrice) ? [unitPriceText(size.unitPrice ?? line.unitPrice, currency, locale) ?? '—'] : []),
                    ],
                  })),
                }}
              />
            )}
            {/* The line's own doors (were its ⋯): ask on this line; reorder it (a person who may order). */}
            <span className="fw-pord-doors">
              {mode === 'confirmed' ? (
                <Button size="sm" variant="quiet" heldReason={model.changeHeld} onClick={() => actions?.onChangeLine?.(line.id)}>
                  {t('lines.askChange')}
                </Button>
              ) : null}
              {model.reorderHref && line.style && !line.measurement ? (
                <Button asChild size="sm" variant="quiet">
                  <a href={`${model.reorderHref}&line=${encodeURIComponent(line.id)}`}>{t('lines.reorder')}</a>
                </Button>
              ) : null}
            </span>
          </Disclosure>
        ))}
      </section>
      {model.options /* B-W2b-374: the lines' options and artwork */}
      {totals ? (
        <Card header={t('totals.title')} headingLevel={2}>
          <SummaryTable
            label={t('totals.title')}
            columns={[t('totals.what'), t('totals.amount')]}
            rows={[
              { id: 'net', cells: [t('totals.net'), words.money(totals.net, currency)] },
              { id: 'vat', cells: [t('totals.vat'), words.money(totals.vat, currency)] },
              { id: 'gross', cells: [t('totals.gross'), words.money(totals.gross, currency)] },
              ...(record.deposits.length > 0 ? [{ id: 'deposit', cells: [t('totals.depositPaid'), words.money(totals.depositPaid, currency)] }, { id: 'toPay', cells: [t('totals.toPay'), words.money(totals.toPay, currency)] }] : []),
            ]}
          />
        </Card>
      ) : null}
    </div>
  )
}
