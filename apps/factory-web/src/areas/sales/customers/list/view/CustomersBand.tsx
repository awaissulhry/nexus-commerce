'use client'

import { Fragment, useEffect, useRef } from 'react'
import { ChevronRight, Info } from 'lucide-react'
import { DetailPopover } from '@nexus/ui/components'
import { FilterChip, Skeleton } from '@nexus/ui/primitives'
import type { Translate } from '../../../../../lib/i18n/messages'
import type { PartyWorkBand, PartyWorkGroup } from '../../../../parties/_shared/api'
import { bandGroupsOf, groupWordOf, type WordRef } from '../model'
import '../list.css'

export interface CustomersBandWords {
  readonly c: Translate
  readonly ord: Translate
  readonly sheet: Translate
  readonly p: Translate
}

/** A group's name in words. */
export function groupName(group: PartyWorkGroup, words: CustomersBandWords): string {
  const ref: WordRef = groupWordOf(group)
  return ref.ns === 'orders' ? words.ord(ref.key) : ref.ns === 'orders-sheet' ? words.sheet(ref.key) : ref.ns === 'parties' ? words.p(ref.key) : words.c(ref.key)
}

/**
 * A group's hint: how many customers and what orders it counts — under Not sent the Work tab's own split (T7: "3 wait for a yes ·
 * 3 wait for the deposit", CONFIRMED only for the deposit) — and what a press does. Also the hint of the pressed door's chip.
 */
export function bandHintOf(group: PartyWorkGroup, band: PartyWorkBand, words: CustomersBandWords): string {
  const { c } = words
  const entry = bandGroupsOf(band).find((item) => item.group === group)
  const customers = entry?.customers ?? 0
  const press = c('band.hint.press')
  if (group === 'NEEDS_US') {
    // F-CL-301 (walk W-10): each number with its own plural form ("1 reply waiting on us", "1 customer has…").
    const what = [c('band.hint.req', { count: band.needsUs.requests }), c('band.hint.rep', { count: band.needsUs.replies }), c('band.hint.late', { count: band.needsUs.late })].join(' · ')
    return `${c('band.hint.needs', { count: customers, what })} ${press}`
  }
  const ordersWords = c('band.orders', { count: entry?.orders ?? 0 }).replace(/^·\s*/, '')
  const why = group === 'NOT_SENT' ? `: ${[words.p('customers.work.band.why.yes', { count: band.notSent.waitsForYes }), words.p('customers.work.band.why.deposit', { count: band.notSent.waitsForDeposit })].join(' · ')}` : ''
  return `${c('band.hint.group', { count: customers, group: groupName(group, words), orders: `${ordersWords}${why}` })} ${press}`
}

/**
 * F-CL-202 (customers list plan §1, 10-design §2, settles T5 / T7 / T13 / T22) — the customers' band (named apart from the customer
 * page's own WorkBand): ONE line in the head row — "All customers: Needs us
 * now 5 | Not sent to the factory 5 › Production not started 2 › … › Done 10 ⓘ". Each number counts CUSTOMERS over the reader's
 * customers and this list's own view, search and filters; the hint says the orders. A press filters THIS list (`?work=`), the pressed
 * door is marked, a second press leaves. 0 stays, quiet; Done quiet; Cancelled never. "Your customers" when the reader's orders.view
 * names its customers. On a phone: a 2-column grid of the same doors. Fetches nothing.
 */
export function CustomersBand({ band, problem, work, onWork, wide, about, words, onRoom }: { band: PartyWorkBand | null; problem: string | null; work: PartyWorkGroup | null; onWork: (group: PartyWorkGroup | null) => void; wide: boolean; about: string; words: CustomersBandWords; onRoom?: (px: number) => void }) {
  const { c } = words
  // The band spans the list's own room: it measures it for the host (the wide room's columns: settle T15), never the window.
  const root = useRef<HTMLDivElement>(null)
  const report = useRef(onRoom)
  report.current = onRoom
  useEffect(() => {
    const element = root.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => report.current?.(element.closest('.fw-pty-head')?.clientWidth ?? element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const label = band?.limited ? c('band.label.yours') : c('band.label.all')
  const info = (
    <DetailPopover trigger={<Info size={15} aria-hidden />} triggerLabel={c('band.about')} triggerClassName="fw-cl-band-info" label={c('band.about')} hoverDelay={150}>
      <div className="fw-cl-band-about">
        <p className="fw-pty-pop-title">{c('band.about')}</p>
        <p>{about}</p>
        <p>{c('band.aboutBody')}</p>
        {band && !band.needsUs.repliesComplete && <p>{c('band.hint.partial')}</p>}
      </div>
    </DetailPopover>
  )
  if (problem)
    return (
      <div className="fw-cl-band" role="group" aria-label={label} ref={root}>
        <span className="fw-cl-band-label">{label}</span>
        <span className="fw-cl-quiet" title={words.p(problem)}>
          {c('band.failed')}
        </span>
        {info}
      </div>
    )
  if (!band)
    return (
      <div className="fw-cl-band" role="group" aria-label={label} aria-busy ref={root}>
        <span className="fw-cl-band-label">{label}</span>
        <Skeleton width={420} height={24} />
      </div>
    )
  const groups = bandGroupsOf(band)
  const door = (entry: (typeof groups)[number]) => {
    const on = work === entry.group
    const quiet = entry.customers === 0 || entry.group === 'DONE'
    return (
      <FilterChip
        key={entry.group}
        size="md"
        pressed={on}
        className={`fw-cl-door${entry.group === 'NEEDS_US' ? ' is-needs' : ''}${quiet ? ' is-quiet' : ''}`}
        count={entry.customers}
        title={bandHintOf(entry.group, band, words)}
        onClick={() => onWork(on ? null : entry.group)}
      >
        {groupName(entry.group, words)}
        {wide && entry.orders !== null && entry.customers > 0 && <span className="fw-cl-door-orders"> {c('band.orders', { count: entry.orders })}</span>}
      </FilterChip>
    )
  }
  const [needs, ...phases] = groups
  return (
    <div className="fw-cl-band" role="group" aria-label={label} ref={root}>
      <span className="fw-cl-band-label">{label}</span>
      {needs && door(needs)}
      <span className="fw-cl-band-divider" aria-hidden />
      <span className="fw-cl-band-phases">
        {phases.map((entry, index) => (
          <Fragment key={entry.group}>
            {index > 0 && <ChevronRight size={12} aria-hidden className="fw-cl-band-arrow" />}
            {door(entry)}
          </Fragment>
        ))}
      </span>
      {info}
    </div>
  )
}
