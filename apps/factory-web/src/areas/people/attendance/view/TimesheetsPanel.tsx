'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { FileQuestion, Stamp, ThumbsUp } from 'lucide-react'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { SelectionLabel } from '@nexus/ui/grid'
import { EmptyState } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { TimesheetRow } from '../api'
import { dayShort, monthWords, TIMESHEET_TONE, timesheetNotSelectable, timesheetVerb } from '../model'
import type { AttendanceActions, AttendanceModel } from '../view-model'
import { useAttendanceWords } from './parts'

/**
 * Timesheets (MES-230; design new tab "Person timesheet"): the month per person, approved by the lead, then HR. A row says the
 * period, whose turn it is and whether it is ready, never a name or an hour (Owner answer W1): a row opens the person's
 * timesheet in a new tab. A lead reads days and states only (B-W2b-42: the ATTENDANCE basis never covers leads).
 */
export function TimesheetsPanel({ model, actions, onHelp }: { model: AttendanceModel; actions?: AttendanceActions | undefined; onHelp: () => void }) {
  const t = useAttendanceWords()
  const locale = useLocale()
  const { teams, lines, prefix, can } = model
  const items = model.timesheets.items
  const href = (row: TimesheetRow) => `${prefix}/people/attendance/timesheets/${encodeURIComponent(row.id)}`
  const columns = useMemo<ColDef<TimesheetRow>[]>(() => {
    const code = (id: string | null, list: ReadonlyArray<{ id: string; code: string }>) => list.find((entry) => entry.id === id)?.code ?? '—'
    const PeriodCell = ({ data }: ICellRendererParams<TimesheetRow>) =>
      data ? (
        <Link href={`${prefix}/people/attendance/timesheets/${encodeURIComponent(data.id)}`} target="_blank">
          {`${dayShort(data.periodStart, locale)} – ${dayShort(data.periodEnd, locale)}`}
        </Link>
      ) : null
    return [
      { colId: 'period', headerName: t('col.period'), minWidth: 210, flex: 1, valueGetter: (params) => params.data?.periodStart ?? '', cellRenderer: PeriodCell },
      { colId: 'team', headerName: t('col.team'), width: 110, valueGetter: (params) => code(params.data?.teamId ?? null, teams) },
      { colId: 'line', headerName: t('col.line'), width: 110, valueGetter: (params) => code(params.data?.lineId ?? null, lines) },
      { colId: 'ready', headerName: t('col.ready'), minWidth: 200, flex: 1, valueGetter: (params) => (params.data ? t(params.data.stage === 'DONE' ? 'timesheets.done' : params.data.ready ? 'timesheets.ready' : 'timesheets.notReady') : '') },
      { colId: 'returned', headerName: t('col.returned'), width: 130, valueGetter: (params) => (params.data?.returned ? t('timesheets.returned') : '') },
      { colId: 'stage', headerName: t('col.stage'), width: 160, valueGetter: (params) => (params.data ? t(`stage.${params.data.stage}`) : ''), cellRenderer: (params: ICellRendererParams<TimesheetRow>) => (params.data ? <Pill tone={TIMESHEET_TONE[params.data.stage]} dot>{t(`stage.${params.data.stage}`)}</Pill> : null) },
    ]
  }, [t, locale, teams, lines, prefix])

  const picked = useMemo(() => (items ?? []).filter((row) => model.timesheets.selected.includes(row.id) && row.ready && timesheetVerb(row, can)), [items, model.timesheets.selected, can])
  const decides = can.timesheetLead || can.timesheetHr
  const prepare = model.timesheets.canPrepare ? (
    <Button size="sm" variant="secondary" onClick={() => actions?.onPrepare()} heldReason={model.timesheets.busy ? t('held.working') : model.scope.allSites ? t('held.pickSite') : null}>
      {t('timesheets.prepare', { month: monthWords(model.month, locale) })}
    </Button>
  ) : undefined

  return (
    <section id="fw-at-timesheets" className="fw-at-section" aria-label={t('timesheets.title')}>
      <h2 className="fw-at-title">{t('timesheets.title')}</h2>
      {!model.can.view && <p className="fw-pp-hint">{t('timesheets.leadNote')}</p>}
      <ListFrame<TimesheetRow>
        label={t('timesheets.title')}
        rows={items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t('timesheets.count', { count: items.length }) : ''}
        rowKind="text"
        listKey="people.attendance.timesheets"
        onHelp={onHelp}
        onOpen={(row) => window.open(href(row), '_blank', 'noopener')}
        cards={{ hrefOf: href }}
        {...(prepare ? { right: prepare } : {})}
        {...(model.timesheets.more ? { more: { label: t('days.more'), onMore: () => actions?.onMoreTimesheets() } } : {})}
        {...(decides
          ? {
              selection: {
                selected: model.timesheets.selected,
                onChange: (ids: string[]) => actions?.onSelectTimesheets(ids),
                actions: (
                  <Button size="sm" variant="primary" onClick={() => actions?.onBulkTimesheets()} heldReason={model.timesheets.busy ? t('held.working') : picked.length === 0 ? t('held.timesheetNotReady') : null}>
                    <ThumbsUp size={14} aria-hidden /> <SelectionLabel>{t('timesheets.bulkApprove', { count: picked.length })}</SelectionLabel>
                  </Button>
                ),
              },
              isRowSelectable: (row: TimesheetRow) => {
                const key = timesheetNotSelectable(row, can)
                return key ? t(key) : null
              },
            }
          : {})}
        state={
          model.timesheets.problem ? (
            <EmptyState
              icon={<FileQuestion size={22} aria-hidden />}
              title={t('timesheets.failed')}
              description={t(model.timesheets.problem)}
              action={
                <Button size="sm" onClick={() => actions?.onRetryTimesheets()}>
                  {t('common.retry')}
                </Button>
              }
            />
          ) : items && items.length === 0 ? (
            <EmptyState icon={<Stamp size={22} aria-hidden />} title={t('timesheets.none')} description={t(model.timesheets.canPrepare ? 'timesheets.noneBody' : 'timesheets.noneLead')} />
          ) : undefined
        }
      />
    </section>
  )
}
