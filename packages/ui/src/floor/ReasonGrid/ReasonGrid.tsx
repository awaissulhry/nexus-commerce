'use client'

/**
 * ReasonGrid — the floor's icon reason grid (gap D20; design part FloorReasonGrid): big tiles with an icon or an example
 * photo, a colour and a word, for every "why" on the floor — scrap, rework, pause, defect, symptom, grade, call type.
 *
 *   <ReasonGrid label="Perché?" reasons={[{ id: 'hole', label: 'Foro', icon: <CircleDot />, tone: 'danger' }, …]}
 *               value={reason} onChange={setReason} words={floorWords.reasons} />
 *   <ReasonGrid mode="count" label="Difetti" reasons={…} counts={counts} onCountChange={(next) => setCounts(next)} />
 *
 * - `pick` (default): one reason, a radio group — one Tab stop, arrows move and pick inside the page (wrapping; ↑ ↓ by
 *   row), Home / End, Space or Enter. The picked tile has a primary border, a thick bar, a tinted ground and a tick —
 *   never colour alone.
 * - `count`: each tap adds one, the count shows big on the tile, the − on the tile takes one off; `max` per reason when
 *   the app sets one. The total is written under the grid.
 * - Up to `pageSize` tiles a page (9: three a row on a tablet, two on a phone, by the grid's own width); "More
 *   reasons" and "Back" turn the page and the focus goes to the new page's first tile. A picked reason opens its page.
 * - A reason that needs a photo ("Other": no typing on the floor) carries a camera mark and the words; the app opens the
 *   photo step after the pick. A held reason stays in view, focusable, says why on the tile and is never picked.
 * - Tap = pick. No long press. Each change is said once in a polite live region.
 * - Sized by the density (`--nds-density-*`): tablet-and-glove sized on the floor tier, small at standard. Every word
 *   comes from the app (`words`, English defaults). Calls nothing: the app saves and gives `confirmFeedback`.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Camera, Check, ChevronLeft, ChevronRight, Lock, Minus } from 'lucide-react'

import { FloorButton } from '../FloorButton'
import {
  REASON_GRID_WORDS,
  REASON_PAGE_SIZE,
  countPress,
  countTotal,
  fillWords,
  isReasonNavKey,
  pageOf,
  pageOfReason,
  reasonCanPick,
  reasonKeyTarget,
  reasonPress,
  reasonTabStop,
  type ReasonGridWords,
  type ReasonTile,
} from './reasonGridModel'
import '../floor.css'
import './reasonGrid.css'

interface ReasonGridBase {
  /** The question, the group's name ("Perché è scarto?"). */
  label: string
  /** Keep the name for screen readers only (the screen's title already asks it). */
  hideLabel?: boolean
  /** In the order set for this station. */
  reasons: readonly ReasonTile[]
  /** Tiles a page (default 9). */
  pageSize?: number
  /** The page shown (0-based), when the app keeps it; else the grid keeps it. */
  page?: number
  onPageChange?: (page: number) => void
  words?: Partial<ReasonGridWords>
  /** The page's language for numbers (default `en-GB`). */
  locale?: string
  id?: string
}

export interface ReasonGridPickProps extends ReasonGridBase {
  mode?: 'pick'
  /** The picked reason's id, or null. */
  value: string | null
  onChange: (id: string, reason: ReasonTile) => void
}

export interface ReasonGridCountProps extends ReasonGridBase {
  mode: 'count'
  /** Reason id → how many. A reason left out is 0. */
  counts: Readonly<Record<string, number>>
  onCountChange: (counts: Record<string, number>, change: { id: string; delta: 1 | -1 }) => void
  /** The most one reason may count (the pieces in the bundle). */
  max?: number | null
}

export type ReasonGridProps = ReasonGridPickProps | ReasonGridCountProps

const escapeId = (id: string): string => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id)

