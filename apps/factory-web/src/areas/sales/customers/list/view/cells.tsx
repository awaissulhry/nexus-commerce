'use client'

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Shirt } from 'lucide-react'
import { Skeleton } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import type { Locale } from '../../../../../lib/i18n/locales'
import type { Translate } from '../../../../../lib/i18n/messages'
import type { ReadPictures } from '../../../../../lib/record-picture/cache'
import { RecordPicture } from '../../../../../lib/record-picture/view/RecordPicture'
import type { CustomerWork } from '../api'
import { workDoor } from '../doors'
import { foldOf, nextPromiseOf, type WorkChip } from '../model'
import '../list.css'

/**
 * F-CL-202 (customers list 10-design §3, settles T2 / T13 / T23–T25 / T30): the cells of where a customer's work stands — Needs us,
 * Work, Next promise, the newest order's picture, Last order. Every chip writes its count and is a door; a cell holds at most two lines
 * and folds the rest into "+n more" (measured in the page, never guessed), a door to the Work tab whose hint lists what it folds.
 * Without facts for a customer (orders.view does not reach it) a cell says "—", never "No order yet". Fetches nothing.
 */

/** The words the cells read (one word per thing: the list's own, the parties', the orders', the levels', the "+n more"). */
export interface CellWords {
  readonly c: Translate
  readonly p: Translate
  readonly ord: Translate
  readonly sheet: Translate
  readonly levels: Translate
  readonly more: Translate
}

/** A chip's words. */
export function chipText(chip: WorkChip, words: CellWords): string {
  // The Work tab's own chip: "Priority: Top" in the level's own words (cw F-CW-105).
  if ('priority' in chip.label) return words.sheet('urgency.priority', { level: words.levels(`priority.level.${chip.label.priority}`) })
  const ref = chip.label
  return ref.ns === 'customers-list' ? words.c(ref.key) : ref.ns === 'parties' ? words.p(ref.key) : ref.ns === 'orders-sheet' ? words.sheet(ref.key) : words.ord(ref.key)
}

