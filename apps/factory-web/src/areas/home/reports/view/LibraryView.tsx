'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { BarChart3, FileText, Mail, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Skeleton, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { Library, LibraryReport } from '../api'
import { libraryRows, outsideCount, reportHref, reportWordKey, stateWords, type LibraryAddress, type ReportsAbilities } from '../model'
import '../reports.css'

/**
 * SCR-104 — Home › Insights › Reports, the library (design home.reports `library`, ANA-029): every report of the standard
 * pack, said as the question it answers, grouped by area (the Area column and its chips), with when I last ran it (the
 * server's run log, B-W2b-24),
 * whether it is e-mailed to me and its formats. A report needing a grain the person lacks stays listed ("Needs cost
 * rights"); one that reads a list outside the person's role is listed only on asking. One view model, nothing fetched.
 */

export interface LibraryModel {
  readonly can: ReportsAbilities
  readonly prefix: string
  readonly address: LibraryAddress
  readonly library: { readonly value: Library | null; readonly problem: string | null }
}

export interface LibraryActions {
  onAddress?: (address: LibraryAddress) => void
  onRetry?: () => void
  onOpen?: (key: string) => void
}

export function LibraryView({ model, actions }: { model: LibraryModel; actions?: LibraryActions }) {
  return (
    <WithMessages namespaces={['home-reports', 'lists']}>
      <LibraryScreen model={model} actions={actions} />
    </WithMessages>
  )
}

