'use client'

import Link from 'next/link'
import { X } from 'lucide-react'
import { GROUP_WAITS_ON, type BeforeOrderGroup } from '@nexus/factory-domain/sales/before-order/groups'
import { Button, InfoTip, Skeleton, Tag } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { Band, BandDoor, Door } from '../band'
import '../quotes-tab.css'

/** F-CQ-101: the tab's own words (messages/<locale>/before-order.json). */
export const BEFORE_ORDER_NS = 'before-order'

/** The band's room edges (10-design §2.1, settles C26, C31): the closed three on line 1 from 1150 px; short New words below it in Italian, below 800 in every language; a 2-column grid of doors below 600. */
export const BAND_EDGES = Object.freeze({ closedOnLine1: 1150, shortWords: 800, grid: 600 })

export interface BeforeOrderBandModel {
  /** The customer's one name on the page (P0-B9). */
  readonly customer: string
  /** null while the counts are read (or when they failed: `failed`). */
  readonly band: Band | null
  readonly failed: boolean
  /** The door the lists show, its count (the band's own number). */
  readonly door: Door | null
  readonly doorCount: number | null
  /** Each door's address (the open one's: everything again) and the address without a door. */
  readonly hrefs: Readonly<Record<Door, string>>
  readonly everything: string
  /** Products › Samples narrowed to the customer (Overview's door), when the line shows. */
  readonly samplesHref: string | null
  /** The band's own room in px (null until measured: the full words, the closed three on line 1). */
  readonly room: number | null
  /** The head's New buttons, each only with its right (and not for a customer with nothing yet: the empty card holds them). */
  readonly newRequest: boolean
  readonly newQuote: boolean
}

export interface BeforeOrderBandActions {
  onNewRequest?: () => void
  onNewQuote?: () => void
  onCloseDoor?: () => void
  onRetry?: () => void
}

/**
 * F-CQ-101 (customer page › Quotes & incoming, 10-design §2; settles C25, C26, C31): the band "Before an order · <customer>" — the
 * head row (the title, New request / New quote for <customer>… by right), line 1 the live groups in life order as equal doors with ›
 * between them (the two that wait on us in an amber pill when > 0, said in words on hover too), the closed three apart and quiet (on
 * line 1 from 1150 px of band room, else on line 2 after "Closed:"), the ⓘ; line 2 only when it holds something (the sample rounds'
 * door); under it the open door's chip (its group, its count, why it holds what it holds, ✕ and "Show everything"). Each door is a
 * real link (⌘-click: a new tab). It fetches nothing.
 */
export function BeforeOrderBand({ model, actions }: { model: BeforeOrderBandModel; actions?: BeforeOrderBandActions }) {
  return (
    <WithMessages namespaces={[BEFORE_ORDER_NS]}>
      <BandView model={model} actions={actions} />
    </WithMessages>
  )
}