export function ReasonGrid(props: ReasonGridProps) {
  const { label, hideLabel, reasons, pageSize = REASON_PAGE_SIZE, locale, id } = props
  const words = useMemo<ReasonGridWords>(() => ({ ...REASON_GRID_WORDS, ...props.words }), [props.words])
  const counting = props.mode === 'count'
  const value = counting ? null : (props as ReasonGridPickProps).value
  const counts = counting ? (props as ReasonGridCountProps).counts : null
  const labelId = useId()
  const gridRef = useRef<HTMLDivElement>(null)
  const number = useMemo(() => new Intl.NumberFormat(locale ?? 'en-GB'), [locale])

  const [ownPage, setOwnPage] = useState(() => pageOfReason(reasons, value, pageSize))
  const asked = props.page ?? ownPage
  const { items, page, pages } = pageOf(reasons, asked, pageSize)
  const [said, setSaid] = useState<{ n: number; text: string }>({ n: 0, text: '' })
  const say = useCallback((text: string) => setSaid((last) => ({ n: last.n + 1, text })), [])
  const focusFirst = useRef(false)

  const turn = (next: number) => {
    const clamped = Math.min(Math.max(0, next), pages - 1)
    if (props.page === undefined) setOwnPage(clamped)
    props.onPageChange?.(clamped)
    focusFirst.current = true
    say(fillWords(words.page, { page: number.format(clamped + 1), pages: number.format(pages) }))
  }

  // After a page turn the focus goes to the new page's first tile (the button pressed may be gone).
  useEffect(() => {
    if (!focusFirst.current) return
    focusFirst.current = false
    const stop = counting ? items[0]?.id : reasonTabStop(items, value)
    if (stop) gridRef.current?.querySelector<HTMLElement>(`[data-reason-id="${escapeId(stop)}"]`)?.focus()
  }, [page, items, counting, value])

  const columns = (): number => {
    const grid = gridRef.current
    if (!grid || typeof getComputedStyle !== 'function') return 3
    return getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 3
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey || !isReasonNavKey(event.key)) return
    const from = (event.target as HTMLElement).closest<HTMLElement>('[data-reason-id]')?.dataset.reasonId ?? null
    if (from === null) return
    const dir = getComputedStyle(event.currentTarget).direction === 'rtl' ? 'rtl' : 'ltr'
    const target = reasonKeyTarget(items, from, event.key, columns(), dir)
    if (target == null) return
    event.preventDefault()
    gridRef.current?.querySelector<HTMLElement>(`[data-reason-id="${escapeId(target)}"]`)?.focus()
    if (counting) return
    const reason = items.find((item) => item.id === target)
    if (reason && reasonCanPick(reason) && target !== value) pick(reason)
  }

  const pick = (reason: ReasonTile) => {
    const pickProps = props as ReasonGridPickProps
    const next = reasonPress(reasons, pickProps.value, reason.id)
    if (next == null || next === pickProps.value) return
    pickProps.onChange(next, reason)
    say(fillWords(words.picked, { reason: reason.label }))
  }

  const count = (reason: ReasonTile, delta: 1 | -1) => {
    const countProps = props as ReasonGridCountProps
    const change = countPress(reasons, countProps.counts, reason.id, delta, countProps.max)
    if (change.refused === 'held') return say(reason.heldReason ?? '')
    if (change.refused === 'max') return say(fillWords(words.atMax, { max: number.format(countProps.max ?? 0) }))
    if (change.refused === 'zero' || change.delta === 0) return
    countProps.onCountChange(change.counts, { id: reason.id, delta: change.delta })
    say(fillWords(words.counted, { reason: reason.label, count: number.format(change.counts[reason.id] ?? 0) }))
  }

  const stop = counting ? null : reasonTabStop(items, value)

  const face = (reason: ReasonTile, picked: boolean, shown: number | null) => (
    <>
      <span className="nds-floor-reason-art" aria-hidden>
        {reason.photo ? (
          // An example photo: decorative, the word names the tile.
          <img className="nds-floor-reason-photo" src={reason.photo} alt="" draggable={false} />
        ) : (
          <span className="nds-floor-icon nds-floor-reason-icon">{reason.icon ?? null}</span>
        )}
      </span>
      {shown !== null && shown > 0 ? (
        <span className="nds-floor-reason-count" aria-hidden>
          {number.format(shown)}
        </span>
      ) : null}
      {picked ? (
        <span className="nds-floor-reason-tick" aria-hidden>
          <Check />
        </span>
      ) : null}
      <span className="nds-floor-reason-label">{reason.label}</span>
      {reason.hint ? <span className="nds-floor-reason-hint">{reason.hint}</span> : null}
      {reason.photoNeeded ? (
        <span className="nds-floor-reason-mark">
          <Camera aria-hidden />
          {words.photoNeeded}
        </span>
      ) : null}
      {reason.heldReason ? (
        <span className="nds-floor-reason-held">
          <Lock aria-hidden />
          {reason.heldReason}
        </span>
      ) : null}
    </>
  )

  const total = counts ? countTotal(counts) : 0

  return (
    <div id={id} className="nds-floor-reasons" data-mode={counting ? 'count' : 'pick'}>
      <div id={labelId} className={hideLabel ? 'nds-floor-sr' : 'nds-floor-reasons-label'}>
        {label}
      </div>
      {reasons.length === 0 ? (
        <p className="nds-floor-reasons-empty">{words.empty}</p>
      ) : (
        <div ref={gridRef} className="nds-floor-reasons-grid" role={counting ? 'group' : 'radiogroup'} aria-labelledby={labelId} onKeyDown={onKeyDown}>
          {items.map((reason) => {
            const held = reason.heldReason || null
            if (!counting) {
              const picked = reason.id === value
              return (
                <button
                  key={reason.id}
                  type="button"
                  role="radio"
                  className="nds-floor-reason"
                  data-reason-id={reason.id}
                  data-tone={reason.tone ?? 'neutral'}
                  aria-checked={picked}
                  tabIndex={reason.id === stop ? 0 : -1}
                  aria-disabled={held ? true : undefined}
                  aria-description={held ?? undefined}
                  onClick={() => (held ? say(held) : pick(reason))}
                >
                  {face(reason, picked, null)}
                </button>
              )
            }
            const shown = Math.max(0, Math.floor(counts?.[reason.id] ?? 0))
            return (
              <div key={reason.id} className="nds-floor-reason-cell" data-has-count={shown > 0 || undefined}>
                <button
                  type="button"
                  className="nds-floor-reason"
                  data-reason-id={reason.id}
                  data-tone={reason.tone ?? 'neutral'}
                  aria-label={shown > 0 ? fillWords(words.tileCount, { reason: reason.label, count: number.format(shown) }) : undefined}
                  aria-disabled={held ? true : undefined}
                  aria-description={held ?? words.addOne}
                  onClick={() => count(reason, 1)}
                >
                  {face(reason, false, shown)}
                </button>
                {shown > 0 ? (
                  <FloorButton
                    size="sm"
                    className="nds-floor-reason-minus"
                    icon={<Minus />}
                    aria-label={fillWords(words.removeOne, { reason: reason.label })}
                    heldReason={held}
                    onClick={() => count(reason, -1)}
                  />
                ) : null}
              </div>
            )
          })}
        </div>
      )}
      {counting && reasons.length > 0 ? <p className="nds-floor-reasons-total">{fillWords(words.total, { count: number.format(total) })}</p> : null}
      {pages > 1 ? (
        <div className="nds-floor-reasons-pager">
          {page > 0 ? (
            <FloorButton icon={<ChevronLeft />} onClick={() => turn(page - 1)}>
              {words.back}
            </FloorButton>
          ) : null}
          <span className="nds-floor-reasons-page">{fillWords(words.page, { page: number.format(page + 1), pages: number.format(pages) })}</span>
          {page < pages - 1 ? (
            <FloorButton icon={<ChevronRight />} onClick={() => turn(page + 1)}>
              {words.more}
            </FloorButton>
          ) : null}
        </div>
      ) : null}
      <span className="nds-floor-sr" role="status" aria-live="polite">
        <span key={said.n}>{said.text}</span>
      </span>
    </div>
  )
}
