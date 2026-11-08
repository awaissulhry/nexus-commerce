'use client'

import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { CircleAlert, CircleCheckBig, ClipboardCheck, CloudOff, Layers, PackageCheck, RotateCcw, ScanLine, Scissors, ShieldAlert, TrafficCone, Truck } from 'lucide-react'
import { FloorButton, FloorList, FloorListRow } from '@nexus/ui/floor'
import { FloorCard } from '@nexus/ui/floor/FloorCard/index'
import { FloorListUpdates } from '@nexus/ui/floor/FloorListUpdates/index'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime, formatNumber, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { FloorState } from '../../../../frame/view/FloorState'
import { ListFooter, TaskLine } from '../../../shared/view/TaskParts'
import { rowCount, rowTone, wordsIn, type InspectorQueue, type InspectorRow, type OpenHeld } from '../model'

/**
 * My work's inspector queue (B-W2b-109; design floor.mywork "queue" variant: inspector queue, QHS-068 — blocking lots first,
 * waiting time; "A row opens its card as a step; scanning still starts the work"; "Rows never move under the finger"). The list:
 * what each inspection holds up (a first piece's run, a lot the work orders need, garments due to ship), its sample so far and how
 * long it waits, mine or nobody's yet — never another person. The card: the facts and "Inspect", which opens the bench that records
 * it (held with the reason where no floor screen does yet). Offline: the queue as of when, from this tablet.
 */

const KIND_ICON: Readonly<Record<InspectorRow['kind'], ReactNode>> = {
  FINAL: <ClipboardCheck />,
  FINAL_DUE: <PackageCheck />,
  INCOMING: <Truck />,
  FIRST_PIECE: <ShieldAlert />,
  CUTTING: <Scissors />,
  ROVING: <TrafficCone />,
  END_OF_LINE: <Layers />,
}

function useRowKeys() {
  const group = useRef<HTMLDivElement>(null)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...(group.current?.querySelectorAll<HTMLElement>('.nds-floor-row.is-pressable') ?? [])]
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1)
    event.preventDefault()
    items[next]?.focus()
  }
  return { group, onKeyDown }
}

export interface InspectionListProps {
  queue: InspectorQueue
  /** From this tablet (offline, or the office did not answer): as of when. */
  asOf: string | null
  /** A fresher queue differs: how many rows (0: not known). */
  pending: number
  changed: boolean
  onShow: () => void
  onOpen: (key: string) => void
  timeZone?: string
}

