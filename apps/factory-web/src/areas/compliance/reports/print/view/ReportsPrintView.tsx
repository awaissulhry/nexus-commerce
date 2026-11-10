'use client'

import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { PrintSection, PrintView } from '@nexus/ui/patterns/print-view/index'
import { Select, Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Cr6, Expiries, Gaps, Kpis, Register } from '../../api'
import { countText, KPI_SIGHT, kpiValueText, mgText, monthLabel, oneText, pctText, refLabel, reviewYearsAll } from '../../model'
import '../../reports.css'

/** SCR-307 — the annual compliance review on paper or as a PDF (design tab:cr-pdf): one view model, nothing fetched. */
export interface ReportsPrintModel {
  person: string
  at: string
  company: string
  can: boolean
  year: number
  /** Today in Rome (the year runs to it). */
  today: string
  /** The year's days read (1 January to 31 December, or to today). */
  range: { from: string; to: string }
  /** The report's page (the strip's way back). */
  back: string
  kpis: Kpis | null
  gaps: Gaps | null
  expiries: Expiries | null
  cr6: Cr6 | null
  register: Register | null
  /** A message key (namespace quality) of the first part that failed. */
  problem: string | null
}

export interface ReportsPrintActions {
  onYear?: (year: number) => void
}

/**
 * The year's compliance review for management review and auditors (design tab:cr-pdf): the company, the year, the brand and
 * the day it was printed on top; then certificate coverage (ANA-025) and the headline numbers, the open gaps by type, what
 * stops in the next 12 months, chromium VI per supplier and the register summary. Coverage and gaps are as of the day it is
 * printed (said in words); the rest is the year's.
 */
export function ReportsPrintView({ model, actions }: { model: ReportsPrintModel; actions?: ReportsPrintActions }) {
  return (
    <WithMessages namespaces={['compliance-reports', 'quality']}>
      <Print model={model} actions={actions} />
    </WithMessages>
  )
}

