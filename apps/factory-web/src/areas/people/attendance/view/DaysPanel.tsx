'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { CalendarClock, FileQuestion, ThumbsUp, X } from 'lucide-react'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { SelectionLabel } from '@nexus/ui/grid'
import { EmptyState } from '@nexus/ui/components'
import { Button, Checkbox, Select, Tag } from '@nexus/ui/primitives'
import { CellSaveMark } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { TIME_ZONE } from '../../_shared/model'
import type { DayRow } from '../api'
import { ANOMALY_KINDS, dayNotSelectable, dayShort, DAY_STATUSES, inlineCodeOffered, isFiltered, plannedText, selectionOf, type AnomalyKind, type DayStatus } from '../model'
import type { AttendanceActions, AttendanceModel } from '../view-model'
import { DayPill, said, useAttendanceWords, type AttendanceWords } from './parts'

export const dayKeys = (t: AttendanceWords): ListKey[] => [
  { keys: ['a'], does: t('keys.approve') },
  { keys: ['e'], does: t('keys.fix') },
  { keys: ['[', ']'], does: t('keys.month') },
  { keys: ['r'], does: t('keys.rollCall') },
]

/**
 * Days (design people.attendance sec:days): a row per day in the shared list frame with its state, and NO name or minutes
 * (Owner answer W1; Statuto dei Lavoratori art. 4): Date · Team · Line · Planned · Clocked · Anomaly · Manual · Absence · Status
 * · Approved. A row opens the Day detail; a planned day nobody clocked in takes its absence code in the row. Selecting and
 * "Approve N clean days" sends what was ticked: a day that cannot be approved comes back held, with why.
 */
