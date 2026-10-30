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
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRightLeft, Lock } from 'lucide-react'
import { Menu } from '../../../components/Menu'
import { Button } from '../../../primitives/Button'
import { Skeleton } from '../../../primitives/Skeleton'
import { Tag } from '../../../primitives/Tag'
import {
  BOARD_VIEW_WORDS,
  boardTabStop,
  cardName,
  cardsByLane,
  countWords,
  fillWords,
  isBoardArrow,
  laneCount,
  laneStep,
  moveHeldReason,
  moveMenu,
  nextCardFocus,
  pickHeldReason,
  targetWords,
  type BoardCard,
  type BoardLane,
  type BoardMove,
  type BoardVia,
  type BoardViewWords,
} from './boardViewModel'
import './board-view.css'

export interface BoardViewProps {
  /** The board's name (a region): "Nonconformances · board". */
  label: string
  /** The statuses, in the list's order. */
  lanes: readonly BoardLane[]
  /** The list's rows as cards, in the list's sort. */
  cards: readonly BoardCard[]
  /**
   * A move passed every check (drag, keyboard, the Move to… menu). The app saves it — or opens its own dialog first (a
   * drop on Closed asks for the closing signature) — and passes the cards back. Return `false` (or a promise of
   * `false`) when it did not happen: the board says so. Without it the board is read-only.
   */
  onMove?: (move: BoardMove) => void | boolean | Promise<void | boolean>
  /** The app's rule for one card in one lane: why it may not go there ("3 of 40 garments not decided"), or nothing. */
  moveHeld?: (card: BoardCard, laneId: string) => string | null | undefined
  /** A card was opened (click, Enter). Without it a card with `href` follows its link. */
  onOpen?: (card: BoardCard) => void
  /** "Show more" under a lane whose `total` is more than the cards drawn: the app reads the next page of that lane. */
  onMore?: (lane: BoardLane) => void
  /** Why nothing can move now (read-only for this person, offline): said at rest and on every attempt. */
  heldReason?: string | null
  /** The lanes are known, the cards not yet: skeleton cards under the lane heads. */
  loading?: boolean
  /** `board` (default) or always the `list`. The board becomes the list below `listBelow` px of its own width. */
  layout?: 'board' | 'list'
  /** Below this width (px, the board's own) the lanes stack as a list (a phone). Default 640. */
  listBelow?: number
  /** Each lane's cards scroll inside this height; default: the lanes grow with their cards. */
  maxHeight?: number | string
  /** A small part at the card's top right (a due-date countdown). Not interactive: it sits inside the card's button. */
  renderAside?: (card: BoardCard) => ReactNode
  /** A part under the card's face (a "decided" bar). It may hold its own control. */
  renderFooter?: (card: BoardCard) => ReactNode
  words?: Partial<BoardViewWords>
  /** The page's language for numbers (default `en-GB`). */
  locale?: string
  /** Start with a keyboard move under way (a design case). */
  defaultMove?: { cardId: string; to: string }
  className?: string
}

const DROP = 'bv:lane:'

