'use client'

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { CalendarClock, Download, FileSpreadsheet, FileText, Info, Mail, Printer, ShieldOff, Table2 } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, Menu, SummaryTable, Tabs, type TabItem } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { formatDate, formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { ReportAbout, ReportColumn, ReportResults, ReportSchedule, ResultGroup, ResultRow } from '../api'
import { cellText, columnLabel, groupValueText, heldOf, printHref, reportHref, reportWordKey, rightsLines, type ReportAddress, type ReportsAbilities, type ReportTab, type Translate } from '../model'
import '../reports.css'

/**
 * SCR-104 — a report (design home.reports rec:Report, `/w/<company>/home/reports/<key>?tab=…`): the band (‹ Reports, the
 * title and its question, Print in a new tab, Export ▾) and three tabs. Results: what the run looks at (the filters, the
 * server's own words of what it applied), "What you see" (the grains left out, the small groups hidden: ANA-034), the
 * rows in the shared list frame (select rows → Export N as CSV; a row opens its record) with group-by and totals.
 * Schedule: who gets it by e-mail (the daily production report) or "not scheduled". About: what it counts. A report the
 * person may not run says why; its About stays readable. One view model, nothing fetched.
 */

type Loaded<T> = { readonly value: T | null; readonly problem: string | null }

export interface ReportModel {
  readonly can: ReportsAbilities
  readonly prefix: string
  readonly key: string
  readonly address: ReportAddress
  readonly about: Loaded<ReportAbout>
  readonly results: Loaded<ReportResults> & { readonly reading: boolean }
  readonly schedule: Loaded<ReportSchedule>
  /** Where each row's record opens (company-free), by row id; absent: the row opens nothing. */
  readonly rowHrefs: Readonly<Record<string, string>>
  readonly selected?: readonly string[]
}

export interface ReportActions {
  onFilter?: (key: string, value: string | null) => void
  onGroup?: (group: string | null) => void
  onRetry?: (part: 'about' | 'results' | 'schedule') => void
  onOpenRow?: (row: ResultRow) => void
  onSelect?: (ids: string[]) => void
  /** The CSV of these rows (all of them when null). */
  onExport?: (ids: readonly string[] | null) => void
}

export function ReportView({ model, actions }: { model: ReportModel; actions?: ReportActions }) {
  return (
    <WithMessages namespaces={['home-reports', 'lists']}>
      <ReportScreen model={model} actions={actions} />
    </WithMessages>
  )
}

function ReportScreen({ model, actions }: { model: ReportModel; actions?: ReportActions }) {
  const t = useT('home-reports')
  const locale = useLocale()
  const back = <Link href={`${model.prefix}/home/reports`}>{t('report.back')}</Link>
  const about = model.about.value

  if (!model.can.view) {
    return (
      <div className="fw-rep">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
        </Card>
      </div>
    )
  }
  if (!about) {
    return (
      <div className="fw-rep">
        <div className="fw-rep-recband">
          <DetailHeader backAsChild backLabel={back} title={model.about.problem ? t('report.noun') : <Skeleton width={260} height={22} />} />
        </div>
        <Card padded>
          {model.about.problem ? (
            <EmptyState
              icon={<FileText size={24} aria-hidden />}
              title={t(model.about.problem === 'error.notFound' ? 'report.notFound' : 'report.failed')}
              description={t(model.about.problem)}
              action={
                model.about.problem === 'error.notFound' ? (
                  <Button size="sm" asChild>
                    <Link href={`${model.prefix}/home/reports`}>{t('report.back')}</Link>
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => actions?.onRetry?.('about')}>
                    {t('common.retry')}
                  </Button>
                )
              }
            />
          ) : (
            <p className="fw-rep-muted" role="status">
              <Spinner size={14} /> {t('common.loading')}
            </p>
          )}
        </Card>
      </div>
    )
  }

  const held = heldOf(about)
  const results = model.results.value
  const tab: ReportTab = model.address.tab
  const tabs: TabItem[] = (['results', 'schedule', 'about'] as const).map((id) => ({ id, label: t(`tab.${id}`), href: reportHref(model.prefix, model.key, { ...model.address, tab: id }) }))
  const exportHeld = held ? t(held.key, { grain: t(`grain.${held.grain ?? 'price'}`) }) : !results ? t('held.reading') : results.rows.length === 0 ? t('held.noRows') : null
  const actionsBar = (
    <span className="fw-rep-actions">
      <Button size="sm" variant="secondary" asChild={!exportHeld} heldReason={exportHeld ?? undefined}>
        {exportHeld ? (
          <>
            <Printer size={14} aria-hidden /> {t('report.print')}
          </>
        ) : (
          <a href={printHref(model.prefix, model.key, model.address)} target="_blank" rel="noopener noreferrer">
            <Printer size={14} aria-hidden /> {t('report.print')}
          </a>
        )}
      </Button>
      <Menu
        label={
          <>
            <Download size={14} aria-hidden /> {t('report.export')}
          </>
        }
        align="right"
        items={[
          { id: 'csv', label: t('report.exportCsv'), icon: <FileSpreadsheet size={14} aria-hidden />, disabled: exportHeld !== null, description: exportHeld, onSelect: () => actions?.onExport?.(null) },
          { id: 'pdf', label: t('report.exportPdf'), icon: <FileText size={14} aria-hidden />, disabled: exportHeld !== null, description: exportHeld, href: exportHeld ? undefined : printHref(model.prefix, model.key, model.address), target: '_blank' },
        ]}
      />
    </span>
  )

  return (
    <div className="fw-rep">
      <div className="fw-rep-recband">
        <DetailHeader backAsChild backLabel={back} title={t(reportWordKey(about.key, 'title'))} actions={actionsBar} />
        <div className="fw-rep-meta">
          <Tag tone="neutral">{t(`area.${about.area}`)}</Tag>
          <span className="fw-rep-question">{t(reportWordKey(about.key, 'question'))}</span>
          {results && tab === 'results' && (
            <span className="fw-rep-muted" role="status">
              {t('results.asOf', { time: formatTime(results.asOf, { locale }) })}
            </span>
          )}
        </div>
        <Tabs ariaLabel={t('tab.label')} tabs={tabs} active={tab} size="sm" overflow="scroll" />
      </div>

      {tab === 'about' ? (
        <AboutTab about={about} />
      ) : held ? (
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t(held.key, { grain: t(`grain.${held.grain ?? 'price'}`) })} description={t(`${held.key}Body`, { grain: t(`grain.${held.grain ?? 'price'}`) })} />
        </Card>
      ) : tab === 'schedule' ? (
        <ScheduleTab model={model} actions={actions} />
      ) : (
        <ResultsTab model={model} about={about} actions={actions} />
      )}
    </div>
  )
}

