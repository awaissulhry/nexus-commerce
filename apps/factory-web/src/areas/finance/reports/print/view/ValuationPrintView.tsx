'use client'

import { Printer } from 'lucide-react'
import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { VALUATION_CATEGORIES, type Valuation, type ValuationRow } from '../../api'
import { basisPhrase, decimalText, methodPhrase, moneyText, orderedRows, reportNotes, unitCostText, type ReportsCan, type ValuationAddress } from '../../model'
import '../../reports.css'

/** SCR-239-print — the stock valuation on paper: one view model, nothing fetched. */
export interface ValuationPrintModel {
  /** Who printed it (said at the top with the time). */
  readonly person: string
  readonly company: string
  readonly can: ReportsCan
  readonly address: ValuationAddress
  readonly today: string
  readonly valuation: { readonly value: Valuation | null; readonly problem: string | null }
  /** When it was read (an instant). */
  readonly readAt: string | null
}

/**
 * Finance › Reports › Stock valuation (print) (design finance.reports tab:print, "a dated document for the accountant"):
 * the company, the day it is valued at, when it was read and by whom written at the top, the method and that it is to
 * confirm with the accountant, the totals by category, then the rows of each category (values only with the cost
 * grain). Opened in a new tab from the report's ⋯; the print stylesheet hides the Office frame, and the browser saves it
 * as a PDF.
 */
export function ValuationPrintView({ model }: { model: ValuationPrintModel }) {
  return (
    <WithMessages namespaces={['finance-reports']}>
      <ValuationPrint model={model} />
    </WithMessages>
  )
}

function ValuationPrint({ model }: { model: ValuationPrintModel }) {
  const t = useT('finance-reports')
  const locale = useLocale()
  const valuation = model.valuation.value
  const day = valuation?.asOfDay ?? model.address.asOf ?? model.today
  const dayText = formatDate(`${day}T12:00:00Z`, { locale })
  if (!model.can.view) {
    return (
      <article className="fw-frv-print">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </article>
    )
  }
  const method = valuation ? methodPhrase(valuation.methods) : null
  const rows = valuation ? orderedRows(valuation.rows, true) : []
  const cost = model.can.cost
  return (
    <article className="fw-frv-print">
      <header className="fw-frv-print-head">
        <h2 className="fw-frv-print-title">{t('print.title', { company: model.company, day: dayText })}</h2>
        <p className="fw-frv-muted">{model.readAt ? t('print.meta', { at: formatDateTime(model.readAt, { locale }), person: model.person }) : model.person}</p>
        {method && <p className="fw-frv-muted">{t(method.key)}</p>}
        <p className="fw-frv-muted">{t('method.accountant')}</p>
        {!cost && <p className="fw-frv-muted">{t('method.noCost')}</p>}
        <Button className="fw-frv-print-button" variant="secondary" onClick={() => window.print()} heldReason={valuation ? undefined : t('print.held')}>
          <Printer size={14} aria-hidden /> {t('print.button')}
        </Button>
      </header>
      {model.valuation.problem ? (
        <Banner tone="danger" title={t('list.failed')}>
          {t(model.valuation.problem)}
        </Banner>
      ) : !valuation ? (
        <p className="fw-frv-muted" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState title={t('list.empty.title')} description={t('list.empty.body', { day: dayText })} />
      ) : (
        <>
          <section className="fw-frv-print-section" aria-label={t('totals.title')}>
            <SummaryTable
              label={t('totals.title')}
              columns={cost ? [t('col.category'), t('totals.rows'), t('col.value')] : [t('col.category'), t('totals.rows')]}
              align={cost ? [undefined, 'right', 'right'] : [undefined, 'right']}
              rows={[
                ...valuation.categories.map((entry) => ({ id: entry.category, cells: cost ? [t(`category.${entry.category}`), String(entry.rows), moneyText(entry.value ?? null, entry.currency, locale)] : [t(`category.${entry.category}`), String(entry.rows)] })),
                { id: 'total', cells: cost ? [t('totals.total'), String(valuation.rows.length), moneyText(valuation.value ?? null, valuation.currency, locale)] : [t('totals.total'), String(valuation.rows.length)] },
              ]}
            />
            {reportNotes(valuation, model.can).map((note) => (
              <p key={note.key} className="fw-frv-muted">
                {t(note.key, { ...note.params, residue: moneyText(valuation.residue ?? null, valuation.currency, locale) })}
              </p>
            ))}
          </section>
          {VALUATION_CATEGORIES.map((category) => {
            const mine = rows.filter((row) => row.category === category)
            if (mine.length === 0) return null
            return (
              <section key={category} className="fw-frv-print-section" aria-label={t(`category.${category}`)}>
                <h2 className="fw-frv-h2">{t(`category.${category}`)}</h2>
                <SummaryTable
                  label={t(`category.${category}`)}
                  density="compact"
                  columns={[t('col.item'), t('col.lot'), t('col.site'), t('col.quantity'), ...(cost ? [t('col.value'), t('col.unitCost')] : []), t('col.basis')]}
                  align={[undefined, undefined, undefined, 'right', ...(cost ? (['right', 'right'] as const) : []), undefined]}
                  rows={mine.map((row) => ({ id: `${row.site.id}|${row.item?.id ?? row.workOrder?.id}|${row.colour?.id ?? ''}|${row.lot?.id ?? ''}`, cells: printCells(row, cost, t, locale) }))}
                />
              </section>
            )
          })}
        </>
      )}
    </article>
  )
}

function printCells(row: ValuationRow, cost: boolean, t: ReturnType<typeof useT>, locale: ReturnType<typeof useLocale>): string[] {
  const basis = basisPhrase(row)
  const item = row.workOrder ? t('row.wip', { number: row.workOrder.number }) : row.item ? `${row.item.code} · ${row.item.name}${row.colour ? ` · ${row.colour.code}` : ''}` : '—'
  const quantity = row.quantity === null ? '—' : `${decimalText(row.quantity, locale)} ${row.uom ?? ''}`.trim()
  return [
    item,
    row.lot?.code ?? '—',
    row.site.code,
    quantity,
    ...(cost ? [moneyText(row.value ?? null, row.currency, locale), row.workOrder ? '—' : unitCostText(row.unitCost ?? null, row.currency, locale)] : []),
    `${row.methods.length > 0 ? row.methods.map((method) => t(`basis.method.${method}`)).join(' · ') : t(basis.key, basis.params)}${row.dependsOnMethod ? ` (${t('row.dependsOnMethod')})` : ''}`,
  ]
}