const escapeId = (id: string): string => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id)

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
 * BoardView — a list's rows as a board by status (gap D19): one lane per status with its count (and the app's line,
 * "Oldest 12 days"), the rows as cards in the list's sort (number, title, the list's fields, marks, an aside such as a
 * due-date countdown, a footer such as a "decided" bar). A view mode of the list beside the table: the same rows, the
 * same filters and saved views; the app switches the mode.
 *
 * Moves, all with the same checks (`boardViewModel.ts`) and the same words:
 * - drag a card onto another lane (mouse; on touch a long press);
 * - keyboard: one Tab stop for the board, arrows move the focus between cards; Space or M picks the focused card up,
 *   ← → choose the lane, Enter or Space drops, Escape cancels; every step is said;
 * - the card's Move to… menu: every other lane, each held one with its reason.
 * Refusals in order: read-only / offline (`heldReason`), the card's own reason, the target lane's reason, the app's
 * `moveHeld`. The board calls nothing: `onMove` saves (or opens the app's dialog first) and the cards come back.
 * Below `listBelow` px of its own width the lanes stack (a phone). Every word comes in through `words` (English by
 * default). Its own entry point (not the grid barrel): `@nexus/ui/grid/views/board/index`.
 */
export function BoardView(props: BoardViewProps) {
  const {
    label,
    lanes,
    cards,
    onMove,
    moveHeld,
    onOpen,
    onMore,
    heldReason,
    loading = false,
    layout = 'board',
    listBelow = 640,
    maxHeight,
    renderAside,
    renderFooter,
    locale,
    defaultMove,
    className,
  } = props
  const words = useMemo<BoardViewWords>(() => ({ ...BOARD_VIEW_WORDS, ...props.words }), [props.words])
  const held = heldReason || (onMove ? null : words.readOnly)
  const rootRef = useRef<HTMLDivElement>(null)
  const width = useOwnWidth(rootRef)
  const asList = layout === 'list' || (width !== null && width < listBelow)
  const instructionsId = useId()

  const byLane = useMemo(() => cardsByLane(cards, lanes), [cards, lanes])
  const laneOf = useCallback((id: string) => lanes.find((lane) => lane.id === id), [lanes])
  const [focusId, setFocusId] = useState<string | null>(null)
  const tabCard = boardTabStop(byLane, lanes, focusId)
  const [keyMove, setKeyMove] = useState<{ cardId: string; to: string } | null>(defaultMove ?? null)
  const [drag, setDrag] = useState<{ cardId: string; to: string | null } | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [said, setSaid] = useState<{ n: number; text: string }>({ n: 0, text: '' })
  const refocus = useRef<string | null>(null)
  const heldTouch = useRef<{ x: number; y: number; said: boolean } | null>(null)
  const say = useCallback((text: string) => setSaid((last) => ({ n: last.n + 1, text })), [])

  const appHeld = useCallback((card: BoardCard, to: string) => moveHeld?.(card, to) ?? null, [moveHeld])
  const reasonFor = useCallback((card: BoardCard, to: string) => moveHeldReason({ card, to, lanes, words, heldReason: held, appHeld: appHeld(card, to) }), [lanes, words, held, appHeld])

  // After a move (keyboard or menu) the focus follows the card to its new lane, once the app has passed it back.
  useEffect(() => {
    const wanted = refocus.current
    const root = rootRef.current
    if (!wanted || !root || saving !== null) return
    const element = root.querySelector<HTMLElement>(`[data-bv-card="${escapeId(wanted)}"]`)
    if (!element) return
    if (document.activeElement !== element) element.focus()
    refocus.current = null
  }, [cards, asList, saving])

  const focusCard = useCallback((id: string) => {
    const element = rootRef.current?.querySelector<HTMLElement>(`[data-bv-card="${escapeId(id)}"]`)
    if (!element) return
    setFocusId(id)
    element.focus()
    element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [])

  /** Hand one move to the app; the board says what happened. */
  const commit = useCallback(
    async (card: BoardCard, to: string, via: BoardVia): Promise<boolean> => {
      const from = laneOf(card.laneId)
      const reason = reasonFor(card, to)
      if (reason) {
        say(fillWords(words.refused, { card: card.label, lane: from?.label ?? '', reason }))
        return false
      }
      const move: BoardMove = { cardId: card.id, from: card.laneId, to, via }
      setSaving(card.id)
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
        say(fillWords(words.notMoved, { card: card.label, lane: from?.label ?? '' }))
        return false
      }
      say(fillWords(words.moved, { card: card.label, lane: laneOf(to)?.label ?? '' }))
      return true
    },
    [laneOf, reasonFor, say, words, onMove],
  )

  const startMove = (card: BoardCard) => {
    const why = pickHeldReason(card, held)
    if (why) return say(why)
    setKeyMove({ cardId: card.id, to: card.laneId })
    say(fillWords(words.pick, { card: card.label, lane: laneOf(card.laneId)?.label ?? '' }))
  }

  const dirOf = (element: Element | null): 'ltr' | 'rtl' => (element && typeof getComputedStyle === 'function' && getComputedStyle(element).direction === 'rtl' ? 'rtl' : 'ltr')

  const onCardKey = (event: ReactKeyboardEvent<HTMLElement>, card: BoardCard) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const key = event.key
    if (keyMove && keyMove.cardId === card.id) {
      if (isBoardArrow(key)) {
        event.preventDefault()
        const step = laneStep(lanes, keyMove.to, key, dirOf(rootRef.current))
        if (step.edge) return say(step.why === 'upDown' ? words.upDown : words.edge)
        setKeyMove({ cardId: card.id, to: step.to })
        say(targetWords({ card, to: step.to, lanes, words, heldReason: held, appHeld: appHeld(card, step.to) }, laneOf(step.to), words))
      } else if (key === 'Enter' || key === ' ') {
        event.preventDefault()
        const to = keyMove.to
        setKeyMove(null)
        if (to === card.laneId) return say(fillWords(words.cancelled, { card: card.label, lane: laneOf(card.laneId)?.label ?? '' }))
        refocus.current = card.id
        void commit(card, to, 'keyboard')
      } else if (key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setKeyMove(null)
        say(fillWords(words.cancelled, { card: card.label, lane: laneOf(card.laneId)?.label ?? '' }))
      }
      return
    }
    if (key === ' ' || key === 'm' || key === 'M') {
      event.preventDefault()
      startMove(card)
    } else if (key === 'Enter') {
      event.preventDefault()
      open(card)
    } else if (isBoardArrow(key)) {
      event.preventDefault()
      const next = nextCardFocus(byLane, lanes, card.id, key, dirOf(rootRef.current))
      if (next) focusCard(next)
    }
  }

  const onCardBlur = (card: BoardCard) => {
    if (keyMove && keyMove.cardId === card.id) {
      setKeyMove(null)
      say(fillWords(words.cancelled, { card: card.label, lane: laneOf(card.laneId)?.label ?? '' }))
    }
  }

  const open = (card: BoardCard) => {
    if (onOpen) return onOpen(card)
    if (card.href) rootRef.current?.querySelector<HTMLAnchorElement>(`[data-bv-open="${escapeId(card.id)}"]`)?.click()
  }

  // A card that cannot move says why on the first drag attempt, by pointer too.
  const heldPointer = (card: BoardCard) => ({
    onPointerDown: (event: ReactPointerEvent) => {
      heldTouch.current = { x: event.clientX, y: event.clientY, said: false }
    },
    onPointerMove: (event: ReactPointerEvent) => {
      const start = heldTouch.current
      if (!start || start.said || event.buttons === 0) return
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) return
      start.said = true
      say(pickHeldReason(card, held) ?? words.saving)
    },
    onPointerUp: () => {
      heldTouch.current = null
    },
  })

  /* ───────── pointer drag ───────── */

  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 4 } }), useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }))
  const collide = useCallback<CollisionDetection>((args) => {
    const hits = pointerWithin(args)
    return hits.length > 0 ? hits : rectIntersection(args)
  }, [])
  const laneFromDrop = (id: string | number | undefined | null): string | null => {
    if (id === undefined || id === null) return null
    const text = String(id)
    return text.startsWith(DROP) ? text.slice(DROP.length) : null
  }
  const onDragStart = (event: DragStartEvent) => {
    if (keyMove) setKeyMove(null)
    const card = cards.find((item) => item.id === String(event.active.id))
    if (card) setDrag({ cardId: card.id, to: card.laneId })
  }
  const onDragOver = (event: DragOverEvent) => {
    setDrag((last) => (last ? { ...last, to: laneFromDrop(event.over?.id) } : last))
  }
  const onDragEnd = (event: DragEndEvent) => {
    const card = cards.find((item) => item.id === String(event.active.id))
    const to = laneFromDrop(event.over?.id)
    setDrag(null)
    if (!card || !to || to === card.laneId) return
    void commit(card, to, 'pointer')
  }
  const silent = useMemo(() => ({ onDragStart: () => undefined, onDragOver: () => undefined, onDragEnd: () => undefined, onDragCancel: () => undefined }), [])

  /* ───────── parts ───────── */

  const pending = keyMove ?? (drag && drag.to ? { cardId: drag.cardId, to: drag.to } : null)
  const pendingCard = pending ? cards.find((card) => card.id === pending.cardId) ?? null : null
  const pendingHeld = pending && pendingCard && pending.to !== pendingCard.laneId ? reasonFor(pendingCard, pending.to) : null

  const menuFor = (card: BoardCard, tabIndex: number) => {
    const why = pickHeldReason(card, held)
    const name = fillWords(words.moveToCard, { card: card.label })
    if (why || saving === card.id) {
      return (
        <Button size="xs" variant="quiet" tabIndex={tabIndex} heldReason={why ?? words.saving} aria-label={name}>
          <ArrowRightLeft size={13} aria-hidden="true" />
          {words.moveTo}
        </Button>
      )
    }
    const items = moveMenu(card, lanes, words, held, (laneId) => appHeld(card, laneId)).map((item) => ({
      id: item.laneId,
      label: fillWords(words.moveHere, { lane: item.label }),
      disabled: Boolean(item.held),
      description: item.held ?? undefined,
      onSelect: () => {
        refocus.current = card.id
        void commit(card, item.laneId, 'menu')
      },
    }))
    return (
      <Menu
        label={
          <>
            <ArrowRightLeft size={13} aria-hidden="true" />
            {words.moveTo}
          </>
        }
        items={items}
        triggerProps={{ className: 'nds-btn xs quiet', 'aria-label': name, tabIndex }}
      />
    )
  }

  const cardPart = (card: BoardCard, lane: BoardLane) => {
    const moving = keyMove?.cardId === card.id || drag?.cardId === card.id
    const cantMove = Boolean(pickHeldReason(card, held)) || saving === card.id
    const tabIndex = card.id === tabCard ? 0 : -1
    return (
      <BoardCardItem
        key={card.id}
        card={card}
        name={cardName(card, lane, words)}
        words={words}
        describedBy={instructionsId}
        tabIndex={tabIndex}
        moving={moving}
        saving={saving === card.id}
        dragDisabled={cantMove || asList}
        onKeyDown={(event) => onCardKey(event, card)}
        onFocus={() => setFocusId(card.id)}
        onBlur={() => onCardBlur(card)}
        onClick={() => open(card)}
        heldHandlers={cantMove ? heldPointer(card) : undefined}
        aside={renderAside?.(card)}
        footer={renderFooter?.(card)}
        actions={
          <>
            {menuFor(card, tabIndex)}
            {card.href ? (
              <Button asChild size="xs" variant="quiet">
                <a href={card.href} tabIndex={tabIndex} data-bv-open={card.id} aria-label={fillWords(words.openCard, { card: card.label })}>
                  {words.open}
                </a>
              </Button>
            ) : null}
          </>
        }
      />
    )
  }

  const lanePart = (lane: BoardLane) => {
    const own = byLane.get(lane.id) ?? []
    const count = laneCount(lane, own.length)
    const target = pending && pendingCard && pending.to === lane.id && pending.to !== pendingCard.laneId
    const more = typeof lane.total === 'number' && lane.total > own.length
    return (
      <LaneZone
        key={lane.id}
        id={`${DROP}${lane.id}`}
        label={lane.label}
        className={['nds-bv-lane', lane.held ? 'is-held' : '', target ? (pendingHeld ? 'is-held-target' : 'is-target') : ''].filter(Boolean).join(' ')}
        tone={lane.tone}
      >
        <div className="nds-bv-lane-head">
          <span className="nds-bv-lane-name">{lane.label}</span>
          <span className="nds-bv-lane-count" aria-hidden="true">
            {loading ? '' : new Intl.NumberFormat(locale ?? 'en-GB').format(count)}
          </span>
          {loading ? null : <span className="nds-vh">{countWords(count, words, locale)}</span>}
          {lane.detail ? <span className="nds-bv-lane-detail">{lane.detail}</span> : null}
          {lane.held ? (
            <span className="nds-bv-lane-held">
              <Lock size={12} aria-hidden="true" />
              {lane.held}
            </span>
          ) : null}
        </div>
        <ul className="nds-bv-lane-cards" style={maxHeight !== undefined ? { maxHeight } : undefined}>
          {loading ? (
            [0, 1].map((n) => (
              <li key={n} className="nds-bv-skeleton">
                <Skeleton height={72} />
              </li>
            ))
          ) : own.length === 0 && !target ? (
            <li className="nds-bv-lane-empty">{words.laneEmpty}</li>
          ) : (
            own.map((card) => cardPart(card, lane))
          )}
          {target && pendingCard ? (
            <li className={['nds-bv-ghost', pendingHeld ? 'is-held' : ''].filter(Boolean).join(' ')} aria-hidden="true" data-bv-ghost="">
              <span className="nds-bv-card-label">{pendingCard.label}</span>
              <span className="nds-bv-ghost-words">
                {pendingHeld ? <Lock size={12} aria-hidden="true" /> : null}
                {pendingHeld ? fillWords(words.dropHeld, { reason: pendingHeld }) : words.dropHere}
              </span>
            </li>
          ) : null}
        </ul>
        {more && !loading ? (
          <div className="nds-bv-lane-foot">
            <span className="nds-bv-lane-shown">{fillWords(words.laneShown, { shown: new Intl.NumberFormat(locale ?? 'en-GB').format(own.length), total: new Intl.NumberFormat(locale ?? 'en-GB').format(lane.total ?? 0) })}</span>
            {onMore ? (
              <Button size="xs" variant="quiet" onClick={() => onMore(lane)}>
                {words.more}
              </Button>
            ) : null}
          </div>
        ) : null}
      </LaneZone>
    )
  }

  const overlayCard = drag ? cards.find((card) => card.id === drag.cardId) : undefined
  const lanesPart = (
    <div className="nds-bv-scroll">
      <div className="nds-bv-lanes" style={asList ? undefined : { gridTemplateColumns: `repeat(${Math.max(1, lanes.length)}, minmax(var(--nds-bv-lane-min), 1fr))` }}>
        {lanes.map(lanePart)}
      </div>
    </div>
  )

  return (
    <div
      ref={rootRef}
      className={['nds-bv', asList ? 'is-list' : 'is-board', keyMove || drag ? 'is-moving' : '', className ?? ''].filter(Boolean).join(' ')}
      role="region"
      aria-label={label}
      aria-busy={loading || undefined}
    >
      <span id={instructionsId} className="nds-vh">
        {words.instructions}
      </span>
      {held ? (
        <p className="nds-bv-held">
          <Lock size={13} aria-hidden="true" />
          {held}
        </p>
      ) : null}
      <p className="nds-bv-status" role="status" aria-live="polite">
        <span key={said.n}>{said.text}</span>
      </p>
      {asList ? (
        lanesPart
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
          {lanesPart}
          {typeof document !== 'undefined'
            ? createPortal(
                <DragOverlay dropAnimation={null} zIndex={1000}>
                  {overlayCard ? (
                    <div className="nds-bv-card is-overlay">
                      <CardFace card={overlayCard} />
                    </div>
                  ) : null}
                </DragOverlay>,
                document.body,
              )
            : null}
        </DndContext>
      )}
    </div>
  )
}

