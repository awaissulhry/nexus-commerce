'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { ChartGantt, ChevronDown, ChevronUp, Grid3x3 } from 'lucide-react'
import { EmptyState, SummaryTable } from '@nexus/ui/components'
import { LoadBar } from '@nexus/ui/patterns/planning-board/index'
import { Button, Kbd, Skeleton, Tag } from '@nexus/ui/primitives'
import { DetailModal } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useBoardWords } from '../../../_shared/planning-board/words'
import { kindWords, pieceLoadWords } from '../../allocation/depth/model'
import type { CellOrders } from '../api'
import type { WorkshopCellJobs, WorkshopLine } from '../depth/api'
import { BAND_CLASS, heatCellAt, heatCellKey, heatCellWords, heatLaneKey, heatLaneWords, heatOrder, heatStep, heatText, heatWeekLabel, kindOfTag, legendOf, parseWorkshopKey, workshopCellAt, workshopCellOrder, workshopHowWords, type Words } from '../depth/model'
import { boardHref, dayWords, minutesText, rangeWords, type Words as CapacityWords } from '../model'
import type { CapacityActions, CapacityModel } from '../view-model'

/**
 * The W2b parts of Capacity & load (SCR-123; B-W2b-338): the Load heatmap (design sec:heatmap: lanes down, weeks across,
 * each cell coloured by its band AND the whole percent written in it, "—" when nothing is available; one Tab stop, the
 * arrows walk the cells, Enter or a click opens the cell's DetailModal) and the two detail modals it and the table's
 * workshop rows open: a lane's orders (GET /planning/capacity/cell) or a workshop's work (GET
 * /planning/capacity/subcontractors/cell), J / K across the cells, Open on board.
 *
 * The DS Heatmap (components/Heatmap) is an intensity map (opacity by value, no number in the cell); the design asks for
 * banded load cells with the number written, so this is an area part composed from DS tokens and named as a missing DS
 * part (a banded "LoadHeatmap").
 */

