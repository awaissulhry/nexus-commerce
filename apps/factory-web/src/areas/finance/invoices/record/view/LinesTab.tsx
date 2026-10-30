'use client'

import Link from 'next/link'
import { Info } from 'lucide-react'
import { Banner, Card, DetailPopover, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { hasRecordPage, recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { Invoice, InvoiceLine } from '../../../_shared/api'
import { checkOf, creditHeld, dayInstant, decimal, dueDateOf, money, unitPrice, vatOf, type CheckFix } from '../../../_shared/model'
import { Bridge, CheckList, PartState } from '../../../_shared/parts'
import type { InvoiceRecordActions, InvoiceRecordModel } from '../record-model'

/**
 * Lines & VAT (design invoice tab "lines"): a draft's checks before issue (each failed check in words with where to fix
 * it; the number it will get when they pass), an issued invoice's notice (it cannot change; corrections only by credit
 * note) or a rejected one's (fix and send again, same number and date); the lines with their DDT, order, quantity, unit
 * price, discount, net and the VAT in words ("Why no VAT?" on a 0 % line); the deposit deductions (a draft may remove
 * one); and the totals as a bridge from the goods to what the customer still has to pay, with the VAT summary.
 */
export function LinesTab({ invoice, model, actions }: { invoice: Invoice; model: InvoiceRecordModel; actions?: InvoiceRecordActions }) {
  const t = useT('finance')
  const locale = useLocale()
  const draft = invoice.status === 'DRAFT'
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const creditWait = creditHeld(invoice, model.can)
  return (
    <div className="fw-fin-stack">
      {draft && <ChecksCard invoice={invoice} model={model} actions={actions} />}
      {!draft && invoice.status !== 'REJECTED' && (
        <Banner
          tone="info"
          title={t('lines.issuedBanner', { date: day(invoice.issueDate) })}
          action={
            invoice.docType !== 'TD04' && !creditWait ? (
              <Button size="sm" onClick={() => actions?.onDialog?.({ kind: 'credit' })}>
                {t('action.creditNote')}
              </Button>
            ) : undefined
          }
        />
      )}
      {invoice.status === 'REJECTED' && (
        <Banner
          tone="danger"
          title={model.sdi?.value?.deadline ? t('lines.rejectedBanner', { date: day(model.sdi.value.deadline.deadline) }) : t('lines.rejectedBannerNoDate')}
          action={
            <Button size="sm" variant="primary" heldReason={model.can.issueInvoices ? null : t('held.noIssue')} onClick={() => actions?.onDialog?.({ kind: 'fix' })}>
              {t('step.fix')}
            </Button>
          }
        />
      )}
      <div className="fw-fin-split">
        <LinesCard invoice={invoice} model={model} actions={actions} />
        <TotalsCard invoice={invoice} model={model} actions={actions} />
      </div>
    </div>
  )
}

function ChecksCard({ invoice, model, actions }: { invoice: Invoice; model: InvoiceRecordModel; actions?: InvoiceRecordActions }) {
  const t = useT('finance')
  const part = model.checks
  if (!part || !part.value) return <PartState problem={part?.problem ?? null} label={t('checks.title')} onRetry={() => actions?.onRetryPart?.('checks')} />
  const checks = part.value
  const fixLink = (fix: CheckFix) => {
    if (fix === 'party' && hasRecordPage('Party', OFFICE_PAGES) && model.can.viewParties)
      return (
        <Button size="sm" variant="link" asChild>
          <Link href={`${model.prefix}${recordAddress({ type: 'Party', id: invoice.buyerPartyId }, OFFICE_PAGES)}`}>{t('checks.fix.party')}</Link>
        </Button>
      )
    if (fix === 'company')
      return (
        <Button size="sm" variant="link" asChild>
          <Link href={`${model.prefix}/finance/settings`}>{t('checks.fix.company')}</Link>
        </Button>
      )
    if (fix === 'series' && OFFICE_PAGES.has('/admin/documents') && model.can.viewNumbering)
      return (
        <Button size="sm" variant="link" asChild>
          <Link href={`${model.prefix}/admin/documents`}>{t('checks.fix.series')}</Link>
        </Button>
      )
    if (fix === 'lines' && model.can.manageInvoices)
      return (
        <Button size="sm" variant="link" onClick={() => actions?.onDialog?.({ kind: 'lines' })}>
          {t('checks.fix.lines')}
        </Button>
      )
    if (fix === 'text' && model.can.manageInvoices)
      return (
        <Button size="sm" variant="link" onClick={() => actions?.onDialog?.({ kind: 'details' })}>
          {t('checks.fix.text')}
        </Button>
      )
    if (fix === 'deduction') return <span className="fw-fin-hint">{t('checks.fix.deduction')}</span>
    return null
  }
  const items = checks.ready
    ? [{ id: 'ready', ok: true, words: t('checks.allPass', { number: checks.numberPreview ?? '—' }) }]
    : checks.problems.map((problem, index) => {
        const words = checkOf(problem)
        return { id: `${problem.code}-${index}`, ok: false, words: t(words.key), fix: fixLink(words.fix) }
      })
  return (
    <Card padded className="fw-fin-card">
      <div className="fw-fin-card-head">
        <h2 className="fw-fin-h2">{t('checks.title')}</h2>
        {checks.ready && (
          <Button size="sm" variant="primary" heldReason={model.can.issueInvoices ? (model.busy ? t('held.busy') : null) : t('held.noIssue')} onClick={() => actions?.onDialog?.({ kind: 'issue' })}>
            {t('step.issue')}
          </Button>
        )}
      </div>
      <p className="fw-fin-hint">{t('checks.explain')}</p>
      <CheckList items={items} label={t('checks.title')} />
      {!checks.ready && <p className="fw-fin-hint">{t('checks.failCount', { count: checks.problems.length })}</p>}
    </Card>
  )
}

/** The VAT cell: the rate, or the reason without VAT with "Why no VAT?" (customer type, the law, the printed wording). */
function VatCell({ line, invoice }: { line: InvoiceLine; invoice: Invoice }) {
  const t = useT('finance')
  const locale = useLocale()
  const vat = vatOf(line)
  if (vat.nature === null) return <span>{vat.rate === null ? '—' : `${decimal(String(vat.rate), locale, 2)} %`}</span>
  const vies = (invoice.billTo as { vies?: { checkedAt?: string } }).vies
  return (
    <DetailPopover
      trigger={
        <span className="fw-fin-inline">
          {vat.nature} <Info size={12} aria-hidden />
        </span>
      }
      triggerLabel={t('vat.whyLabel', { code: vat.nature })}
      label={t('vat.whyTitle')}
    >
      <div className="fw-fin-stack-tight">
        <b>{t('vat.whyTitle')}</b>
        <span>{vat.key ? t(vat.key) : t('vat.otherCode', { code: vat.nature })}</span>
        {vies?.checkedAt && <span>{t('vat.vies', { date: formatDate(vies.checkedAt, { locale }) })}</span>}
        {vat.law && <span className="fw-fin-hint">{t('vat.printed', { text: vat.law })}</span>}
      </div>
    </DetailPopover>
  )
}

function LinesCard({ invoice, model, actions }: { invoice: Invoice; model: InvoiceRecordModel; actions?: InvoiceRecordActions }) {
  const t = useT('finance')
  const locale = useLocale()
  const related = model.related.value
  const draft = invoice.status === 'DRAFT'
  const goods = invoice.lines.filter((line) => line.kind !== 'DEPOSIT_DEDUCTION')
  const deductions = invoice.lines.filter((line) => line.kind === 'DEPOSIT_DEDUCTION')
  const ddtOf = (id: string | null) => (id ? related?.ddts.find((ddt) => ddt.id === id) : undefined)
  const td02Of = (id: string | null) => (id ? related?.depositInvoices.find((entry) => entry.id === id) : undefined)
  const price = model.can.price
  const columns = [t('lines.col.description'), t('lines.col.quantity'), ...(price ? [t('lines.col.unitPrice'), t('lines.col.discount'), t('lines.col.net')] : []), t('lines.col.vat')]
  const rows = [
    ...goods.map((line) => {
      const ddt = ddtOf(line.ddtId)
      return {
        id: line.id,
        cells: [
          <span key="d" className="fw-fin-cell">
            <span>{line.description}</span>
            <span className="nds-summary-sub">{[line.itemCode, ddt ? t('lines.ddtRef', { number: ddt.number }) : null].filter(Boolean).join(' · ') || '—'}</span>
          </span>,
          `${decimal(line.quantity, locale)}${line.uom ? ` ${line.uom}` : ''}`,
          ...(price ? [unitPrice(line.unitPrice, invoice.currency, locale), line.discountPct ? `${decimal(line.discountPct, locale)} %` : '—', money(line.netAmount, invoice.currency, locale)] : []),
          <VatCell key="v" line={line} invoice={invoice} />,
        ],
      }
    }),
    ...deductions.map((line) => {
      const td02 = td02Of(line.depositInvoiceId)
      return {
        id: line.id,
        cells: [
          <span key="d" className="fw-fin-cell">
            <span>{td02 ? t('lines.deduction', { number: td02.number ?? '—' }) : line.description}</span>
            <span className="nds-summary-sub">
              {td02 ? (
                <Link className="fw-fin-link" href={`${model.prefix}/finance/invoices/${td02.id}`}>
                  {t('lines.openTd02')}
                </Link>
              ) : (
                t('lines.deductionSub')
              )}
              {draft && model.can.manageInvoices && (
                <>
                  {' · '}
                  <Button size="sm" variant="link" heldReason={model.busy ? t('held.busy') : null} onClick={() => actions?.onRemoveDeduction?.(line.id)}>
                    {t('lines.removeDeduction')}
                  </Button>
                </>
              )}
            </span>
          </span>,
          '1',
          ...(price ? ['—', '—', money(line.netAmount, invoice.currency, locale)] : []),
          <VatCell key="v" line={line} invoice={invoice} />,
        ],
      }
    }),
  ]
  return (
    <Card padded className="fw-fin-card">
      <div className="fw-fin-card-head">
        <h2 className="fw-fin-h2">{t('lines.title')}</h2>
        {draft && (
          <span className="fw-fin-actions">
            <Button size="sm" heldReason={model.can.manageInvoices ? null : t('held.noManage')} onClick={() => actions?.onDialog?.({ kind: 'lines' })}>
              {t('lines.edit')}
            </Button>
            <Button size="sm" variant="quiet" heldReason={model.can.manageInvoices ? null : t('held.noManage')} onClick={() => actions?.onDialog?.({ kind: 'details' })}>
              {t('lines.editDetails')}
            </Button>
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <EmptyState title={t('lines.empty.title')} description={t('lines.empty.body')} />
      ) : (
        <SummaryTable label={t('lines.title')} columns={columns} rows={rows} widths={price ? ['44%', '10%', '14%', '10%', '12%', '10%'] : ['70%', '15%', '15%']} align={price ? [undefined, 'right', 'right', 'right', 'right', 'left'] : [undefined, 'right', 'left']} stackOnPhone />
      )}
      <KeyValue
        dense
        labelCase="sentence"
        columns={2}
        items={[
          { label: t('lines.causale'), value: invoice.causale ?? '—' },
          { label: t('lines.due'), value: dueDateOf(invoice) ? formatDate(dayInstant(dueDateOf(invoice)!), { locale }) : '—', hint: t('lines.method') },
          { label: t('lines.basis'), value: t(`basis.${invoice.priceBasis}`) },
          { label: t('lines.refs'), value: (invoice.documentRefs ?? []).map((ref) => (ref as { number?: string }).number ?? '').filter(Boolean).join(', ') || '—' },
        ]}
      />
      {!model.related.value && model.related.problem === null && (
        <p className="fw-fin-hint" role="status">
          <Spinner size={12} /> {t('part.loading', { part: t('lines.relatedPart') })}
        </p>
      )}
    </Card>
  )
}

function TotalsCard({ invoice, model }: { invoice: Invoice; model: InvoiceRecordModel; actions?: InvoiceRecordActions }) {
  const t = useT('finance')
  const locale = useLocale()
  if (!model.can.price) {
    return (
      <Card padded className="fw-fin-card">
        <h2 className="fw-fin-h2">{t('totals.title')}</h2>
        <p className="fw-fin-hint">{t('totals.noGrain')}</p>
      </Card>
    )
  }
  const goods = invoice.lines.filter((line) => line.kind !== 'DEPOSIT_DEDUCTION').reduce((sum, line) => sum + (line.netAmount ?? 0), 0)
  const deducted = invoice.lines.filter((line) => line.kind === 'DEPOSIT_DEDUCTION').reduce((sum, line) => sum + (line.netAmount ?? 0), 0)
  const m = (value: number | null | undefined) => money(value, invoice.currency, locale)
  const payable = invoice.docType === 'TD01' || invoice.docType === 'TD24'
  const rows = [
    { id: 'goods', label: t('totals.goods'), value: m(goods) },
    ...(deducted !== 0 ? [{ id: 'deposit', label: t('totals.deposit'), value: m(deducted) }] : []),
    { id: 'taxable', label: t('totals.taxable'), value: m(invoice.netTotal) },
    { id: 'vat', label: t('totals.vat'), value: m(invoice.vatTotal) },
    ...(invoice.stampDutyAmount ? [{ id: 'stamp', label: t('totals.stamp'), value: m(invoice.stampDutyAmount) }] : []),
    { id: 'gross', label: t(invoice.docType === 'TD04' ? 'totals.credit' : 'totals.gross'), value: m(invoice.grossTotal), total: true },
    ...(payable && invoice.status !== 'DRAFT'
      ? [
          ...((invoice.creditedAmount ?? 0) > 0 ? [{ id: 'credited', label: t('totals.credited'), value: m(-(invoice.creditedAmount ?? 0)) }] : []),
          { id: 'paid', label: t('totals.paid'), value: m((invoice.paidAmount ?? 0) > 0 ? -(invoice.paidAmount ?? 0) : 0) },
          { id: 'open', label: t('totals.open'), value: m(invoice.openAmount), total: true },
        ]
      : []),
  ]
  const summary = invoice.vatSummary ?? []
  return (
    <Card padded className="fw-fin-card">
      <h2 className="fw-fin-h2">{t('totals.title')}</h2>
      <Bridge rows={rows} label={t('totals.title')} />
      {(invoice.refundDueAmount ?? 0) > 0 && <Banner tone="warning" title={t('totals.refundDue', { amount: m(invoice.refundDueAmount) })} />}
      {summary.length > 0 && (
        <SummaryTable
          label={t('totals.summary')}
          columns={[t('totals.col.treatment'), t('totals.col.taxable'), t('totals.col.vat')]}
          rows={summary.map((entry, index) => ({
            id: `${entry.rate ?? ''}-${entry.nature ?? ''}-${index}`,
            cells: [entry.nature ? `${entry.nature}` : `${decimal(entry.rate, locale, 2)} %`, m(entry.taxable), m(entry.vat)],
          }))}
          align={[undefined, 'right', 'right']}
        />
      )}
    </Card>
  )
}