/* ─────────────────────────── small parts ─────────────────────────── */

function LaneZone({ id, label, className, tone, children }: { id: string; label: string; className: string; tone?: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <section ref={setNodeRef} className={[className, isOver ? 'is-hovered' : ''].filter(Boolean).join(' ')} aria-label={label} data-tone={tone ?? 'neutral'}>
      {children}
    </section>
  )
}

function CardFace({ card, aside }: { card: BoardCard; aside?: ReactNode }) {
  return (
    <>
      <span className="nds-bv-card-top">
        <span className="nds-bv-card-label">{card.label}</span>
        {aside ? <span className="nds-bv-card-aside">{aside}</span> : null}
      </span>
      {card.title ? <span className="nds-bv-card-title">{card.title}</span> : null}
      {card.fields && card.fields.length > 0 ? (
        <span className="nds-bv-card-fields">
          {card.fields.map((field) => (
            <span key={field.label} className="nds-bv-card-field">
              <span className="nds-bv-card-field-label">{field.label}</span>
              <span className="nds-bv-card-field-value">{field.value}</span>
            </span>
          ))}
        </span>
      ) : null}
      {card.marks && card.marks.length > 0 ? (
        <span className="nds-bv-card-marks">
          {card.marks.map((mark) => (
            <Tag key={mark.label} tone={mark.tone ?? 'neutral'}>
              {mark.label}
            </Tag>
          ))}
        </span>
      ) : null}
      {card.held ? (
        <span className="nds-bv-card-held">
          <Lock size={12} aria-hidden="true" />
          {card.held}
        </span>
      ) : null}
    </>
  )
}

