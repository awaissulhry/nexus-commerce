'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { Equal, EqualNot, FileText, Inbox, Lock, RefreshCw } from 'lucide-react'
import { Banner, Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate, formatNumber } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { money, unitPrice } from '../../../quotes/model'
import { priceDiffOf, priceMatchCellOf, signedMoney } from '../../list/price-check-columns'
import type { PriceCheck } from '../../price-check/api'
import { sourceWords } from '../../price-check/model'
import { PriceCheckDialog } from '../../price-check/PriceCheckDialog'
import type { PriceCheckDialogActions, PriceCheckDialogModel } from '../../price-check/use-price-check'
import { customerUnitOf, editHeldOf, historyHref, isEmptyCheck, seqList, sourceLinesOf, totalPiecesOf, type PriceCheckCardActions, type PriceCheckCardModel } from '../price-check-card'
import type { Order, PriceMatch } from '../../api'
import { amendHeld } from '../../daily-model'
import type { Phrase } from '../../model'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * F-CP-142 (customer page plan C2d, C3; design 11-money §3.3, picture 21; review A3) — the order page's Money › "Price check" card,
 * after Totals: a SummaryTable (stacked on a phone) — Line · Pieces · Our unit price · Customer's unit price · Our amount · Customer's
 * amount · Check · Difference — and a Total row, the hint (difference = ours − the customer's, without VAT, to the cent), how many
 * lines still lack the customer's price, where the customer's price came from (the portal, the customer's PO with its file, typed by
 * us; who and when; the note), and three doors: Customer's price… (the ONE window, so/price-check; the primary while there is none),
 * Change our price › (the order's own Edit mode: one edit path), History › (the audit of this order's customer prices). A request that
 * named the customer's prices is offered as one row (Take them over), inside the card, never a second banner.
 *
 * Without the price grain — as Sales worker, as Production manager — the card is ONE line, "Shown to people who see prices": no
 * table, no figure, no count, and nothing was asked of the API. Draws its model; the container (use-price-check-card.ts) reads.
 */
export function PriceCheckSection({ record, order, actions }: { record: OrderRecordModel; order: Order; actions?: OrderRecordActions | undefined }) {
  const model = record.priceCheck
  const dialog = record.priceCheckDialog ? { model: record.priceCheckDialog, actions: actions?.priceCheckDialog ?? {} } : undefined
  return (
    // F-OL-04: "Change our price ›" lands on Lines, the first line's Unit price box focused; held with words without orders.manage.
    <PriceCheckCard model={model} seesPrices={record.can.price} actions={actions?.priceCheck} dialog={dialog} prefix={record.prefix} orderId={order.id} changeHeld={amendHeld(order, record.can)} onChangeOurs={() => actions?.linesTab?.onLand?.({ lineId: null, box: 'price' })} />
  )
}

function PriceCheckCard({ model, seesPrices, actions, dialog, prefix, orderId, changeHeld, onChangeOurs }: {
  model: PriceCheckCardModel | null | undefined
  /** The price grain: without it the card is one line of words whatever the container holds. */
  seesPrices: boolean
  actions?: PriceCheckCardActions | undefined
  /** The ONE customer's-price window while open (its own hook reads and saves). */
  dialog?: { readonly model: PriceCheckDialogModel; readonly actions: PriceCheckDialogActions } | undefined
  prefix: string
  orderId: string
  changeHeld: Phrase | null
  /** F-OL-04: Change our price › — the Lines tab, the price box focused. */
  onChangeOurs?: (() => void) | undefined
}) {
  const t = useT('orders')
  // The money wall first: no price grain, one line of words (a design case without the container's read: the same).
  const read = !seesPrices ? ({ state: 'held' } as const) : model?.read
  if (!read) return null
  const title = (
    <h2 className="fw-so-h2" id="price-check-title">
      {t('priceCheck.card.title')}
    </h2>
  )
  if (read.state === 'held') {
    // The money wall: one line of words, never a blank, never a figure (and no request was made).
    return (
      <section id="price-check" className="fw-so-anchor" aria-labelledby="price-check-title">
        <Card padded>
          {title}
          <p className="fw-so-hint fw-so-inline">
            <Lock size={13} aria-hidden /> {t('summary.noPrice')}
          </p>
        </Card>
      </section>
    )
  }
  return (
    <section id="price-check" className="fw-so-anchor" aria-labelledby="price-check-title">
      <Card padded>
        {read.state === 'loading' ? (
          <div className="fw-so-stack" role="status" aria-busy="true" aria-label={t('priceCheck.reading')}>
            {title}
            <Skeleton height={20} />
            <Skeleton height={20} />
            <Skeleton height={20} />
          </div>
        ) : read.state === 'failed' ? (
          <div className="fw-so-stack">
            {title}
            <Banner
              tone="danger"
              title={t('priceCheck.readFailed')}
              action={
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {t('common.retry')}
                </Button>
              }
            >
              {t(read.problem)}
            </Banner>
          </div>
        ) : (
          <Filled check={read.check} stale={read.stale} taking={read.taking} problem={read.problem} canHistory={model?.canHistory ?? false} changeHeld={changeHeld} actions={actions} prefix={prefix} orderId={orderId} onChangeOurs={onChangeOurs} title={title} />
        )}
      </Card>
      {dialog?.model && <PriceCheckDialog model={dialog.model} actions={dialog.actions} />}
    </section>
  )
}

function Filled({
  check,
  stale,
  taking,
  problem,
  canHistory,
  changeHeld,
  actions,
  prefix,
  orderId,
  onChangeOurs,
  title,
}: {
  check: PriceCheck
  stale: boolean
  taking: boolean
  problem: Phrase | null
  canHistory: boolean
  changeHeld: Phrase | null
  actions?: PriceCheckCardActions | undefined
  prefix: string
  orderId: string
  onChangeOurs?: (() => void) | undefined
  title: ReactNode
}) {
  const t = useT('orders')
  const locale = useLocale()
  const empty = isEmptyCheck(check)
  const editHeld = editHeldOf(check)
  const currency = check.currency
  const total = check.total
  const amount = (value: number | null | undefined) => (value === null || value === undefined ? '—' : money(value, currency, locale))
  const rows = [...check.lines]
    .sort((a, b) => a.seq - b.seq)
    .map((line) => ({
      id: line.lineId,
      cells: [
        <span key="line" className="fw-so-cell">
          <span>{`${line.seq} · ${line.label}`}</span>
          {line.row && <span className="fw-so-cell-sub">{t(sourceWords(line.row.source))}</span>}
        </span>,
        formatNumber(line.pieces, locale),
        unitPrice(line.ourUnitPrice, currency, locale),
        customerUnitOf(line) ? unitPrice(customerUnitOf(line), currency, locale) : line.row ? t('priceCheck.lineTotal') : '—',
        amount(line.ourAmount),
        amount(line.brandAmount),
        <MatchCell key="check" match={line.priceMatch} lines={0} t={t} />,
        <DiffCell key="diff" diff={line.priceDiff} currency={currency} t={t} />,
      ],
    }))
  rows.push({
    id: 'total',
    cells: [
      <strong key="line">{t('priceCheck.card.total')}</strong>,
      formatNumber(totalPiecesOf(check), locale),
      '',
      '',
      <strong key="ours">{amount(total.ourPrice)}</strong>,
      <strong key="theirs">{amount(total.brandPrice)}</strong>,
      <MatchCell key="check" match={total.priceMatch} lines={total.priceNotEqualLines} t={t} />,
      <DiffCell key="diff" diff={total.priceDiff} currency={currency} t={t} />,
    ],
  })
  const sources = sourceLinesOf(check)
  const editButton = (
    <Button size="sm" variant={empty ? 'primary' : undefined} heldReason={editHeld ? t(editHeld.key, editHeld.params) : null} onClick={() => actions?.onEdit?.()}>
      {t('priceCheck.card.edit')}
    </Button>
  )
  return (
    <div className="fw-so-stack">
      <div className="fw-so-card-head">
        <span className="fw-so-inline">
          {title}
          {!empty && <MatchCell match={total.priceMatch} lines={total.priceNotEqualLines} t={t} />}
        </span>
        <span className="fw-so-actions">
          {editButton}
          <Button size="sm" variant="quiet" heldReason={changeHeld ? t(changeHeld.key, changeHeld.params) : null} onClick={() => onChangeOurs?.()}>
            {t('priceCheck.card.changeOurs')}
          </Button>
          {canHistory ? (
            <Button size="sm" variant="quiet" asChild>
              <Link href={historyHref(prefix, orderId)}>{t('priceCheck.card.history')}</Link>
            </Button>
          ) : (
            <Button size="sm" variant="quiet" heldReason={t('priceCheck.card.historyHeld')}>
              {t('priceCheck.card.history')}
            </Button>
          )}
        </span>
      </div>
      {/* ONE line of the card's own state: a refusal of the take-over, or "Here they are now" after one. */}
      {stale ? (
        <Banner tone="warning" icon={<RefreshCw size={18} aria-hidden />} title={t('priceCheck.stale')} />
      ) : problem ? (
        <Banner tone="danger" title={t(problem.key, problem.params)} />
      ) : null}
      {check.fromRequest && (
        <div className="fw-so-card-head" role="group" aria-label={t('priceCheck.card.takeOverLabel')}>
          <span className="fw-so-inline">
            <Inbox size={14} aria-hidden />
            {check.fromRequest.number ? t('priceCheck.card.takeOver', { number: check.fromRequest.number }) : t('priceCheck.card.takeOverNoNumber')}
            <span className="fw-so-hint">{t('priceCheck.card.takeOverLines', { count: check.fromRequest.lines })}</span>
          </span>
          <Button size="sm" variant="primary" heldReason={taking ? t('priceCheck.card.taking') : editHeld ? t(editHeld.key, editHeld.params) : null} onClick={() => actions?.onTakeOver?.(check.fromRequest!.requestId)}>
            {t('priceCheck.card.takeOverAction')}
          </Button>
        </div>
      )}
      {empty ? (
        <EmptyState title={t('priceCheck.card.emptyTitle')} description={t('priceCheck.card.emptyBody')} />
      ) : (
        <>
          <SummaryTable
            label={t('priceCheck.card.tableLabel', { number: check.number })}
            density="roomy"
            stackOnPhone
            columns={[t('priceCheck.col.line'), t('priceCheck.col.pieces'), t('priceCheck.col.ours'), t('priceCheck.card.col.theirs'), t('priceCheck.card.col.ourAmount'), t('priceCheck.card.col.theirAmount'), t('priceCheck.card.col.check'), t('priceCheck.card.col.diff')]}
            align={['left', 'right', 'right', 'right', 'right', 'right', 'left', 'right']}
            widths={['22%', '8%', '11%', '11%', '12%', '12%', '13%', '11%']}
            rows={rows}
          />
          <p className="fw-so-hint">{t('priceCheck.card.hint')}</p>
          {total.priceMissingLines > 0 && <p className="fw-so-hint">{t('priceCheck.card.missing', { missing: total.priceMissingLines, lines: check.lines.length })}</p>}
          {total.priceOtherCurrency > 0 && <p className="fw-so-hint">{t('priceCheck.otherCurrency', { count: total.priceOtherCurrency })}</p>}
          <div className="fw-so-stack-tight">
            <h3 className="fw-so-h3">{t('priceCheck.card.sources')}</h3>
            {sources.map((source) => (
              <p key={source.key} className="fw-so-hint fw-so-inline">
                <strong>{t(sourceWords(source.source))}</strong>
                <span>
                  {[
                    source.seqs.length > 0 ? t('priceCheck.card.linesOf', { count: source.seqs.length, list: seqList(source.seqs) }) : null,
                    source.total ? t('priceCheck.orderTotal') : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {source.file && (
                  <span className="fw-so-inline">
                    <FileText size={13} aria-hidden /> {source.file.name}
                    <Tag tone="neutral">
                      <Lock size={11} aria-hidden /> {t('priceCheck.card.priced')}
                    </Tag>
                  </span>
                )}
                <span>{source.by ? t('priceCheck.card.typedBy', { name: source.by, date: formatDate(source.at, { locale }) }) : formatDate(source.at, { locale })}</span>
                {source.note && <span>{t('priceCheck.card.note', { note: source.note })}</span>}
              </p>
            ))}
          </div>
        </>
      )}
      {empty && !check.fromRequest && editHeld && <p className="fw-so-hint">{t(editHeld.key, editHeld.params)}</p>}
    </div>
  )
}

/** The Check: a DS Tag with its own mark (never colour alone) — "Equal", "Not equal" (+ "{count} lines"), "— No customer price yet"; a line that is not checked: "—". */
function MatchCell({ match, lines, t }: { match: PriceMatch | null; lines: number; t: Translate }) {
  if (match === null) return <span title={t('priceCheck.card.notChecked')}>—</span>
  const cell = priceMatchCellOf({ priceMatch: match, priceNotEqualLines: lines })
  if (!cell) return null
  if (cell.state === 'NO_BRAND_PRICE') return <span className="fw-so-hint">{t(cell.words.key)}</span>
  return (
    <span className="fw-so-cell">
      <Tag tone={cell.tone}>
        {cell.state === 'EQUAL' ? <Equal size={12} aria-hidden /> : <EqualNot size={12} aria-hidden />} {t(cell.words.key)}
      </Tag>
      {cell.state === 'NOT_EQUAL' && cell.lines && <span className="fw-so-cell-sub">{t(cell.lines.key, cell.lines.params)}</span>}
    </span>
  )
}

/** The Difference: "+€60.00" (we ask more), "−€10.00" (we ask less), "€0.00", "—" when not known. */
function DiffCell({ diff, currency, t }: { diff: number | null; currency: string; t: Translate }) {
  const locale = useLocale()
  const sign = priceDiffOf({ priceDiff: diff })
  const text = signedMoney(sign, currency, locale)
  if (!sign?.words) return <span>{text}</span>
  return (
    <span className="fw-so-cell" title={t(sign.words.key)}>
      <span>{text}</span>
      <span className="fw-so-cell-sub">{t(sign.words.key)}</span>
    </span>
  )
}
