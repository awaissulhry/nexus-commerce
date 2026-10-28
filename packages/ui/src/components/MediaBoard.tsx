'use client'

import { useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { ImageOff, MoreHorizontal, Plus, Star } from 'lucide-react'
import { Menu, type MenuItemDef } from './Menu'
import { cdnFit } from '../lib/cdn-image'
import { MediaTypeIcon, mediaImageUrl } from './MediaPreview'
import { useSortableDrag } from './useSortableDrag'
import { previewIndex } from '../lib/sortable'
import { useHorizontalOverflow } from './useHorizontalOverflow'

/**
 * MediaBoard — several ordered photo sets on one board (images rebuild P3b; DS-GAPS 2026-09-27).
 *
 * `MediaGallery` orders ONE list. A photo plan has several ordered sets — Common, one per colour, safety, per SKU — and a
 * photo moves between them. Every row here is one ordered set; its first tile is the row's main photo (★). A tile moves
 * within its row or into another row by drag, by keyboard, or from its menu:
 * - arrows move the focus between tiles and rows; Enter opens the photo; M makes it the main photo; Delete removes it
 *   from the row (never from the library);
 * - Space picks a tile up, arrows choose a row and a position, Space drops it, Escape cancels; Alt+Space drops a copy;
 * - dragging moves; holding Alt (⌥) while dropping adds a copy and keeps the original ("Also use in…").
 * Photos dragged in from outside the board (a library) carry `externalType` with a JSON array of ids.
 *
 * `liveDrag` (a board with ONE row — the sheet's Product media pop-up, 2026-09-28; Owner: "The UI of the drag-and-drop
 * has to be better"): the pointer drag shows the result while it happens — the tile lifts and follows the pointer, the
 * other tiles slide into their neighbours' slots, Esc cancels, the panel scrolls near its edges, touch works
 * (`useSortableDrag`, layout `grid`). Off by default: the Media page's several rows keep their drag between rows.
 *
 * `slots` (the Media page's photo grid, 2026-09-29; Owner: "rows = sets, columns = slots (MAIN, PT01…)"): the rows line
 * up under ONE header of slot names and each position is a fixed slot. A row shows its empty slots up to its `capacity`
 * as places to drop on; the first one is a button that asks to add photos there (`onAddRequest`). No ★ badge: the
 * MAIN column says which photo is the main one. A row may name its own slots (Amazon safety images: PS01…). The board
 * scrolls sideways as one, the set names staying in view. Off by default.
 */

export const MEDIA_BOARD_EXTERNAL_TYPE = 'application/x-nexus-media-ids'
const INTERNAL_TYPE = 'application/x-nexus-media-board'

export interface MediaBoardItem {
  id: string
  src?: string | null
  label: string
  mediaType?: string
  /** Small facts under the tile ("also in Common", "480 px", "IT DE"). */
  badges?: ReactNode
  /** A tile with a problem gets a coloured edge; the reason belongs in `badges`. */
  tone?: 'warning' | 'danger'
}

export interface MediaBoardRow {
  id: string
  /** Plain text: used in announcements and menus ("Nero"). */
  label: string
  /** Shown beside the label ("9 SKUs · 6 / 12"). */
  detail?: ReactNode
  /** Where the row's photos come from (a SourceIndicator). */
  source?: ReactNode
  /** The row's own buttons (＋ Add, Use own photos). */
  actions?: ReactNode
  items: readonly MediaBoardItem[]
  /** A row that takes no drops or edits (another tool owns it). Default true. */
  editable?: boolean
  emptyLabel?: string
  /** Slots mode: this row's own slot names (default: the board's `slots`). */
  slots?: readonly string[]
  /** Slots mode: the most photos the row takes (default: as many as it has slot names). */
  capacity?: number
}

export interface MediaBoardMove { itemId: string; from: string; to: string; index: number; copy: boolean }

export interface MediaBoardProps {
  label: string
  rows: readonly MediaBoardRow[]
  /** Within a row `index` is the tile's final position; into another row it is the insertion point. */
  onMove(move: MediaBoardMove): void
  onDropExternal?(drop: { itemIds: string[]; to: string; index: number }): void
  externalType?: string
  onRemove?(rowId: string, itemId: string): void
  onOpen?(rowId: string, itemId: string): void
  /** Extra menu items for one tile, shown before "Remove". */
  itemMenu?(rowId: string, itemId: string, index: number): MenuItemDef[]
  /** Offer "Also use in" (copy) in menus and on Alt. Default true. */
  allowCopy?: boolean
  firstLabel?: string
  disabled?: boolean
  /** A ONE-row board drags live (lift, follow, slide). Ignored when the board has several rows. */
  liveDrag?: boolean
  /** Slots mode: the column names (MAIN, PT01…). See the component's comment. */
  slots?: readonly string[]
  /** Slots mode: the first empty slot of an editable row asks to add photos there. */
  onAddRequest?(rowId: string): void
}

interface Moving { itemId: string; from: string; fromIndex: number; to: string; index: number }
interface DropAt { row: string; index: number }

export function MediaBoard({ label, rows, onMove, onDropExternal, externalType = MEDIA_BOARD_EXTERNAL_TYPE, onRemove, onOpen, itemMenu, allowCopy = true, firstLabel = 'Main photo', disabled = false, liveDrag = false, slots, onAddRequest }: MediaBoardProps) {
  const board = useRef<HTMLDivElement>(null)
  const dragging = useRef<{ itemId: string; from: string; fromIndex: number } | null>(null)
  const focusAfter = useRef<{ row: string; itemId: string } | null>(null)
  const [focus, setFocus] = useState<{ row: string; index: number } | null>(null)
  const [moving, setMoving] = useState<Moving | null>(null)
  const [dropAt, setDropAt] = useState<DropAt | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const only = rows.length === 1 ? rows[0] : null
  const live = liveDrag && !!only && !disabled && only.editable !== false && only.items.length > 1
  const sort = useSortableDrag({
    layout: 'grid', disabled: !live,
    onMove: (from, to) => { const item = only?.items[from]; if (only && item) commit({ itemId: item.id, from: only.id, to: only.id, index: to, copy: false }) },
    onDragState: state => { if (state && only) setAnnouncement(`${only.items[state.from]?.label ?? 'Photo'}, moving to position ${state.to + 1} of ${only.items.length}.`) },
  })

  const rowOf = (id: string) => rows.find(r => r.id === id)
  const editable = (row: MediaBoardRow | undefined) => !!row && !disabled && row.editable !== false
  // Slots mode: every position is a named slot; empty ones show up to the row's capacity (at least the named ones).
  const slotted = !!slots && !live
  // Slots mode scrolls sideways as one: while it does, the board keeps its scrollbar in a band under the last row
  // (components.css), off that row's frame and captions.
  useHorizontalOverflow(board, { enabled: slotted })
  const slotNames = (row: MediaBoardRow) => row.slots ?? slots ?? []
  const slotName = (row: MediaBoardRow, index: number) => slotNames(row)[index] ?? String(index + 1)
  const emptySlots = (row: MediaBoardRow) => !slotted ? 0
    : Math.max(0, Math.min(row.capacity ?? slotNames(row).length, Math.max(slotNames(row).length, row.items.length + 1)) - row.items.length)
  const columns = slotted ? Math.max(slots!.length, ...rows.map(r => r.items.length + emptySlots(r))) : 0
  const position = (row: MediaBoardRow, index: number) => slotted ? slotName(row, index) : index === 0 ? firstLabel.toLowerCase() : `position ${index + 1} of ${row.items.length}`
  const focusable = rows.filter(r => r.items.length)
  // The focus survives reorders and removals: it stays on a real tile, or on the first tile when its row emptied.
  const current = focus && rowOf(focus.row)?.items.length ? { row: focus.row, index: Math.min(focus.index, rowOf(focus.row)!.items.length - 1) }
    : focusable[0] ? { row: focusable[0].id, index: 0 } : null

  useLayoutEffect(() => {
    const next = focusAfter.current
    if (!next) return
    focusAfter.current = null
    const row = rowOf(next.row)
    const index = row?.items.findIndex(i => i.id === next.itemId) ?? -1
    if (index < 0) return
    setFocus({ row: next.row, index })
    tileButton(next.row, index)?.focus()
  })

  function tileButton(row: string, index: number) {
    return board.current?.querySelector<HTMLButtonElement>(`[data-board-row="${CSS.escape(row)}"] [data-board-index="${index}"] .nds-media-board-thumb`) ?? null
  }
  function moveFocus(row: string, index: number) {
    setFocus({ row, index })
    tileButton(row, index)?.focus()
  }
  function commit(move: MediaBoardMove) {
    if (move.from === move.to && !move.copy) {
      const at = rowOf(move.from)?.items.findIndex(i => i.id === move.itemId) ?? -1
      if (at === move.index) return
    }
    focusAfter.current = { row: move.copy ? move.from : move.to, itemId: move.itemId }
    onMove(move)
    const target = rowOf(move.to)
    setAnnouncement(`${labelOf(move.from, move.itemId)} ${move.copy ? 'also added to' : 'moved to'} ${target?.label ?? 'the set'}, position ${move.index + 1}.`)
  }
  const labelOf = (row: string, itemId: string) => rowOf(row)?.items.find(i => i.id === itemId)?.label ?? 'Photo'
  const alreadyIn = (row: MediaBoardRow | undefined, itemId: string) => !!row?.items.some(i => i.id === itemId)

  function onTileKey(event: KeyboardEvent<HTMLButtonElement>, row: MediaBoardRow, index: number) {
    const item = row.items[index]
    const key = event.key
    if (moving) {
      if (key === 'Escape') { event.preventDefault(); setMoving(null); setAnnouncement('Move cancelled. Nothing changed.'); return }
      if (key === ' ' || key === 'Enter') {
        event.preventDefault()
        const copy = allowCopy && event.altKey && moving.to !== moving.from
        setMoving(null)
        if (moving.to !== moving.from && alreadyIn(rowOf(moving.to), moving.itemId)) { setAnnouncement(`That photo is already in ${rowOf(moving.to)?.label}. Nothing changed.`); return }
        commit({ itemId: moving.itemId, from: moving.from, to: moving.to, index: moving.index, copy })
        return
      }
      const targets = rows.filter(r => r.id === moving.from || editable(r))
      const at = targets.findIndex(r => r.id === moving.to)
      let next: Moving | null = null
      const size = (r: MediaBoardRow) => r.id === moving.from ? r.items.length - 1 : r.items.length
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const r = targets[at]
        next = { ...moving, index: Math.max(0, Math.min(size(r), moving.index + (key === 'ArrowLeft' ? -1 : 1))) }
      } else if ((key === 'ArrowUp' || key === 'ArrowDown') && targets.length) {
        const r = targets[Math.max(0, Math.min(targets.length - 1, at + (key === 'ArrowUp' ? -1 : 1)))]
        next = { ...moving, to: r.id, index: Math.min(moving.index, size(r)) }
      }
      if (next) {
        event.preventDefault()
        setMoving(next)
        setDropAt({ row: next.to, index: next.index })
        const r = rowOf(next.to)!
        setAnnouncement(`${r.label}, position ${next.index + 1} of ${size(r) + 1}.`)
      }
      return
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      event.preventDefault()
      moveFocus(row.id, Math.max(0, Math.min(row.items.length - 1, index + (key === 'ArrowLeft' ? -1 : 1))))
    } else if (key === 'ArrowUp' || key === 'ArrowDown') {
      event.preventDefault()
      const at = focusable.findIndex(r => r.id === row.id)
      const r = focusable[at + (key === 'ArrowUp' ? -1 : 1)]
      if (r) moveFocus(r.id, Math.min(index, r.items.length - 1))
    } else if (key === 'Home' || key === 'End') {
      event.preventDefault()
      moveFocus(row.id, key === 'Home' ? 0 : row.items.length - 1)
    } else if (key === ' ' && editable(row)) {
      event.preventDefault()
      setMoving({ itemId: item.id, from: row.id, fromIndex: index, to: row.id, index })
      setDropAt({ row: row.id, index })
      setAnnouncement(`${item.label} picked up from ${row.label}. Arrow keys choose a set and a position, Space drops${allowCopy ? ', Alt+Space adds a copy' : ''}, Escape cancels.`)
    } else if ((key === 'm' || key === 'M') && !event.metaKey && !event.ctrlKey && editable(row) && index > 0) {
      event.preventDefault()
      commit({ itemId: item.id, from: row.id, to: row.id, index: 0, copy: false })
    } else if ((key === 'Delete' || key === 'Backspace') && onRemove && editable(row)) {
      event.preventDefault()
      const next = row.items[index + 1] ?? row.items[index - 1]
      if (next) focusAfter.current = { row: row.id, itemId: next.id }
      onRemove(row.id, item.id)
      setAnnouncement(`${item.label} removed from ${row.label}. It stays in the library.`)
    }
  }

  // ── pointer drag ──
  const accepts = (event: DragEvent) => event.dataTransfer.types.includes(INTERNAL_TYPE) || (!!onDropExternal && event.dataTransfer.types.includes(externalType))
  function over(event: DragEvent, row: MediaBoardRow, index: number) {
    if (!editable(row) || !accepts(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = dragging.current && !(allowCopy && event.altKey) ? 'move' : 'copy'
    if (dropAt?.row !== row.id || dropAt.index !== index) setDropAt({ row: row.id, index })
  }
  function overTile(event: DragEvent<HTMLLIElement>, row: MediaBoardRow, index: number) {
    const rect = event.currentTarget.getBoundingClientRect()
    over(event, row, event.clientX > rect.left + rect.width / 2 ? index + 1 : index)
  }
  function drop(event: DragEvent, row: MediaBoardRow) {
    if (!editable(row) || !dropAt || dropAt.row !== row.id) return
    event.preventDefault()
    event.stopPropagation()
    const at = dropAt.index
    setDropAt(null)
    const source = dragging.current
    dragging.current = null
    if (source) {
      const copy = allowCopy && event.altKey && source.from !== row.id
      if (source.from !== row.id && alreadyIn(row, source.itemId)) { setAnnouncement(`That photo is already in ${row.label}. Nothing changed.`); return }
      // Within one row the drop point counts the tile itself; the final position does not.
      const index = source.from === row.id && at > source.fromIndex ? at - 1 : at
      commit({ itemId: source.itemId, from: source.from, to: row.id, index, copy })
      return
    }
    if (!onDropExternal) return
    let ids: unknown
    try { ids = JSON.parse(event.dataTransfer.getData(externalType) || '[]') } catch { ids = [] }
    const fresh = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && !alreadyIn(row, id)) : []
    if (!fresh.length) { setAnnouncement(`Those photos are already in ${row.label}.`); return }
    onDropExternal({ itemIds: fresh, to: row.id, index: at })
    setAnnouncement(`${fresh.length} photo${fresh.length > 1 ? 's' : ''} added to ${row.label}.`)
  }

  function menuFor(row: MediaBoardRow, index: number): MenuItemDef[] {
    const item = row.items[index]
    const can = editable(row)
    const others = rows.filter(r => r.id !== row.id && editable(r))
    return [
      ...(onOpen ? [{ id: 'open', label: 'Open', onSelect: () => onOpen(row.id, item.id) }] : []),
      { id: 'main', label: 'Make main photo', disabled: !can || index === 0, onSelect: () => commit({ itemId: item.id, from: row.id, to: row.id, index: 0, copy: false }) },
      { id: 'earlier', label: 'Move earlier', disabled: !can || index === 0, onSelect: () => commit({ itemId: item.id, from: row.id, to: row.id, index: index - 1, copy: false }) },
      { id: 'later', label: 'Move later', disabled: !can || index === row.items.length - 1, onSelect: () => commit({ itemId: item.id, from: row.id, to: row.id, index: index + 1, copy: false }) },
      ...(can && others.length ? [{ id: 'move-heading', heading: true, label: 'Move to' },
        ...others.map(r => ({ id: `move:${r.id}`, label: r.label, disabled: alreadyIn(r, item.id), onSelect: () => commit({ itemId: item.id, from: row.id, to: r.id, index: r.items.length, copy: false }) }))] : []),
      ...(allowCopy && others.length ? [{ id: 'copy-heading', heading: true, label: 'Also use in' },
        ...others.map(r => ({ id: `copy:${r.id}`, label: r.label, disabled: alreadyIn(r, item.id), onSelect: () => commit({ itemId: item.id, from: row.id, to: r.id, index: r.items.length, copy: true }) }))] : []),
      ...(itemMenu ? itemMenu(row.id, item.id, index) : []),
      ...(onRemove && can ? [{ id: 'remove-separator', separator: true }, { id: 'remove', label: `Remove from ${row.label}`, onSelect: () => onRemove(row.id, item.id) }] : []),
    ]
  }

  return <div ref={board} className={`nds-media-board${slotted ? ' slots' : ''}`} role="group" aria-label={label}
    onDragLeave={event => { if (!board.current?.contains(event.relatedTarget as Node | null)) setDropAt(null) }}>
    {slotted && <div className="nds-media-board-columns" aria-hidden>
      <span className="nds-media-board-columns-head" />
      <span className="nds-media-board-columns-list">{Array.from({ length: columns }, (_, i) => <span key={i}>{slots![i] ?? i + 1}</span>)}</span>
    </div>}
    {rows.map(row => {
      const target = dropAt?.row === row.id ? dropAt.index : null
      return <section key={row.id} className="nds-media-board-row" data-board-row={row.id} data-editable={editable(row) || undefined}
        data-drop-end={target !== null && target >= row.items.length ? true : undefined} aria-label={row.label}
        onDragOver={event => over(event, row, row.items.length)} onDrop={event => drop(event, row)}>
        <header className="nds-media-board-head">
          <span className="nds-media-board-label">{row.label}</span>
          {row.detail != null && <span className="nds-media-board-detail">{row.detail}</span>}
          {row.source != null && <span className="nds-media-board-source">{row.source}</span>}
          {row.actions != null && <span className="nds-media-board-actions">{row.actions}</span>}
        </header>
        <ol ref={live ? sort.listRef as unknown as Ref<HTMLOListElement> : undefined} className={`nds-media-board-list${live ? ' live' : ''}${live && sort.drag ? ' dragging' : ''}`}
          aria-label={`${row.label}, ${row.items.length} photo${row.items.length === 1 ? '' : 's'}`}>
          {row.items.map((item, index) => {
            const isFocus = current?.row === row.id && current.index === index
            const picked = moving?.itemId === item.id && moving.from === row.id
            // While a live drag runs, each tile shows the position it WILL have (the lifted one its target).
            const d = live ? sort.drag : null
            const shown = d ? previewIndex(index, d.from, d.to) : index
            return <li key={item.id} {...(live ? sort.itemProps(index) : {})} data-board-index={index} data-drop-before={target === index || undefined} data-picked={picked || undefined}
              onDragOver={event => overTile(event, row, index)}>
              <div className={`nds-media-board-tile${item.tone ? ` is-${item.tone}` : ''}`}>
                <button type="button" className="nds-media-board-thumb" tabIndex={isFocus ? 0 : -1} draggable={editable(row) && !live} data-nds-sort-handle={live ? '' : undefined}
                  aria-label={`${item.label}, ${position(row, index)} in ${row.label}`}
                  aria-keyshortcuts={editable(row) ? 'Space M Delete' : undefined}
                  onFocus={() => { if (!isFocus) setFocus({ row: row.id, index }) }}
                  onBlur={event => { if (moving && !board.current?.contains(event.relatedTarget as Node | null)) { setMoving(null); setDropAt(null) } }}
                  onClick={() => onOpen?.(row.id, item.id)}
                  onKeyDown={event => onTileKey(event, row, index)}
                  // Space picks up; its keyup must not also "click" (open) the photo.
                  onKeyUp={event => { if (event.key === ' ') event.preventDefault() }}
                  onDragStart={event => {
                    dragging.current = { itemId: item.id, from: row.id, fromIndex: index }
                    event.dataTransfer.effectAllowed = allowCopy ? 'copyMove' : 'move'
                    event.dataTransfer.setData(INTERNAL_TYPE, item.id)
                  }}
                  onDragEnd={() => { dragging.current = null; setDropAt(null) }}>
                  <Tile item={item} />
                  {/* Slots mode: the header names the slot; a row with its own names (PS01…) shows them on the tile. */}
                  {(!slotted || row.slots) && <span className="nds-media-board-pos" aria-hidden>{slotted ? slotName(row, shown) : shown === 0 ? <Star size={12} fill="currentColor" /> : shown + 1}</span>}
                </button>
                <span className="nds-media-board-caption" title={item.label}>{item.label}</span>
                {item.badges != null && <span className="nds-media-board-badges">{item.badges}</span>}
                <Menu label={<MoreHorizontal size={14} aria-hidden />} items={menuFor(row, index)} align="right" className="nds-media-board-menu"
                  triggerProps={{ 'aria-label': `Actions for ${item.label} in ${row.label}`, title: `Actions for ${item.label}`, className: 'nds-btn xs', tabIndex: isFocus ? 0 : -1 }} />
              </div>
            </li>
          })}
          {!slotted && !row.items.length && <li className="nds-media-board-empty">{row.emptyLabel ?? (editable(row) ? 'No photos — drop photos here' : 'No photos')}</li>}
          {Array.from({ length: emptySlots(row) }, (_, i) => {
            const index = row.items.length + i
            const next = i === 0 && editable(row)
            return <li key={`slot:${index}`} className={`nds-media-board-slot${next ? ' is-next' : ''}`}>
              {row.slots && <span className="nds-media-board-slot-name" aria-hidden>{slotName(row, index)}</span>}
              {next && onAddRequest && <button type="button" className="nds-media-board-add" onClick={() => onAddRequest(row.id)}
                aria-label={`Add photos to ${row.label}, ${slotName(row, index)}`} title={`Add photos to ${row.label}`}><Plus size={16} aria-hidden /></button>}
            </li>
          })}
        </ol>
      </section>
    })}
    <span className="nds-media-board-status" role="status" aria-live="polite">{announcement}</span>
  </div>
}

function Tile({ item }: { item: MediaBoardItem }) {
  const [failed, setFailed] = useState<string | null>(null)
  const src = mediaImageUrl(item.src)
  if (!src) return <span className="nds-media-board-failure">{item.mediaType ? <MediaTypeIcon type={item.mediaType} size={20} /> : <ImageOff size={20} aria-hidden />}</span>
  if (failed === src) return <span className="nds-media-board-failure"><ImageOff size={20} aria-hidden /><span>Unavailable</span></span>
  return <img src={cdnFit(src, 192)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(src)} />
}
