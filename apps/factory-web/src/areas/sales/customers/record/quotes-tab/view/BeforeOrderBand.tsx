'use client'

import Link from 'next/link'
import { X } from 'lucide-react'
import { GROUP_WAITS_ON, type BeforeOrderGroup } from '@nexus/factory-domain/sales/before-order/groups'
import { Button, InfoTip } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { CustomerBand } from '../../band/CustomerBand' // F-CQ-B: the customer page's ONE band part
import type { BandTile } from '../../band/customer-band'
import type { Band, BandDoor, Door } from '../band'
import '../quotes-tab.css'

/** F-CQ-101: the tab's own words (messages/<locale>/before-order.json). */
export const BEFORE_ORDER_NS = 'before-order'

/** The head's short New words (10-design §2.1, settles C26, C31): below 800 px of band room in every language, below 1150 in Italian. */
export const SHORT_NEW_BELOW = Object.freeze({ every: 800, it: 1150 })

export interface BeforeOrderBandModel {
  /** The customer's one name on the page (P0-B9). */
  readonly customer: string
  /** null while the counts are read (or when they failed: `failed`). */
  readonly band: Band | null
  readonly failed: boolean
  /** The door the lists show, its count (the band's own number). */
  readonly door: Door | null
  readonly doorCount: number | null
  /** The address without a door (✕, "Show everything"). */
  readonly everything: string
  /** Products › Samples narrowed to the customer (Overview's door), when the line shows. */
  readonly samplesHref: string | null
  /** The band's own room in px (null until measured: the full New words). */
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
  /** F-CQ-B: a door pressed — the host writes ONE replace to its address (the open door's: everything again), the scroll kept. */
  onDoor?: (door: Door) => void
}

/**
 * F-CQ-101 (customer page › Quotes & incoming, 10-design §2; settles C25, C26, C31): the band "Before an order · <customer>" — the
 * head row (the title, New request / New quote for <customer>… by right), the live groups in life order as equal doors (the two that
 * wait on us carry the warning dot when > 0, said in words in the tip), the closed three apart and quiet ("Closed:"), the ⓘ; the
 * sample rounds' door; the open door's line (its group, its count, why it holds what it holds, "Show everything", ✕).
 *
 * F-CQ-B (band consistency, Owner 2026-11-23; band/plan.md B1–B11): drawn by the customer page's ONE band part (CustomerBand) with
 * the design system's own parts, as Sales › Orders draws its tiles: the live groups as compact filter tiles (a press: the host's ONE
 * replace, the scroll kept; pressed again: everything), the closed three as quiet FilterChips; on a phone the groups fold into one
 * button that opens them as a centred list (no 2-column grid any more). It fetches nothing.
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
  const short = room !== null && (room < SHORT_NEW_BELOW.every || (locale === 'it' && room < SHORT_NEW_BELOW.it))
  const label = (group: Door) => b(`group.${group}`, { customer })
  const who = (group: BeforeOrderGroup): string | null => {
    const on = GROUP_WAITS_ON[group]
    return on === 'US' ? b('band.who.us') : on === 'CUSTOMER' ? b('band.who.customer', { customer }) : on === 'APPROVER' ? b('band.who.approver') : null
  }
  // Each door a design-system tile (or, closed, a quiet chip): its number with the pin class, its tip in words (who it waits on).
  const tileOf = (door: BandDoor): BandTile => {
    const words = label(door.group)
    const waits = who(door.group)
    const tip = waits ? b('band.segTitle', { count: door.count, group: words, who: waits }) : b('band.segTitleClosed', { count: door.count, group: words })
    return {
      id: door.group,
      label: words,
      count: door.count,
      value: <span className="fw-bo-count">{door.count}</span>,
      title: door.active ? b('door.showAll', { count: band?.total ?? 0 }) : tip,
      note: b(`door.why.${door.group}`),
      door: true,
      pressed: door.active,
      ours: door.ours,
    }
  }
  const title = `${b('band.title')} · ${customer}`
  const head = (
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
  )
  const samples =
    model.samplesHref && band && band.samples !== null ? (
      <Link className="fw-cb-link" href={model.samplesHref}>
        {b('band.samples', { count: band.samples })}
      </Link>
    ) : null
  // B8: the open door — one quiet status line "<group> · N — <why> · Show everything (N)" and its ✕.
  const status = model.door ? (
    <>
      <span className="fw-bo-doorname">
        {label(model.door)}
        {model.doorCount !== null ? ` · ${model.doorCount}` : ''}
      </span>
      <span>— {b(`door.why.${model.door}`)}</span>
      <Link href={model.everything} replace scroll={false} className="fw-cb-link">
        {b('door.showAll', { count: band?.total ?? 0 })}
      </Link>
      <Link
        href={model.everything}
        replace
        scroll={false}
        className="fw-bo-doorclose"
        aria-label={b('door.close', { group: label(model.door) })}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || !actions?.onCloseDoor) return
          event.preventDefault()
          actions.onCloseDoor()
        }}
      >
        <X size={12} aria-hidden />
      </Link>
    </>
  ) : null
  // The open door that is no group of the band (Open quotes: the Work line's door): the phone's button says it with its number.
  const everything =
    model.door && band && ![...band.live, ...band.closed].some((door) => door.group === model.door)
      ? { label: label(model.door), value: <span className="fw-bo-count">{model.doorCount ?? '—'}</span> }
      : { label: b('band.everything'), value: <span className="fw-bo-count">{band?.total ?? '—'}</span> }
  const failed = (
    <>
      {b('band.failed')}{' '}
      <Button size="sm" variant="quiet" onClick={() => actions?.onRetry?.()}>
        {b('band.retry')}
      </Button>
    </>
  )
  return (
    <CustomerBand
      model={{
        label: title,
        head,
        groupsLabel: b('band.pipeline'),
        groups: band ? band.live.map(tileOf) : [],
        state: band ? 'ready' : model.failed ? 'failed' : 'reading',
        failed,
        closed: { word: b('band.closed'), groups: band ? band.closed.map(tileOf) : [] },
        notes: samples,
        status,
        info: { tip: <InfoTip tip={b('band.info')} /> },
        everything,
        window: {
          title,
          notes: (
            <>
              <p>{b('band.info')}</p>
              {samples && <p>{samples}</p>}
            </>
          ),
        },
      }}
      actions={{ onGroup: (id) => actions?.onDoor?.(id as Door) }}
    />
  )
}