function LibraryScreen({ model, actions }: { model: LibraryModel; actions?: LibraryActions }) {
  const t = useT('home-reports')
  const locale = useLocale()
  const library = model.library.value
  const words = useMemo(() => (report: LibraryReport) => ({ title: t(reportWordKey(report.key, 'title')), question: t(reportWordKey(report.key, 'question')) }), [t])
  const rows = useMemo(() => (library ? libraryRows(library.reports, model.address, words) : null), [library, model.address, words])
  const outside = library ? outsideCount(library.reports) : 0
  const set = (change: Partial<LibraryAddress>) => actions?.onAddress?.({ ...model.address, ...change })

  const columns = useMemo<ColDef<LibraryReport>[]>(() => {
    const ReportCell = ({ data }: ICellRendererParams<LibraryReport>) =>
      data ? (
        <span className="fw-rep-cell">
          <Link className="fw-rep-link" href={reportHref(model.prefix, data.key)}>
            {t(reportWordKey(data.key, 'title'))}
          </Link>
          <span className="fw-rep-sub">{t(reportWordKey(data.key, 'question'))}</span>
        </span>
      ) : null
    const AreaCell = ({ data }: ICellRendererParams<LibraryReport>) => (data ? <Tag tone="neutral">{t(`area.${data.area}`)}</Tag> : null)
    const LastCell = ({ data }: ICellRendererParams<LibraryReport>) => {
      const at = data?.lastRunByMe ?? null
      return <span className={at ? '' : 'fw-rep-muted'}>{at ? formatDateTime(at, { locale }) : t('library.never')}</span>
    }
    const ScheduleCell = ({ data }: ICellRendererParams<LibraryReport>) =>
      data?.mailed ? (
        <Tag tone="info">
          <Mail size={12} aria-hidden /> {t('library.mailed')}
        </Tag>
      ) : (
        <span className="fw-rep-muted">{data?.mail ? t('library.mailable') : t('library.notScheduled')}</span>
      )
    const FormatsCell = ({ data }: ICellRendererParams<LibraryReport>) => <span>{data ? data.formats.map((format) => t(`format.${format}`)).join(' · ') : ''}</span>
    const RightsCell = ({ data }: ICellRendererParams<LibraryReport>) => {
      const held = data ? stateWords(data, t) : null
      return held ? (
        <Tag tone={data?.state === 'NEEDS_GRAIN' ? 'warning' : 'neutral'}>
          <ShieldOff size={12} aria-hidden /> {held}
        </Tag>
      ) : (
        <span className="fw-rep-muted">{t('library.ready')}</span>
      )
    }
    return [
      { colId: 'report', headerName: t('library.col.report'), minWidth: 280, flex: 2.4, cellRenderer: ReportCell, autoHeight: true },
      { colId: 'area', headerName: t('library.col.area'), minWidth: 120, flex: 0.6, cellRenderer: AreaCell },
      { colId: 'last', headerName: t('library.col.last'), minWidth: 150, flex: 0.8, cellRenderer: LastCell },
      { colId: 'schedule', headerName: t('library.col.schedule'), minWidth: 150, flex: 0.8, cellRenderer: ScheduleCell },
      { colId: 'formats', headerName: t('library.col.formats'), minWidth: 110, flex: 0.5, cellRenderer: FormatsCell },
      { colId: 'rights', headerName: t('library.col.rights'), minWidth: 170, flex: 0.9, cellRenderer: RightsCell },
    ]
  }, [t, locale, model.prefix])

  if (!model.can.view) {
    return (
      <div className="fw-rep">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
        </Card>
      </div>
    )
  }

  const state = model.library.problem ? (
    <EmptyState
      icon={<FileText size={22} aria-hidden />}
      title={t('library.failed')}
      description={t(model.library.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : rows && rows.length === 0 ? (
    <EmptyState icon={<FileText size={22} aria-hidden />} title={t('library.noMatch')} description={t('library.noMatchBody')} action={<Button size="sm" onClick={() => actions?.onAddress?.({ q: '', area: null, outside: model.address.outside })}>{t('library.clear')}</Button>} />
  ) : null

  return (
    <div className="fw-rep">
      <div className="fw-rep-band" role="status" aria-label={t('band.label')}>
        {library ? (
          <span className="fw-rep-muted">
            {t('library.updated', { time: formatTime(library.asOf, { locale }) })} · {t('library.count', { count: library.reports.length - outside })}
          </span>
        ) : model.library.problem ? null : (
          <span className="fw-rep-muted">
            <Skeleton width={180} height={14} />
          </span>
        )}
      </div>

      <section className="fw-rep-section" aria-labelledby="fw-rep-library">
        <div className="fw-rep-head">
          <h2 id="fw-rep-library" className="fw-rep-h">
            <BarChart3 size={16} aria-hidden /> {t('library.title')}
          </h2>
          <p className="fw-rep-muted">{t('library.intro')}</p>
        </div>
        {model.library.problem && library === null ? null : !library ? (
          <p className="fw-rep-muted" role="status">
            {t('common.loading')}
          </p>
        ) : null}
        <ListFrame<LibraryReport>
          label={t('library.title')}
          rows={library ? (rows ?? []) : model.library.problem ? [] : null}
          rowId={(row) => row.key}
          columns={columns}
          count={rows ? t('library.shown', { count: rows.length }) : '—'}
          search={
            <Input
              size="sm"
              type="search"
              aria-label={t('library.search')}
              placeholder={t('library.search')}
              value={model.address.q}
              onChange={(event) => set({ q: event.target.value })}
            />
          }
          tools={
            <span className="fw-rep-chips" role="group" aria-label={t('library.areas')}>
              <FilterChip pressed={model.address.area === null} onClick={() => set({ area: null })}>
                {t('library.allAreas')}
              </FilterChip>
              {(library?.areas ?? []).map((entry) => (
                <FilterChip key={entry.area} pressed={model.address.area === entry.area} onClick={() => set({ area: model.address.area === entry.area ? null : entry.area })}>
                  {t(`area.${entry.area}`)}
                </FilterChip>
              ))}
              {outside > 0 && (
                <FilterChip pressed={model.address.outside} count={outside} onClick={() => set({ outside: !model.address.outside })}>
                  {t('library.outside')}
                </FilterChip>
              )}
            </span>
          }
          onOpen={(row) => actions?.onOpen?.(row.key)}
          state={state}
        />
        {model.library.problem && library !== null && (
          <Banner tone="warning" title={t('library.stale')}>
            {t(model.library.problem)}
          </Banner>
        )}
        <p className="fw-rep-muted fw-rep-foot">{t('library.foot')}</p>
      </section>
    </div>
  )
}
