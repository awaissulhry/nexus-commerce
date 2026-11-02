'use client'

import { useMemo, useRef, useState } from 'react'
import { Lock } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { actionsColumn, SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Select } from '@nexus/ui/primitives'
import { LINE_DAY_STATES, type LineDayState } from '@nexus/factory-domain/production/labour/rules'
import { DateField } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { siteColumn } from '../../../../shell/scope/scope-context'
import type { LineDay } from '../api'
import { blockerPhrase, closeDayHeld, codedPhrase, dayKey, daySelectable, dayTarget, reopenDayHeld } from '../model'
import type { LabourActions, LabourModel } from './LabourView'
import { dayText, DayPill, say, useLabourT } from './parts'

/**
 * Line days (design lb-days): "Close each line's day once off-standard time is coded and anomalies are cleared; closed days
 * feed pay". Columns: line · date · off-standard coded (yes / 3 blocks left) · anomalies · status (Open / Ready / Closed) · who
 * closed it (an office person, the line's record: never a worker). Close day is held until the anomalies are cleared, with
 * the count; a closed day is reopened by who may, with a reason. Ready days can be closed together. A row opens the day.
 */
export function DaysList({ model, actions }: { model: LabourModel; actions?: LabourActions }) {
  const t = useLabourT()
  const locale = useLocale()
  const latest = useRef({ actions, model })
  latest.current = { actions, model }
  const [selected, setSelected] = useState<readonly string[]>([])
  const rows = model.days.items

  const columns = useMemo<ColDef<LineDay>[]>(() => {
    const Line = ({ data }: ICellRendererParams<LineDay>) =>
      data ? (
        <span className="fw-lb-cell">
          <span className="fw-lb-ellipsis">{data.line.code}</span>
          <span className="fw-lb-sub fw-lb-ellipsis">{data.line.name}</span>
        </span>
      ) : null
    const Day = ({ data }: ICellRendererParams<LineDay>) => (data ? <span className="fw-lb-num">{dayText(data.workDate, locale, model.timeZone)}</span> : null)
    const Coded = ({ data }: ICellRendererParams<LineDay>) => (data ? <span className="fw-lb-ellipsis">{say(t, codedPhrase(data))}</span> : null)
    const Anomalies = ({ data }: ICellRendererParams<LineDay>) =>
      data ? (
        <span className="fw-lb-cell">
          <span className="fw-lb-num">{data.anomalies}</span>
          {data.blockers
            .filter((blocker) => blocker.kind !== 'OFF_STANDARD_RUNNING' && blocker.kind !== 'OFF_STANDARD_WAITING')
            .slice(0, 1)
            .map((blocker) => (
              <span key={blocker.kind} className="fw-lb-sub fw-lb-ellipsis">
                {say(t, blockerPhrase(blocker))}
              </span>
            ))}
        </span>
      ) : null
    const Status = ({ data }: ICellRendererParams<LineDay>) =>
      data ? (
        <span className="fw-lb-cell">
          <span>
            <DayPill state={data.state} />
          </span>
          {data.closedBy && <span className="fw-lb-sub fw-lb-ellipsis">{t('days.closedBy', { name: data.closedBy.name })}</span>}
        </span>
      ) : null
    const site = siteColumn<LineDay>(model.scope, (row) => row.siteId, t('col.site'))
    return [
      { colId: 'line', headerName: t('col.line'), minWidth: 130, flex: 0.8, cellRenderer: Line, valueGetter: (params) => params.data?.line.code ?? '' },
      ...(site ? [site] : []),
      { colId: 'date', headerName: t('col.date'), minWidth: 110, flex: 0.6, cellRenderer: Day, valueGetter: (params) => params.data?.workDate ?? '' },
      { colId: 'coded', headerName: t('col.coded'), minWidth: 170, flex: 0.9, cellRenderer: Coded, valueGetter: (params) => params.data?.offStandard.left ?? 0 },
      { colId: 'anomalies', headerName: t('col.anomalies'), minWidth: 170, flex: 0.9, cellRenderer: Anomalies, valueGetter: (params) => params.data?.anomalies ?? 0 },
      { colId: 'records', headerName: t('col.records'), minWidth: 136, flex: 0.5, type: 'rightAligned', valueGetter: (params) => params.data?.records ?? 0 },
      { colId: 'status', headerName: t('col.status'), minWidth: 170, flex: 0.8, cellRenderer: Status, valueGetter: (params) => (params.data ? t(`dayState.${params.data.state}`) : '') },
      actionsColumn<LineDay>({
        primary: (row) => [
          row.state === 'CLOSED'
            ? {
                id: 'reopen',
                label: t('days.reopen'),
                onClick: (day: LineDay) => latest.current.actions?.onDialog?.({ kind: 'reopen', day: dayTarget(day), reason: '', problem: null }),
                disabled: (day: LineDay) => {
                  const held = reopenDayHeld(day, latest.current.model.can, latest.current.model.busy)
                  return held ? say(t, held) : null
                },
                ariaLabel: (day: LineDay) => t('days.reopenNamed', { line: day.line.code, day: dayText(day.workDate, locale, latest.current.model.timeZone) }),
              }
            : {
                id: 'close',
                label: t('days.close'),
                tone: 'primary' as const,
                onClick: (day: LineDay) => latest.current.actions?.onDialog?.({ kind: 'close', days: [dayTarget(day)], note: '', problem: null }),
                disabled: (day: LineDay) => {
                  const held = closeDayHeld(day, latest.current.model.can, latest.current.model.busy)
                  return held ? say(t, held) : null
                },
                ariaLabel: (day: LineDay) => t('days.closeNamed', { line: day.line.code, day: dayText(day.workDate, locale, latest.current.model.timeZone) }),
              },
        ],
        prefsLabel: t('col.actions'),
      }),
    ]
  }, [t, locale, model.timeZone, model.scope])

  const picked = (rows ?? []).filter((row) => selected.includes(dayKey(row)))
  const state = model.days.problem ? (
    <EmptyState title={t('days.failed')} description={t(model.days.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : rows && rows.length === 0 ? (
    <EmptyState title={t('days.empty.title')} description={t('days.empty.body')} />
  ) : undefined

  return (
    <section className="fw-lb-section" aria-label={t('days.title')}>
      <h2 className="fw-lb-h2">{t('days.title')}</h2>
      <p className="fw-lb-hint">{t('days.hint')}</p>
      <ListFrame<LineDay>
        label={t('days.title')}
        title={t('days.title')}
        rows={state ? [] : rows}
        rowId={dayKey}
        columns={columns}
        count={rows ? t('days.count', { count: rows.length }) : '—'}
        tools={
          <span className="fw-lb-filters">
            <Select size="sm" aria-label={t('days.stateLabel')} value={model.address.state ?? ''} onChange={(event) => actions?.onAddress?.({ state: (event.target.value || null) as LineDayState | null })}>
              <option value="">{t('days.stateAll')}</option>
              {LINE_DAY_STATES.map((state) => (
                <option key={state} value={state}>
                  {t(`dayState.${state}`)}
                </option>
              ))}
            </Select>
            <span className="fw-lb-date">
              <span className="fw-lb-sub">{t('common.from')}</span>
              <DateField ariaLabel={t('common.from')} value={model.address.from ?? model.days.from ?? ''} onChange={(value) => actions?.onAddress?.({ from: value || null })} />
            </span>
            <span className="fw-lb-date">
              <span className="fw-lb-sub">{t('common.to')}</span>
              <DateField ariaLabel={t('common.to')} value={model.address.to ?? model.days.to ?? ''} onChange={(value) => actions?.onAddress?.({ to: value || null })} />
            </span>
          </span>
        }
        selection={
          model.can.close
            ? {
                selected,
                onChange: setSelected,
                actions: (
                  <Button
                    size="sm"
                    variant="primary"
                    aria-label={t('bulk.close', { count: picked.length })}
                    heldReason={picked.length === 0 ? t('held.noDayPicked') : model.busy ? t('held.busy') : null}
                    onClick={() => {
                      actions?.onDialog?.({ kind: 'close', days: picked.map(dayTarget), note: '', problem: null })
                      setSelected([])
                    }}
                  >
                    <Lock size={13} aria-hidden /> <SelectionLabel>{t('bulk.close', { count: picked.length })}</SelectionLabel>
                  </Button>
                ),
              }
            : undefined
        }
        isRowSelectable={(day) => {
          const held = daySelectable(day, model.can)
          return held ? say(t, held) : null
        }}
        onHelp={() => actions?.onDialog?.({ kind: 'keys' })}
        onOpen={(day) => actions?.onAddress?.({ open: dayKey(day) })}
        state={state}
      />
    </section>
  )
}
