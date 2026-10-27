'use client'

/**
 * Reviews › Inbox on a phone (< 760 px, the Inbox-phone board): one card per review instead of the grid — the stars and
 * the status, two lines of text, channel · market, buyer, when, the product and when a reply is due; an overdue review
 * has a red edge. A tap opens the review (a full-screen sheet). "Load 50 more" reads the next page. A long press (or
 * Select) starts ticking: then a tap ticks, and the bulk actions sit in a bar at the bottom of the screen.
 *
 * Each card is a DS `PressableRow` (one button, its name the review's text); the layout is `inbox.module.css`.
 */
import { useCallback, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'
import { EmptyState, PressableRow } from '@/design-system/components'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import { STATUS_WORD, channelMarketWords } from '../_lib/reviewWords'
import { RatingMark } from './inboxColumns'
import type { InboxRow } from './inboxDatasource'
import { STATUS_TONE, agoWords, dueWords, photoWords, plural, productWords } from './inboxTiles'
import s from './inbox.module.css'

const LONG_PRESS_MS = 550

export interface InboxCardsProps {
  rows: readonly InboxRow[] | null
  total: number | null
  loading: boolean
  error: string | null
  onRetry: () => void
  onOpen: (id: string) => void
  /** Ticking mode: a tap ticks instead of opening. */
  selecting: boolean
  selected: ReadonlySet<string>
  onToggle: (id: string) => void
  /** A long press: start ticking with this card. */
  onLongPress: (id: string) => void
  onMore: () => void
  /** Why "Load 50 more" cannot run now, or null. */
  moreHeld: string | null
  filtered: boolean
  onClearFilters: () => void
}

export function InboxCards({
  rows, total, loading, error, onRetry, onOpen, selecting, selected, onToggle, onLongPress, onMore, moreHeld, filtered, onClearFilters,
}: InboxCardsProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressed = useRef<string | null>(null)
  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }, [])
  const start = useCallback((id: string) => {
    cancel()
    pressed.current = null
    timer.current = setTimeout(() => {
      pressed.current = id
      onLongPress(id)
    }, LONG_PRESS_MS)
  }, [cancel, onLongPress])
  const tap = useCallback((id: string) => {
    // The click that ends a long press only started ticking.
    if (pressed.current === id) {
      pressed.current = null
      return
    }
    if (selecting) onToggle(id)
    else onOpen(id)
  }, [selecting, onToggle, onOpen])

  if (error && !rows?.length) {
    return (
      <EmptyState
        icon={<AlertTriangle size={20} />}
        title="Couldn’t load the reviews"
        description={`${error} This is not an empty Inbox.`}
        action={<Button size="sm" onClick={onRetry}>Try again</Button>}
      />
    )
  }
  if (!rows) {
    return (
      <div className={s.cards} aria-busy="true" aria-label="Loading the reviews">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={120} />)}
      </div>
    )
  }
  if (rows.length === 0) {
    return filtered ? (
      <EmptyState
        title="No reviews match these filters"
        description="Clear a filter to see more. New reviews still arrive while filters are on."
        action={<Button size="sm" onClick={onClearFilters}>Clear all filters</Button>}
      />
    ) : (
      <EmptyState title="No reviews yet" description="Reviews arrive here as Nexus reads them, or when you import a file." />
    )
  }

  const now = Date.now()
  return (
    <div className={s.cardsWrap}>
      <ul className={s.cards} aria-label="Reviews">
        {rows.map((row) => {
          const due = dueWords(row, now)
          const product = productWords(row)
          const ticked = selected.has(row.id)
          return (
            <li
              key={row.id}
              className={`${s.card}${due.kind === 'late' ? ` ${s.cardLate}` : ''}${ticked ? ` ${s.cardTicked}` : ''}`}
              onPointerDown={() => start(row.id)}
              onPointerUp={cancel}
              onPointerLeave={cancel}
              onPointerCancel={cancel}
              onContextMenu={(e) => { if (pressed.current === row.id) e.preventDefault() }}
            >
              <PressableRow
                label={<span className={s.cardText}>{row.snippet || 'No text'}</span>}
                leading={<RatingMark channel={row.channel} rating={row.rating} />}
                onClick={() => tap(row.id)}
                active={selecting ? ticked : undefined}
                description={selecting ? (ticked ? 'Ticked. Tap to untick.' : 'Tap to tick.') : 'Opens the review. Press and hold to tick.'}
                stacked
              >
                <span className={s.cardMeta}>
                  <Pill tone={STATUS_TONE[row.status] ?? 'neutral'}>{STATUS_WORD[row.status] ?? row.status}</Pill>
                  <span>{channelMarketWords(row.channel, row.market, 'short')}</span>
                  {row.buyer && <span>{row.buyer}</span>}
                  {photoWords(row) && <span>{photoWords(row)}</span>}
                  <span>{agoWords(row.postedAt, now)}</span>
                </span>
                <span className={s.cardMeta}>
                  <span className={product ? undefined : s.muted}>{product ?? 'No product link'}</span>
                  <span className={due.kind === 'late' ? s.dueLate : due.kind === 'soon' ? s.dueSoon : s.sub}>{due.text}</span>
                </span>
              </PressableRow>
            </li>
          )
        })}
      </ul>
      <div className={s.loadMore}>
        <span className={s.sub}>{total != null ? `Showing ${rows.length.toLocaleString('en-US')} of ${plural(total, 'review', 'reviews')}` : ''}</span>
        {total != null && rows.length < total && (
          <Button size="sm" onClick={onMore} heldReason={loading ? 'Loading the next 50…' : moreHeld}>Load 50 more</Button>
        )}
      </div>
    </div>
  )
}
