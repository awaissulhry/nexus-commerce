'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { CalendarClock, MoreHorizontal, Play } from 'lucide-react'
import { Banner, EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { CountsCan, Phrase } from '../../model'
import type { Schedule } from '../api'
import { countBlocked, DEPTH_NAMESPACE, DUE_TONE, dueWords, scopeParts, startHeld } from '../model'
import type { CountSchedulesActions, CountSchedulesModel } from '../use-count-schedules'

/**
 * B-W2b-320 — Due counts (design warehouse.counts sec:cn-schedule, SCM-227; the tile "Due this week" opens it): the active
 * schedules due this week, most overdue first, on the shared list frame — the location or class, every how many days,
 * when last counted (its count), when due and how overdue — with Start count per row (the schedule's own count, its lines
 * frozen until counted; it opens) or for the selected rows ("Start N counts"). Below it, how many places running counts
 * block now (conn "Locations (blocked during a count)"). The next date is set when a count closes (the API's rule).
 */

export function useCountsDepthWords() {
  const t = useT(DEPTH_NAMESPACE)
  return useMemo(() => ({ t, say: (words: Phrase | null | undefined) => (words ? t(words.key, words.params) : null) }), [t])
}

export const DUE_SECTION_ID = 'fw-cn-due'

export function DueCounts({ model, can, prefix, timeZone, actions }: { model: CountSchedulesModel; can: CountsCan; prefix: string; timeZone: string; actions?: CountSchedulesActions }) {
  const { t, say } = useCountsDepthWords()
  const locale = useLocale()
  const place = { locale, timeZone }
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const rows = model.due.value?.rows ?? null
  const busy = model.starting.length > 0

  const columns = useMemo<ColDef<Schedule>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<Schedule>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-ellipsis">{data.name}</span>
          <span className="fw-st-sub">{scopeParts(data).map((part) => t(part.key, part.params)).join(' · ')}</span>
        </span>
      ) : null
    const LastCell = ({ data }: ICellRendererParams<Schedule>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-num">{data.lastCountedOn ? formatDate(`${data.lastCountedOn}T12:00:00Z`, place) : t('cd.due.never')}</span>
          {data.lastCount && (
            <Link className="fw-st-link fw-st-sub" href={`${prefix}/warehouse/counts/${encodeURIComponent(data.lastCount.id)}`}>
              {data.lastCount.number}
            </Link>
          )}
        </span>
      ) : null
    const DueCell = ({ data }: ICellRendererParams<Schedule>) =>
      data ? (
        <span className="fw-st-cell">
          <span>
            <Pill tone={DUE_TONE[data.due]}>{say(dueWords(data))}</Pill>
          </span>
          <span className="fw-st-sub">{formatDate(`${data.nextDueOn}T12:00:00Z`, place)}</span>
        </span>
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<Schedule>) => {
      if (!data) return null
      const held = say(startHeld(data, can, busy))
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('cd.due.rowMenu', { name: data.name }) }}
          items={[
            { id: 'start', label: t('cd.due.start'), disabled: !!held, description: held ?? undefined, onSelect: () => actions?.onStart?.([data.id]) },
            {
              id: 'edit',
              label: t('cd.due.edit'),
              disabled: !can.manage,
              description: can.manage ? undefined : t('cd.held.noManage'),
              onSelect: () => {
                actions?.onSchedules?.(true)
                actions?.onEditSchedule?.(data)
              },
            },
          ]}
        />
      )
    }
    return [
      { colId: 'name', headerName: t('cd.due.col.name'), minWidth: 220, flex: 1.8, cellRenderer: NameCell },
      { colId: 'every', headerName: t('cd.due.col.every'), minWidth: 110, flex: 0.6, valueGetter: (params) => (params.data ? t('cd.due.everyDays', { count: params.data.everyDays }) : '') },
      { colId: 'last', headerName: t('cd.due.col.last'), minWidth: 130, flex: 0.8, cellRenderer: LastCell },
      { colId: 'due', headerName: t('cd.due.col.due'), minWidth: 160, flex: 0.9, cellRenderer: DueCell },
      { colId: 'more', headerName: t('cd.due.col.actions'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, say, place.locale, place.timeZone, prefix, can, busy, actions])

  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const startManyHeld = !can.manage ? t('cd.held.noManage') : busy ? t('cd.held.busy') : null
  const blocked = countBlocked(model.blocked)
  const state = model.due.problem ? (
    <EmptyState title={t('cd.due.failed')} description={t('cd.common.tryAgainLater')} action={<Button size="sm" onClick={() => actions?.onRetryDue?.()}>{t('cd.common.retry')}</Button>} />
  ) : rows && rows.length === 0 ? (
    <EmptyState
      icon={<CalendarClock size={20} aria-hidden />}
      title={t('cd.due.empty')}
      description={t('cd.due.emptyBody')}
      action={
        <Button size="sm" onClick={() => actions?.onSchedules?.(true)}>
          {t('cd.schedule.open')}
        </Button>
      }
    />
  ) : undefined

  return (
    <section className="fw-cn-stack" aria-labelledby={DUE_SECTION_ID}>
      <div className="fw-cn-head">
        <h2 className="fw-cn-h3" id={DUE_SECTION_ID} tabIndex={-1}>
          {t('cd.due.title')}
        </h2>
        <span className="fw-cn-hint">{t('cd.due.hint')}</span>
      </div>
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(model.notice.words) ?? ''}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissDueNotice?.()}>
              {t('cd.common.close')}
            </Button>
          }
        />
      )}
      <ListFrame<Schedule>
        label={t('cd.due.tableLabel')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('cd.due.count', { count: rows.length }) : '—'}
        listKey={null}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" variant="primary" aria-label={t('cd.due.startN', { count: picked.length })} heldReason={startManyHeld} onClick={() => actions?.onStart?.(picked.map((row) => row.id))}>
              {busy ? <Spinner size={12} /> : <Play size={13} aria-hidden />} <SelectionLabel>{t('cd.due.startN', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        isRowSelectable={(row) => say(startHeld(row, can, false))}
        state={state}
      />
      {model.blocked !== null && (
        <p className="fw-cn-hint">
          {blocked > 0 ? t('cd.blocked.count', { count: blocked }) : t('cd.blocked.none')}{' '}
          <Link className="fw-st-link" href={`${prefix}/warehouse/locations`}>
            {t('cd.blocked.open')}
          </Link>
        </p>
      )}
    </section>
  )
}