// ---- Results ---------------------------------------------------------------------------------------------------------------

function ResultsTab({ model, about, actions }: { model: ReportModel; about: ReportAbout; actions?: ReportActions }) {
  const t = useT('home-reports')
  const locale = useLocale()
  const results = model.results.value
  const [ownSelected, setOwnSelected] = useState<string[]>([])
  const selected = model.selected ? [...model.selected] : ownSelected
  const setSelected = actions?.onSelect ?? setOwnSelected
  const columns = results?.columns ?? about.columns
  const grouped = results?.groupBy ? (columns.find((column) => column.key === results.groupBy) ?? null) : null
  const applied = new Map((results?.applied ?? []).map((entry) => [entry.key, entry]))

  const filterValueText = (key: string, value: string | null, kind: string, label: string | null): string => {
    if (value === null) return kind === 'site' ? t('filters.allSites') : t('filters.any')
    if (kind === 'period') return t(`period.${value}`)
    if (kind === 'choice') return t(reportWordKey(about.key, `choice.${key}.${value}`))
    return label ?? value
  }

  const rowColumns = useMemo<ColDef<ResultRow>[]>(
    () =>
      columns.map((column, index) => {
        const Cell = ({ data }: ICellRendererParams<ResultRow>) => {
          if (!data) return null
          const text = cellText(column, data.cells[column.key], data.currency, t, locale)
          const href = index === 0 ? model.rowHrefs[data.id] : undefined
          if (href) {
            return (
              <Link className="fw-rep-link" href={href}>
                {text}
              </Link>
            )
          }
          return <span className={column.kind === 'number' || column.kind === 'money' || column.kind === 'percent' ? 'fw-rep-num' : undefined}>{text || (column.people ? '—' : '')}</span>
        }
        return { colId: column.key, headerName: columnLabel(about.key, column, t), minWidth: column.kind === 'text' ? 150 : 110, flex: column.kind === 'text' ? 1.2 : 0.7, cellRenderer: Cell, type: column.kind === 'number' || column.kind === 'money' || column.kind === 'percent' ? 'rightAligned' : undefined }
      }),
    [columns, about.key, t, locale, model.rowHrefs],
  )

  const groupColumns = useMemo<ColDef<ResultGroup & { id: string }>[]>(() => {
    if (!grouped) return []
    const sums = columns.filter((column) => column.sum)
    const Value = ({ data }: ICellRendererParams<ResultGroup & { id: string }>) => (data ? <strong>{groupValueText(grouped, data.value, t, locale)}</strong> : null)
    const Rows = ({ data }: ICellRendererParams<ResultGroup & { id: string }>) => (data ? <span className="fw-rep-num">{data.rows}</span> : null)
    return [
      { colId: 'group', headerName: columnLabel(about.key, grouped, t), minWidth: 180, flex: 1.4, cellRenderer: Value },
      { colId: 'rows', headerName: t('results.rows'), minWidth: 100, flex: 0.5, cellRenderer: Rows, type: 'rightAligned' },
      ...sums.map((column) => ({
        colId: column.key,
        headerName: columnLabel(about.key, column, t),
        minWidth: 120,
        flex: 0.7,
        type: 'rightAligned',
        cellRenderer: ({ data }: ICellRendererParams<ResultGroup & { id: string }>) => (data ? <span className="fw-rep-num">{sumText(column, data.sums[column.key], data.currency, t, locale)}</span> : null),
      })),
    ]
  }, [grouped, columns, about.key, t, locale])

  const lines = rightsLines(results?.rights ?? null, t)
  const groupable = columns.filter((column) => column.group)
  const reading = model.results.reading
  const state = model.results.problem ? (
    <EmptyState
      icon={<Table2 size={22} aria-hidden />}
      title={t('results.failed')}
      description={t(model.results.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.('results')}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : results && results.rows.length === 0 ? (
    <EmptyState icon={<Table2 size={22} aria-hidden />} title={t('results.empty')} description={t('results.emptyBody')} />
  ) : null

  return (
    <div className="fw-rep-stack">
      <section className="fw-rep-filters" aria-label={t('filters.label')}>
        {about.filters.map((filter) => {
          const asked = model.address.filters[filter.key] ?? null
          const value = asked ?? applied.get(filter.key)?.value ?? filter.default
          return (
            <label key={filter.key} className="fw-rep-filter">
              <span className="fw-rep-filter-label">{t(reportWordKey(about.key, `filter.${filter.key}`))}</span>
              <Select size="sm" value={value ?? ''} onChange={(event) => actions?.onFilter?.(filter.key, event.target.value || null)} disabled={reading}>
                {(filter.default === null || filter.kind === 'site') && <option value="">{filter.kind === 'site' ? t('filters.allSites') : t('filters.any')}</option>}
                {filter.choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {filterValueText(filter.key, choice.value, filter.kind, choice.label)}
                  </option>
                ))}
              </Select>
            </label>
          )
        })}
        {groupable.length > 0 && (
          <label className="fw-rep-filter">
            <span className="fw-rep-filter-label">{t('filters.groupBy')}</span>
            <Select size="sm" value={results?.groupBy ?? (model.address.group === 'none' ? 'none' : (model.address.group ?? about.groupBy ?? 'none'))} onChange={(event) => actions?.onGroup?.(event.target.value)} disabled={reading}>
              <option value="none">{t('filters.notGrouped')}</option>
              {groupable.map((column) => (
                <option key={column.key} value={column.key}>
                  {columnLabel(about.key, column, t)}
                </option>
              ))}
            </Select>
          </label>
        )}
        {reading && (
          <span className="fw-rep-muted" role="status">
            <Spinner size={12} /> {t('results.reading')}
          </span>
        )}
      </section>

      {results && results.applied.length > 0 && (
        <p className="fw-rep-applied">
          <strong>{t('filters.applied')}</strong>{' '}
          {results.applied
            .map((entry) => {
              const filter = about.filters.find((item) => item.key === entry.key)
              return `${t(reportWordKey(about.key, `filter.${entry.key}`))}: ${filterValueText(entry.key, entry.value, filter?.kind ?? 'choice', entry.label)}`
            })
            .join(' · ')}
          {results.range ? ` · ${t('filters.range', { from: formatDate(`${results.range.from}T12:00:00Z`, { locale }), to: formatDate(`${results.range.to}T12:00:00Z`, { locale }) })}` : ''}
        </p>
      )}

      {lines.length > 0 && (
        <Banner tone="info" title={t('rights.title')} icon={<Info size={16} aria-hidden />} action={<Link className="fw-rep-link" href={`${model.prefix}/me`}>{t('rights.link')}</Link>}>
          {lines.map((line) => (
            <span key={line} className="fw-rep-line">
              {line}
            </span>
          ))}
        </Banner>
      )}
      {results && !results.complete && (
        <Banner tone="warning" title={t('results.cut', { count: results.rows.length })}>
          {t('results.cutBody')}
        </Banner>
      )}

      {grouped && results?.groups ? (
        <ListFrame<ResultGroup & { id: string }>
          label={t('results.groupsLabel', { column: columnLabel(about.key, grouped, t) })}
          rows={results.groups.map((group, index) => ({ ...group, id: `g${index}` }))}
          rowId={(row) => row.id}
          columns={groupColumns}
          count={t('results.groups', { count: results.groups.length, rows: results.totals.rows })}
          right={
            <Button size="sm" variant="quiet" onClick={() => actions?.onGroup?.('none')}>
              {t('results.showRows')}
            </Button>
          }
          listKey={null}
          state={state}
        />
      ) : (
        <ListFrame<ResultRow>
          label={t(reportWordKey(about.key, 'title'))}
          rows={results ? results.rows : model.results.problem ? [] : null}
          rowId={(row) => row.id}
          columns={rowColumns}
          count={results ? t('results.count', { count: results.rows.length }) : '—'}
          selection={{
            selected,
            onChange: setSelected,
            actions: (
              <Button size="sm" aria-label={t('results.exportSelected', { count: selected.length })} onClick={() => actions?.onExport?.(selected)}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('results.exportSelected', { count: selected.length })}</SelectionLabel>
              </Button>
            ),
          }}
          listKey={null}
          onOpen={(row) => actions?.onOpenRow?.(row)}
          state={state}
        />
      )}

      {results && results.rows.length > 0 && <Totals reportKey={about.key} columns={columns} results={results} />}
      <p className="fw-rep-muted fw-rep-foot">{t('results.foot')}</p>
    </div>
  )
}

