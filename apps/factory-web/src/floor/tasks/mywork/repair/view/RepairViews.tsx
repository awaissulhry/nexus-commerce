'use client'

import { useRef, type KeyboardEvent } from 'react'
import { CircleCheckBig, Clock, CloudOff, PauseCircle, ScanLine, Wrench } from 'lucide-react'
import { FloorButton, FloorList, FloorListRow, QuantityPad } from '@nexus/ui/floor'
import { FloorCard } from '@nexus/ui/floor/FloorCard/index'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime, formatNumber, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Translate } from '../../../../../lib/i18n/messages'
import { FloorState } from '../../../../frame/view/FloorState'
import { ListFooter, TaskLine, Ticks, type TickState } from '../../../shared/view/TaskParts'
import { KNOWN_REPAIR_REFUSALS, outCounts, reasonWords, repairHeld, type RepairQueue, type RepairRow } from '../model'

/**
 * My work's repair queue (B-W2b-126; MES-132; design floor.mywork "Variants: … repair queue (W2b, MES-132)", "Confirm by scan,
 * not by reading (MES-188)"). The list: this station's bundles in repair, then its waiting ones, then the site's — the bundle,
 * the work order, the operation it goes back to, why, since when, and how many garments; a row opens its card. The card: what
 * to redo, and "scan the bundle" to scan it in (the rework starts) or out (how did it come out: all good in one tap, or the
 * good ones typed, the rest scrapped). Repair minutes are the rework's, kept in the office, never a person's: the floor shows
 * the time of the scan in, never a duration or a pace (F2). Offline: the queue as of when, and a scan waits on this tablet.
 */

export interface RepairLineModel {
  readonly code: string
  readonly step: 'IN' | 'OUT'
  readonly good?: number
  readonly scrap?: number
  readonly ticks: TickState
  /** The refusal's code, when the office refused it. */
  readonly refusal?: string | null
  /** The office's words, when the code is not one this screen knows. */
  readonly words?: string | null
}

const STATE_ICON = { WAITING: <Clock />, IN_REPAIR: <Wrench /> } as const

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

/** "Waiting", "In repair", "On hold": a state, never a duration (no pace on the floor, F2). */
function stateWord(t: Translate, row: RepairRow): string {
  if (row.held) return t('repair.state.held')
  return t(`repair.state.${row.state}`)
}

/** The rows of the queue (design FloorList rows: icon by kind, title, meta, status word, big number). */
export function RepairList({ queue, asOf, onOpen, timeZone }: { queue: RepairQueue; asOf: string | null; onOpen: (reworkId: string) => void; timeZone?: string }) {
  const t = useT('floor-mywork')
  const shared = useT('floor-tasks')
  const locale = useLocale()
  const { group, onKeyDown } = useRowKeys()
  const time = (value: string) => formatTime(value, { locale, timeZone })
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-mywork-repair">
      <h2 id="fw-mywork-repair" className="fw-floor-section-title">
        {t('repair.title')}
      </h2>
      <p className="fw-mywork-status fw-floor-muted">
        {[queue.station ? t('status.station', { station: queue.station.name }) : t('repair.noStation'), t('status.asOf', { time: time(asOf ?? queue.asOf) })].join(' · ')}
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
        <FloorState tone="success" icon={<CircleCheckBig />} title={t('repair.none.title')} text={t('repair.none.body')} />
      ) : (
        <>
          <div ref={group} onKeyDown={onKeyDown}>
            <FloorList label={t('repair.title')}>
              {queue.rows.map((row) => (
                <FloorListRow
                  key={row.reworkId}
                  icon={row.held ? <PauseCircle /> : STATE_ICON[row.state]}
                  tone={row.held ? 'danger' : row.state === 'IN_REPAIR' ? 'primary' : 'neutral'}
                  title={
                    <span>
                      {row.here ? (
                        <span className="fw-floor-pill fw-mywork-rush" data-tone="info">
                          {t('repair.here')}
                        </span>
                      ) : null}
                      <span className="fw-floor-code">{row.bundle?.code ?? row.workOrder.number}</span>
                      {row.bundle ? <> · {row.workOrder.number}</> : null}
                    </span>
                  }
                  meta={[
                    t('op', { seq: row.reworkAt.seq, name: row.reworkAt.name }),
                    reasonWords(row, locale),
                    row.state === 'IN_REPAIR' && row.inAt ? t('repair.inAt', { station: row.station?.code ?? '', time: time(row.inAt) }) : t('repair.since', { time: formatDateTime(row.since, { locale, timeZone }) }),
                  ].join(' · ')}
                  status={stateWord(t, row)}
                  count={formatNumber(row.quantity, locale)}
                  countLabel={t('repair.garments', { count: row.quantity })}
                  onPress={() => onOpen(row.reworkId)}
                />
              ))}
            </FloorList>
          </div>
          <ListFooter
            count={t('repair.count', { count: queue.rows.length })}
            keys={[
              { key: '↑ ↓', does: t('keys.repair') },
              { key: 'Enter', does: t('keys.openRepair') },
              { key: 'Esc', does: shared('keys.escape') },
            ]}
          />
        </>
      )}
    </section>
  )
}

