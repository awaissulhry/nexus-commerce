'use client'

import { Bookmark, Check, CircleSlash, MapPin, PackageCheck, Replace, Route } from 'lucide-react'
import { FloorList, FloorListRow, type FloorTone } from '@nexus/ui/floor'
import type { Translate } from '../../../../../lib/i18n/messages'
import { ListFooter, TaskLine, Ticks } from '../../../shared/view/TaskParts'
import { codeOfStop, nextStop, stopHeld, stopKey, walkSummary, type PickedLast, type Walk, type WalkStop } from '../model'

/**
 * B-W2b-310 — the pick list by bin on Pick & issue (SCR-093's W2b part; design floor.pick sec:need "W2b pick list (SCM-212): sorted
 * by bin path, reservations, scan each pick"; review route SCR-384): one walk through the store for the work order — its stops in
 * the order of the site's bins, each with its turn, its place, what to take there (the reserved lot or hide first, an approved
 * substitute, then the proposed stock) and how much; the next stop marked; a stop that may not be taken now says why (a blocked
 * place, a lot on hold or not released). The scan of what is taken at a stop IS the issue (Pick.tsx). No money, no person.
 */

export interface BinWalkModel {
  readonly walk: Walk
  /** Stops this tablet took that the office has not read back yet (kept offline, or just sent). */
  readonly taken: ReadonlySet<string>
}

const SOURCE_ICON = { RESERVED: <Bookmark />, SUBSTITUTE: <Replace />, PROPOSED: <MapPin /> } as const

export function BinWalk({ model, t, shared, amount }: { model: BinWalkModel; t: Translate; shared: Translate; amount: (value: number | string, uom: string) => string }) {
  const { walk, taken } = model
  const next = nextStop(walk, taken)
  const summary = walkSummary(walk, taken)
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-pick-walk">
      <h2 id="fw-pick-walk" className="fw-floor-subtitle">
        {t('walk.title')}
      </h2>
      {walk.stops.length === 0 ? (
        <p className="fw-floor-muted">{t('walk.empty')}</p>
      ) : (
        <>
          <TaskLine tone="info" icon={<Route />}>
            {summary.stops === 0 ? t('walk.allTaken') : t('walk.summary', { count: summary.places, first: summary.first ?? '' })}
            {walk.kit.location ? ` · ${t('walk.kitAt', { place: walk.kit.location.code })}` : ''}
          </TaskLine>
          <FloorList label={t('walk.title')}>
            {walk.stops.map((stop) => (
              <StopRow key={`${stop.turn}:${stopKey(stop)}`} stop={stop} next={next !== null && stopKey(next) === stopKey(stop)} taken={taken.has(stopKey(stop))} t={t} amount={amount} />
            ))}
          </FloorList>
          <ListFooter
            count={t('walk.count', { count: walk.stops.length })}
            keys={[
              { key: 'Tab', does: shared('keys.tab') },
              { key: 'Enter', does: t('keys.done') },
              { key: 'Esc', does: shared('keys.escape') },
            ]}
          />
        </>
      )}
    </section>
  )
}

function StopRow({ stop, next, taken, t, amount }: { stop: WalkStop; next: boolean; taken: boolean; t: Translate; amount: (value: number | string, uom: string) => string }) {
  const held = stopHeld(stop)
  const code = codeOfStop(stop)
  const tone: FloorTone = taken ? 'success' : held ? 'warning' : next ? 'primary' : 'neutral'
  const meta = [
    stop.colourCode ? `${stop.itemName} · ${stop.colourCode}` : stop.itemName,
    code !== stop.itemCode ? code : null,
    t(`walk.source.${stop.source}`),
    stop.location.path.length > 1 ? stop.location.path.join(' › ') : null,
    held ? t(`walk.held.${held}`) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <FloorListRow
      icon={taken ? <Check /> : held ? <CircleSlash /> : SOURCE_ICON[stop.source]}
      tone={tone}
      title={<span className="fw-floor-code">{t('walk.stopTitle', { turn: stop.turn, place: stop.location.code })}</span>}
      meta={meta}
      status={taken ? t('walk.taken') : held ? t('walk.notNow') : next ? t('walk.next') : t('walk.scanIt', { code })}
      count={amount(stop.quantity, stop.baseUom)}
      countLabel={t('walk.toTake')}
    />
  )
}

/** The last stop taken: what, from where, and where it stands (two ticks). */
export function PickedLine({ last, t, amount }: { last: PickedLast; t: Translate; amount: (value: number | string, uom: string) => string }) {
  return (
    <div className="fw-pick-result" role="status">
      <TaskLine tone={last.ticks === 'refused' ? 'danger' : 'success'} icon={last.ticks === 'refused' ? <CircleSlash /> : <PackageCheck />}>
        {last.ticks === 'refused'
          ? t('walk.last.refused', { code: last.code, place: last.place })
          : last.quantity
            ? t(last.substitute ? 'walk.last.substitute' : 'walk.last.taken', { code: last.code, place: last.place, quantity: amount(last.quantity, last.uom) })
            : t(last.substitute ? 'walk.last.substituteWhole' : 'walk.last.takenWhole', { code: last.code, place: last.place })}
      </TaskLine>
      <Ticks state={last.ticks} />
    </div>
  )
}