function Print({ model, actions }: { model: ReportsPrintModel; actions?: ReportsPrintActions | undefined }) {
  const t = useT('compliance-reports')
  const quality = useT('quality')
  const locale = useLocale()
  const ds = useDsWords()
  const day = (date: string) => formatDate(`${date}T12:00:00Z`, { locale })
  const { kpis, gaps, expiries, cr6, register } = model
  const ready = !!kpis && !!gaps && !!expiries && !!cr6 && !!register
  const filters = [
    { label: t('print.year'), value: model.range.to < `${model.year}-12-31` ? t('print.yearSoFar', { year: model.year, to: day(model.range.to) }) : String(model.year) },
    { label: t('print.period'), value: `${day(model.range.from)} – ${day(model.range.to)}` },
    { label: t('print.brand'), value: kpis?.brand ? `${kpis.brand.code} · ${kpis.brand.name}` : t('scope.allBrands') },
  ]
  return (
    <PrintView
      title={t('print.title', { year: model.year })}
      meta={[model.company]}
      printedAt={formatDateTime(model.at, { locale })}
      printedBy={model.person}
      filters={filters}
      printHeld={ready ? null : t('print.held')}
      back={{ href: model.back, label: t('print.back') }}
      tools={
        <Select size="sm" aria-label={t('print.pickYear')} value={String(model.year)} onChange={(event) => actions?.onYear?.(Number(event.target.value))}>
          {reviewYearsAll(model.today).map((year) => (
            <option key={year} value={year}>
              {year}
            </option>
          ))}
        </Select>
      }
      labels={ds.printView}
    >
      {!model.can ? (
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      ) : model.problem ? (
        <Banner tone="danger" title={t('print.failed')}>
          {quality(model.problem)}
        </Banner>
      ) : !ready ? (
        <p className="fw-cr-hint" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : (
        <>
          <p className="fw-cr-print-note">{t('print.note', { today: day(model.today) })}</p>
          <PrintSection title={t('section.kpi')}>
            <SummaryTable
              label={t('section.kpi')}
              columns={[t('print.figure'), t('print.value'), t('print.basis')]}
              align={[undefined, 'right', undefined]}
              rows={(['coverage', 'shipped', 'gaps', 'refusals', 'registerOpen', 'crViLots'] as const).map((kpi) => {
                const seen = KPI_SIGHT[kpi].every((sight) => kpis!.sight[sight])
                const k = kpis!.kpis
                const basis = !seen
                  ? t('tile.notInRole')
                  : kpi === 'coverage'
                    ? k.coverage && k.coverage.needing > 0 ? t('tile.coverage', { covered: countText(k.coverage.covered, locale), needing: countText(k.coverage.needing, locale), expiring: k.coverage.expiring }) : t('tile.coverageNone')
                    : kpi === 'shipped'
                      ? k.shipped && k.shipped.pairs > 0 ? t('tile.shipped', { covered: countText(k.shipped.covered, locale), needing: countText(k.shipped.needing, locale), shipments: k.shipped.shipments }) : t('tile.shippedNone')
                      : kpi === 'crViLots'
                        ? k.crViLots && k.crViLots.lots > 0 ? t('tile.crViLots', { with: countText(k.crViLots.withEvidence, locale), lots: countText(k.crViLots.lots, locale) }) : t('tile.crViLotsNone')
                        : kpi === 'refusals'
                          ? t('print.overridden', { count: k.refusals?.overridden ?? 0 })
                          : kpi === 'registerOpen'
                            ? t('tile.registerOpen', { count: k.registerOpen?.risk ?? 0 })
                            : t('tile.gaps')
                return { id: kpi, cells: [t(`kpi.${kpi}`), seen ? kpiValueText(kpi, k, locale) : '—', basis] }
              })}
            />
          </PrintSection>
          <PrintSection title={t('section.gaps')}>
            {gaps!.rows.length === 0 ? (
              <p>{t('tile.notInRole')}</p>
            ) : (
              <SummaryTable
                label={t('gaps.tableLabel')}
                columns={[t('gaps.type'), t('gaps.count'), t('gaps.styles'), t('gaps.markets'), t('gaps.blocking'), t('gaps.requirements')]}
                align={[undefined, 'right', 'right', 'right', 'right', 'left']}
                rows={gaps!.rows.map((row) => ({ id: row.type, cells: [t(`gap.${row.type}`), countText(row.count, locale), countText(row.styles, locale), countText(row.markets, locale), countText(row.blocking, locale), row.requirements.join(', ') || '—'] }))}
              />
            )}
          </PrintSection>
          <PrintSection title={t('print.expiryTitle', { from: day(expiries!.from), to: day(expiries!.to) })}>
            {expiries!.count === 0 ? (
              <p>{expiries!.sight.certificates ? t('expiry.empty') : t('tile.notInRole')}</p>
            ) : (
              <SummaryTable
                label={t('section.expiry')}
                columns={[t('csv.month'), t('csv.validTo'), t('print.record'), t('csv.status')]}
                rows={expiries!.months.flatMap((month) =>
                  month.items.map((item) => ({
                    id: `${item.recordType}-${item.recordId}`,
                    cells: [
                      monthLabel(month.month, locale),
                      day(item.validTo),
                      item.recordType === 'Certificate' ? t('expiry.certificate', { label: item.label, detail: item.detail ?? '' }) : t('expiry.declaration', { label: item.label, kind: item.detail ? t(`declaration.${item.detail}`) : '', party: item.party ?? '' }),
                      [item.status === 'SUSPENDED' ? t('expiry.suspended') : null, item.endsWithBase ? t('expiry.endsWithBase') : null].filter(Boolean).join(' · ') || '—',
                    ],
                  })),
                )}
              />
            )}
          </PrintSection>
          <PrintSection title={t('section.cr6')}>
            {!cr6!.sight.lots ? (
              <p>{t('tile.notInRole')}</p>
            ) : cr6!.suppliers.length === 0 ? (
              <p>{t('cr6.empty')}</p>
            ) : (
              <SummaryTable
                label={t('cr6.tableLabel')}
                columns={[t('cr6.supplier'), t('cr6.lots'), t('cr6.median'), t('cr6.highestShort'), t('cr6.limit'), t('cr6.fails')]}
                align={[undefined, 'right', 'right', 'right', 'right', 'right']}
                rows={cr6!.suppliers.map((row) => ({ id: row.party?.id ?? 'none', cells: [refLabel(row.party) ?? t('cr6.noSupplier'), countText(row.lots, locale), mgText(row.median, locale), mgText(row.highest, locale), mgText(row.limit, locale), countText(row.fails, locale)] }))}
              />
            )}
          </PrintSection>
          <PrintSection title={t('section.register')}>
            {!register!.sight.register ? (
              <p>{t('tile.notInRole')}</p>
            ) : (
              <>
                <SummaryTable
                  label={t('register.tableLabel')}
                  columns={[t('register.kind'), t('register.opened'), t('register.closed'), t('register.openAtEnd'), t('register.median')]}
                  align={[undefined, 'right', 'right', 'right', 'right']}
                  rows={[
                    ...register!.kinds.map((row) => ({ id: row.kind, cells: [t(`kind.${row.kind}`), countText(row.opened, locale), countText(row.closed, locale), countText(row.openAtEnd, locale), row.medianDaysToClose === null ? '—' : t('register.days', { days: oneText(row.medianDaysToClose, locale) })] })),
                    ...(register!.all ? [{ id: 'all', cells: [t('register.all'), countText(register!.all.opened, locale), countText(register!.all.closed, locale), countText(register!.all.openAtEnd, locale), register!.all.medianDaysToClose === null ? '—' : t('register.days', { days: oneText(register!.all.medianDaysToClose, locale) })] }] : []),
                  ]}
                />
                <ul className="fw-cr-print-list">
                  {register!.notices ? <li>{t('register.notices', { sent: register!.notices.sent, drafts: register!.notices.drafts })}</li> : null}
                  {register!.recalls ? <li>{t('register.recalls', { active: register!.recalls.active, closed: register!.recalls.closed, out: countText(register!.recalls.unitsStillOut, locale) })}</li> : null}
                  {register!.requests ? (
                    <li>
                      {t('register.requests', { received: register!.requests.received, open: register!.requests.open, overdue: register!.requests.overdue })}{' '}
                      {register!.requests.answered > 0 ? t('register.onTime', { onTime: register!.requests.onTime, answered: register!.requests.answered, pct: pctText(register!.requests.onTimePct, locale) }) : t('register.noneAnswered')}
                    </li>
                  ) : null}
                </ul>
              </>
            )}
          </PrintSection>
        </>
      )}
    </PrintView>
  )
}