/** One repair, big: what to redo, and the scan that starts or ends it. */
export function RepairCard({ row, asOf, timeZone, onStartWithout }: { row: RepairRow; asOf: string | null; timeZone?: string; onStartWithout?: () => void }) {
  const t = useT('floor-mywork')
  const ds = useDsWords()
  const locale = useLocale()
  const held = repairHeld(row)
  const day = (value: string) => formatDate(`${value}T12:00:00.000Z`, { locale, timeZone: 'UTC' })
  return (
    <FloorCard
      icon={<Wrench />}
      kind={t('repair.kind')}
      code={row.bundle?.code ?? row.workOrder.number}
      id="fw-mywork-repair-card"
      headingLevel={3}
      title={
        <>
          <p className="fw-mywork-style">
            <span className="fw-floor-code">{row.workOrder.number}</span> · {row.workOrder.style.name} · {row.cell.colourwayCode} {row.cell.size}
            {row.bundle?.part ? ` · ${row.bundle.part}` : ''}
          </p>
          <p className="fw-mywork-op">{t('op', { seq: row.reworkAt.seq, name: row.reworkAt.name })}</p>
        </>
      }
      status={{ label: stateWord(t, row), tone: row.held ? 'danger' : row.state === 'IN_REPAIR' ? 'primary' : 'info' }}
      facts={[
        { id: 'garments', label: t('repair.garments', { count: row.quantity }), value: formatNumber(row.quantity, locale) },
        { id: 'reason', label: t('repair.fact.reason'), value: reasonWords(row, locale) },
        { id: 'found', label: t('repair.fact.found'), value: row.foundAt ? t('op', { seq: row.foundAt.seq, name: row.foundAt.name }) : t('repair.fact.foundOutside') },
        { id: 'since', label: t('repair.fact.since'), value: formatDateTime(row.since, { locale, timeZone }) },
        { id: 'due', label: t('fact.due'), value: row.workOrder.dueDate ? day(row.workOrder.dueDate) : null },
        { id: 'station', label: t('repair.fact.station'), value: row.station && row.inAt ? t('repair.inAt', { station: row.station.code, time: formatTime(row.inAt, { locale, timeZone }) }) : null },
      ]}
      flags={[
        ...(row.workOrder.rush ? [{ id: 'rush', label: t('rush'), tone: 'danger' as const }] : []),
        ...(row.held ? [{ id: 'hold', label: row.workOrder.holdReason ? t('onHoldWhy', { reason: row.workOrder.holdReason }) : t('repair.state.held'), tone: 'danger' as const }] : []),
      ]}
      asOf={asOf}
      formatTime={(value) => formatTime(value, { locale, timeZone })}
      labels={ds.floorCard}
    >
      <div className="fw-floor-stack">
        {row.description ? <p className="fw-mywork-text">{row.description}</p> : null}
        {held ? (
          <TaskLine tone="warning" icon={<PauseCircle />} alert>
            {t(`repair.held.${held}`)}
          </TaskLine>
        ) : row.bundle ? (
          <TaskLine tone="info" icon={<ScanLine />}>
            {row.state === 'WAITING' ? t('repair.scanIn', { code: row.bundle.code }) : t('repair.scanOut', { code: row.bundle.code })}
          </TaskLine>
        ) : (
          <>
            <TaskLine tone="info" icon={<Wrench />}>
              {row.state === 'WAITING' ? t('repair.noBundleIn') : t('repair.noBundleOut')}
            </TaskLine>
            {onStartWithout ? (
              <FloorButton size="lg" variant="primary" icon={<Wrench />} onClick={onStartWithout}>
                {row.state === 'WAITING' ? t('repair.startWithout') : t('repair.doneWithout')}
              </FloorButton>
            ) : null}
          </>
        )}
      </div>
    </FloorCard>
  )
}