/** One chip: a door with its words and its count. */
export function ChipDoor({ chip, href, words, measure }: { chip: WorkChip; href: string; words: CellWords; measure?: boolean }) {
  const text = chipText(chip, words)
  return (
    <Link className={`fw-cl-chip is-${chip.tone}`} href={href} title={`${text} ${chip.count}`} {...(measure ? { 'data-chip': '' } : {})}>
      <span className="fw-cl-chip-text">{text}</span>
      <b className="fw-cl-chip-n">{chip.count}</b>
    </Link>
  )
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * Chips in at most `lines` lines (and at most `max` chips): the ones a further line would need fold into "+n more". The chips are
 * measured once per set (their own widths), then each width change of the cell refolds from those widths.
 */
export function FoldChips({ chips, chip, more, lines = 2, max }: { chips: readonly WorkChip[]; chip: (item: WorkChip) => ReactNode; more: (folded: readonly WorkChip[]) => ReactNode; lines?: number; max?: number }) {
  const box = useRef<HTMLSpanElement>(null)
  const cache = useRef<{ readonly widths: readonly number[]; readonly more: number } | null>(null)
  const key = chips.map((item) => `${item.id}:${item.count}`).join(',')
  const [shown, setShown] = useState<number | null>(null)
  const cap = max ?? Number.POSITIVE_INFINITY
  useIsoLayoutEffect(() => {
    cache.current = null
    setShown(null)
  }, [key])
  useIsoLayoutEffect(() => {
    const element = box.current
    if (!element || shown !== null) return
    const widths = Array.from(element.querySelectorAll<HTMLElement>('[data-chip]'), (node) => node.offsetWidth)
    const moreWidth = element.querySelector<HTMLElement>('[data-more]')?.offsetWidth ?? 64
    cache.current = { widths, more: moreWidth }
    setShown(Math.min(cap, foldOf(widths, element.clientWidth, moreWidth, lines)))
  }, [shown, key, cap, lines])
  useEffect(() => {
    const element = box.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const known = cache.current
      if (known) setShown(Math.min(cap, foldOf(known.widths, element.clientWidth, known.more, lines)))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [cap, lines])
  const count = shown ?? chips.length
  return (
    <span className={`fw-cl-chips${lines === 1 ? ' is-one' : ''}`} ref={box}>
      {chips.slice(0, count).map((item) => chip(item))}
      {shown === null ? (
        <span className="fw-cl-measure" data-more="" aria-hidden>
          {more(chips)}
        </span>
      ) : shown < chips.length ? (
        more(chips.slice(shown))
      ) : null}
    </span>
  )
}

/** "+n more": the Work tab, its hint listing the folded chips. */
export function MoreDoor({ folded, href, customer, words }: { folded: readonly WorkChip[]; href: string; customer: string; words: CellWords }) {
  const list = folded.map((item) => `${chipText(item, words)} ${item.count}`).join(' · ')
  return (
    <Link className="fw-cl-chip is-more" href={href} title={words.c('work.moreHint', { list, customer })}>
      {words.more('batch.more', { count: folded.length })}
    </Link>
  )
}

/** What a cell of facts says before its chips: reading, couldn't read, or no facts for this customer ("—"); null: draw the facts. */
export function factsState({ work, reading, problem, words }: { work: CustomerWork | undefined; reading: boolean; problem: string | null; words: CellWords }): ReactNode {
  if (problem) return <span className="fw-cl-quiet" title={words.p(problem)}>{words.c('cell.failed')}</span>
  if (reading) return <Skeleton width={96} height={14} />
  if (!work) return <span className="fw-cl-quiet">—</span>
  return null
}

/** Next promise: the date and "in 3 d" / "today"; never a past date; "No promise ahead", "No open order", or "—". */
export function NextPromiseCell({ work, today, locale, words, inline = false }: { work: CustomerWork; today: string; locale: Locale; words: CellWords; inline?: boolean }) {
  const promise = nextPromiseOf(work, today)
  if (promise.kind === 'none') return <span className="fw-cl-quiet">—</span>
  if (promise.kind === 'noneAhead') return <span className="fw-cl-quiet">{words.c('prom.noneAhead')}</span>
  if (promise.kind === 'noOpen') return <span className="fw-cl-quiet">{words.c('prom.noOpen')}</span>
  return (
    <span className={inline ? 'fw-cl-promise is-inline' : 'fw-cl-promise'}>
      <span className="fw-cl-promise-date">{formatDate(`${promise.date}T12:00:00Z`, { locale })}</span>
      <span className="fw-cl-quiet">{promise.days === 0 ? words.c('prom.today') : words.c('prom.in', { days: promise.days })}</span>
    </span>
  )
}

/** The newest order's picture (the ONE picture part, its batch read); no order: the placeholder with words. */
export function PictureCell({ work, read, size, words, onOpen }: { work: CustomerWork | undefined; read: ReadPictures | null; size: 'cell' | 'phone'; words: CellWords; onOpen?: ((order: { readonly id: string; readonly number: string }) => void) | null }) {
  const newest = work?.newestOrder ?? null
  if (!newest)
    return (
      <span className={`fw-rpic fw-rpic-${size} fw-rpic-none`} role="img" aria-label={words.c('pic.noOrder')} title={words.c('pic.noOrder')}>
        <Shirt size={size === 'cell' ? 18 : 24} aria-hidden />
      </span>
    )
  return (
    <span className="fw-cl-pic" title={words.c('pic.newest', { number: newest.number })}>
      <RecordPicture source="order" recordId={newest.id} number={newest.number} size={size} read={read} {...(onOpen ? { onOpen: () => onOpen(newest) } : {})} />
    </span>
  )
}

/** A chips cell: Needs us or Work, folded at two lines (one on the phone's Work line). */
export function ChipsCell({ chips, prefix, partyId, customer, words, lines = 2, max, empty }: { chips: readonly WorkChip[]; prefix: string; partyId: string; customer: string; words: CellWords; lines?: number; max?: number; empty?: ReactNode }) {
  if (chips.length === 0) return <>{empty ?? null}</>
  return (
    <FoldChips
      chips={chips}
      lines={lines}
      {...(max !== undefined ? { max } : {})}
      chip={(item) => <ChipDoor key={item.id} chip={item} href={workDoor(prefix, partyId, item.door)} words={words} measure />}
      more={(folded) => <MoreDoor folded={folded} href={workDoor(prefix, partyId, { kind: 'work' })} customer={customer} words={words} />}
    />
  )
}
