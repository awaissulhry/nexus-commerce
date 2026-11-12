'use client'

import Link from 'next/link'
import { ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { AdherenceRows, AdherenceState, UtilisationRows } from '../api'
import { adherenceDrillCsvRows, capacityHref, chosenLane, laneLabel, minutesText, neighbourOf, pctText, signedDays, utilisationDrillCsvRows, weekLabel, workOrderHref, type DrillTarget } from '../model'
import { Failed, NAMESPACE, Shape } from './Parts'
import type { ReportsActions, ReportsModel } from './types'

const STATE_TONE: Record<AdherenceState, 'success' | 'danger' | 'neutral'> = { ON_TIME: 'success', LATE: 'danger', NOT_PLANNED: 'neutral' }

/**
 * Work orders behind this bar (design planning.reports pop drill, a detail modal from a bar or a point: "The rows that make the
 * number, each a link"; keys J / K): for a schedule-adherence bar the finished work orders with their plan (the version the floor
 * had, or the working plan) and what happened — start and finish against plan in days, on time or late; for a utilisation point
 * the work orders whose scans earned its minutes (per operation) and, for this week and later, those booking its load. J / K (and
 * the buttons) open the same line or lane's next and previous week. Export writes the rows as a CSV file; the primary opens
 * Capacity & load for a point, and is held with its reason for a bar (the work orders list takes no "finished in week" filter).
 */
export function DrillDialog({ model, actions }: { model: ReportsModel; actions?: ReportsActions | undefined }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const drill = model.drill
  if (!drill) return null
  const target = drill.target
  const weeks = target.section === 'adherence' ? (model.adherence.status === 'ready' ? model.adherence.value.weeks : []) : model.utilisation.status === 'ready' ? model.utilisation.value.weeks : []
  const keys = weeks.map((week) => week.key)
  const next = neighbourOf(target, keys, 1)
  const previous = neighbourOf(target, keys, -1)
  const week = target.week ? weeks.find((entry) => entry.key === target.week) : undefined
  const when = week ? weekLabel(week, locale) : t('drill.wholePeriod')
  const name = (() => {
    if (target.section === 'adherence') {
      if (target.lineKey === null) return t('adherence.allLines')
      if (target.lineKey === 'none') return t('adherence.noLine')
      const line = model.adherence.status === 'ready' ? model.adherence.value.lines.find((entry) => entry.line?.id === target.lineKey)?.line : null
      return line ? `${line.code} · ${line.name}` : t('adherence.allLines')
    }
    const lane = model.utilisation.status === 'ready' ? chosenLane(model.utilisation.value, target.laneKey) : null
    return lane ? laneLabel(lane, { plant: t('utilisation.plant'), kind: (kind) => t(`utilisation.kind.${kind}`) }) : t('utilisation.plant')
  })()
  const at = (value: string | null) => (value ? formatDateTime(value, { locale }) : '—')
  const onKeyDown = (event: React.KeyboardEvent) => {
    const element = event.target as HTMLElement
    if (element.closest('input, textarea, select')) return
    if ((event.key === 'j' || event.key === 'J') && next) {
      event.preventDefault()
      actions?.onDrill?.(next)
    } else if ((event.key === 'k' || event.key === 'K') && previous) {
      event.preventDefault()
      actions?.onDrill?.(previous)
    }
  }
  const ready = drill.read.status === 'ready'
  const exportRows = () => {
    if (drill.target.section === 'adherence' && drill.read.status === 'ready') {
      actions?.onExport?.('drill', [t('drill.col.workOrder'), t('drill.col.style'), t('drill.col.line'), t('drill.col.plannedStart'), t('drill.col.plannedFinish'), t('drill.col.actualStart'), t('drill.col.actualFinish'), t('drill.col.startDays'), t('drill.col.finishDays'), t('drill.col.state')], adherenceDrillCsvRows(drill.read.value as AdherenceRows, { state: (state) => t(`adherence.state.${state}`) }))
    } else if (drill.read.status === 'ready') {
      actions?.onExport?.('drill', [t('drill.col.part'), t('drill.col.workOrder'), t('drill.col.operation'), t('drill.col.lane'), t('drill.col.garments'), t('drill.col.minutes')], utilisationDrillCsvRows(drill.read.value as UtilisationRows))
    }
  }
  const empty = ready && (target.section === 'adherence' ? (drill.read.value as AdherenceRows).rows.length === 0 : !((drill.read.value as UtilisationRows).earned?.rows.length || (drill.read.value as UtilisationRows).booked?.rows.length))
  const footer = (
    <>
      <Button size="sm" onClick={() => previous && actions?.onDrill?.(previous)} heldReason={previous ? null : target.week ? t('drill.first') : t('drill.noWeeks')} aria-keyshortcuts="k">
        <ChevronLeft size={14} aria-hidden /> {t('drill.previous')}
      </Button>
      <Button size="sm" onClick={() => next && actions?.onDrill?.(next)} heldReason={next ? null : target.week ? t('drill.last') : t('drill.noWeeks')} aria-keyshortcuts="j">
        {t('drill.next')} <ChevronRight size={14} aria-hidden />
      </Button>
      <span className="grow" />
      <Button size="sm" onClick={exportRows} heldReason={ready && !empty ? null : t('drill.exportHeld')}>
        <Download size={14} aria-hidden /> {t('drill.export')}
      </Button>
      {target.section === 'utilisation' && model.site ? (
        <Button size="sm" variant="primary" asChild>
          <Link href={capacityHref(model.prefix, model.site.id)}>{t('drill.openCapacity')}</Link>
        </Button>
      ) : (
        <Button size="sm" variant="primary" heldReason={t('drill.openHeld')}>
          {t('drill.openList')}
        </Button>
      )}
    </>
  )
  return (
    <Modal open onClose={() => actions?.onDrill?.(null)} title={t('drill.title')} subtitle={t('drill.subtitle', { name, when })} size="xxl" footer={footer}>
      <div className="fw-plr-drill" onKeyDown={onKeyDown}>
        {drill.read.status === 'loading' || drill.read.status === 'idle' ? <Shape chart={false} /> : null}
        {drill.read.status === 'error' ? <Failed title={t('drill.failed')} problem={drill.read.problem} onRetry={actions?.onDrillRetry} /> : null}
        {drill.read.status === 'ready' && drill.target.section === 'adherence' ? <AdherenceRowsView answer={drill.read.value as AdherenceRows} model={model} at={at} /> : null}
        {drill.read.status === 'ready' && drill.target.section === 'utilisation' ? <UtilisationRowsView answer={drill.read.value as UtilisationRows} model={model} /> : null}
        <p className="fw-plr-muted">{t('drill.keys')}</p>
      </div>
    </Modal>
  )
}

function AdherenceRowsView({ answer, model, at }: { answer: AdherenceRows; model: ReportsModel; at: (value: string | null) => string }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  return (
    <>
      <KeyValue
        columns={3}
        items={[
          { label: t('adherence.kv.onTime'), value: pctText(answer.figures.onTimePct, locale), hint: t('adherence.kv.onTimeHint', { onTime: answer.figures.onTime, planned: answer.figures.planned }) },
          { label: t('adherence.kv.finished'), value: String(answer.figures.finished), hint: answer.figures.notPlanned > 0 ? t('adherence.kv.notPlanned', { count: answer.figures.notPlanned }) : t('adherence.kv.allPlanned') },
          { label: t('adherence.kv.late'), value: String(answer.figures.late), hint: t('adherence.kv.meanFinish', { days: signedDays(answer.figures.meanFinishDays, locale) }) },
        ]}
      />
      {answer.rows.length === 0 ? (
        <EmptyState title={t('drill.empty')} description={t('drill.emptyHint')} />
      ) : (
        <SummaryTable
          label={t('drill.tableLabel')}
          stackOnPhone
          widths={['16%']}
          columns={[t('drill.col.workOrder'), t('drill.col.line'), t('drill.col.planned'), t('drill.col.actual'), t('drill.col.startDays'), t('drill.col.finishDays'), t('drill.col.state')]}
          align={[undefined, undefined, undefined, undefined, 'right', 'right', undefined]}
          rows={answer.rows.map((row) => ({
            id: row.workOrder.id,
            cells: [
              <span key="w" className="fw-plr-cell">
                <Link className="fw-plr-link" href={workOrderHref(model.prefix, row.workOrder.id, row.workOrder.number)}>
                  {row.workOrder.number}
                </Link>
                <span className="fw-plr-muted">{`${row.workOrder.style.code} · ${row.workOrder.style.name}`}</span>
              </span>,
              row.line ? row.line.code : t('adherence.noLine'),
              row.planned ? (
                <span key="p" className="fw-plr-cell">
                  <span>{`${at(row.planned.startAt)} – ${at(row.planned.endAt)}`}</span>
                  <span className="fw-plr-muted">{row.planned.source === 'PUBLISHED' ? t('drill.version', { number: row.planned.number ?? 0 }) : t('drill.working')}</span>
                </span>
              ) : (
                <span key="p" className="fw-plr-muted">
                  {t('drill.notPlanned')}
                </span>
              ),
              `${at(row.actual.startAt)} – ${at(row.actual.finishAt)}`,
              signedDays(row.startDays, locale),
              signedDays(row.finishDays, locale),
              <Tag key="s" tone={STATE_TONE[row.state]}>
                {t(`adherence.state.${row.state}`)}
              </Tag>,
            ],
          }))}
        />
      )}
      {answer.more > 0 ? <p className="fw-plr-muted">{t('drill.more', { count: answer.more })}</p> : null}
    </>
  )
}

function UtilisationRowsView({ answer, model }: { answer: UtilisationRows; model: ReportsModel }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const wo = (row: { workOrder: { id: string; number: string; style: { code: string; name: string } } }) => (
    <span key="w" className="fw-plr-cell">
      <Link className="fw-plr-link" href={workOrderHref(model.prefix, row.workOrder.id, row.workOrder.number)}>
        {row.workOrder.number}
      </Link>
      <span className="fw-plr-muted">{`${row.workOrder.style.code} · ${row.workOrder.style.name}`}</span>
    </span>
  )
  return (
    <>
      {answer.earned ? (
        <section className="fw-plr-drill-part" aria-labelledby="plr-drill-earned">
          <h3 className="fw-plr-h3" id="plr-drill-earned">
            {t('drill.earnedTitle', { minutes: minutesText(answer.earned.minutes, locale) })}
          </h3>
          {answer.earned.rows.length === 0 ? (
            <p className="fw-plr-muted">{t('drill.earnedNone')}</p>
          ) : (
            <SummaryTable
              label={t('drill.earnedTitle', { minutes: minutesText(answer.earned.minutes, locale) })}
              stackOnPhone
              widths={['22%']}
              columns={[t('drill.col.workOrder'), t('drill.col.operation'), t('drill.col.lane'), t('drill.col.garments'), t('drill.col.minutes')]}
              align={[undefined, undefined, undefined, 'right', 'right']}
              rows={answer.earned.rows.map((row) => ({ id: `${row.workOrder.id}|${row.operation.id}`, cells: [wo(row), t('drill.operation', { seq: row.operation.seq, name: row.operation.name }), row.lane.code, String(row.garments), minutesText(row.minutes, locale)] }))}
            />
          )}
          {answer.earned.more > 0 ? <p className="fw-plr-muted">{t('drill.more', { count: answer.earned.more })}</p> : null}
        </section>
      ) : null}
      {answer.booked ? (
        <section className="fw-plr-drill-part" aria-labelledby="plr-drill-booked">
          <h3 className="fw-plr-h3" id="plr-drill-booked">
            {t('drill.bookedTitle', { minutes: minutesText(answer.booked.minutes, locale) })}
          </h3>
          {answer.booked.rows.length === 0 ? (
            <p className="fw-plr-muted">{t('drill.bookedNone')}</p>
          ) : (
            <SummaryTable
              label={t('drill.bookedTitle', { minutes: minutesText(answer.booked.minutes, locale) })}
              stackOnPhone
              widths={['22%']}
              columns={[t('drill.col.workOrder'), t('drill.col.operation'), t('drill.col.lane'), t('drill.col.pieces'), t('drill.col.minutes'), t('drill.col.placedBy')]}
              align={[undefined, undefined, undefined, 'right', 'right', undefined]}
              rows={answer.booked.rows.map((row) => ({ id: `${row.workOrder.id}|${row.operation.id}|${row.lane.code}`, cells: [wo(row), t('drill.operation', { seq: row.operation.seq, name: row.operation.name }), row.lane.code, String(row.pieces), minutesText(row.minutes, locale), t(`drill.placedBy.${row.placedBy}`)] }))}
            />
          )}
          {answer.booked.more > 0 ? <p className="fw-plr-muted">{t('drill.more', { count: answer.booked.more })}</p> : null}
        </section>
      ) : null}
    </>
  )
}

export type { DrillTarget }