/** The scan out: how did it come out? All good in one tap, or the good ones typed (the rest are scrapped). */
export function RepairOut({ row, good, onGood, onAllGood, onConfirm, heldReason }: { row: RepairRow; good: number | null; onGood: (value: number | null) => void; onAllGood: () => void; onConfirm: () => void; heldReason: string | null }) {
  const t = useT('floor-mywork')
  const locale = useLocale()
  // The confirm says what will be sent only once a number is typed (the one tap for all good is the big button above).
  const counts = good === null ? null : outCounts(row, good)
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-mywork-repair-out">
      <h2 id="fw-mywork-repair-out" className="fw-floor-section-title">
        {t('repair.out.title', { code: row.bundle?.code ?? row.workOrder.number })}
      </h2>
      <FloorButton size="lg" block variant="primary" icon={<CircleCheckBig />} heldReason={heldReason} onClick={onAllGood} autoFocus>
        {t('repair.out.allGood', { count: row.quantity })}
      </FloorButton>
      <QuantityPad
        label={t('repair.out.good')}
        value={good}
        onChange={onGood}
        min={0}
        max={row.quantity}
        expected={row.quantity}
        expectedLabel={(count) => t('repair.out.of', { count })}
        decimalSeparator={locale === 'it' ? ',' : '.'}
        decrementLabel={t('pad.less')}
        incrementLabel={t('pad.more')}
        clearLabel={t('pad.clear')}
        backLabel={t('pad.back')}
        emptyLabel={t('pad.empty')}
        rangeLabel={(min, max) => t('pad.range', { min: min ?? 0, max: max ?? row.quantity })}
        onConfirm={onConfirm}
        confirmLabel={counts ? t('repair.out.confirm', { good: counts.good, scrap: counts.scrap }) : t('repair.out.confirmEmpty')}
        confirmHeldReason={heldReason ?? (counts ? null : t('pad.range', { min: 0, max: row.quantity }))}
      />
      {counts && counts.scrap > 0 ? (
        <TaskLine tone="warning" icon={<Wrench />}>
          {t('repair.out.scrapSaid', { count: counts.scrap })}
        </TaskLine>
      ) : null}
    </section>
  )
}

/** What the last scan did, with the tablet's two ticks; a refusal in words. */
export function RepairLine({ line }: { line: RepairLineModel }) {
  const t = useT('floor-mywork')
  const refused = line.ticks === 'refused'
  const words = refused
    ? line.refusal && KNOWN_REPAIR_REFUSALS.has(line.refusal)
      ? t(`repair.refusal.${line.refusal}`, { code: line.code })
      : (line.words ?? t('repair.refused', { code: line.code }))
    : line.step === 'IN'
      ? t('repair.saidIn', { code: line.code })
      : t('repair.saidOut', { code: line.code, good: line.good ?? 0, scrap: line.scrap ?? 0 })
  return (
    <TaskLine tone={refused ? 'danger' : 'success'} icon={<Wrench />} alert={refused}>
      {words} <Ticks state={line.ticks} />
    </TaskLine>
  )
}

/** Nothing on this tablet and no network, or the office did not answer. */
export function RepairUnread({ problem, onRetry }: { problem: 'offline' | 'error'; onRetry: () => void }) {
  const t = useT('floor-mywork')
  const shared = useT('floor-tasks')
  return problem === 'offline' ? (
    <FloorState tone="warning" icon={<CloudOff />} title={shared('notOnTablet.title')} text={t('repair.offline')} alert />
  ) : (
    <FloorState tone="danger" icon={<Wrench />} title={t('repair.error.title')} text={t('repair.error.body')} alert>
      <FloorButton size="lg" variant="secondary" onClick={onRetry}>
        {shared('action.retry')}
      </FloorButton>
    </FloorState>
  )
}
