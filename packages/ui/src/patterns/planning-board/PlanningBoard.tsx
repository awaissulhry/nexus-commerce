'use client'

import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRightLeft, Lock, Pin, Redo2, Undo2 } from 'lucide-react'
import { Field } from '../../components/Field'
import { Modal } from '../../components/Modal'
import { Button } from '../../primitives/Button'
import { Select } from '../../primitives/Select'
import { Skeleton } from '../../primitives/Skeleton'
import { Tag } from '../../primitives/Tag'
import { LoadBar } from './LoadBar'
import { LOAD_BAR_WORDS, fillWords, minutesFormatter, type LoadBarWords } from './loadBarModel'
import {
  EMPTY_HISTORY,
  PLANNING_BOARD_WORDS,
  TRAY_PLACE,
  bookedByCell,
  capacityOf,
  cardName,
  cellKey,
  dropHeldReason,
  historyStep,
  isMoveKey,
  isOver,
  landingLoads,
  landingWords,
  laneCapacity,
  minutesByBucket,
  moveStart,
  moveStep,
  nextFocus,
  packTracks,
  placeOf,
  placeWords,
  recordMove,
  samePlace,
  spanAt,
  spanOf,
  withMove,
  type BoardShape,
  type Formatter,
  type HistoryEntry,
  type PlanningBoardWords,
  type PlanningBucket,
  type PlanningCard,
  type PlanningHistory,
  type PlanningLane,
  type PlanningLayout,
  type PlanningMove,
  type PlanningPlace,
  type PlanningVia,
} from './planningBoardModel'
import './planning-board.css'

export interface PlanningBoardProps {
  /** The board's name (a region): "Planning board · Site A". */
  label: string
  lanes: readonly PlanningLane[]
  buckets: readonly PlanningBucket[]
  cards: readonly PlanningCard[]
  /**
   * `time` (default): lanes are rows, buckets are columns. `columns`: lanes are columns (an allocation board). `list`:
   * always the list. Either grid becomes the list below `listBelow` px of its own width (a phone).
   */
  layout?: PlanningLayout | 'list'
  /** Below this width (px, the board's own) the board is a list with a Move dialog per card. Default 640. */
  listBelow?: number
  /** Draw the tray ("Not on the board"); it takes drops. Default true. */
  tray?: boolean
  /**
   * A move was made (drag, keyboard, the list's dialog, undo, redo). The app saves it and passes the cards back; return
   * `false` (or a promise of `false`) when it did not happen — the board then says so and keeps it off the undo list.
   * Without it the board is read-only.
   */
  onMove?: (move: PlanningMove) => void | boolean | Promise<void | boolean>
  /** A card was opened (click, Enter): the app shows its detail or its record. */
  onOpen?: (card: PlanningCard) => void
  /** P on a card (or the app's own control): pin or unpin. Without it P does nothing. */
  onPin?: (card: PlanningCard, pinned: boolean) => void
  /** The app's check of one card at one place: why it cannot go there (material, a gate, a workshop), or nothing. */
  dropHeld?: (card: PlanningCard, to: PlanningPlace) => string | null | undefined
  /** `block` refuses a drop that takes a cell over capacity; `allow` (default) makes it and says `move.over`. */
  overload?: 'allow' | 'block'
  /** Why nothing can move now (read-only for this person, offline): said at rest and on every attempt. */
  heldReason?: string | null
  /** Lanes and buckets are known, cards not yet: skeleton cells (lane names first). */
  loading?: boolean
  /** Each load cell opens a popover: how its capacity is made and what is booked in it. Default true. */
  cellDetails?: boolean
  /** The board scrolls inside this height (its column heads stay); default: it grows with its lanes. */
  maxHeight?: number | string
  words?: Partial<PlanningBoardWords>
  loadWords?: Partial<LoadBarWords>
  /** The page's language for numbers (default `en-GB`). */
  locale?: string
  formatMinutes?: (minutes: number) => string
  /** Start with a keyboard move under way (a design case, a tour). */
  defaultMove?: { cardId: string; to: PlanningPlace }
  className?: string
}

interface KeyMove {
  cardId: string
  target: PlanningPlace
  lastBucketId: string | null
}

interface Pending {
  cardId: string
  target: PlanningPlace
}

const TRAY_DROP = 'pb:tray'
const LANE_TEMPLATE = (buckets: number) => `var(--nds-pb-lane-w) repeat(${Math.max(1, buckets)}, minmax(var(--nds-pb-cell-min), 1fr))`

const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  if (!element || typeof element.closest !== 'function') return false
  return element.isContentEditable || element.closest('input, textarea, select, [role="dialog"]') !== null
}

