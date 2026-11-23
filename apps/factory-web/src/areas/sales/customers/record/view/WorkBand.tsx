'use client'

import { Fragment } from 'react'
import Link from 'next/link'
import { formatNumber } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { OrderPhase } from '../../../orders/api'
import { NAMESPACE as SHEET_NS, phasePhrase } from '../../../orders/list/sheet/model'
import { PHASE_ICON } from '../../../orders/list/sheet/phase-icon'
import type { BeforeLinePart } from '../before-order'
import type { StripTile } from '../use-customer-work'
import type { BandChip, BandGroup, BandPicture } from '../work-band'
// F-CQ-B (band consistency, Owner 2026-11-23): the band is drawn by the customer page's ONE band part (the design system's tiles and chips).
import { CustomerBand } from '../band/CustomerBand'
import type { BandChipItem, BandTile } from '../band/customer-band'

/**
 * F-CW-101 (customer Work tab plan §1; 10-design §2; picture 20; lead settles S2, S3, S16, S24, S27, S32, S38) — the Work tab's band,
 * in the waiting strip's place.
 *
 *   groups   the bigger picture — every order of the customer in exactly one of seven groups, each a count and a door (a press shows
 *            those orders; the same press again shows all); 0 is shown as 0; Cancelled stands apart; told apart by word and place,
 *            never by colour alone
 *   notes    "All orders of <customer>: N" (the total, and the door to all) · the two whys of "Not sent to the factory" · "Before an
 *            order: …" (never added into the order numbers) · the link to the customer's work orders (moved here from the toolbar)
 *   chips    what waits — today's six facts, the same reads, doors and windows; a zero chip stays; while reading "—"; a failed read
 *            "!" and its press reads it again; a chip without its right is left out
 *
 * F-CQ-B (band consistency, Owner 2026-11-23; band/plan.md B1–B11): drawn by the customer page's ONE band part (CustomerBand) with
 * the design system's own parts, as Sales › Orders draws its tiles — the six live groups as compact filter tiles, Cancelled apart as
 * a quiet chip on the notes line, what waits as FilterChips. Same doors, same counts, same words. Sized by its own ROOM; on a phone
 * the groups fold into one button that opens them as a centred list. Draws its model and fetches nothing.
 */

export interface WorkBandModel {
  readonly customer: string
  readonly picture: BandPicture
  /** The group whose orders the sheet shows now (its door pressed); null: none. */
  readonly shown: OrderPhase | null
  readonly whys: ReadonlyArray<{ readonly why: 'yes' | 'deposit'; readonly count: number }>
  readonly before: readonly BeforeLinePart[]
  readonly chips: readonly BandChip[]
  /** The chips whose view the sheet shows now (Late, Waiting for deposit). */
  readonly pressed?: readonly StripTile[]
  /** "Work orders of <customer> ›" (workorders.view; null: not drawn). */
  readonly workOrdersHref?: string | null
  /** Replies waiting on us: their list in Sales › Incoming. */
  readonly repliesHref?: string | null
  /** Requests to answer: the page's review window on exactly those requests (null: none waits, or none could be listed). */
  readonly requestsHref?: string | null
  /** Design cases: the groups' window open. */
  readonly windowOpen?: boolean
  /** cw fx6 (re-walk R-4): the read of the groups failed: the band says so once, with the chips' own retry. */
  readonly failed?: boolean
}

export interface WorkBandActions {
  /** A group's door: its orders — or, pressed while shown, all orders again. */
  readonly onGroup?: (group: BandGroup) => void
  /** "All orders of <customer>". */
  readonly onAll?: () => void
  // F-CQ-303: "N drafts" is a link to Quotes & incoming at WRITING (the Work tab's Drafts view is gone): no drafts handler any more.
  /** Late and Waiting for deposit: their views of the sheet. */
  readonly onView?: (view: 'late' | 'deposit') => void
  /** Waiting for <customer> and Open tasks: their centred windows. */
  readonly onWindow?: (window: 'customer' | 'tasks') => void
  /** A chip whose read failed: read it again. */
  readonly onRetry?: (tile: StripTile) => void
  // F-CQ-B: Requests to answer and Replies waiting on us are chips now (buttons): the HOST navigates (the view stays pure). `keepScroll`:
  // the review window opens on this page (the scroll stays); Replies opens Sales › Incoming.
  readonly onGo?: (href: string, keepScroll: boolean) => void
}

