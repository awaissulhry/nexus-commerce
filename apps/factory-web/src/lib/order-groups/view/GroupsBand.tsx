'use client'

import type { ReactNode } from 'react'
import { formatNumber } from '../../i18n/format'
import { useLocale, useT } from '../../i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { CustomerBand, type CustomerBandModel } from '../../customer-band/CustomerBand'
import type { BandTile } from '../../customer-band/customer-band'
import { GROUPS_NAMESPACES, groupMarkOf, groupNameOf, groupNoteOf, isClosedGroup, ORDER_LIST_NS, type GroupFace, type GroupWords, type OrderGroup } from '../groups'

/**
 * pg-w1 (portal grid plan § 2; 18-lead-settles Z2, Z3; 10-design § 1.2) — the band of a customer's orders by where they are, ONE part
 * for both faces: it wraps the band frame (lib/customer-band) and owns the band's words per face — its name, the groups' name, each
 * group's name, tip, note and mark, the ⓘ, the phone's "everything", the window's title, the failed read. Office words are read where
 * they live (`parties` customers.work.band.*, the phase words of `orders` / `orders-sheet`); the customer's in `order-list` ›
 * `customer.*`. The counts are the host's read (office: the board's byPhase; customer: the server's sheet `groups`, `open`,
 * `needsYou`), never a sum made here; "—" while not read. It fetches nothing.
 *
 *   office    the customer page's Work band: the seven phases (Cancelled apart); the Work tab's own facts (its notes line, What
 *             waits, the window's lines) come in `officeFacts` — office facts, never the band's words
 *   customer  the portal's list: six groups, Cancelled and Closed requests apart; the notes line "Your open orders and requests: N"
 *             (a door: everything open) · "Requests: N need your answer" (a door: Requests, its tile's warning dot); the window's sum
 */

/** One group with the count the host read (null: not read — "—", never 0) and whether it is a door the host can open. */
export interface GroupCount {
  readonly group: OrderGroup
  readonly count: number | null
  readonly door: boolean
}

export interface GroupsBandModel {
  readonly face: GroupFace
  /** Every group of the face with its count, in the band's order; the closed ones stand apart. */
  readonly groups: readonly GroupCount[]
  /** Everything: office, every order of the customer; customer, every open order and request (the server's `open`). null: not read. */
  readonly total: number | null
  /** The group the list shows now (its door pressed); null: none. */
  readonly shown: OrderGroup | null
  readonly state: 'ready' | 'reading' | 'failed'
  /** Office: the customer whose orders these are (the office words name it). */
  readonly customer?: string
  /** Customer: how many need your answer (the server's `needsYou`): Requests' warning dot and the notes line. null: not read. */
  readonly needsYou?: number | null
  /** Office: the facts only the office band says (the Work tab's notes line, What waits, the window's lines). */
  readonly officeFacts?: {
    readonly line?: ReactNode
    readonly chips?: CustomerBandModel['chips']
    readonly window?: ReactNode
  }
  /** Design cases: the groups' window open from the start. */
  readonly windowOpen?: boolean
}

export interface GroupsBandActions {
  /** A group's door: its records — or, pressed while shown, everything again (the host decides). */
  readonly onGroup?: (group: OrderGroup) => void
  /** Customer: the notes line's door — everything open. */
  readonly onEverything?: () => void
  /** The groups could not be read: read them again (the failed words are then its button). */
  readonly onRetry?: () => void
}

export function GroupsBand(props: { model: GroupsBandModel; actions?: GroupsBandActions }) {
  return (
    <WithMessages namespaces={GROUPS_NAMESPACES[props.model.face]}>
      <Band {...props} />
    </WithMessages>
  )
}