interface BoardCardItemProps {
  card: BoardCard
  name: string
  words: BoardViewWords
  describedBy: string
  tabIndex: number
  moving: boolean
  saving: boolean
  dragDisabled: boolean
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
  onFocus: () => void
  onBlur: () => void
  onClick: () => void
  heldHandlers?: {
    onPointerDown: (event: ReactPointerEvent) => void
    onPointerMove: (event: ReactPointerEvent) => void
    onPointerUp: () => void
  }
  aside?: ReactNode
  footer?: ReactNode
  actions: ReactNode
}

function BoardCardItem({ card, name, words, describedBy, tabIndex, moving, saving, dragDisabled, onKeyDown, onFocus, onBlur, onClick, heldHandlers, aside, footer, actions }: BoardCardItemProps) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: card.id, disabled: dragDisabled })
  return (
    <li className={['nds-bv-card', card.held ? 'is-held' : '', moving || isDragging ? 'is-moving' : '', saving ? 'is-saving' : ''].filter(Boolean).join(' ')} aria-busy={saving || undefined}>
      <div
        ref={setNodeRef}
        role="button"
        tabIndex={tabIndex}
        aria-label={name}
        aria-describedby={describedBy}
        data-bv-card={card.id}
        className="nds-bv-card-face"
        {...listeners}
        {...heldHandlers}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        onClick={onClick}
      >
        <CardFace card={card} aside={aside} />
        {saving ? <span className="nds-bv-card-saving">{words.saving}</span> : null}
      </div>
      {footer ? <div className="nds-bv-card-footer">{footer}</div> : null}
      <div className="nds-bv-card-actions">{actions}</div>
    </li>
  )
}