/** The rows (design FloorList rows: icon by kind, title, meta, status word, big number), what holds up most first. */
export function InspectionList({ queue, asOf, pending, changed, onShow, onOpen, timeZone }: InspectionListProps) {
  const t = useT('floor-myinspections')
  const shared = useT('floor-tasks')
  const ds = useDsWords()
  const locale = useLocale()
  const { group, onKeyDown } = useRowKeys()
  const time = (value: string) => formatTime(value, { locale, timeZone })
  /** Since when, as a time of day (a date too when not today): how long a lot waits, never a pace. */
  const when = (value: string, today: string) => (value.slice(0, 10) === today.slice(0, 10) ? time(value) : formatDateTime(value, { locale, timeZone }))
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-myinsp-title">
      <h2 id="fw-myinsp-title" className="fw-floor-section-title">
        {t('title')}
      </h2>
      <FloorListUpdates pending={changed ? Math.max(1, pending) : 0} countUnknown={!pending} onShow={onShow} labels={ds.floorListUpdates} />
      <p className="fw-mywork-status fw-floor-muted">
        {t('asOf', { time: time(asOf ?? queue.asOf) })}
        {asOf ? (
          <span className="fw-mywork-asof">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <CloudOff />
            </span>
            {t('fromTablet')}
          </span>
        ) : null}
      </p>
      {queue.rows.length === 0 ? (
        <FloorState tone="success" icon={<CircleCheckBig />} title={t('empty.title')} text={t('empty.body')} />
      ) : (
        <>
          <div ref={group} onKeyDown={onKeyDown}>
            <FloorList label={t('title')}>
              {queue.rows.map((row) => {
                const count = rowCount(row)
                return (
                  <FloorListRow
                    key={row.key}
                    icon={KIND_ICON[row.kind]}
                    tone={rowTone(row)}
                    title={
                      <span>
                        <span className="fw-floor-code">{row.number ?? row.workOrder?.number ?? row.bundle?.code ?? row.lot?.code ?? '—'}</span> · {wordsIn(row.kindWords, locale)}
                      </span>
                    }
                    meta={[
                      row.title,
                      row.progress ? wordsIn(row.progress.words, locale) : null,
                      row.dueAt ? t(row.overdue ? 'overdue' : 'due', { time: formatDateTime(row.dueAt, { locale, timeZone }) }) : row.waitingSince ? t('since', { time: when(row.waitingSince, queue.asOf) }) : null,
                      t(`taken.${row.taken}`),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    status={t(`blocks.${row.blocks.what}`)}
                    count={count ? formatNumber(count.value, locale) : undefined}
                    countLabel={count ? t(count.what === 'blocks' ? `count.${row.blocks.what}` : 'count.left', { count: count.value }) : undefined}
                    onPress={() => onOpen(row.key)}
                  />
                )
              })}
            </FloorList>
          </div>
          <ListFooter
            count={queue.capped ? `${t('count', { count: queue.rows.length })} · ${t('capped')}` : t('count', { count: queue.rows.length })}
            keys={[
              { key: '↑ ↓', does: t('keys.rows') },
              { key: 'Enter', does: t('keys.open') },
              { key: 'Esc', does: shared('keys.escape') },
            ]}
          />
        </>
      )}
    </section>
  )
}

/** One inspection's card (a row opened): what it is, what it holds up, the sample so far; "Inspect" opens its bench. */
export function InspectionCard({ row, held, asOf, onGo, timeZone }: { row: InspectorRow; held: OpenHeld; asOf: string | null; onGo: () => void; timeZone?: string }) {
  const t = useT('floor-myinspections')
  const ds = useDsWords()
  const locale = useLocale()
  return (
    <FloorCard
      icon={KIND_ICON[row.kind]}
      kind={wordsIn(row.kindWords, locale)}
      code={row.number ?? row.workOrder?.number ?? row.bundle?.code ?? row.lot?.code ?? '—'}
      title={<p className="fw-mywork-style">{row.title}</p>}
      status={{ label: t(`blocks.${row.blocks.what}`), tone: rowTone(row) }}
      facts={[
        { id: 'blocks', label: t('fact.blocks'), value: wordsIn(row.blocks.words, locale) },
        { id: 'plan', label: t('fact.plan'), value: row.plan ? t('plan', { code: row.plan.code, number: row.plan.number }) : null },
        { id: 'progress', label: t('fact.progress'), value: row.progress ? wordsIn(row.progress.words, locale) : null },
        { id: 'waiting', label: t('fact.waiting'), value: row.waitingSince ? formatDateTime(row.waitingSince, { locale, timeZone }) : null },
        { id: 'due', label: t('fact.due'), value: row.dueAt ? formatDateTime(row.dueAt, { locale, timeZone }) : null },
        { id: 'operation', label: t('fact.operation'), value: row.operation ? t('operation', { seq: row.operation.seq, name: row.operation.name }) : null },
        { id: 'taken', label: t('fact.taken'), value: t(`taken.${row.taken}`) },
      ]}
      flags={row.overdue ? [{ id: 'overdue', label: t('overdueFlag'), tone: 'danger' as const }] : []}
      asOf={asOf}
      formatTime={(value) => formatTime(value, { locale, timeZone })}
      labels={ds.floorCard}
    >
      <div className="fw-floor-stack">
        <TaskLine tone="info" icon={<ScanLine />}>
          {t('scanToStart')}
        </TaskLine>
        <FloorButton size="lg" block variant="primary" icon={<ClipboardCheck />} heldReason={held ? t(`held.${held}`) : null} onClick={onGo}>
          {row.kind === 'FINAL_DUE' ? t('start') : t('inspect')}
        </FloorButton>
      </div>
    </FloorCard>
  )
}

/** The queue could not be read and none is kept: why, and Try again. */
export function InspectionsUnread({ problem, onRetry }: { problem: 'offline' | 'error'; onRetry: () => void }) {
  const t = useT('floor-myinspections')
  const shared = useT('floor-tasks')
  return problem === 'offline' ? (
    <FloorState tone="warning" icon={<CloudOff />} title={shared('notOnTablet.title')} text={t('offline')} alert />
  ) : (
    <FloorState tone="danger" icon={<CircleAlert />} title={t('error.title')} text={t('error.body')} alert>
      <FloorButton size="lg" variant="secondary" icon={<RotateCcw />} onClick={onRetry}>
        {shared('action.retry')}
      </FloorButton>
    </FloorState>
  )
}