export function LoadHeatmap({ model, actions, words, capacityWords }: { model: CapacityModel; actions?: CapacityActions; words: Words; capacityWords: CapacityWords }) {
  const { t, locale } = words
  const heat = model.heatmap ?? { status: 'loading' as const }
  const data = heat.status === 'ready' ? heat.value : null
  const [focus, setFocus] = useState<{ row: number; col: number }>({ row: 0, col: 0 })
  const cells = useRef(new Map<string, HTMLButtonElement>())
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, row: number, col: number) => {
    if (!data) return
    const next = heatStep(data, row, col, event.key)
    if (!next) return
    event.preventDefault()
    setFocus(next)
    cells.current.get(`${next.row}:${next.col}`)?.focus()
  }
  return (
    <section className="fw-pch" aria-labelledby="fw-pch-title">
      <div className="fw-pch-head">
        <h2 className="fw-pch-title" id="fw-pch-title">
          {t('cp.heat.title')}
        </h2>
        <span className="fw-pc-hint">{data ? t('cp.heat.hint', { count: data.weeks.length, weeks: String(data.weeks.length), from: dayWords(data.from, locale), to: dayWords(data.to, locale) }) : t('cp.heat.hintPlain')}</span>
      </div>
      <ul className="fw-pch-legend" aria-label={t('cp.heat.legend')}>
        {legendOf(words).map((entry) => (
          <li key={entry.band}>
            <span className={`fw-pch-swatch ${BAND_CLASS[entry.band]}`} aria-hidden="true">
              {entry.band === 'UNKNOWN' ? '—' : ''}
            </span>
            {entry.label}
          </li>
        ))}
      </ul>
      {heat.status === 'loading' ? (
        <div className="fw-pch-frame" aria-busy="true" aria-label={t('cp.heat.reading')}>
          <div className="fw-pch-axes">
            <span className="fw-pc-hint">{t('cp.heat.axisLanes')}</span>
            <span className="fw-pc-hint">{t('cp.heat.axisWeeks')}</span>
          </div>
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} height={34} />
          ))}
        </div>
      ) : heat.status === 'error' ? (
        <EmptyState
          icon={<Grid3x3 size={24} aria-hidden />}
          title={t('cp.heat.errorTitle')}
          description={capacityWords.t(heat.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetryHeat?.()}>
              {capacityWords.t('common.retry')}
            </Button>
          }
        />
      ) : data && data.lanes.length === 0 ? (
        <EmptyState icon={<Grid3x3 size={24} aria-hidden />} title={t('cp.heat.emptyTitle')} description={t('cp.heat.emptyBody')} />
      ) : data ? (
        <div className="fw-pch-scroll">
          <table className="fw-pch-table" aria-label={t('cp.heat.label', { site: data.site.name })}>
            <thead>
              <tr>
                <th scope="col" className="fw-pch-lanehead">
                  {t('cp.heat.axisLanes')}
                </th>
                {data.weeks.map((week) => (
                  <th key={week.key} scope="col" className="fw-pch-weekhead">
                    {heatWeekLabel(week, capacityWords)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.lanes.map((lane, row) => {
                const named = heatLaneWords(lane, words)
                return (
                  <tr key={heatLaneKey(lane)}>
                    <th scope="row" className="fw-pch-lane">
                      <span className="fw-pc-ellipsis">{named.name}</span>
                      <span className="fw-pc-cell-sub fw-pc-ellipsis">{named.sub}</span>
                    </th>
                    {lane.cells.map((cell, col) => {
                      const key = heatCellKey(lane, cell.key)
                      const label = heatCellWords(lane, cell, words)
                      const tabbable = focus.row === row && focus.col === col
                      return (
                        <td key={cell.key} className="fw-pch-td">
                          <button
                            type="button"
                            ref={(element) => {
                              if (element) cells.current.set(`${row}:${col}`, element)
                              else cells.current.delete(`${row}:${col}`)
                            }}
                            className={`fw-pch-cell ${BAND_CLASS[cell.band]}`}
                            aria-label={label}
                            title={label}
                            tabIndex={tabbable ? 0 : -1}
                            onFocus={() => setFocus({ row, col })}
                            onKeyDown={(event) => onKey(event, row, col)}
                            onClick={() => actions?.onHeat?.(key)}
                          >
                            {heatText(cell, locale)}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {data ? <p className="fw-pc-hint">{t('cp.heat.counts', { cells: String(data.counts.cellsOver), lanes: String(data.counts.lanesOver), count: data.counts.cellsOver })}</p> : null}
    </section>
  )
}

/** J / K inside a detail modal (never while typing): the previous and the next cell. */
function useWalk(prev: string | null, next: string | null, open: (key: string) => void) {
  const latest = useRef({ prev, next, open })
  latest.current = { prev, next, open }
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="menu"]') || target.isContentEditable)) return
      const now = latest.current
      const pressed = event.key.toLowerCase()
      if (pressed === 'j' && now.next) {
        event.preventDefault()
        now.open(now.next)
      } else if (pressed === 'k' && now.prev) {
        event.preventDefault()
        now.open(now.prev)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function WalkButtons({ prev, next, open, words }: { prev: string | null; next: string | null; open: (key: string) => void; words: CapacityWords }) {
  const { t } = words
  return (
    <span className="fw-pc-inline">
      <Button size="sm" variant="quiet" aria-label={t('cell.prev')} heldReason={prev ? null : t('cell.first')} onClick={() => prev && open(prev)} aria-keyshortcuts="k">
        <ChevronUp size={16} aria-hidden /> <Kbd>K</Kbd>
      </Button>
      <Button size="sm" variant="quiet" aria-label={t('cell.next')} heldReason={next ? null : t('cell.last')} onClick={() => next && open(next)} aria-keyshortcuts="j">
        <ChevronDown size={16} aria-hidden /> <Kbd>J</Kbd>
      </Button>
    </span>
  )
}

/** The work behind a workshop cell (subcontract orders, parts on the allocation board, the plan's proposals). */
function JobsTable({ jobs, model, words, unit }: { jobs: WorkshopCellJobs; model: CapacityModel; words: Words; unit: 'MINUTES' | 'PIECES' }) {
  const { t, locale } = words
  if (jobs.jobs.length === 0) return <p className="fw-pc-hint">{t('cp.jobs.none')}</p>
  return (
    <SummaryTable
      label={t('cp.jobs.label')}
      density="compact"
      stackOnPhone
      columns={[t('cp.jobs.col.what'), t('cp.jobs.col.workOrder'), t('cp.jobs.col.days'), t('cp.jobs.col.garments'), t(`cp.jobs.col.share.${unit}`), t('cp.jobs.col.pct')]}
      align={['left', 'left', 'left', 'right', 'right', 'right']}
      rows={jobs.jobs.map((job) => ({
        id: `${job.kind}-${job.id}`,
        cells: [
          <span key="what" className="fw-pc-cell">
            <span>
              {t(`cp.jobs.kind.${job.kind}`)} {job.number ? `· ${job.number}` : ''}
            </span>
            <span className="fw-pc-cell-sub">
              {t(`cp.jobs.status.${['DRAFT', 'ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED', 'RECEIVED', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'PLANNED'].includes(job.status) ? job.status : 'OTHER'}`)}
              {job.proposed ? ` · ${t('cp.jobs.proposed')}` : ''}
            </span>
          </span>,
          job.workOrder?.number ? (
            <span key="wo" className="fw-pc-cell">
              <Link className="fw-pc-link" href={`${model.prefix}/production/work-orders/${encodeURIComponent(job.workOrder.id)}`}>
                {job.workOrder.number}
              </Link>
              {job.style ? <span className="fw-pc-cell-sub">{job.style}</span> : null}
            </span>
          ) : (
            <span key="wo" className="fw-pc-cell-sub">
              {job.style ?? '—'}
            </span>
          ),
          rangeWords(job.from, job.to, locale),
          String(job.garments),
          minutesText(job.share, locale),
          `${minutesText(job.sharePct, locale)}%`,
        ],
      }))}
    />
  )
}

/** A workshop cell of the load table (`?cell=WORKSHOP:…`): its load, how its capacity is made, the work behind it. */
export function WorkshopCellDetail({ model, actions, lines, words, capacityWords }: { model: CapacityModel; actions?: CapacityActions; lines: readonly WorkshopLine[]; words: Words; capacityWords: CapacityWords }) {
  const { t, locale } = words
  const kit = useBoardWords()
  const subs = model.subcontractors?.status === 'ready' ? model.subcontractors.value : null
  const key = model.controls.cell!
  const at = subs ? workshopCellAt(subs, key) : null
  const order = workshopCellOrder(lines)
  const index = order.indexOf(key)
  const prev = index > 0 ? order[index - 1]! : null
  const next = index >= 0 && index < order.length - 1 ? order[index + 1]! : null
  const open = (target: string) => actions?.onCell?.(target)
  useWalk(prev, next, open)
  const loaded = model.workshopCell?.key === key ? model.workshopCell.jobs : ({ status: 'loading' } as const)
  const bucket = at && subs ? (subs.buckets.find((entry) => entry.key === at.cell.key) ?? { key: at.cell.key, kind: subs.bucket, from: at.cell.from, to: at.cell.to }) : null
  const title = at && bucket ? capacityWords.t('cell.title', { lane: at.line.name, bucket: bucketTitle(bucket, capacityWords) }) : capacityWords.t('cell.gone')
  const pieceWords = { ...kit.load, ...pieceLoadWords(t) }
  return (
    <DetailModal
      open
      onClose={() => actions?.onCell?.(null)}
      title={title}
      subtitle={at ? t('cp.detail.subtitle', { kind: kindWords(at.line.workCentreKind, words), from: dayWords(at.cell.from, locale, true), to: dayWords(at.cell.to, locale, true) }) : undefined}
      meta={<Tag tone="neutral">{t('cp.kind.WORKSHOP')}</Tag>}
      loading={at !== null && loaded.status === 'loading'}
      error={!at ? (model.subcontractors?.status === 'loading' ? undefined : capacityWords.t('error.gone')) : loaded.status === 'error' ? capacityWords.t(loaded.problem) : undefined}
      onRetry={() => actions?.onRetryCell?.()}
      actions={
        <>
          <WalkButtons prev={prev} next={next} open={open} words={capacityWords} />
          {at ? (
            <Button size="sm" variant="primary" asChild>
              <a href={boardHref(model.prefix, model.siteId, [{ kind: 'WORKSHOP', id: at.line.id }], at.cell.from)} target="_blank" rel="noreferrer">
                <ChartGantt size={13} aria-hidden /> {capacityWords.t('cell.board')}
              </a>
            </Button>
          ) : null}
        </>
      }
    >
      {at ? (
        <div className="fw-pc-detail">
          <LoadBar size="md" label={title} labelVisible={false} booked={Number(at.cell.booked)} available={at.cell.available === null ? undefined : Number(at.cell.available)} words={at.line.unit === 'PIECES' ? pieceWords : kit.load} locale={INTL_LOCALE[locale]} />
          <section aria-labelledby="fw-pch-how">
            <h3 id="fw-pch-how" className="fw-pc-text">
              <b>{t('cp.how.titleShort')}</b>
            </h3>
            <ul className="fw-pc-list">
              {workshopHowWords(at.line, at.cell, words).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
          {loaded.status === 'ready' ? <JobsTable jobs={loaded.value} model={model} words={words} unit={at.line.unit ?? 'PIECES'} /> : null}
          <p className="fw-pc-hint">{t('cp.detail.noPerson')}</p>
        </div>
      ) : null}
    </DetailModal>
  )
}

const bucketTitle = (bucket: { key: string; kind: string; from: string; to: string }, words: CapacityWords): string => {
  if (bucket.kind === 'DAY') return dayWords(bucket.from, words.locale, true)
  const week = /W(\d{2})$/.exec(bucket.key)?.[1]
  return bucket.kind === 'WEEK' ? words.t('bucket.week', { week: week ? String(Number(week)) : '—', range: rangeWords(bucket.from, bucket.to, words.locale) }) : rangeWords(bucket.from, bucket.to, words.locale)
}

/** A heatmap cell (`?heat=`): the same DetailModal as the table's (design "Click a cell = the same DetailModal"). */
export function HeatCellDetail({ model, actions, words, capacityWords }: { model: CapacityModel; actions?: CapacityActions; words: Words; capacityWords: CapacityWords }) {
  const { t, locale } = words
  const kit = useBoardWords()
  const heat = model.heatmap?.status === 'ready' ? model.heatmap.value : null
  const key = model.controls.heat!
  const at = heat ? heatCellAt(heat, key) : null
  const order = heat ? heatOrder(heat) : []
  const index = order.indexOf(key)
  const prev = index > 0 ? order[index - 1]! : null
  const next = index >= 0 && index < order.length - 1 ? order[index + 1]! : null
  const open = (target: string) => actions?.onHeat?.(target)
  useWalk(prev, next, open)
  const loaded = model.heatCell?.key === key ? model.heatCell.detail : ({ status: 'loading' } as const)
  const week = at && heat ? heat.weeks.find((entry) => entry.key === at.cell.key) : null
  const title = at && week ? capacityWords.t('cell.title', { lane: at.lane.name, bucket: heatWeekLabel(week, capacityWords) }) : capacityWords.t('cell.gone')
  const pieceWords = { ...kit.load, ...pieceLoadWords(t) }
  const workshop = at?.lane.kind === 'WORKSHOP' ? parseWorkshopKey(key) : null
  return (
    <DetailModal
      open
      onClose={() => actions?.onHeat?.(null)}
      title={title}
      subtitle={at ? t('cp.detail.days', { from: dayWords(at.cell.from, locale, true), to: dayWords(at.cell.to, locale, true) }) : undefined}
      meta={at ? <Tag tone="neutral">{at.lane.kind === 'WORKSHOP' ? t('cp.kind.WORKSHOP') : t(`cp.kind.${at.lane.kind}`)}</Tag> : undefined}
      loading={at !== null && loaded.status === 'loading'}
      error={!at ? (model.heatmap?.status === 'loading' ? undefined : capacityWords.t('error.gone')) : loaded.status === 'error' ? capacityWords.t(loaded.problem) : undefined}
      onRetry={() => actions?.onRetryHeatCell?.()}
      actions={
        <>
          <WalkButtons prev={prev} next={next} open={open} words={capacityWords} />
          {at ? (
            <Button size="sm" variant="primary" asChild>
              <a href={boardHref(model.prefix, model.siteId, [{ kind: at.lane.kind, id: at.lane.id }], at.cell.from)} target="_blank" rel="noreferrer">
                <ChartGantt size={13} aria-hidden /> {capacityWords.t('cell.board')}
              </a>
            </Button>
          ) : null}
        </>
      }
    >
      {at ? (
        <div className="fw-pc-detail">
          <LoadBar size="md" label={title} labelVisible={false} booked={Number(at.cell.booked)} available={at.cell.available === null ? undefined : Number(at.cell.available)} words={at.lane.unit === 'PIECES' ? pieceWords : kit.load} locale={INTL_LOCALE[locale]} />
          <p className="fw-pc-text">{t('cp.detail.band', { band: t(`cp.band.${at.cell.band}`), pct: heatText(at.cell, locale) })}</p>
          {workshop && loaded.status === 'ready' && loaded.value.kind === 'workshop' ? (
            <>
              {kindOfTag(workshop.tag) !== null ? <p className="fw-pc-hint">{t('cp.detail.kindOnly', { kind: kindWords(kindOfTag(workshop.tag), words) })}</p> : null}
              <JobsTable jobs={loaded.value.jobs} model={model} words={words} unit={at.lane.unit ?? 'PIECES'} />
            </>
          ) : null}
          {loaded.status === 'ready' && loaded.value.kind === 'lane' ? <OrdersTable orders={loaded.value.orders} model={model} words={capacityWords} /> : null}
          <p className="fw-pc-hint">{t('cp.detail.noPerson')}</p>
        </div>
      ) : null}
    </DetailModal>
  )
}

/** A lane's orders in a heatmap week, as the table's cell says them (B-W2a-70's columns). */
function OrdersTable({ orders, model, words }: { orders: CellOrders; model: CapacityModel; words: CapacityWords }) {
  const { t, locale } = words
  const timeZone = model.capacity.status === 'ready' ? model.capacity.value.site.timeZone : undefined
  if (orders.orders.length === 0) return <p className="fw-pc-hint">{t('cell.noOrders')}</p>
  return (
    <SummaryTable
      label={t('cell.orders')}
      density="compact"
      stackOnPhone
      columns={[t('cell.col.workOrder'), t('cell.col.operation'), t('cell.col.pieces'), t('cell.col.minutes'), t('cell.col.share'), t('cell.col.placed')]}
      align={['left', 'left', 'right', 'right', 'right', 'left']}
      rows={orders.orders.map((entry) => ({
        id: `${entry.workOrder.id}-${entry.operation.id}`,
        cells: [
          <span key="wo" className="fw-pc-cell">
            <Link className="fw-pc-link" href={`${model.prefix}/production/work-orders/${encodeURIComponent(entry.workOrder.id)}`}>
              {entry.workOrder.number}
            </Link>
            <span className="fw-pc-cell-sub">
              {entry.workOrder.style.code} {entry.workOrder.style.name}
            </span>
          </span>,
          `${entry.operation.seq} · ${entry.operation.code} ${entry.operation.name}`,
          String(entry.pieces),
          t('cell.minutes', { minutes: minutesText(entry.minutes, locale) }),
          `${minutesText(entry.sharePct, locale)}%`,
          entry.placedBy === 'SLOT' && entry.slot ? t('cell.placedSlot', { time: formatDateTime(entry.slot.startAt, { locale, timeZone }) }) : entry.workOrder.dueDate ? t('cell.placedDue', { date: dayWords(entry.workOrder.dueDate, locale) }) : t('cell.placedDueNone'),
        ],
      }))}
    />
  )
}

