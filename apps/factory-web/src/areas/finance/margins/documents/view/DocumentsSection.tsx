'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { EmptyState, MetricStrip, SummaryTable, type Metric } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import type { Locale } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { moneyText } from '../../../costing/model'
import { DEPTH_NAMESPACE } from '../../floor/model'
import type { CostDocument, FreightDocument, InvoiceDocument, OrderDocuments, PaymentDocument } from '../api'
import { costKindKey, costRecord, documentHref, heldPhrase, invoiceKindKey, invoiceRecord, isEmpty, methodKey, noteKey, paymentRecord, stateKey, type DocumentsState } from '../model'
import '../documents.css'

/** What the person may see of the amounts (each by its grain). */
export interface DocumentsCan {
  readonly price: boolean
  readonly cost: boolean
}

/**
 * pop:order "Documents (W2b): invoices, credit notes, cost entries, freight, payments — each a link" (B-W2b-416; FIN-053):
 * the totals over the order's documents (by grain), then each group as a small table whose first cell opens the document's
 * own page (⌘-click: a new tab). A group the person may not see says which permission it needs; a group with nothing says
 * so; loading and a failed read are said, never drawn as empty. Fetches nothing.
 */
export function DocumentsSection({ state, can, prefix, onRetry }: { state: DocumentsState | null; can: DocumentsCan; prefix: string; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={[DEPTH_NAMESPACE]}>
      <DocumentsBody state={state} can={can} prefix={prefix} onRetry={onRetry} />
    </WithMessages>
  )
}

