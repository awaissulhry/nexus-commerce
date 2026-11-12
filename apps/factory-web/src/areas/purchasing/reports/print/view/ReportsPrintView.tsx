'use client'

import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { PrintSection, PrintView } from '@nexus/ui/patterns/print-view/index'
import { Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { money } from '../../../../_shared/stock/model'
import type { LateRow, Spend } from '../../api'
import { amountText, blockedOf, groupLabel, monthOf, monthText, pivotMonths, shareText, type ReportsCan } from '../../model'
import '../../reports.css'

/** SCR-372 — Purchasing reports on paper or as a PDF (design tab:print): one view model, nothing fetched. */
export interface ReportsPrintModel {
  person: string
  at: string
  company: string
  /** The top bar's site; null: every site the person sees. */
  site: string | null
  can: ReportsCan
  range: { from: string; to: string }
  /** The report's page (the strip's way back). */
  back: string
  spend: Spend | null
  /** The late lines (the first 200 of the worklist), null while read or without the orders' view. */
  late: readonly LateRow[] | null
  /** More late lines than printed. */
  lateMore: boolean
  /** A message key (purchasing-reports) of the part that failed. */
  problem: string | null
}

/**
 * The monthly buying review on paper (design tab:print, "Print stylesheet with the filters at the top"): the company, the site,
 * the period, the grouping and the day it was printed on top; then the spend by the grouping (sample orders apart, by month when
 * the period spans months) and the late lines with what they hold up. Amounts only with the cost grain.
 */
export function ReportsPrintView({ model }: { model: ReportsPrintModel }) {
  return (
    <WithMessages namespaces={['purchasing-reports', 'warehouse-reports']}>
      <Print model={model} />
    </WithMessages>
  )
}

function Print({ model }: { model: ReportsPrintModel }) {
  const t = useT('purchasing-reports')
  const wr = useT('warehouse-reports')
  const locale = useLocale()
  const ds = useDsWords()
  const day = (date: string | null) => (date ? formatDate(`${date}T12:00:00Z`, { locale }) : '—')
  const { spend, late } = model
  const ready = !!spend && (late !== null || !model.can.orders)
  const cost = model.can.cost && (spend?.sight.values ?? false)
  const by = spend?.by ?? 'supplier'
  const months = spend && cost ? pivotMonths(spend) : []
  const filters = [
    { label: t('print.period'), value: `${day(model.range.from)} – ${day(model.range.to)}` },
    { label: t('print.site'), value: model.site ?? t('print.allSites') },
    { label: t('print.by'), value: t(`by.${by}`) },
  ]
  const label = (group: Spend['groups'][number]) => groupLabel(group, by, { category: (kind) => wr(`type.${kind}`), locale })
  const cells = (figures: Spend['all'], group: Spend['groups'][number] | null) => [
    ...months.map((month) => {
      const entry = group ? monthOf(group, month) : null
      return entry ? money(entry.production ?? null, entry.currency, locale) : '—'
    }),
    ...(cost ? [amountText(figures, 'production', locale), amountText(figures, 'samples', locale)] : []),
    String(figures.orders),
    String(figures.lines),
    String(figures.sampleOrders),
    ...(cost ? [group ? shareText(group.share, locale) : '—'] : []),
  ]
  return (
    <PrintView
      title={t('print.title')}
      meta={[model.company]}
      printedAt={formatDateTime(model.at, { locale })}
      printedBy={model.person}
      filters={filters}
      printHeld={ready ? null : t('print.held')}
      back={{ href: model.back, label: t('print.back') }}
      labels={ds.printView}
    >
      {!model.can.view ? (
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      ) : model.problem ? (
        <Banner tone="danger" title={t('print.failed')}>
          {t(model.problem)}
        </Banner>
      ) : !ready ? (
        <p className="fw-pr-hint" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : (
        <>
          <PrintSection title={t('print.spendTitle', { by: t(`by.${by}`) })}>
            {!spend!.sight.orders ? (
              <p>{t('notInRole.orders')}</p>
            ) : spend!.groups.length === 0 ? (
              <p>{t('spend.empty')}</p>
            ) : (
              <>
                <SummaryTable
                  label={t('spend.tableLabel')}
                  widths={['26%']}
                  columns={[t(`by.${by}`), ...months.map((month) => monthText(month, locale)), ...(cost ? [t('col.production'), t('col.samples')] : []), t('col.orders'), t('col.lines'), t('col.sampleOrders'), ...(cost ? [t('col.share')] : [])]}
                  align={[undefined, ...months.map(() => 'right' as const), ...(cost ? (['right', 'right'] as const) : []), 'right', 'right', 'right', ...(cost ? (['right'] as const) : [])]}
                  rows={[...spend!.groups.map((group) => ({ id: group.key, cells: [label(group), ...cells(group, group)] })), { id: 'all', cells: [<strong key="t">{t('spend.all')}</strong>, ...cells(spend!.all, null)] }]}
                />
                <p className="fw-pr-print-note">{[t('spend.definition'), spend!.more > 0 ? t('spend.more', { count: spend!.more }) : null, cost ? null : t('spend.noCost')].filter(Boolean).join(' ')}</p>
              </>
            )}
          </PrintSection>
          <PrintSection title={t('section.late')}>
            {!model.can.orders || late === null ? (
              <p>{t('notInRole.late')}</p>
            ) : late.length === 0 ? (
              <p>{t('late.empty')}</p>
            ) : (
              <>
                <SummaryTable
                  label={t('section.late')}
                  widths={['14%', '16%']}
                  columns={[t('late.col.line'), t('late.col.supplier'), t('late.col.material'), t('late.col.expected'), t('late.col.why'), t('late.col.workOrders'), t('late.col.salesOrders')]}
                  rows={late.map((row) => {
                    const blocked = blockedOf(row)
                    return {
                      id: row.lineId,
                      cells: [
                        t('late.line', { number: row.number, seq: row.seq }),
                        row.supplierName,
                        `${row.item.code} · ${row.item.name}`,
                        `${day(row.expectedDate)}${row.daysLate > 0 ? ` (${t('late.daysLate', { count: row.daysLate })})` : ''}`,
                        row.reasons.map((reason) => t(`reason.${reason}`)).join(', '),
                        blocked.workOrders.map((entry) => `${entry.number}${entry.lateBy > 0 ? ` (+${entry.lateBy})` : ''}`).join(', ') || '—',
                        blocked.salesOrders.map((entry) => `${entry.number} (${day(entry.promiseDate)})`).join(', ') || '—',
                      ],
                    }
                  })}
                />
                <p className="fw-pr-print-note">{[t('late.definition'), model.lateMore ? t('print.lateMore', { count: late.length }) : null].filter(Boolean).join(' ')}</p>
              </>
            )}
          </PrintSection>
        </>
      )}
    </PrintView>
  )
}