export const WORK_BAND_NAMESPACES = ['parties', 'orders', SHEET_NS] as const

export function WorkBand(props: { model: WorkBandModel; actions?: WorkBandActions }) {
  return (
    <WithMessages namespaces={WORK_BAND_NAMESPACES}>
      <Band {...props} />
    </WithMessages>
  )
}

// F-CQ-B: the model onto the ONE band part — the groups as tiles (Cancelled apart), the notes, the six facts as chips, the window.
function Band({ model, actions }: { model: WorkBandModel; actions?: WorkBandActions }) {
  const t = useT('parties')
  const o = useT('orders')
  const s = useT(SHEET_NS)
  const locale = useLocale()
  const { customer, picture } = model
  const number = (value: number | null): string => (value === null ? '—' : formatNumber(value, locale))
  const groupWords = (phase: OrderPhase): string => {
    const words = phasePhrase(phase)
    return words.orders ? o(words.key) : s(words.key)
  }
  const all = t('customers.work.band.all', { customer })
  const whys = model.whys.map((entry) => t(`customers.work.band.why.${entry.why}`, { count: entry.count })).join(' · ')

  // The seven groups: a door only with its handler (a count of an older answer's group of two states has none: never a held door).
  const tileOf = (group: BandGroup): BandTile => {
    const label = groupWords(group.phase)
    const on = model.shown === group.phase
    const door = !!(group.door && actions?.onGroup)
    return {
      id: group.phase,
      label,
      count: group.count,
      value: <span className="fw-cwb-num">{number(group.count)}</span>,
      ...(door ? { title: t(on ? 'customers.work.band.groupOnTip' : 'customers.work.band.groupTip', { group: label }) } : {}),
      note: s(`phase.note.${group.phase}`),
      icon: PHASE_ICON[group.phase],
      door,
      pressed: on,
    }
  }
  const live = picture.groups.filter((group) => group.phase !== 'CANCELLED').map(tileOf)
  const cancelled = picture.groups.filter((group) => group.phase === 'CANCELLED').map(tileOf)
  const onGroup = (id: string) => {
    const group = picture.groups.find((each) => each.phase === id)
    if (group) actions?.onGroup?.(group)
  }

  const before = model.before.map((part, index) => {
    const words = t(`customers.work.band.before.${part.part}`, { count: part.count })
    return (
      <Fragment key={part.part}>
        {index > 0 && ' · '}
        {/* F-CQ-303 (13-backend R14): every part is a real link now — the drafts' too (Quotes & incoming at WRITING). */}
        {part.href ? (
          <Link className="fw-cb-link" href={part.href}>
            {words}
          </Link>
        ) : (
          words
        )}
      </Fragment>
    )
  })
  const beforeLine =
    model.before.length > 0 ? (
      <span>
        <b>{t('customers.work.band.before.label')}</b> {before}
      </span>
    ) : null
  const whysLine = whys ? (
    <span>
      <b>{groupWords('NOT_SENT')}:</b> {whys}
    </span>
  ) : null
  const workOrders = model.workOrdersHref ? (
    <Link className="fw-cb-link" href={model.workOrdersHref}>
      {t('customers.band.workOrders', { customer })}
    </Link>
  ) : null

  // The notes line: the total (the door to all), the whys, "Before an order", the work orders (folded away on a phone: the window says them).
  const notes = (
    <>
      <span>
        {actions?.onAll ? (
          <button type="button" className="fw-cb-link" onClick={() => actions.onAll?.()}>
            {t('customers.work.band.allCount', { customer })}
          </button>
        ) : (
          t('customers.work.band.allCount', { customer })
        )}{' '}
        <b className="fw-cwb-num">{number(picture.total)}</b>
      </span>
      {whysLine}
      {beforeLine}
      {/* F-CQ-B fx1 (walk B-07): on the line only from 1040 px of room — below it the groups' window says it (Cancelled stays on line 1). */}
      {workOrders && <span className="fw-cb-roomy">{workOrders}</span>}
    </>
  )
  // The window's lines under the groups (the ⓘ, and the phone's fold) — cw fx5 (walk W-32): the work orders' door its last line.
  const windowNotes = (
    <>
      <p>{t('customers.work.band.sum')}</p>
      {whysLine && <p>{whysLine}</p>}
      {beforeLine && <p>{beforeLine}</p>}
      <p>{t('customers.work.band.beforeNote')}</p>
      {model.workOrdersHref && (
        <p>
          <Link className="fw-cb-link" href={model.workOrdersHref}>
            {t('customers.band.workOrders', { customer })}
          </Link>
        </p>
      )}
    </>
  )
  // cw fx6 (re-walk R-4): the groups could not be read — said ONCE in the chips' own words ("Couldn't be read · Try again"); the press
  // reads the board again (the retry of the chips this same read feeds).
  const failedWords = t('customers.work.tile.failed')
  const failed = actions?.onRetry ? (
    <button type="button" className="fw-cb-link" onClick={() => actions.onRetry?.('late')}>
      {failedWords}
    </button>
  ) : (
    failedWords
  )
  const state = model.failed || picture.state === 'failed' ? 'failed' : picture.state === 'ready' ? 'ready' : 'reading'
  const chips = model.chips.map((chip) => {
    const item = chipOf(chip, t(`customers.work.tile.${chip.tile}`, { customer }), t(`customers.work.strip.${chip.group}`, { customer }), failedWords, model, actions)
    // F-CQ-B (lead, phone overflow): "Waiting for <customer>" says "Waiting for the customer" on a phone (a DS chip never wraps a long
    // name); its name and tip keep the customer's.
    return chip.tile === 'customer' ? { ...item, short: t('customers.work.tile.customerShort') } : item
  })

  return (
    <CustomerBand
      model={{
        label: all,
        groupsLabel: t('customers.work.band.pipeline'),
        groups: live,
        state,
        failed,
        closed: { groups: cancelled },
        notes,
        chips: { label: t('customers.work.strip.label'), items: chips },
        info: t('customers.work.band.info'), // F-CQ-B fx1 (walk B-06): the ONE ⓘ of both tabs (it opens the groups' window)
        everything: { label: all, value: <span className="fw-cwb-num">{number(picture.total)}</span> },
        window: { title: all, notes: windowNotes, ...(model.windowOpen ? { open: true } : {}) },
      }}
      actions={{ onGroup }}
    />
  )
}

