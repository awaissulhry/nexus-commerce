'use client'

/**
 * The Customise dialog's drag and drop (2026-10-01). The Owner: "I didn't really like the drag-and-drop UI and the UX
 * for the column drops … make it look absolutely stunning and very responsive … without any compromise on speed and
 * quality". The browser's own HTML drag (a translucent snapshot, no landing spot, no auto-scroll, no keyboard) is
 * replaced by dnd-kit, already a dependency:
 *   - a row is picked up anywhere after a 4 px mouse move (a click on its checkbox or buttons stays a click), or after a
 *     short press of a finger (a swipe still scrolls the list);
 *   - it lifts as a floating card (`DragCard`); the rows around it slide apart, so the gap shows where it will land;
 *   - the list scrolls by itself near its edges; Space / arrows / Space (Escape cancels) do the same by keyboard, and a
 *     screen reader hears each step;
 *   - only `transform` moves while dragging; rows keep their React identity, so 228 columns stay at 60 fps.
 * The ORDER rules stay in `preferencesLogic` (tested in node); this file only says what was dropped where.
 */
import { memo, useMemo, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import { closestCenter, useDndContext, type CollisionDetection, type Modifier } from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'

/** What a drop names: a column of the grouped list, a group, a pinned column (left / right), or a flat-list column. */
export type DragKind = 'col' | 'group' | 'pin-left' | 'pin-right' | 'flat'
const PREFIX: Record<DragKind, string> = { col: 'c:', group: 'g:', 'pin-left': 'p:', 'pin-right': 'r:', flat: 'f:' }

export const dragId = (kind: DragKind, key: string): string => `${PREFIX[kind]}${key}`
export function parseDragId(id: string | number | null | undefined): { kind: DragKind; key: string } | null {
  if (typeof id !== 'string') return null
  const kind = (Object.keys(PREFIX) as DragKind[]).find((k) => id.startsWith(PREFIX[k]))
  return kind ? { kind, key: id.slice(PREFIX[kind].length) } : null
}

/** Where a dragged kind may land: a column among columns and onto a group; everything else only among its own kind. */
export function canLandOn(active: DragKind, over: DragKind): boolean {
  return active === 'col' ? over === 'col' || over === 'group' : active === over
}

/**
 * The card stays centred on the pointer, whatever the list does under it. Lifting a GROUP folds every group to its
 * heading, so the heading under the pointer moves away (measured on :3650: a group grabbed low in a scrolled list landed
 * at the top). Centring on the pointer keeps "where I point" = "where it lands". A keyboard drag (no pointer) moves as is.
 */
export const followPointer: Modifier = ({ activatorEvent, activeNodeRect, transform }) => {
  if (!activeNodeRect || !activatorEvent || !('clientY' in activatorEvent)) return transform
  const pointerY = (activatorEvent as MouseEvent).clientY + transform.y
  return { ...transform, y: pointerY - activeNodeRect.top - activeNodeRect.height / 2 }
}

/**
 * The target is what is under the POINTER (its layout position, before any row slid aside), not what the card's
 * rectangle touches: with groups folding under a lifted group, the card's measured rectangle and the pointer drifted
 * one heading apart (measured on :3650, Shipping dropped on Variations landed above Offer Identity). A keyboard drag
 * has no pointer and keeps the closest centre. `allowed` filters the places this drag may land.
 */
export function pointerFirst(allowed: (id: string) => boolean): CollisionDetection {
  return (args) => {
    const containers = args.droppableContainers.filter((c) => allowed(String(c.id)))
    const pointer = args.pointerCoordinates
    if (!pointer) return closestCenter({ ...args, droppableContainers: containers })
    return containers.flatMap((container) => {
      const rect = args.droppableRects.get(container.id)
      return rect ? [{ id: container.id, data: { droppableContainer: container, value: Math.abs(rect.top + rect.height / 2 - pointer.y) } }] : []
    }).sort((a, b) => a.data.value - b.data.value)
  }
}

/** The rows slide apart over 180 ms, on the DS's standard curve; a reduced-motion operator gets no slide. */
export const SLIDE = { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' }

export interface DragHandle {
  /** The keyboard handle: focus it and press Space to lift. */
  ref: (element: HTMLElement | null) => void
  props: HTMLAttributes<HTMLElement>
}

interface SortableProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  id: string
  disabled?: boolean
  /** Rows slide without animation for an operator who asked for reduced motion. */
  still?: boolean
  /** While this row is the one lifted, its slot takes the colour of the group it is over (`toneOf` the target id). */
  toneOf?: (overId: string | null) => string | undefined
  /** A group heading: says it is the target while a COLUMN is held over it. */
  heading?: boolean
  /** The grip's accessible name and size; the grip is drawn first, before `children`. */
  grip: { label: string; size?: number }
  /**
   * The row's content, as ELEMENTS made by the parent — not a render function. While a drag is on, every sortable row
   * redraws on each new target; handing it the same elements lets React skip the row's content entirely. Measured on
   * :3650 with 233 rows: 50–200 ms a move with a render function, which is not "without any compromise on speed".
   */
  children: ReactNode
}

/**
 * One sortable row or group heading. The POINTER can lift it anywhere on the row; the KEYBOARD lifts it from its grip
 * only, so Space on the row's checkbox still ticks the checkbox.
 */
export function Sortable({ id, disabled, still, toneOf, heading, grip, className, style, children, ...rest }: SortableProps) {
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform, transition, isDragging, isOver, active, over } = useSortable({
    id, disabled, transition: still ? null : SLIDE,
  })
  // Read here, from the drag itself, so passing over a row redraws the rows involved, never the whole dialog.
  const target = heading && isOver && parseDragId(active?.id)?.kind === 'col'
  const tone = isDragging && toneOf ? toneOf(over ? String(over.id) : null) : undefined
  const moved: CSSProperties = { ...style, transform: CSS.Translate.toString(transform), transition: still ? undefined : transition }
  // The keyboard listener goes on the grip; the mouse and touch listeners on the whole row.
  const { onKeyDown, ...pointer } = (listeners ?? {}) as Record<string, (event: unknown) => void>
  // Kept the same between redraws, so the grip (memoised) is not redrawn on every new target either.
  const handle = useMemo<DragHandle | null>(() => (disabled ? null : {
    ref: setActivatorNodeRef,
    props: { ...attributes, onKeyDown: onKeyDown as HTMLAttributes<HTMLElement>['onKeyDown'] },
  }), [disabled, setActivatorNodeRef, attributes, onKeyDown])
  return (
    <div ref={setNodeRef} style={moved} className={[className, isDragging ? 'is-drag-source' : '', target ? 'is-drop-target' : ''].filter(Boolean).join(' ')}
      {...(tone ? { 'data-tone': tone } : {})} {...(disabled ? {} : pointer)} {...rest}>
      <Grip handle={handle} label={grip.label} size={grip.size} />
      {children}
    </div>
  )
}