export function DaysPanel({ model, actions, onHelp }: { model: AttendanceModel; actions?: AttendanceActions | undefined; onHelp: () => void }) {
  const t = useAttendanceWords()
  const locale = useLocale()
  const items = model.days.items
  const { teams, lines, codes, can, cells } = model

  const columns = useMemo<ColDef<DayRow>[]>(() => {
    const code = (id: string | null, list: ReadonlyArray<{ id: string; code: string }>) => list.find((entry) => entry.id === id)?.code ?? '—'
    const DateCell = ({ data }: ICellRendererParams<DayRow>) =>
      data ? (
        <Link href={`?open=${encodeURIComponent(data.id)}`} scroll={false} onClick={(event) => { if (!event.metaKey && !event.ctrlKey) { event.preventDefault(); actions?.onOpenDay(data.id) } }}>
          {dayShort(data.date, locale)}
        </Link>
      ) : null
    const AnomalyCell = ({ data }: ICellRendererParams<DayRow>) =>
      data ? (
        data.anomalies.kinds.length === 0 ? (
          <span className="fw-pp-sub">—</span>
        ) : (
          <span className="fw-at-tones">
            {data.anomalies.kinds.map((kind) => (
              <Tag key={kind} tone="warning">
                {t(`anomalyKind.${kind}`)}
              </Tag>
            ))}
          </span>
        )
      ) : null
    const AbsenceCell = ({ data }: ICellRendererParams<DayRow>) => {
      if (!data) return null
      const cell = cells[data.id]
      if (!inlineCodeOffered(data, can) || codes.length === 0) return <span className={data.absence === 'NONE' ? 'fw-pp-sub' : undefined}>{t(`absence.${data.absence}`)}</span>
      return (
        <span className="fw-at-inline">
          <Select size="sm" aria-label={t('days.codeFor', { day: dayShort(data.date, locale) })} value="" disabled={cell?.state === 'saving'} onChange={(event) => event.target.value && actions?.onInlineCode(data, event.target.value)} onKeyDown={(event) => event.stopPropagation()}>
            <option value="">{t('days.addCode')}</option>
            {codes.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.code} · {entry.labelI18n[locale] ?? entry.labelI18n.it ?? entry.code}
              </option>
            ))}
          </Select>
          {cell?.state === 'saving' && <CellSaveMark state="saving" />}
          {cell?.state === 'failed' && <span className="fw-at-cell-problem" role="alert">{said(t, cell.words)}</span>}
        </span>
      )
    }
    return [
      { colId: 'date', headerName: t('col.date'), width: 120, pinned: 'left', valueGetter: (params) => params.data?.date ?? '', cellRenderer: DateCell },
      { colId: 'team', headerName: t('col.team'), width: 96, valueGetter: (params) => code(params.data?.teamId ?? null, teams) },
      { colId: 'line', headerName: t('col.line'), width: 86, valueGetter: (params) => code(params.data?.lineId ?? null, lines) },
      { colId: 'planned', headerName: t('col.planned'), minWidth: 170, valueGetter: (params) => (params.data ? (plannedText(params.data.planned) ?? t('days.noShift')) : '') },
      { colId: 'clocked', headerName: t('col.clocked'), width: 120, valueGetter: (params) => (params.data ? t(params.data.presence ? 'days.clocked' : 'days.notClocked') : '') },
      { colId: 'anomaly', headerName: t('col.anomaly'), minWidth: 170, flex: 1, valueGetter: (params) => (params.data?.anomalies.kinds ?? []).map((kind) => t(`anomalyKind.${kind}`)).join(', '), cellRenderer: AnomalyCell },
      { colId: 'manual', headerName: t('col.manual'), width: 104, valueGetter: (params) => (params.data?.manual ? t('days.manual') : '') },
      { colId: 'absence', headerName: t('col.absence'), width: 170, valueGetter: (params) => (params.data ? t(`absence.${params.data.absence}`) : ''), cellRenderer: AbsenceCell },
      { colId: 'status', headerName: t('col.status'), width: 120, valueGetter: (params) => (params.data ? t(`status.${params.data.status}`) : ''), cellRenderer: (params: ICellRendererParams<DayRow>) => (params.data ? <DayPill status={params.data.status} /> : null) },
      { colId: 'approved', headerName: t('col.approved'), width: 110, valueGetter: (params) => (params.data?.approvedAt ? formatDate(params.data.approvedAt, { locale, timeZone: TIME_ZONE }) : '') },
    ]
  }, [t, locale, actions, teams, lines, codes, can, cells])

  const picked = useMemo(() => (items ?? []).filter((row) => model.selected.includes(row.id)), [items, model.selected])
  const counted = selectionOf(picked, model.today)
  const chip = model.address.tile ? t(`tile.${model.address.tile}.chip`) : model.address.manual ? t('days.manualChip') : null

  const tools = (
    <span className="fw-pp-row">
      <Select size="sm" aria-label={t('days.statusFilter')} value={model.address.status ?? ''} onChange={(event) => actions?.onStatus((event.target.value || null) as DayStatus | null)}>
        <option value="">{t('days.allStatuses')}</option>
        {DAY_STATUSES.map((status) => (
          <option key={status} value={status}>
            {t(`status.${status}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" aria-label={t('days.anomalyFilter')} value={model.address.anomaly ?? ''} onChange={(event) => actions?.onAnomaly((event.target.value || null) as AnomalyKind | null)}>
        <option value="">{t('days.allAnomalies')}</option>
        {ANOMALY_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {t(`anomalyKind.${kind}`)}
          </option>
        ))}
      </Select>
      <Checkbox label={t('days.manualOnly')} checked={model.address.manual} onChange={(event) => actions?.onManualFilter(event.target.checked)} />
      {chip && (
        <Button size="sm" variant="tonal" onClick={() => actions?.onClearFilters()}>
          {chip} <X size={13} aria-hidden />
        </Button>
      )}
    </span>
  )

  const filtered = isFiltered(model.address)
  return (
    <section id="fw-at-days" className="fw-at-section" aria-label={t('days.title')}>
      <h2 className="fw-at-title">{t('days.title')}</h2>
      {model.address.tile === 'TO_APPROVE' && <p className="fw-pp-hint">{t('days.toApproveNote')}</p>}
      <ListFrame<DayRow>
        label={t('days.title')}
        rows={items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t('days.count', { count: items.length }) : ''}
        tools={tools}
        rowKind="text"
        keys={dayKeys(t)}
        onHelp={onHelp}
        onOpen={(row) => actions?.onOpenDay(row.id)}
        cards={{ hrefOf: (row) => `?open=${encodeURIComponent(row.id)}` }}
        {...(model.updates > 0 ? { updates: { count: model.updates, onShow: () => actions?.onShowUpdates() } } : {})}
        {...(model.days.more && !filteredByClient(model) ? { more: { label: t('days.more'), onMore: () => actions?.onMoreDays() } } : {})}
        {...(model.can.approve
          ? {
              selection: {
                selected: model.selected,
                onChange: (ids: string[]) => actions?.onSelectDays(ids),
                actions: (
                  <Button size="sm" variant="primary" onClick={() => actions?.onApproveSelected()} heldReason={model.approving ? t('held.working') : null}>
                    <ThumbsUp size={14} aria-hidden /> <SelectionLabel>{t('days.approveSelected', { count: counted.clean })}</SelectionLabel>
                    {counted.held > 0 ? ` · ${t('days.willBeHeld', { count: counted.held })}` : ''}
                  </Button>
                ),
              },
              isRowSelectable: (row: DayRow) => {
                const key = dayNotSelectable(row)
                return key ? t(key) : null
              },
            }
          : {})}
        state={
          model.days.problem ? (
            <EmptyState
              icon={<FileQuestion size={22} aria-hidden />}
              title={t('days.failed')}
              description={t(model.days.problem)}
              action={
                <Button size="sm" onClick={() => actions?.onRetryDays()}>
                  {t('common.retry')}
                </Button>
              }
            />
          ) : items && items.length === 0 ? (
            filtered ? (
              <EmptyState
                icon={<CalendarClock size={22} aria-hidden />}
                title={t('days.noMatch')}
                description={t('days.noMatchBody')}
                action={
                  <Button size="sm" onClick={() => actions?.onClearFilters()}>
                    {t('common.clearFilters')}
                  </Button>
                }
              />
            ) : (
              <EmptyState icon={<CalendarClock size={22} aria-hidden />} title={t('days.none')} description={t('days.noneBody')} />
            )
          ) : undefined
        }
      />
    </section>
  )
}

/** The tile with no API filter read every page already. */
const filteredByClient = (model: AttendanceModel): boolean => model.address.tile === 'NO_CODE'