function sumText(column: ReportColumn, value: string | number | null | undefined, currency: string | null, t: Translate, locale: ReturnType<typeof useLocale>): string {
  if (value === null || value === undefined) return column.kind === 'money' ? t('results.severalCurrencies') : '—'
  return cellText(column, value, currency, t, locale)
}

function Totals({ reportKey, columns, results }: { reportKey: string; columns: readonly ReportColumn[]; results: ReportResults }) {
  const t = useT('home-reports')
  const locale = useLocale()
  const sums = columns.filter((column) => column.sum && column.key in results.totals.sums)
  return (
    <Card padded className="fw-rep-totals" aria-label={t('results.totals')}>
      <KeyValue
        columns={3}
        phoneColumns={2}
        dense
        labelCase="sentence"
        items={[
          { label: t('results.rows'), value: String(results.totals.rows) },
          ...sums.map((column) => ({ label: columnLabel(reportKey, column, t), value: sumText(column, results.totals.sums[column.key], results.totals.currency, t, locale), hint: column.kind === 'money' && results.totals.mixedCurrencies ? t('results.severalCurrenciesHint') : undefined })),
        ]}
      />
    </Card>
  )
}

// ---- Schedule -------------------------------------------------------------------------------------------------------------

function ScheduleTab({ model, actions }: { model: ReportModel; actions?: ReportActions }) {
  const t = useT('home-reports')
  const locale = useLocale()
  const schedule = model.schedule.value
  if (model.schedule.problem) {
    return (
      <Card padded>
        <EmptyState
          icon={<CalendarClock size={22} aria-hidden />}
          title={t('schedule.failed')}
          description={t(model.schedule.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.('schedule')}>
              {t('common.retry')}
            </Button>
          }
        />
      </Card>
    )
  }
  if (!schedule) {
    return (
      <Card padded aria-busy="true">
        <p className="fw-rep-muted" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      </Card>
    )
  }
  if (!schedule.schedulable) {
    return (
      <Card padded>
        <EmptyState icon={<CalendarClock size={22} aria-hidden />} title={t('schedule.none')} description={t('schedule.noneBody')} />
      </Card>
    )
  }
  const manage = schedule.manage ? `${model.prefix}${schedule.manage}` : null
  const days = (weekdays: readonly number[]) => weekdays.map((day) => t(`day.${day}`)).join(', ')
  const link: ReactNode = manage ? (
    <Button size="sm" variant="secondary" asChild>
      <Link href={manage}>
        <Mail size={14} aria-hidden /> {t('schedule.manage')}
      </Link>
    </Button>
  ) : null
  return (
    <Card padded>
      <section className="fw-rep-stack" aria-labelledby="fw-rep-schedule">
        <div className="fw-rep-head fw-rep-head--row">
          <h2 id="fw-rep-schedule" className="fw-rep-h">
            {t('schedule.title')}
          </h2>
          {link}
        </div>
        {schedule.subscriptions.length === 0 ? (
          <EmptyState icon={<Mail size={22} aria-hidden />} title={t('schedule.nobody')} description={t('schedule.nobodyBody')} />
        ) : (
          <SummaryTable
            label={t('schedule.title')}
            stackOnPhone
            columns={[t('schedule.col.for'), t('schedule.col.site'), t('schedule.col.when'), t('schedule.col.language'), t('schedule.col.state'), t('schedule.col.last')]}
            rows={schedule.subscriptions.map((row) => ({
              id: row.id,
              cells: [
                row.mine ? t('schedule.you', { name: row.user.name }) : row.user.name,
                row.site ? `${row.site.code} · ${row.site.name}` : t('filters.allSites'),
                t('schedule.when', { time: row.sendTime, days: days(row.weekdays) }),
                t(`language.${row.locale}`),
                <Tag key="state" tone={row.active ? 'success' : 'neutral'}>
                  {t(row.active ? 'schedule.on' : 'schedule.off')}
                </Tag>,
                row.lastSentAt ? formatDateTime(row.lastSentAt, { locale }) : t('schedule.neverSent'),
              ],
            }))}
          />
        )}
        <p className="fw-rep-muted">{t('schedule.foot')}</p>
      </section>
    </Card>
  )
}

