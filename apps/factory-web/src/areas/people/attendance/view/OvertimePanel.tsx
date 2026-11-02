'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Clock, FileQuestion, ThumbsUp } from 'lucide-react'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { SelectionLabel } from '@nexus/ui/grid'
import { EmptyState } from '@nexus/ui/components'
import { Button, Pill, SegmentedControl } from '@nexus/ui/primitives'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { EntryRow } from '../api'
import { blockingLimit, dayShort, ENTRY_TONE, entryNotSelectable } from '../model'
import type { AttendanceActions, AttendanceModel } from '../view-model'
import { LimitPills, useAttendanceWords } from './parts'

/**
 * Overtime to approve (design people.attendance sec:overtime, MES-229): overtime is paid only after approval. The shared list
 * frame instead of the design's SummaryTable (Owner rule 2026-10-29), and no name or hours (Owner answer W1): date · team · line ·
 * class · planned · a tone per limit · status. The person, the hours and each limit in words open one record. Approve N is one
 * command each; a limit that blocks needs its reason inside the record, so a list never overrides it.
 */
export function OvertimePanel({ model, actions, onHelp }: { model: AttendanceModel; actions?: AttendanceActions | undefined; onHelp: () => void }) {
  const t = useAttendanceWords()
  const locale = useLocale()
  const { teams, lines, prefix } = model
  const items = model.overtime.items
  const columns = useMemo<ColDef<EntryRow>[]>(() => {
    const code = (id: string | null, list: ReadonlyArray<{ id: string; code: string }>) => list.find((entry) => entry.id === id)?.code ?? '—'
    const DateCell = ({ data }: ICellRendererParams<EntryRow>) =>
      data ? (
        <Link href={`?entry=${encodeURIComponent(data.id)}`} scroll={false} onClick={(event) => { if (!event.metaKey && !event.ctrlKey) { event.preventDefault(); actions?.onOpenEntry(data.id) } }}>
          {dayShort(data.date, locale)}
        </Link>
      ) : null
    const RequestCell = ({ data }: ICellRendererParams<EntryRow>) => (data ? data.requestId ? <Link href={`${prefix}/people/shifts?open=${encodeURIComponent(data.requestId)}`}>{t('overtime.planned')}</Link> : <span className="fw-pp-sub">{t('overtime.notPlanned')}</span> : null)
    return [
      { colId: 'date', headerName: t('col.date'), width: 130, pinned: 'left', valueGetter: (params) => params.data?.date ?? '', cellRenderer: DateCell },
      { colId: 'team', headerName: t('col.team'), width: 100, valueGetter: (params) => code(params.data?.teamId ?? null, teams) },
      { colId: 'line', headerName: t('col.line'), width: 100, valueGetter: (params) => code(params.data?.lineId ?? null, lines) },
      { colId: 'class', headerName: t('col.class'), width: 110, valueGetter: (params) => (params.data ? t(`class.${params.data.class}`) : '') },
      { colId: 'request', headerName: t('col.request'), width: 220, valueGetter: (params) => (params.data ? t(params.data.requestId ? 'overtime.planned' : 'overtime.notPlanned') : ''), cellRenderer: RequestCell },
      { colId: 'limits', headerName: t('col.limits'), minWidth: 340, flex: 1, valueGetter: (params) => (params.data?.checks ?? []).map((check) => `${t(`limit.${check.rule}.short`)} · ${t(`limitState.${check.state}`)}`).join(', '), cellRenderer: (params: ICellRendererParams<EntryRow>) => (params.data ? <LimitPills checks={params.data.checks} /> : null) },
      { colId: 'status', headerName: t('col.status'), width: 130, valueGetter: (params) => (params.data ? t(`entryStatus.${params.data.status}`) : ''), cellRenderer: (params: ICellRendererParams<EntryRow>) => (params.data ? <Pill tone={ENTRY_TONE[params.data.status]} dot>{t(`entryStatus.${params.data.status}`)}</Pill> : null) },
    ]
  }, [t, locale, actions, teams, lines, prefix])

  const picked = useMemo(() => (items ?? []).filter((row) => model.overtime.selected.includes(row.id)), [items, model.overtime.selected])
  const free = picked.filter((row) => !blockingLimit(row.checks)).length

  return (
    <section id="fw-at-overtime" className="fw-at-section" aria-label={t('overtime.title')}>
      <h2 className="fw-at-title">{t('overtime.title')}</h2>
      <p className="fw-pp-hint">{t('overtime.note')}</p>
      <ListFrame<EntryRow>
        label={t('overtime.title')}
        rows={items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t('overtime.count', { count: items.length }) : ''}
        rowKind="text"
        listKey="people.attendance.overtime"
        onHelp={onHelp}
        onOpen={(row) => actions?.onOpenEntry(row.id)}
        cards={{ hrefOf: (row) => `?entry=${encodeURIComponent(row.id)}` }}
        tools={
          <SegmentedControl
            size="sm"
            ariaLabel={t('overtime.show')}
            value={model.overtime.all ? 'all' : 'waiting'}
            onChange={(value) => actions?.onOvertimeAll(value === 'all')}
            options={[
              { value: 'waiting', label: t('overtime.waiting') },
              { value: 'all', label: t('overtime.all') },
            ]}
          />
        }
        {...(model.overtime.more ? { more: { label: t('days.more'), onMore: () => actions?.onMoreOvertime() } } : {})}
        {...(model.can.reviewOvertime
          ? {
              selection: {
                selected: model.overtime.selected,
                onChange: (ids: string[]) => actions?.onSelectEntries(ids),
                actions: (
                  <Button size="sm" variant="primary" onClick={() => actions?.onBulkEntries()} heldReason={model.overtime.busy ? t('held.working') : free === 0 ? t('held.limitBlocks') : null}>
                    <ThumbsUp size={14} aria-hidden /> <SelectionLabel>{t('overtime.bulkApprove', { count: free })}</SelectionLabel>
                  </Button>
                ),
              },
              isRowSelectable: (row: EntryRow) => {
                const key = entryNotSelectable(row)
                return key ? t(key) : null
              },
            }
          : {})}
        state={
          model.overtime.problem ? (
            <EmptyState
              icon={<FileQuestion size={22} aria-hidden />}
              title={t('overtime.failed')}
              description={t(model.overtime.problem)}
              action={
                <Button size="sm" onClick={() => actions?.onRetryOvertime()}>
                  {t('common.retry')}
                </Button>
              }
            />
          ) : items && items.length === 0 ? (
            <EmptyState icon={<Clock size={22} aria-hidden />} title={t('overtime.none')} description={t('overtime.noneBody')} />
          ) : undefined
        }
      />
    </section>
  )
}