function Band({ model, actions }: { model: GroupsBandModel; actions?: GroupsBandActions }) {
  const parties = useT('parties')
  const orders = useT('orders')
  const sheet = useT('orders-sheet')
  const list = useT(ORDER_LIST_NS)
  const locale = useLocale()
  const office = model.face === 'office'
  const say = (words: GroupWords, params?: Readonly<Record<string, string | number>>): string => (words.ns === 'orders' ? orders(words.key, params) : words.ns === ORDER_LIST_NS ? list(words.key, params) : sheet(words.key, params))
  const number = (value: number | null | undefined): string => (value === null || value === undefined ? '—' : formatNumber(value, locale))
  const needs = model.needsYou ?? 0
  const needsWords = !office && needs > 0 ? list('customer.band.needsYou', { count: needs }) : null

  // The face's own words for the band (the office's read where they live, with the customer's name).
  const customer = model.customer ?? ''
  const all = office ? parties('customers.work.band.all', { customer }) : list('customer.band.label')
  const groupsLabel = office ? parties('customers.work.band.pipeline') : list('customer.band.groups')
  const tipOf = (on: boolean, group: string): string => (office ? parties(on ? 'customers.work.band.groupOnTip' : 'customers.work.band.groupTip', { group }) : list(on ? 'customer.band.groupOnTip' : 'customer.band.groupTip', { group }))

  // The groups: a door only with the host's handler (a count without one is a plain tile: never a held door).
  const tileOf = (entry: GroupCount): BandTile => {
    const label = say(groupNameOf(model.face, entry.group))
    const on = model.shown === entry.group
    const door = !!(entry.door && actions?.onGroup)
    const ours = entry.group === 'REQUESTS' && needsWords ? { ours: true, oursWords: needsWords } : {}
    const icon = groupMarkOf(model.face, entry.group)
    return {
      id: entry.group,
      label,
      count: entry.count,
      value: <span className="fw-cwb-num">{number(entry.count)}</span>,
      ...(door ? { title: needsWords && entry.group === 'REQUESTS' ? `${tipOf(on, label)} · ${needsWords}` : tipOf(on, label) } : {}),
      note: say(groupNoteOf(model.face, entry.group)),
      ...(icon ? { icon } : {}),
      door,
      pressed: on,
      ...ours,
    }
  }
  const live = model.groups.filter((entry) => !isClosedGroup(model.face, entry.group)).map(tileOf)
  const closed = model.groups.filter((entry) => isClosedGroup(model.face, entry.group)).map(tileOf)
  const onGroup = (id: string) => {
    const entry = model.groups.find((each) => each.group === id)
    if (entry) actions?.onGroup?.(entry.group)
  }

  // The customer's notes line: everything open (its door) · Requests that need your answer (its door); the window's sum.
  const requests = say(groupNameOf('customer', 'REQUESTS'))
  const customerLine = office ? null : (
    <>
      <span>
        {actions?.onEverything ? (
          <button type="button" className="fw-cb-link" onClick={() => actions.onEverything?.()}>
            {list('customer.band.openCount')}
          </button>
        ) : (
          list('customer.band.openCount')
        )}{' '}
        <b className="fw-cwb-num">{number(model.total)}</b>
      </span>
      {needsWords && (
        <span>
          <b>{requests}:</b>{' '}
          {actions?.onGroup ? (
            <button type="button" className="fw-cb-link" onClick={() => actions.onGroup?.('REQUESTS')}>
              {needsWords}
            </button>
          ) : (
            needsWords
          )}
        </span>
      )}
    </>
  )
  const customerWindow = office ? null : <p>{list('customer.band.sum')}</p>

  // cw fx6 (re-walk R-4): the groups could not be read — said ONCE ("Couldn't be read · Try again"), in the strip's place; the press
  // reads them again (the host's retry: on the Work tab the board's read, which the chips use too).
  const failedWords = parties('customers.work.tile.failed')
  const failed = actions?.onRetry ? (
    <button type="button" className="fw-cb-link" onClick={() => actions.onRetry?.()}>
      {failedWords}
    </button>
  ) : (
    failedWords
  )

  const chips = office ? model.officeFacts?.chips : undefined
  // pg-fx3 (walk W-06): the customer's failed read says ONLY that, with its Try again — no notes line of "—", no ⓘ over a window of
  // dashes. The office face keeps what it draws (cw fx6: the Work tab's own facts and the ⓘ stay beside the failed line).
  const quiet = !office && model.state === 'failed'
  return (
    <CustomerBand
      model={{
        label: all,
        groupsLabel,
        groups: live,
        state: model.state,
        failed,
        closed: { groups: closed },
        notes: office ? model.officeFacts?.line : quiet ? null : customerLine,
        ...(chips ? { chips } : {}),
        ...(quiet ? {} : { info: parties('customers.work.band.info') }), // F-CQ-B fx1 (walk B-06): the ONE ⓘ (it opens the groups' window)
        everything: { label: office ? all : list('customer.band.open'), value: <span className="fw-cwb-num">{number(model.total)}</span> },
        window: { title: all, notes: office ? model.officeFacts?.window : customerWindow, ...(model.windowOpen ? { open: true } : {}) },
      }}
      actions={{ onGroup }}
    />
  )
}
