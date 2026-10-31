'use client'

import Link from 'next/link'
import { Check, RefreshCw } from 'lucide-react'
import { Button, Pill } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayInstant, decimal, money, unitPrice } from '../../../_shared/model'
import type { InvoiceMatch } from '../../api'
import { orderHref, PAYABLES_NAMESPACE, VERDICT_TONE, type Phrase } from '../../model'

/**
 * MatchPanel — a NEW part (design finance.payables Match "Ordered, received, invoiced": `NEW MatchPanel`), composed in this
 * area because only Supplier invoices draws it (W2a plan §7: one-area parts live in the area): per invoice line what we
 * ORDERED (quantity × the order's price), what ARRIVED (the receipts not billed by the supplier's other invoices, with the
 * last receipt and its delivery note) and what they CHARGE (quantity × price), the verdict as a Pill with the API's words
 * in the person's language, the difference's value, and the line's verbs: Accept difference with reason (held with its
 * reason), Match again (when the facts changed since). Prices and amounts only with the cost grain (absent, never '—').
 */
export function MatchPanel({
  matches,
  currency,
  cost,
  prefix,
  purchasing,
  acceptHeld,
  onAccept,
  onMatchAgain,
  matchAgainHeld,
}: {
  matches: readonly InvoiceMatch[]
  currency: string
  cost: boolean
  prefix: string
  purchasing: boolean
  /** Why a difference may not be accepted now (null: it may). */
  acceptHeld: Phrase | null
  onAccept?: (matchId: string) => void
  onMatchAgain?: () => void
  matchAgainHeld: Phrase | null
}) {
  const t = useT(PAYABLES_NAMESPACE)
  const locale = useLocale()
  const qty = (value: string | null, unit: string) => (value === null ? '—' : `${decimal(value, locale)} ${unit}`)
  const times = (value: string | null, unit: string, price: string | undefined) =>
    cost && price !== undefined ? t('match.times', { quantity: qty(value, unit), price: unitPrice(price, currency, locale) }) : qty(value, unit)
  return (
    <ul className="fw-fpy-match" aria-label={t('match.title')}>
      {matches.map((entry) => {
        const order = entry.order
        const outside = entry.verdict !== 'WITHIN'
        return (
          <li key={entry.id} className="fw-fpy-match-row">
            <div className="fw-fpy-head">
              <span className="fw-fpy-inline">
                <b>{t('match.line', { seq: entry.lineSeq })}</b>
                {order ? (
                  purchasing && order.kind === 'PURCHASE_ORDER' ? (
                    <Link className="fw-fpy-link" href={orderHref(prefix, order.id)}>
                      {order.lineSeq !== null ? t('match.orderLine', { number: order.number, seq: order.lineSeq }) : order.number}
                    </Link>
                  ) : (
                    <span>{order.lineSeq !== null ? t('match.orderLine', { number: order.number, seq: order.lineSeq }) : order.number}</span>
                  )
                ) : (
                  <span className="fw-fpy-muted">{t('match.noOrder')}</span>
                )}
                {order?.item && <span className="fw-fpy-muted">{`${order.item.code} · ${order.item.name}`}</span>}
              </span>
              <span className="fw-fpy-inline">
                <Pill tone={entry.accepted ? 'success' : VERDICT_TONE[entry.verdict]}>{entry.accepted ? t('match.accepted') : t(`verdict.${entry.verdict}`)}</Pill>
                <span>{locale === 'it' ? entry.words.it : entry.words.en}</span>
              </span>
            </div>
            <div className="fw-fpy-match-cols">
              <div className="fw-fpy-match-col">
                <span className="fw-fpy-match-label">{t('match.ordered')}</span>
                <span className="fw-fpy-match-value">{times(entry.orderedQuantity, entry.unit, entry.orderedUnitPrice)}</span>
              </div>
              <div className="fw-fpy-match-col">
                <span className="fw-fpy-match-label">{t('match.received')}</span>
                <span className="fw-fpy-match-value">{qty(entry.receivedQuantity, entry.unit)}</span>
                <span className="fw-fpy-cell-sub">
                  {entry.receipt
                    ? t(entry.receipt.supplierDdtNumber ? 'match.receiptDdt' : 'match.receipt', {
                        number: entry.receipt.number,
                        ddt: entry.receipt.supplierDdtNumber ?? '',
                        date: entry.receipt.supplierDdtDate ? formatDate(dayInstant(entry.receipt.supplierDdtDate), { locale }) : '—',
                      })
                    : t('match.nothingReceived')}
                </span>
              </div>
              <div className="fw-fpy-match-col">
                <span className="fw-fpy-match-label">{t('match.invoiced')}</span>
                <span className="fw-fpy-match-value">{times(entry.invoicedQuantity, entry.unit, entry.invoicedUnitPrice)}</span>
                {cost && typeof entry.differenceAmount === 'number' && entry.differenceAmount !== 0 && (
                  <span className="fw-fpy-cell-sub fw-fpy-num">{t('match.difference', { amount: signed(entry.differenceAmount, currency, locale) })}</span>
                )}
              </div>
            </div>
            {entry.accepted && (
              <p className="fw-fpy-muted">
                {t('match.acceptedBy', { name: entry.accepted.by.name ?? t('match.someone'), date: formatDate(entry.accepted.at, { locale }), note: entry.accepted.note })}
              </p>
            )}
            {(entry.stale || (outside && !entry.accepted)) && (
              <span className="fw-fpy-inline">
                {outside && !entry.accepted && (
                  <Button size="sm" heldReason={acceptHeld ? t(acceptHeld.key, acceptHeld.params) : null} onClick={() => onAccept?.(entry.id)}>
                    <Check size={14} aria-hidden /> {t('match.accept')}
                  </Button>
                )}
                {entry.stale && (
                  <Button size="sm" heldReason={matchAgainHeld ? t(matchAgainHeld.key, matchAgainHeld.params) : null} onClick={() => onMatchAgain?.()}>
                    <RefreshCw size={14} aria-hidden /> {t('match.again')}
                  </Button>
                )}
                {entry.stale && <span className="fw-fpy-muted">{t('match.stale')}</span>}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function signed(minor: number, currency: string, locale: 'it' | 'en'): string {
  const text = money(Math.abs(minor), currency, locale)
  return minor > 0 ? `+${text}` : `−${text}`
}