// ---- About ----------------------------------------------------------------------------------------------------------------

function AboutTab({ about }: { about: ReportAbout }) {
  const t = useT('home-reports')
  return (
    <Card padded>
      <section className="fw-rep-stack" aria-labelledby="fw-rep-about">
        <h2 id="fw-rep-about" className="fw-rep-h">
          {t('about.title')}
        </h2>
        <KeyValue
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('about.question'), value: t(reportWordKey(about.key, 'question')) },
            { label: t('about.definition'), value: t(reportWordKey(about.key, 'definition')) },
            { label: t('about.sources'), value: t(reportWordKey(about.key, 'sources')) },
            { label: t('about.refresh'), value: t('about.refreshLive') },
            { label: t('about.owner'), value: t('about.ownerPack') },
            { label: t('about.formats'), value: about.formats.map((format) => t(`format.${format}`)).join(' · ') },
            { label: t('about.numbers'), value: about.numbers.length > 0 ? about.numbers.map((number) => t(`number.${number.key}.label`)).join(' · ') : t('about.noNumbers') },
            {
              label: t('about.leftOut'),
              value: about.leftOut.columns.length > 0 ? about.leftOut.columns.map((column) => `${columnLabel(about.key, column, t)} (${t(`grain.${column.grain ?? 'price'}`)})`).join(', ') : t('about.nothingLeftOut'),
            },
            { label: t('about.people'), value: about.columns.some((column) => column.people) ? t('about.peopleHidden') : t('about.noPeople') },
          ]}
        />
        <p className="fw-rep-muted">{t('about.kpiLater')}</p>
      </section>
    </Card>
  )
}