function BandView({ model, actions }: { model: BeforeOrderBandModel; actions?: BeforeOrderBandActions }) {
  const b = useT(BEFORE_ORDER_NS)
  const locale = useLocale()
  const { band, room, customer } = model
  const wide = room === null || room >= BAND_EDGES.closedOnLine1
  const short = room !== null && (room < BAND_EDGES.shortWords || (locale === 'it' && room < BAND_EDGES.closedOnLine1))
  const grid = room !== null && room < BAND_EDGES.grid
  const label = (group: Door) => b(`group.${group}`, { customer })
  const who = (group: BeforeOrderGroup): string | null => {
    const on = GROUP_WAITS_ON[group]
    return on === 'US' ? b('band.who.us') : on === 'CUSTOMER' ? b('band.who.customer', { customer }) : on === 'APPROVER' ? b('band.who.approver') : null
  }
  const doorLink = (door: BandDoor, quiet: boolean) => {
    const words = label(door.group)
    const waits = who(door.group)
    const tip = waits ? b('band.segTitle', { count: door.count, group: words, who: waits }) : b('band.segTitleClosed', { count: door.count, group: words })
    return (
      <Link
        href={model.hrefs[door.group]}
        // A door of this tab replaces the address (Back leaves the page); F-CQ-205: the drafts' door too (their section is here).
        replace
        scroll={false}
        className={`fw-bo-door${quiet ? ' is-closed' : ''}${door.active ? ' is-active' : ''}${door.count === 0 ? ' is-zero' : ''}`}
        aria-current={door.active ? 'true' : undefined}
        title={door.active ? b('door.showAll', { count: band?.total ?? 0 }) : tip}
        aria-label={`${door.count} ${words}${waits ? ` · ${b('band.waitsOn', { who: waits })}` : ''}`}
      >
        <span className="fw-bo-count">{door.ours && door.count > 0 ? <Tag tone="warning">{door.count}</Tag> : door.count}</span>
        <span className="fw-bo-label">{words}</span>
      </Link>
    )
  }
  const closed = band && band.closed.length > 0 ? (
    <span className="fw-bo-closedset">
      <span className="fw-bo-closedword">{b('band.closed')}</span>
      {band.closed.map((door) => (
        <span key={door.group}>{doorLink(door, true)}</span>
      ))}
      <InfoTip tip={b('band.info')} />
    </span>
  ) : null
  const title = `${b('band.title')} · ${customer}`
  return (
    <section className={`fw-bo${grid ? ' is-grid' : ''}`} aria-label={title}>
      <div className="fw-bo-head">
        <h3 className="fw-bo-title">{title}</h3>
        {(model.newRequest || model.newQuote) && (
          <span className="fw-bo-actions">
            {model.newRequest && (
              <Button size="sm" onClick={() => actions?.onNewRequest?.()} title={short ? b('band.newRequest', { customer }) : undefined}>
                {short ? b('band.newRequestShort') : b('band.newRequest', { customer })}
              </Button>
            )}
            {model.newQuote && (
              <Button size="sm" variant="primary" onClick={() => actions?.onNewQuote?.()} title={short ? b('band.newQuote', { customer }) : undefined} aria-keyshortcuts="c">
                {short ? b('band.newQuoteShort') : b('band.newQuote', { customer })}
              </Button>
            )}
          </span>
        )}
      </div>
      {band === null ? (
        model.failed ? (
          <p className="fw-bo-quiet" role="status">
            {b('band.failed')}{' '}
            <Button size="sm" variant="quiet" onClick={() => actions?.onRetry?.()}>
              {b('band.retry')}
            </Button>
          </p>
        ) : (
          <Skeleton height={44} />
        )
      ) : (
        <>
          <ol className="fw-bo-line" aria-label={b('band.pipeline')}>
            {band.live.map((door, index) => (
              <li key={door.group} className="fw-bo-step">
                {index > 0 && (
                  <span className="fw-bo-sep" aria-hidden>
                    ›
                  </span>
                )}
                {doorLink(door, false)}
              </li>
            ))}
            {wide && closed && <li className="fw-bo-step is-apart">{closed}</li>}
          </ol>
          {(model.samplesHref || (!wide && closed)) && (
            <div className="fw-bo-line2">
              {model.samplesHref && band.samples !== null && (
                <Link className="fw-bo-quietdoor" href={model.samplesHref}>
                  {b('band.samples', { count: band.samples })}
                </Link>
              )}
              {!wide && closed}
            </div>
          )}
        </>
      )}
      {model.door && (
        <div className="fw-bo-doorchip" role="status">
          <span className="fw-bo-doorname">
            {label(model.door)}
            {model.doorCount !== null ? ` · ${model.doorCount}` : ''}
          </span>
          <Link href={model.everything} replace scroll={false} className="fw-bo-doorclose" aria-label={b('door.close', { group: label(model.door) })} onClick={(event) => {
            if (event.metaKey || event.ctrlKey || !actions?.onCloseDoor) return
            event.preventDefault()
            actions.onCloseDoor()
          }}>
            <X size={12} aria-hidden />
          </Link>
          <span className="fw-bo-why">{b(`door.why.${model.door}`)}</span>
          <Link href={model.everything} replace scroll={false} className="fw-bo-quietdoor">
            {b('door.showAll', { count: band?.total ?? 0 })}
          </Link>
        </div>
      )}
    </section>
  )
}