/** The board's own width (null until measured): the list fallback reads it, not the window's. */
function useOwnWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    setWidth(element.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/**
 * PlanningBoard — resource lanes over time with cards in standard minutes (gap D18): lines, work centres and
 * subcontractors as lanes, days or weeks as buckets, the load per lane and bucket on top of each lane (LoadBar), a tray
 * of cards without a slot, and an allocation layout where lanes are columns.
 *
 * Moves, all with the same checks (`planningBoardModel.ts`) and the same words:
 * - drag a card (mouse; on touch a long press) onto a cell, a column or the tray — the target shows the load after the
 *   drop while you drag;
 * - keyboard: focus a card, Space or M picks it up, arrows choose a lane and a bucket (the tray after the last lane), the
 *   cells show the load after the drop, Enter or Space drops, Escape cancels; every step is said;
 * - below `listBelow` px (a phone) a list with a Move dialog per card (lane, bucket, the load after the move).
 * A pinned card does not move; a held lane, a closed bucket and the app's `dropHeld` refuse with their reason; `overload`
 * `block` refuses a drop over capacity. Undo / Redo (⌘Z / ⌘⇧Z, or the buttons) only while the card is where the move
 * put it. Read-only (`heldReason`) is said at rest and on the first attempt.
 *
 * Data in, events out: the board calls nothing. The app passes lanes, buckets and cards, saves `onMove` and passes the
 * cards back. Every word comes in through `words` / `loadWords` (English by default). Its own entry point (not the
 * patterns barrel): `@nexus/ui/patterns/planning-board/index`.
 */
export function PlanningBoard(props: PlanningBoardProps) {
  const {
    label,
    lanes,
    buckets,
    cards,
    layout: asked = 'time',
    listBelow = 640,
    tray = true,
    onMove,
    onOpen,
    onPin,
    dropHeld,
    overload = 'allow',
    heldReason,
    loading = false,
    cellDetails = true,
    maxHeight,
    locale,
    formatMinutes,
    defaultMove,
    className,
  } = props
  const words = useMemo<PlanningBoardWords>(() => ({ ...PLANNING_BOARD_WORDS, ...props.words }), [props.words])
  const loadWords = useMemo<LoadBarWords>(() => ({ ...LOAD_BAR_WORDS, ...props.loadWords }), [props.loadWords])
  const minutes = useMemo(() => formatMinutes ?? minutesFormatter(locale), [formatMinutes, locale])
  const format = useMemo<Formatter>(() => ({ minutes }), [minutes])
  const layout: PlanningLayout = asked === 'columns' ? 'columns' : 'time'
  const shape = useMemo<BoardShape>(() => ({ lanes, buckets, layout, tray }), [lanes, buckets, layout, tray])
  const held = heldReason || (onMove ? null : words.readOnly)

  const rootRef = useRef<HTMLDivElement>(null)
  const width = useOwnWidth(rootRef)
  const asList = asked === 'list' || (width !== null && width < listBelow)
  const instructionsId = useId()

  const [keyMove, setKeyMove] = useState<KeyMove | null>(() => (defaultMove ? { cardId: defaultMove.cardId, target: defaultMove.to, lastBucketId: defaultMove.to.bucketId } : null))
  const [drag, setDrag] = useState<Pending | null>(null)
  const [history, setHistory] = useState<PlanningHistory>(EMPTY_HISTORY)
  const [said, setSaid] = useState<{ n: number; text: string }>({ n: 0, text: '' })
  const [saving, setSaving] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [listMove, setListMove] = useState<{ cardId: string; to: PlanningPlace } | null>(null)
  const refocus = useRef<{ id: string; kind: 'card' | 'move' } | null>(null)
  const heldTouch = useRef<{ x: number; y: number; said: boolean } | null>(null)

  const say = useCallback((text: string) => setSaid((last) => ({ n: last.n + 1, text })), [])
  const fill = fillWords

  // Where each card is drawn: on a lane inside the window, or in the tray.
  const drawn = useMemo(() => {
    const laneIds = new Set(lanes.map((lane) => lane.id))
    const bucketIds = new Set(buckets.map((bucket) => bucket.id))
    return cards.filter((card) => (card.laneId === null ? tray : laneIds.has(card.laneId) && (layout === 'columns' || (card.bucketId !== null && bucketIds.has(card.bucketId)))))
  }, [cards, lanes, buckets, tray, layout])
  const tabCard = drawn.find((card) => card.id === focusId)?.id ?? drawn[0]?.id ?? null

  const pending: Pending | null = keyMove ? { cardId: keyMove.cardId, target: keyMove.target } : drag
  const pendingCard = pending ? cards.find((card) => card.id === pending.cardId) ?? null : null
  const pendingMoves = pending && pendingCard && !samePlace(placeOf(pendingCard), pending.target, layout)
  const cardsAfter = useMemo(() => (pending && pendingMoves ? withMove(cards, pending.cardId, pending.target, layout) : null), [pending, pendingMoves, cards, layout])
  const bookedNow = useMemo(() => bookedByCell(cards, shape), [cards, shape])
  const bookedAfter = useMemo(() => (cardsAfter ? bookedByCell(cardsAfter, shape) : null), [cardsAfter, shape])
  const pendingHeld = pending && pendingCard && pendingMoves ? dropHeldReason({ card: pendingCard, to: pending.target, shape, cards, words, heldReason: held, overload, appHeld: dropHeld?.(pendingCard, pending.target) }) : null

  // After a move by keyboard, the list or undo, the focus follows the card to its new place.
  useEffect(() => {
    const wanted = refocus.current
    const root = rootRef.current
    // Wait until the save is answered: a held button is drawn inside its tooltip, so its element changes once more.
    if (!wanted || !root || saving !== null) return
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(wanted.id) : wanted.id
    const element = root.querySelector<HTMLElement>(wanted.kind === 'move' ? `[data-pb-move="${escaped}"]` : `[data-pb-card="${escaped}"]`)
    if (!element) return
    if (document.activeElement !== element) element.focus()
    refocus.current = null
  }, [cards, asList, saving])

  const focusCard = useCallback((id: string) => {
    const root = rootRef.current
    if (!root) return
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id
    const element = root.querySelector<HTMLElement>(`[data-pb-card="${escaped}"]`) ?? root.querySelector<HTMLElement>(`[data-pb-move="${escaped}"]`)
    if (!element) return
    setFocusId(id)
    element.focus()
    element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [])

  const placeOfCard = (card: PlanningCard, place: PlanningPlace = placeOf(card)) => placeWords(place, shape, words, spanAt(card, place, shape))

  /** Save one move through the app; the board says what happened and keeps it on the undo list when it did. */
  const commit = useCallback(
    async (cardId: string, to: PlanningPlace, via: PlanningVia, entry?: HistoryEntry): Promise<boolean> => {
      const card = cards.find((item) => item.id === cardId)
      if (!card) return false
      const from = placeOf(card)
      const fromWords = placeWords(from, shape, words, spanAt(card, from, shape))
      const toWords = placeWords(to, shape, words, spanAt(card, to, shape))
      const reason = dropHeldReason({ card, to, shape, cards, words, heldReason: held, overload, appHeld: dropHeld?.(card, to) })
      if (reason) {
        refocus.current = null
        say(fill(words.refused, { card: card.label, place: fromWords, reason }))
        return false
      }
      const loadAfter = landingLoads(withMove(cards, cardId, to, layout), cardId, shape)
      const move: PlanningMove = { cardId, from, to, via, loadAfter, over: loadAfter.some(isOver) }
      setSaving(cardId)
      let made = false
      try {
        made = (await onMove?.(move)) !== false
      } catch {
        made = false
      } finally {
        setSaving(null)
      }
      if (!made) {
        refocus.current = null
        say(fill(words.notMoved, { card: card.label, place: fromWords }))
        return false
      }
      setHistory((last) => recordMove(last, entry ?? { cardId, from, to }, via))
      say(fill(via === 'undo' ? words.undone : via === 'redo' ? words.redone : words.moved, { card: card.label, place: toWords }))
      return true
    },
    [cards, shape, words, held, overload, dropHeld, layout, onMove, say, fill],
  )

  const runHistory = useCallback(
    (kind: 'undo' | 'redo') => {
      const check = historyStep(history, kind, cards, layout, words, held)
      if (!check.move) {
        say(check.reason)
        return
      }
      const root = rootRef.current
      if (root && root.contains(document.activeElement) && !(document.activeElement as HTMLElement | null)?.closest('.nds-pb-bar')) {
        refocus.current = { id: check.move.cardId, kind: asList ? 'move' : 'card' }
      }
      void commit(check.move.cardId, check.move.to, kind, check.entry)
    },
    [history, cards, layout, words, held, say, commit, asList],
  )
  const undoCheck = historyStep(history, 'undo', cards, layout, words, held)
  const redoCheck = historyStep(history, 'redo', cards, layout, words, held)

  /** The words for a keyboard move's target: the place and the load after the drop, or why it is held. */
  const targetWords = (card: PlanningCard, target: PlanningPlace): string => {
    const place = placeOfCard(card, target)
    if (samePlace(placeOf(card), target, layout)) {
      return fill(words.target, { place, load: landingWords(landingLoads(cards, card.id, shape), shape, loadWords, format) })
    }
    const reason = dropHeldReason({ card, to: target, shape, cards, words, heldReason: held, overload, appHeld: dropHeld?.(card, target) })
    if (reason) return fill(words.targetHeld, { place, reason })
    if (target.laneId === null) return fill(words.targetTray, { place })
    return fill(words.target, { place, load: landingWords(landingLoads(withMove(cards, card.id, target, layout), card.id, shape), shape, loadWords, format) })
  }

  const startMove = (card: PlanningCard) => {
    if (held) return say(held)
    if (card.pinned) return say(fill(words.pinnedHeld, { card: card.label }))
    const target = moveStart(card, shape)
    setKeyMove({ cardId: card.id, target, lastBucketId: card.bucketId ?? target.bucketId })
    const pick = fill(words.pick, { card: card.label, minutes: fill(words.minutes, { minutes: minutes(card.minutes) }), place: placeOfCard(card) })
    say(samePlace(placeOf(card), target, layout) ? pick : `${pick} ${targetWords(card, target)}`)
  }

  const stepMove = (card: PlanningCard, key: Parameters<typeof moveStep>[1]) => {
    if (!keyMove) return
    const step = moveStep(keyMove.target, key, shape, keyMove.lastBucketId)
    if (step.edge) return say(step.why === 'columns' ? words.edgeColumns : words.edge)
    setKeyMove({ ...keyMove, target: step.target, lastBucketId: step.target.bucketId ?? keyMove.lastBucketId })
    say(targetWords(card, step.target))
  }

  const cancelMove = (card: PlanningCard) => {
    setKeyMove(null)
    say(fill(words.cancelled, { card: card.label, place: placeOfCard(card) }))
  }

  const dropMove = (card: PlanningCard) => {
    if (!keyMove) return
    const target = keyMove.target
    setKeyMove(null)
    if (samePlace(placeOf(card), target, layout)) return say(fill(words.cancelled, { card: card.label, place: placeOfCard(card) }))
    refocus.current = { id: card.id, kind: 'card' }
    void commit(card.id, target, 'keyboard')
  }

  const pin = (card: PlanningCard) => {
    if (!onPin) return
    if (held) return say(held)
    onPin(card, !card.pinned)
    say(fill(card.pinned ? words.unpinnedNow : words.pinnedNow, { card: card.label }))
  }

  const onCardKey = (event: ReactKeyboardEvent<HTMLElement>, card: PlanningCard) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const key = event.key
    if (keyMove && keyMove.cardId === card.id) {
      if (isMoveKey(key)) {
        event.preventDefault()
        stepMove(card, key)
      } else if (key === 'Enter' || key === ' ') {
        event.preventDefault()
        dropMove(card)
      } else if (key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        cancelMove(card)
      }
      return
    }
    if (key === ' ' || key === 'm' || key === 'M') {
      event.preventDefault()
      startMove(card)
    } else if (key === 'Enter') {
      event.preventDefault()
      onOpen?.(card)
    } else if (key === 'p' || key === 'P') {
      if (!onPin) return
      event.preventDefault()
      pin(card)
    } else if (isMoveKey(key)) {
      event.preventDefault()
      const next = nextFocus(card.id, key, drawn, shape)
      if (next) focusCard(next)
    }
  }

  const onCardBlur = (card: PlanningCard) => {
    if (keyMove && keyMove.cardId === card.id) cancelMove(card)
  }

  // A held card (pinned, read-only) says why on the first drag attempt, by pointer too.
  const heldPointer = (card: PlanningCard) => ({
    onPointerDown: (event: ReactPointerEvent) => {
      heldTouch.current = { x: event.clientX, y: event.clientY, said: false }
    },
    onPointerMove: (event: ReactPointerEvent) => {
      const start = heldTouch.current
      if (!start || start.said || event.buttons === 0) return
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) return
      start.said = true
      say(held ?? (card.pinned ? fill(words.pinnedHeld, { card: card.label }) : words.saving))
    },
    onPointerUp: () => {
      heldTouch.current = null
    },
  })

  const onRootKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || isTyping(event.target)) return
    const key = event.key.toLowerCase()
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault()
      runHistory('undo')
    } else if ((key === 'z' && event.shiftKey) || key === 'y') {
      event.preventDefault()
      runHistory('redo')
    }
  }

  /* ───────── pointer drag ───────── */

  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 4 } }), useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }))
  const drops = useMemo(() => {
    const map = new Map<string, PlanningPlace>()
    if (tray) map.set(TRAY_DROP, TRAY_PLACE)
    lanes.forEach((lane, at) => {
      if (layout === 'columns') map.set(`pb:col:${at}`, { laneId: lane.id, bucketId: null })
      else buckets.forEach((bucket, b) => map.set(`pb:cell:${at}:${b}`, { laneId: lane.id, bucketId: bucket.id }))
    })
    return map
  }, [lanes, buckets, layout, tray])
  const collide = useCallback<CollisionDetection>((args) => {
    const hits = pointerWithin(args)
    return hits.length > 0 ? hits : rectIntersection(args)
  }, [])
  const dropTarget = (overId: string | number | undefined | null, card: PlanningCard | undefined): PlanningPlace | null => {
    if (overId === undefined || overId === null) return null
    const place = drops.get(String(overId))
    if (!place) return null
    // The columns layout keeps the card's bucket.
    return layout === 'columns' && place.laneId !== null ? { laneId: place.laneId, bucketId: card?.bucketId ?? buckets[0]?.id ?? null } : place
  }
  const onDragStart = (event: DragStartEvent) => {
    if (keyMove) setKeyMove(null)
    const card = cards.find((item) => item.id === String(event.active.id))
    if (card) setDrag({ cardId: card.id, target: placeOf(card) })
  }
  const onDragOver = (event: DragOverEvent) => {
    const card = cards.find((item) => item.id === String(event.active.id))
    const target = dropTarget(event.over?.id, card)
    if (card && target) setDrag({ cardId: card.id, target })
  }
  const onDragEnd = (event: DragEndEvent) => {
    const card = cards.find((item) => item.id === String(event.active.id))
    const target = dropTarget(event.over?.id, card)
    setDrag(null)
    if (!card || !target || samePlace(placeOf(card), target, layout)) return
    void commit(card.id, target, 'pointer')
  }
  const silent = useMemo(() => ({ onDragStart: () => undefined, onDragOver: () => undefined, onDragEnd: () => undefined, onDragCancel: () => undefined }), [])

  /* ───────── parts ───────── */

  const cardProps = (card: PlanningCard) => {
    const moving = keyMove?.cardId === card.id || drag?.cardId === card.id
    const cantMove = Boolean(held) || Boolean(card.pinned) || saving === card.id
    return {
      card,
      name: cardName(card, shape, words, format),
      words,
      format,
      describedBy: instructionsId,
      tabIndex: card.id === tabCard ? 0 : -1,
      moving,
      saving: saving === card.id,
      disabled: cantMove,
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => onCardKey(event, card),
      onFocus: () => setFocusId(card.id),
      onBlur: () => onCardBlur(card),
      onClick: () => onOpen?.(card),
      heldHandlers: cantMove ? heldPointer(card) : undefined,
    }
  }

  const ghostFor = (place: { laneId: string | null }): PlanningCard | null =>
    pending && pendingCard && pendingMoves && pending.target.laneId === place.laneId ? pendingCard : null

  const cellPopover = (lane: PlanningLane, bucket: PlanningBucket, index: number) => {
    if (!cellDetails) return undefined
    const inCell = cards.flatMap((card) => {
      if (card.laneId !== lane.id || card.bucketId === null) return []
      const start = buckets.findIndex((item) => item.id === card.bucketId)
      if (start < 0 || index < start || index >= start + spanOf(card, start, buckets.length)) return []
      return [{ card, minutes: minutesByBucket(card)[index - start] ?? 0 }]
    })
    const booked = bookedNow.get(cellKey(lane.id, bucket.id)) ?? 0
    const formula = lane.capacityWords?.[bucket.id]
    return ({ close }: { close: (options?: { returnFocus?: boolean }) => void }) => {
      return (
        <div>
          <p className="nds-detailpop-h">{fill(words.cellTitle, { lane: lane.label, bucket: bucket.label })}</p>
          {formula ? <p className="nds-detailpop-reason">{formula}</p> : null}
          {inCell.length === 0 ? (
            <p className="nds-detailpop-note">{words.cellEmpty}</p>
          ) : (
            <ul className="nds-detailpop-list">
              {inCell.map(({ card, minutes: share }) => (
                <li key={card.id} className="nds-detailpop-item">
                  <span>{fill(words.cellCard, { card: card.label, minutes: fill(words.minutes, { minutes: minutes(share) }), share: booked > 0 ? `${Math.round((share / booked) * 100)}%` : '—' })}</span>
                  <Button size="xs" variant="link" onClick={() => { close(); focusCard(card.id) }}>
                    {fill(words.showOnBoard, { card: card.label })}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )
    }
  }

  const loadCell = (lane: PlanningLane, bucket: PlanningBucket, index: number, size: 'sm' | 'md' = 'sm', labelVisible = true) => {
    const key = cellKey(lane.id, bucket.id)
    const booked = bookedNow.get(key) ?? 0
    const after = bookedAfter ? bookedAfter.get(key) ?? 0 : null
    const popover = cellPopover(lane, bucket, index)
    return (
      <LoadBar
        booked={booked}
        available={capacityOf(lane, bucket.id)}
        after={after !== null && after !== booked ? after : null}
        label={fill(words.place, { lane: lane.label, bucket: bucket.label })}
        size={size}
        labelVisible={labelVisible}
        words={loadWords}
        formatMinutes={minutes}
        detail={popover ? (api: { close: (options?: { returnFocus?: boolean }) => void }) => popover(api) : undefined}
        detailLabel={fill(words.cellTitle, { lane: lane.label, bucket: bucket.label })}
      />
    )
  }

  const laneLoad = (lane: PlanningLane) => {
    const key = cellKey(lane.id, '*')
    const booked = bookedNow.get(key) ?? 0
    const after = bookedAfter ? bookedAfter.get(key) ?? 0 : null
    const formula = buckets.map((bucket) => lane.capacityWords?.[bucket.id]).filter(Boolean).join(' ')
    return (
      <LoadBar
        booked={booked}
        available={laneCapacity(lane, buckets)}
        after={after !== null && after !== booked ? after : null}
        label={lane.label}
        size="md"
        labelVisible={false}
        words={loadWords}
        formatMinutes={minutes}
        detail={cellDetails && formula ? <p className="nds-detailpop-reason">{formula}</p> : undefined}
        detailLabel={lane.label}
      />
    )
  }

  const laneHead = (lane: PlanningLane) => (
    <>
      <span className="nds-pb-lane-name">{lane.label}</span>
      {lane.detail ? <span className="nds-pb-lane-detail">{lane.detail}</span> : null}
      {lane.held ? (
        <span className="nds-pb-lane-held">
          <Lock size={12} aria-hidden="true" />
          {lane.held}
        </span>
      ) : null}
    </>
  )

  const bar = (
    <div className="nds-pb-bar">
      <span className="nds-pb-actions">
        <Button size="sm" variant="quiet" heldReason={undoCheck.move ? null : undoCheck.reason} onClick={() => runHistory('undo')}>
          <Undo2 size={14} aria-hidden="true" />
          {words.undo}
        </Button>
        <Button size="sm" variant="quiet" heldReason={redoCheck.move ? null : redoCheck.reason} onClick={() => runHistory('redo')}>
          <Redo2 size={14} aria-hidden="true" />
          {words.redo}
        </Button>
      </span>
      {held ? (
        <span className="nds-pb-held">
          <Lock size={13} aria-hidden="true" />
          {held}
        </span>
      ) : null}
      <span className="nds-pb-status" role="status" aria-live="polite">
        <span key={said.n}>{said.text}</span>
      </span>
    </div>
  )

  const trayCards = drawn.filter((card) => card.laneId === null)
  const empty = !loading && drawn.length === 0

  const trayPart = (variant: 'side' | 'column') => {
    const ghost = ghostFor(TRAY_PLACE)
    return (
      <DropZone id={TRAY_DROP} className={['nds-pb-tray', variant === 'column' ? 'is-column' : '', pending && pending.target.laneId === null && pendingMoves ? (pendingHeld ? 'is-held-target' : 'is-target') : ''].filter(Boolean).join(' ')} label={words.tray}>
        <div className="nds-pb-tray-head">
          <span className="nds-pb-lane-name">{words.tray}</span>
          <span className="nds-pb-lane-detail">{loading ? '' : String(trayCards.length)}</span>
        </div>
        <div className="nds-pb-tray-list">
          {loading ? (
            [0, 1, 2].map((n) => <Skeleton key={n} height={44} />)
          ) : trayCards.length === 0 && !ghost ? (
            <p className="nds-pb-tray-empty">{words.trayEmpty}</p>
          ) : (
            trayCards.map((card) => <BoardCard key={card.id} {...cardProps(card)} />)
          )}
          {ghost ? <GhostCard card={ghost} words={words} format={format} held={Boolean(pendingHeld)} /> : null}
        </div>
      </DropZone>
    )
  }

  const timeBoard = () => {
    const template = LANE_TEMPLATE(buckets.length)
    return (
      <div className="nds-pb-scroll" style={maxHeight !== undefined ? { maxHeight } : undefined}>
        <div className="nds-pb-time" style={{ '--nds-pb-buckets': String(buckets.length) } as CSSProperties}>
          <div className="nds-pb-headrow" style={{ gridTemplateColumns: template }}>
            <div className="nds-pb-corner">{words.lanes}</div>
            {buckets.map((bucket) => (
              <div key={bucket.id} className={['nds-pb-bucket', bucket.today ? 'is-today' : '', bucket.closed ? 'is-closed' : ''].filter(Boolean).join(' ')}>
                <span className="nds-pb-bucket-label">{bucket.label}</span>
                {bucket.detail ? <span className="nds-pb-bucket-detail">{bucket.detail}</span> : null}
                {bucket.today ? <Tag tone="info">{words.today}</Tag> : null}
                {bucket.closed ? <span className="nds-pb-bucket-closed">{fill('{closed}: {reason}', { closed: words.closed, reason: bucket.closed })}</span> : null}
              </div>
            ))}
          </div>
          {lanes.map((lane, laneAt) => {
            const index = new Map(buckets.map((bucket, at) => [bucket.id, at]))
            const onLane = drawn.filter((card) => card.laneId === lane.id)
            const ghost = ghostFor({ laneId: lane.id })
            const items = onLane.map((card) => {
              const start = index.get(card.bucketId ?? '') ?? 0
              return { id: card.id, start, span: spanOf(card, start, buckets.length) }
            })
            const ghostStart = ghost && pending ? index.get(pending.target.bucketId ?? '') ?? 0 : 0
            const ghostItem = ghost ? { id: '\u0000ghost', start: ghostStart, span: spanOf(ghost, ghostStart, buckets.length) } : null
            const tracks = packTracks(ghostItem ? [...items, ghostItem] : items)
            const trackCount = Math.max(1, ...[...tracks.values()].map((track) => track + 1))
            const rows = `1 / span ${trackCount + 1}`
            const targetCells = new Set<number>()
            if (ghostItem) for (let k = 0; k < ghostItem.span; k++) targetCells.add(ghostItem.start + k)
            return (
              <div key={lane.id} className={['nds-pb-lane', lane.held ? 'is-held' : ''].filter(Boolean).join(' ')} style={{ gridTemplateColumns: template }} role="group" aria-label={lane.label}>
                <div className="nds-pb-lane-head" style={{ gridRow: rows }}>
                  {laneHead(lane)}
                </div>
                {buckets.map((bucket, b) => {
                  const closed = bucket.closed || lane.closed?.[bucket.id]
                  const after = bookedAfter?.get(cellKey(lane.id, bucket.id))
                  const overAfter = targetCells.has(b) && typeof after === 'number' && isOver({ booked: after, available: capacityOf(lane, bucket.id) })
                  return (
                    <DropZone
                      key={bucket.id}
                      id={`pb:cell:${laneAt}:${b}`}
                      className={[
                        'nds-pb-cell',
                        bucket.today ? 'is-today' : '',
                        closed ? 'is-closed' : '',
                        targetCells.has(b) ? (pendingHeld ? 'is-held-target' : overAfter ? 'is-over-target' : 'is-target') : '',
                      ].filter(Boolean).join(' ')}
                      style={{ gridColumn: `${b + 2}`, gridRow: rows }}
                      title={closed || undefined}
                    />
                  )
                })}
                {buckets.map((bucket, b) => (
                  <div key={bucket.id} className="nds-pb-load" style={{ gridColumn: `${b + 2}`, gridRow: '1' }}>
                    {loading ? <Skeleton height={26} /> : loadCell(lane, bucket, b)}
                  </div>
                ))}
                {loading
                  ? <div className="nds-pb-skeleton" style={{ gridColumn: `2 / span ${Math.max(1, Math.min(2, buckets.length))}`, gridRow: '2' }}><Skeleton height={44} /></div>
                  : onLane.map((card) => {
                    const item = items.find((entry) => entry.id === card.id)
                    if (!item) return null
                    return <BoardCard key={card.id} {...cardProps(card)} style={{ gridColumn: `${item.start + 2} / span ${item.span}`, gridRow: `${(tracks.get(card.id) ?? 0) + 2}` }} />
                  })}
                {ghost && ghostItem ? (
                  <GhostCard card={ghost} words={words} format={format} held={Boolean(pendingHeld)} style={{ gridColumn: `${ghostItem.start + 2} / span ${ghostItem.span}`, gridRow: `${(tracks.get(ghostItem.id) ?? 0) + 2}` }} />
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const columnsBoard = () => (
    <div className="nds-pb-scroll" style={maxHeight !== undefined ? { maxHeight } : undefined}>
      <div className="nds-pb-columns" style={{ gridTemplateColumns: `repeat(${lanes.length + (tray ? 1 : 0)}, minmax(var(--nds-pb-col-min), 1fr))` }}>
        {tray ? trayPart('column') : null}
        {lanes.map((lane, at) => {
          const ghost = ghostFor({ laneId: lane.id })
          const onLane = drawn.filter((card) => card.laneId === lane.id)
          const target = Boolean(ghost)
          return (
            <DropZone
              key={lane.id}
              id={`pb:col:${at}`}
              className={['nds-pb-column', lane.held ? 'is-held' : '', target ? (pendingHeld ? 'is-held-target' : 'is-target') : ''].filter(Boolean).join(' ')}
              label={lane.label}
            >
              <div className="nds-pb-column-head">{laneHead(lane)}</div>
              <div className="nds-pb-column-load">{loading ? <Skeleton height={34} /> : laneLoad(lane)}</div>
              <div className="nds-pb-column-list">
                {loading ? <Skeleton height={44} /> : onLane.map((card) => <BoardCard key={card.id} {...cardProps(card)} />)}
                {ghost ? <GhostCard card={ghost} words={words} format={format} held={Boolean(pendingHeld)} /> : null}
              </div>
            </DropZone>
          )
        })}
      </div>
    </div>
  )

  /* ───────── the list (phone width) ───────── */

  const listCard = (card: PlanningCard) => {
    const why = held || (card.pinned ? fill(words.pinnedHeld, { card: card.label }) : null)
    return (
      <li key={card.id} className={['nds-pb-listcard', card.late ? 'is-late' : '', card.pinned ? 'is-pinned' : ''].filter(Boolean).join(' ')} aria-busy={saving === card.id || undefined}>
        <span className="nds-pb-listcard-face" aria-hidden="true">
          <CardFace card={card} words={words} format={format} />
        </span>
        <span className="nds-vh">{cardName(card, shape, words, format)}</span>
        <span className="nds-pb-listcard-actions">
          {onOpen ? (
            <Button size="sm" variant="quiet" onClick={() => onOpen(card)} aria-label={fill(words.openCard, { card: card.label })}>
              {words.open}
            </Button>
          ) : null}
          <Button size="sm" data-pb-move={card.id} heldReason={why} onClick={() => setListMove({ cardId: card.id, to: moveStart(card, shape) })} aria-label={fill(words.moveTitle, { card: card.label })}>
            <ArrowRightLeft size={14} aria-hidden="true" />
            {words.move}
          </Button>
        </span>
      </li>
    )
  }

  const listBoard = () => (
    <div className="nds-pb-list">
      {lanes.map((lane) => {
        const onLane = drawn.filter((card) => card.laneId === lane.id)
        return (
          <section key={lane.id} className={['nds-pb-list-lane', lane.held ? 'is-held' : ''].filter(Boolean).join(' ')} aria-label={lane.label}>
            <div className="nds-pb-list-head">{laneHead(lane)}</div>
            {layout === 'columns' ? (
              <>
                {loading ? <Skeleton height={34} /> : laneLoad(lane)}
                <ul className="nds-pb-list-cards">{onLane.map(listCard)}</ul>
              </>
            ) : (
              buckets.map((bucket, b) => {
                const starting = onLane.filter((card) => card.bucketId === bucket.id)
                return (
                  <div key={bucket.id} className={['nds-pb-list-bucket', bucket.today ? 'is-today' : ''].filter(Boolean).join(' ')}>
                    <div className="nds-pb-list-bucket-head">
                      <span className="nds-pb-bucket-label">{bucket.label}</span>
                      {bucket.today ? <Tag tone="info">{words.today}</Tag> : null}
                      {bucket.closed || lane.closed?.[bucket.id] ? <span className="nds-pb-bucket-closed">{fill('{closed}: {reason}', { closed: words.closed, reason: bucket.closed || lane.closed?.[bucket.id] || '' })}</span> : null}
                    </div>
                    {loading ? <Skeleton height={26} /> : loadCell(lane, bucket, b, 'md', false)}
                    {starting.length > 0 ? <ul className="nds-pb-list-cards">{starting.map(listCard)}</ul> : null}
                  </div>
                )
              })
            )}
          </section>
        )
      })}
      {tray ? (
        <section className="nds-pb-list-lane is-tray" aria-label={words.tray}>
          <div className="nds-pb-list-head">
            <span className="nds-pb-lane-name">{words.tray}</span>
            <span className="nds-pb-lane-detail">{loading ? '' : String(trayCards.length)}</span>
          </div>
          {trayCards.length === 0 ? <p className="nds-pb-tray-empty">{loading ? '' : words.trayEmpty}</p> : <ul className="nds-pb-list-cards">{trayCards.map(listCard)}</ul>}
        </section>
      ) : null}
    </div>
  )

  const listDialog = () => {
    if (!listMove) return null
    const card = cards.find((item) => item.id === listMove.cardId)
    if (!card) return null
    const to = listMove.to
    const reason = dropHeldReason({ card, to, shape, cards, words, heldReason: held, overload, appHeld: dropHeld?.(card, to) })
    const landing = to.laneId === null ? [] : landingLoads(withMove(cards, card.id, to, layout), card.id, shape)
    const lane = lanes.find((item) => item.id === to.laneId)
    const close = () => setListMove(null)
    const confirm = () => {
      setListMove(null)
      refocus.current = { id: card.id, kind: 'move' }
      void commit(card.id, to, 'list')
    }
    return (
      <Modal
        open
        onClose={close}
        size="sm"
        title={fill(words.moveTitle, { card: card.label })}
        returnFocusTo={() => rootRef.current?.querySelector<HTMLElement>(`[data-pb-move="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(card.id) : card.id}"]`) ?? null}
        footer={
          <>
            <Button onClick={close}>{words.moveCancel}</Button>
            <Button variant="primary" heldReason={reason} onClick={confirm}>
              {words.moveConfirm}
            </Button>
          </>
        }
      >
        <div className="nds-pb-movedialog">
          <p className="nds-pb-movedialog-from">{cardName(card, shape, words, format)}</p>
          <Field label={words.moveLane}>
            <Select
              value={to.laneId ?? ''}
              onChange={(event) => {
                const laneId = event.target.value === '' ? null : event.target.value
                setListMove({ cardId: card.id, to: laneId === null ? TRAY_PLACE : { laneId, bucketId: layout === 'columns' ? card.bucketId : to.bucketId ?? card.bucketId ?? buckets[0]?.id ?? null } })
              }}
            >
              {tray ? <option value="">{words.tray}</option> : null}
              {lanes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.held ? `${item.label} — ${item.held}` : item.label}
                </option>
              ))}
            </Select>
          </Field>
          {layout === 'time' && to.laneId !== null ? (
            <Field label={words.moveBucket}>
              <Select value={to.bucketId ?? ''} onChange={(event) => setListMove({ cardId: card.id, to: { laneId: to.laneId, bucketId: event.target.value } })}>
                {buckets.map((bucket) => {
                  const closed = bucket.closed || lane?.closed?.[bucket.id]
                  return (
                    <option key={bucket.id} value={bucket.id}>
                      {closed ? `${bucket.label} — ${words.closed}` : bucket.label}
                    </option>
                  )
                })}
              </Select>
            </Field>
          ) : null}
          {landing.map((cell) => {
            const bucket = buckets.find((item) => item.id === cell.bucketId)
            return (
              <LoadBar
                key={cell.bucketId}
                booked={cell.booked}
                available={cell.available}
                label={bucket ? fill(words.place, { lane: lane?.label ?? '', bucket: bucket.label }) : lane?.label ?? ''}
                size="md"
                words={loadWords}
                formatMinutes={minutes}
              />
            )
          })}
          {reason && reason !== words.samePlace ? <p className="nds-pb-movedialog-held">{reason}</p> : null}
        </div>
      </Modal>
    )
  }

  const overlayCard = drag ? cards.find((card) => card.id === drag.cardId) : undefined
  const grid = layout === 'columns' ? columnsBoard() : timeBoard()

  return (
    <div
      ref={rootRef}
      className={['nds-pb', asList ? 'is-list' : `is-${layout}`, keyMove || drag ? 'is-moving' : '', className ?? ''].filter(Boolean).join(' ')}
      role="region"
      aria-label={label}
      aria-busy={loading || undefined}
      onKeyDown={onRootKey}
    >
      <span id={instructionsId} className="nds-vh">
        {words.instructions}
      </span>
      {bar}
      {empty ? <p className="nds-pb-empty">{words.empty}</p> : null}
      {asList ? (
        listBoard()
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={collide}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDrag(null)}
          accessibility={{ announcements: silent, screenReaderInstructions: { draggable: words.instructions } }}
        >
          {layout === 'time' && tray ? (
            <div className="nds-pb-body has-tray">
              {grid}
              {trayPart('side')}
            </div>
          ) : (
            grid
          )}
          {typeof document !== 'undefined'
            ? createPortal(
                <DragOverlay dropAnimation={null} zIndex={1000}>
                  {overlayCard ? (
                    <div className="nds-pb-card is-overlay">
                      <CardFace card={overlayCard} words={words} format={format} />
                    </div>
                  ) : null}
                </DragOverlay>,
                document.body,
              )
            : null}
        </DndContext>
      )}
      {listDialog()}
    </div>
  )
}

/* ─────────────────────────── small parts ─────────────────────────── */

function DropZone({ id, className, style, title, label, children }: { id: string; className: string; style?: CSSProperties; title?: string; label?: string; children?: ReactNode }) {
  const { setNodeRef, isOver: hovered } = useDroppable({ id })
  return (
    <div ref={setNodeRef} className={[className, hovered ? 'is-hovered' : ''].filter(Boolean).join(' ')} style={style} title={title} role={label ? 'group' : undefined} aria-label={label}>
      {children}
    </div>
  )
}

function CardFace({ card, words, format }: { card: PlanningCard; words: PlanningBoardWords; format: Formatter }) {
  return (
    <>
      <span className="nds-pb-card-top">
        <span className="nds-pb-card-label">{card.label}</span>
        {card.pinned ? (
          <span className="nds-pb-card-pin">
            <Pin size={12} aria-hidden="true" />
            {words.pinned}
          </span>
        ) : null}
      </span>
      {card.detail ? <span className="nds-pb-card-detail">{card.detail}</span> : null}
      <span className="nds-pb-card-minutes">{fillWords(words.minutes, { minutes: format.minutes(Number.isFinite(card.minutes) ? card.minutes : 0) })}</span>
      {card.late || (card.marks && card.marks.length > 0) ? (
        <span className="nds-pb-card-marks">
          {card.late ? <Tag tone="danger">{words.late}</Tag> : null}
          {(card.marks ?? []).map((mark) => (
            <Tag key={mark.label} tone={mark.tone ?? 'neutral'}>
              {mark.label}
            </Tag>
          ))}
        </span>
      ) : null}
      {card.note ? <span className="nds-pb-card-note">{card.note}</span> : null}
    </>
  )
}

interface BoardCardProps {
  card: PlanningCard
  name: string
  words: PlanningBoardWords
  format: Formatter
  describedBy: string
  tabIndex: number
  moving: boolean
  saving: boolean
  disabled: boolean
  style?: CSSProperties
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
  onFocus: () => void
  onBlur: () => void
  onClick: () => void
  heldHandlers?: {
    onPointerDown: (event: ReactPointerEvent) => void
    onPointerMove: (event: ReactPointerEvent) => void
    onPointerUp: () => void
  }
}

function BoardCard({ card, name, words, format, describedBy, tabIndex, moving, saving, disabled, style, onKeyDown, onFocus, onBlur, onClick, heldHandlers }: BoardCardProps) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: card.id, disabled })
  return (
    <div
      ref={setNodeRef}
      role="button"
      tabIndex={tabIndex}
      aria-label={name}
      aria-describedby={describedBy}
      aria-busy={saving || undefined}
      data-pb-card={card.id}
      className={[
        'nds-pb-card',
        card.late ? 'is-late' : '',
        card.pinned ? 'is-pinned' : '',
        moving || isDragging ? 'is-moving' : '',
        saving ? 'is-saving' : '',
      ].filter(Boolean).join(' ')}
      style={style}
      {...listeners}
      {...heldHandlers}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      onClick={onClick}
    >
      <CardFace card={card} words={words} format={format} />
      {saving ? <span className="nds-vh">{words.saving}</span> : null}
    </div>
  )
}

function GhostCard({ card, words, format, held, style }: { card: PlanningCard; words: PlanningBoardWords; format: Formatter; held: boolean; style?: CSSProperties }) {
  return (
    <div className={['nds-pb-card', 'is-ghost', held ? 'is-held' : ''].filter(Boolean).join(' ')} style={style} aria-hidden="true" data-pb-ghost="">
      <CardFace card={card} words={words} format={format} />
    </div>
  )
}