/** One fact of "What waits": its words, its number, its door — today's doors and windows, each a FilterChip. */
function chipOf(chip: BandChip, label: string, group: string, failed: string, model: WorkBandModel, actions?: WorkBandActions): BandChipItem {
  const base = { id: chip.tile, label, count: chip.value, title: group, rule: chip.first }
  // A failed read: only this chip says so, and its press reads it again.
  if (chip.read.status === 'failed') return { ...base, failed, ...(actions?.onRetry ? { onPress: () => actions.onRetry?.(chip.tile) } : {}) }
  if (chip.tile === 'requests' && model.requestsHref) {
    const href = model.requestsHref
    return { ...base, onPress: () => actions?.onGo?.(href, true) }
  }
  if (chip.tile === 'replies' && model.repliesHref) {
    const href = model.repliesHref
    return { ...base, onPress: () => actions?.onGo?.(href, false) }
  }
  if ((chip.tile === 'late' || chip.tile === 'deposit') && actions?.onView) {
    const view = chip.tile
    return { ...base, pressed: !!model.pressed?.includes(view), onPress: () => actions.onView?.(view) }
  }
  if ((chip.tile === 'customer' || chip.tile === 'tasks') && actions?.onWindow) {
    const which = chip.tile
    return { ...base, dialog: true, onPress: () => actions.onWindow?.(which) }
  }
  return base
}