/** The grip a row is lifted by — the keyboard's way in. */
export const Grip = memo(function Grip({ handle, label, size = 14 }: { handle: DragHandle | null; label: string; size?: number }) {
  if (!handle) return <GripVertical size={size} className="nds-prefs-grip" aria-hidden />
  return (
    <span ref={handle.ref} {...handle.props} className="nds-prefs-grip nds-prefs-griphandle" aria-label={label}>
      <GripVertical size={size} aria-hidden />
    </span>
  )
})

/**
 * The lifted card under the pointer: the row's name, the colour edge of the group it is over (`toneOf` the target; a
 * group card keeps its own), and how many columns move with it.
 */
export const DragCard = memo(function DragCard({ label, tone, toneOf, count, group }: { label: string; tone?: string; toneOf?: (overId: string | null) => string | undefined; count?: number; group?: boolean }) {
  const { over } = useDndContext()
  const shown = (!group && toneOf ? toneOf(over ? String(over.id) : null) : undefined) ?? tone
  return (
    <div className={['nds-prefs-dragcard', group ? 'is-group' : ''].filter(Boolean).join(' ')} data-tone={shown}>
      <GripVertical size={14} aria-hidden />
      <span className="nds-prefs-dragcard-lbl">{label}</span>
      {count !== undefined && (group || count > 1) && <span className="nds-prefs-dragcard-count">{count} {count === 1 ? 'column' : 'columns'}</span>}
    </div>
  )
})