function DocumentsBody({ state, can, prefix, onRetry }: { state: DocumentsState | null; can: DocumentsCan; prefix: string; onRetry?: () => void }) {
  const t = useT(DEPTH_NAMESPACE)
  const locale = useLocale()
  const documents = state?.value ?? null
  return (
    <section className="fw-fmg-card fw-fmd" aria-labelledby="fw-fmd-title">
      <h3 id="fw-fmd-title" className="fw-fmg-h3">
        {t('documents.title')}
      </h3>
      {state?.problem ? (
        <EmptyState
          title={t('documents.failed')}
          description={t(state.problem)}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : !documents ? (
        <p className="fw-fmg-muted" role="status" aria-busy="true">
          {t('documents.loading')}
        </p>
      ) : isEmpty(documents) ? (
        <p className="fw-fmg-muted">{t('documents.none')}</p>
      ) : (
        <>
          <Totals documents={documents} can={can} locale={locale} />
          {documents.notes.length > 0 && (
            <ul className="fw-fmd-notes">
              {documents.notes.map((note) => (
                <li key={note} className="fw-fmg-muted">
                  {t(noteKey(note), { count: documents.totals.otherCurrency })}
                </li>
              ))}
            </ul>
          )}
          <div className="fw-fmd-groups">
            <Group title={t('group.invoices')} held={documents.invoices.held} count={documents.invoices.rows.length}>
              <InvoiceTable rows={documents.invoices.rows} can={can} prefix={prefix} label={t('group.invoices')} />
            </Group>
            <Group title={t('group.creditNotes')} held={documents.creditNotes.held} count={documents.creditNotes.rows.length}>
              <InvoiceTable rows={documents.creditNotes.rows} can={can} prefix={prefix} label={t('group.creditNotes')} credit />
            </Group>
            <Group title={t('group.costs')} held={documents.costs.held} count={documents.costs.rows.length}>
              <CostTable rows={documents.costs.rows} can={can} prefix={prefix} label={t('group.costs')} />
            </Group>
            <Group title={t('group.freight')} held={documents.freight.held} count={documents.freight.rows.length}>
              <FreightTable rows={documents.freight.rows} can={can} prefix={prefix} label={t('group.freight')} />
            </Group>
            <Group title={t('group.payments')} held={documents.payments.held} count={documents.payments.rows.length} wide>
              <PaymentTable rows={documents.payments.rows} can={can} prefix={prefix} label={t('group.payments')} />
            </Group>
          </div>
        </>
      )}
    </section>
  )
}

function Totals({ documents, can, locale }: { documents: OrderDocuments; can: DocumentsCan; locale: Locale }) {
  const t = useT(DEPTH_NAMESPACE)
  const currency = documents.order.currency
  const totals = documents.totals
  const tile = (label: string, value: number | null | undefined, hint: string): Metric => ({ label, value: moneyText(value ?? null, currency, locale), hint })
  const metrics: Metric[] = [
    ...(can.price && documents.invoices.held === null ? [tile(t('totals.net'), totals.net, t('totals.netHint', { invoiced: moneyText(totals.invoiced ?? null, currency, locale), credited: moneyText(totals.credited ?? null, currency, locale) }))] : []),
    ...(can.price && documents.invoices.held === null && typeof totals.deposits === 'number' && totals.deposits !== 0 ? [tile(t('totals.deposits'), totals.deposits, t('totals.depositsHint'))] : []),
    ...(can.price && documents.payments.held === null ? [tile(t('totals.paid'), totals.paid, t('totals.paidHint'))] : []),
    ...(can.price && documents.freight.held === null ? [tile(t('totals.freightCharged'), totals.freightCharged, t('totals.freightChargedHint'))] : []),
    ...(can.cost && documents.freight.held === null ? [tile(t('totals.freightCost'), totals.freightCost, t('totals.freightCostHint'))] : []),
  ]
  if (metrics.length === 0) return <p className="fw-fmg-muted">{t('totals.noGrain')}</p>
  return <MetricStrip metrics={metrics} minTileWidth={170} />
}

function Group({ title, held, count, wide, children }: { title: string; held: string | null; count: number; wide?: boolean; children: ReactNode }) {
  const t = useT(DEPTH_NAMESPACE)
  const phrase = held ? heldPhrase(held) : null
  return (
    <div className={`fw-fmd-group${wide ? ' is-wide' : ''}`}>
      <h4 className="fw-fmd-h4">
        {title} <span className="fw-fmg-muted">{t('group.count', { count })}</span>
      </h4>
      {phrase ? <p className="fw-fmg-muted">{t(phrase.key, phrase.params)}</p> : count === 0 ? <p className="fw-fmg-muted">{t('group.empty')}</p> : children}
    </div>
  )
}

/** A document's first cell: its number as a link to its own page (or plain text when it has none). */
function Opens({ href, children }: { href: string | null; children: ReactNode }) {
  return href ? (
    <Link className="fw-fmg-link" href={href}>
      {children}
    </Link>
  ) : (
    <span>{children}</span>
  )
}

const day = (value: string | null, locale: Locale): string => (value ? formatDate(`${value}T12:00:00Z`, { locale }) : '—')

function InvoiceTable({ rows, can, prefix, label, credit }: { rows: readonly InvoiceDocument[]; can: DocumentsCan; prefix: string; label: string; credit?: boolean }) {
  const t = useT(DEPTH_NAMESPACE)
  const locale = useLocale()
  return (
    <SummaryTable
      label={label}
      stackOnPhone
      columns={[t('col.document'), t('col.date'), t('col.state'), ...(can.price ? [t('col.forOrder'), t('col.total')] : [])]}
      align={[undefined, undefined, undefined, ...(can.price ? (['right', 'right'] as const) : [])]}
      widths={can.price ? ['30%', '15%', '19%', '18%', '18%'] : ['44%', '24%', '32%']}
      rows={rows.map((row) => ({
        id: row.id,
        cells: [
          <span key="d" className="fw-fmg-cell">
            <Opens href={documentHref(prefix, invoiceRecord(row))}>{row.number ?? t('documents.noNumber')}</Opens>
            <span className="fw-fmg-cell-sub">
              {t(invoiceKindKey(row), { type: row.docType })}
              {credit && row.of ? ` · ${t('invoice.credits', { number: row.of.number ?? t('documents.noNumber') })}` : ''}
              {!credit && row.of ? ` · ${t('invoice.adds', { number: row.of.number ?? t('documents.noNumber') })}` : ''}
            </span>
          </span>,
          day(row.issueDate, locale),
          <Tag key="s" tone={row.status === 'DRAFT' || row.status === 'REJECTED' || row.status === 'ERROR' ? 'warning' : 'neutral'}>
            {t(stateKey('Invoice', row.status))}
          </Tag>,
          ...(can.price
            ? [
                <span key="f" className="fw-fmg-cell">
                  <span className="fw-fmg-num">{moneyText(row.forOrder ?? null, row.currency, locale)}</span>
                  {row.shared && <span className="fw-fmg-cell-sub">{t('invoice.shared')}</span>}
                </span>,
                moneyText(row.netTotal ?? null, row.currency, locale),
              ]
            : []),
        ],
      }))}
    />
  )
}

function CostTable({ rows, can, prefix, label }: { rows: readonly CostDocument[]; can: DocumentsCan; prefix: string; label: string }) {
  const t = useT(DEPTH_NAMESPACE)
  const locale = useLocale()
  const detail = (row: CostDocument): string => {
    const parts = [row.pieces !== null && row.ofPieces !== null ? t('cost.pieces', { pieces: row.pieces, of: row.ofPieces }) : null, t('cost.entries', { count: row.entries }), row.reversed ? t('cost.reversed') : null]
    return parts.filter((part): part is string => part !== null).join(' · ')
  }
  return (
    <SummaryTable
      label={label}
      stackOnPhone
      columns={[t('col.document'), t('col.date'), t('col.detail'), ...(can.cost ? [t('col.amount')] : [])]}
      align={[undefined, undefined, undefined, ...(can.cost ? (['right'] as const) : [])]}
      widths={can.cost ? ['32%', '16%', '34%', '18%'] : ['38%', '20%', '42%']}
      rows={rows.map((row) => ({
        id: `${row.kind}:${row.record.id}`,
        cells: [
          <span key="d" className="fw-fmg-cell">
            <Opens href={documentHref(prefix, costRecord(row))}>{row.record.number ?? t('documents.noNumber')}</Opens>
            <span className="fw-fmg-cell-sub">
              {t(costKindKey(row))} · {t(stateKey(row.record.type, row.status))}
            </span>
          </span>,
          day(row.date, locale),
          detail(row),
          ...(can.cost ? [moneyText(row.amount ?? null, row.currency, locale)] : []),
        ],
      }))}
    />
  )
}

function FreightTable({ rows, can, prefix, label }: { rows: readonly FreightDocument[]; can: DocumentsCan; prefix: string; label: string }) {
  const t = useT(DEPTH_NAMESPACE)
  const locale = useLocale()
  return (
    <SummaryTable
      label={label}
      stackOnPhone
      columns={[t('col.shipment'), t('col.date'), t('col.carrier'), ...(can.price ? [t('col.charged')] : []), ...(can.cost ? [t('col.carrierCost')] : [])]}
      align={[undefined, undefined, undefined, ...(can.price ? (['right'] as const) : []), ...(can.cost ? (['right'] as const) : [])]}
      rows={rows.map((row) => ({
        id: row.shipment.id,
        cells: [
          <span key="d" className="fw-fmg-cell">
            <Opens href={documentHref(prefix, { type: 'Shipment', id: row.shipment.id })}>{row.shipment.number}</Opens>
            <span className="fw-fmg-cell-sub">{t(stateKey('Shipment', row.shipment.status))}</span>
          </span>,
          day(row.date, locale),
          row.carrier ?? t('freight.noCarrier'),
          ...(can.price ? [row.charge === null || row.charge === undefined ? t('freight.noCharge') : moneyText(row.charge, row.chargeCurrency, locale)] : []),
          ...(can.cost ? [row.cost === null || row.cost === undefined ? t('freight.noCost') : moneyText(row.cost, row.costCurrency, locale)] : []),
        ],
      }))}
    />
  )
}

function PaymentTable({ rows, can, prefix, label }: { rows: readonly PaymentDocument[]; can: DocumentsCan; prefix: string; label: string }) {
  const t = useT(DEPTH_NAMESPACE)
  const locale = useLocale()
  return (
    <SummaryTable
      label={label}
      stackOnPhone
      columns={[t('col.payment'), t('col.date'), t('col.placedOn'), ...(can.price ? [t('col.paid'), t('col.paymentAmount')] : [])]}
      align={[undefined, undefined, undefined, ...(can.price ? (['right', 'right'] as const) : [])]}
      widths={can.price ? ['26%', '14%', '28%', '16%', '16%'] : ['36%', '24%', '40%']}
      rows={rows.map((row) => ({
        id: row.id,
        cells: [
          <span key="d" className="fw-fmg-cell">
            <Opens href={documentHref(prefix, paymentRecord(row))}>{row.reference}</Opens>
            <span className="fw-fmg-cell-sub">
              {t(methodKey(row.method))} · {t(stateKey('Payment', row.status))}
              {row.reversed ? ` · ${t('payment.reversed')}` : ''}
            </span>
          </span>,
          day(row.receivedOn, locale),
          <span key="p" className="fw-fmd-places">
            {row.to.map((target) => {
              const href = documentHref(prefix, target)
              const text = target.type === 'Invoice' ? (target.number ?? t('documents.noNumber')) : t('payment.deposit')
              return href ? (
                <Link key={target.id} className="fw-fmg-link" href={href}>
                  {text}
                </Link>
              ) : (
                <span key={target.id}>{text}</span>
              )
            })}
          </span>,
          ...(can.price ? [moneyText(row.paid ?? null, row.currency, locale), moneyText(row.amount ?? null, row.currency, locale)] : []),
        ],
      }))}
    />
  )
}
