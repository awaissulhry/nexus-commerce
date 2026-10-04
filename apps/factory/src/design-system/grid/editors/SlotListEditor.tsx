'use client'

/**
 * Step 4.3 #3 (A-52; R-55, R-56) — the bullets editor: a small FORM of positions in AG's popup, and the one cell's renderer.
 *
 * Two modes, one editor:
 *   `slots` — a channel's fixed positions (Amazon bullets, 10 × 700). Every position is shown, an empty one stays in place
 *             and is never compacted; the value reported is exactly `max` positions.
 *   `list`  — Shared (master) bullets, one unbounded list: the items plus ONE trailing empty position; blanks are dropped
 *             from the value reported, as the server drops them.
 *
 * Composes the DS: `OrderedList` (pointer drag + labelled up/down buttons + its live announcement) with stable ids
 * `p1…pN` — never the bullet TEXT, which repeats and can be empty — and a DS `Textarea` per position. Keys (R-55): Tab and
 * Shift+Tab move between positions; Tab on the last position (Shift+Tab on the first) is left to AG, which commits and
 * moves right (left); Alt+↑/↓ move the focused bullet with an announcement; Enter saves; Shift+Enter never adds a line; Esc
 * is AG's cancel. The ColDef hands AG's copy of those keys to this editor through `suppressSlotListKeys`.
 *
 * AG36: every change is reported through `props.onValueChange` (a ref `getValue` is never read); nothing is reported on
 * mount; an editor opened and left untouched cancels (`isCancelAfterEnd`), so it can never write.
 *
 * A position over the channel's cap is MARKED (the counter and `aria-invalid`), never truncated — the server judges it and
 * refuses that position alone (R-58/R-60).
 */
import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ICellEditorParams, ICellRendererParams } from 'ag-grid-community'
import { useGridCellEditor } from 'ag-grid-react'

import { Button, Textarea } from '../../primitives'
import { OrderedList } from '../../components/OrderedList'
import { CellSaveMark } from '../renderers/CellSaveMark'
import { CellSaveReason, EmptyValue, RequiredValue } from '../renderers/cells'
import { MarkedValue } from '../renderers/MarkedValue'
import { PROVENANCE_PRECEDENCE, provenanceLabel, strongestProvenance, type CellProvenance } from '../renderers/provenance'
import type { CellSaveState, CellSaveTracker } from './roundTrip'
import { editorBox, roomToRightOf } from './editorBox'
import { EDITOR_KEY_HINT_FORM } from './editorHint'
import {
  SLOT_LIST_EDITOR_CLASS, bulletsEditorKey, listModeCommit, listModeItems, moveByKey, slotListValue, slotPositionOf, withTrailingEmpty,
  type SlotGroup,
} from './slotList'

/** What the column tells the editor. Namespaced (`slotList`) so AG's merge with a formula selector's params never collides. */
export interface SlotListSettings {
  mode: 'slots' | 'list'
  /** Positions in `slots` mode; the list's cap in `list` mode (`null` = unbounded). */
  max: number | null
  /** The per-position character cap the channel declares, when it declares one. */
  maxLength?: number | null
  /** One position's name: `Bullet` → "Bullet 3". */
  itemLabel: string
  /** The whole list's name: `Bullet points`. */
  label: string
}

export interface SlotListEditorParams extends Partial<ICellEditorParams> {
  slotList: SlotListSettings
  value?: unknown
  onValueChange?: (value: unknown) => void
  stopEditing?: (cancel?: boolean) => void
}

/** The field fact under the key line — the editor's own keyboard reorder, stated where it is available. */
export const slotListMoveFact = (itemLabel: string) => `Alt+↑↓ moves a ${itemLabel.toLowerCase()}`

const idOf = (n: number) => `p${n}`

export const SlotListEditor = forwardRef<unknown, SlotListEditorParams>(function SlotListEditor(props, _ref) {
  const settings = props.slotList
  const { mode, itemLabel, label } = settings
  const slots = mode === 'slots'
  const max = slots ? Math.max(0, settings.max ?? 0) : settings.max ?? null
  const cap = settings.maxLength ?? null
  /* The opening value, read ONCE: AG's `value` prop follows `onValueChange`, and neither the first render nor a cancel may
     chase it. A typed start key (`eventKey`) is deliberately NOT inserted into position 1 — typing on the cell opens the
     form without silently replacing the first bullet (A-52 §3, a stated choice). */
  const initial = useRef((() => {
    const texts = slots ? slotListValue(Array.isArray(props.value) ? props.value : [], max ?? 0) : listModeItems(props.value, max)
    const ids = texts.map((_, i) => idOf(i + 1))
    return { ids, texts: Object.fromEntries(ids.map((id, i) => [id, texts[i]])) as Record<string, string>, next: texts.length + 1 }
  })()).current
  const [order, setOrder] = useState<string[]>(initial.ids)
  const [texts, setTexts] = useState<Record<string, string>>(initial.texts)
  const nextId = useRef(initial.next)
  const touched = useRef(false)
  const [announcement, setAnnouncement] = useState('')
  const fields = useRef(new Map<string, HTMLTextAreaElement | null>())
  const pendingFocus = useRef<string | null>(null)

  useGridCellEditor({ isCancelAfterEnd: () => !touched.current })

  const valueOf = useCallback((ids: readonly string[], all: Record<string, string>): unknown => {
    const positions = ids.map((id) => all[id] ?? '')
    return slots ? slotListValue(positions, max ?? 0) : listModeCommit(positions)
  }, [slots, max])

  const report = useCallback((ids: string[], all: Record<string, string>) => {
    touched.current = true
    props.onValueChange?.(valueOf(ids, all))
  }, [props.onValueChange, valueOf])

  const edit = useCallback((id: string, value: string) => {
    const all = { ...texts, [id]: value }
    let ids = order
    if (!slots) {
      const positions = withTrailingEmpty(order.map((x) => all[x] ?? ''), max)
      if (positions.length > order.length) {
        const added = idOf(nextId.current++)
        ids = [...order, added]
        all[added] = ''
      }
    }
    setTexts(all)
    if (ids !== order) setOrder(ids)
    report(ids, all)
  }, [texts, order, slots, max, report])

  const positionLabel = useCallback((id: string, ids: readonly string[] = order) => `${itemLabel} ${ids.indexOf(id) + 1}`, [order, itemLabel])

  const reorder = useCallback((ids: string[]) => {
    setOrder(ids)
    report(ids, texts)
  }, [texts, report])

  const focusField = useCallback((id: string | undefined) => {
    if (!id) return
    const el = fields.current.get(id)
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [])

  /* Opens on position 1, caret at the end. */
  useLayoutEffect(() => { focusField(order[0]) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  /* A moved bullet keeps the focus: React moves the keyed row, and a moved node can drop focus. */
  useEffect(() => {
    if (pendingFocus.current) { focusField(pendingFocus.current); pendingFocus.current = null }
  }, [order, focusField])

  const save = () => { props.stopEditing?.() }
  const cancel = () => { props.api?.stopEditing(true) }

  const keyboard = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const { position, onButton } = slotPositionOf(e.target)
    const action = bulletsEditorKey({ key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing }, position, order.length, { onButton })
    /* `press`: the button's own Enter (its native click) — AG is kept off it by `suppressSlotListKeys`, nothing else here. */
    if (action === 'type' || action === 'ag' || action === 'press') return
    e.preventDefault()
    e.stopPropagation()
    if (action === 'next') focusField(order[position])
    else if (action === 'prev') focusField(order[position - 2])
    else if (action === 'save') save()
    else if (action === 'up' || action === 'down') {
      const step = moveByKey(order, position, action, (id) => positionLabel(id))
      if (!step) return
      setAnnouncement(step.announcement)
      pendingFocus.current = step.focus
      reorder(step.order)
    }
  }

  const cellRect = props.eGridCell?.getBoundingClientRect()
  const box = editorBox({
    cellWidth: cellRect?.width ?? props.column?.getActualWidth() ?? 0,
    cellHeight: cellRect?.height ?? 0,
    roomToRight: cellRect ? roomToRightOf(cellRect.left, typeof window === 'undefined' ? 0 : window.innerWidth) : typeof window === 'undefined' ? 0 : window.innerWidth,
    kind: 'slotlist',
  })

  const renderItem = (id: string) => {
    const position = order.indexOf(id) + 1
    const value = texts[id] ?? ''
    const over = cap !== null && value.length > cap
    const counterId = `${props.column?.getColId?.() ?? 'slots'}-${id}-count`
    return (
      <div className="nds-slotlist-position">
        <div className="nds-slotlist-head">
          <span className="nds-slotlist-label">{`${itemLabel} ${position}`}</span>
          <span id={counterId} className={`nds-slotlist-count${over ? ' over' : ''}`}>
            {cap !== null ? `${value.length} / ${cap}` : String(value.length)}
          </span>
        </div>
        <Textarea
          ref={(el) => { fields.current.set(id, el) }}
          rows={2}
          value={value}
          aria-label={`${itemLabel} ${position}`}
          aria-describedby={counterId}
          aria-invalid={over || undefined}
          spellCheck
          onChange={(e) => edit(id, e.target.value)}
        />
      </div>
    )
  }

  const dark = props.eGridCell?.closest('.dark') ? ' dark' : ''
  return (
    <div className={`${SLOT_LIST_EDITOR_CLASS} nds-readable${dark}`} data-slot-count={order.length} role="group"
      aria-label={label} style={{ width: box.width, maxWidth: box.width, maxHeight: box.height }} onKeyDownCapture={keyboard}>
      <div className="nds-slotlist-body">
        <OrderedList label={label} items={order} onChange={reorder} renderItem={renderItem} itemLabel={(id) => positionLabel(id)} compact />
      </div>
      <span className="sr-only" role="status">{announcement}</span>
      <div className="nds-formula-actions nds-slotlist-actions">
        <span className="nds-slotlist-keys">
          <span className="nds-editor-keyhint">{EDITOR_KEY_HINT_FORM}</span>
          <span className="nds-slotlist-fact">{slotListMoveFact(itemLabel)}</span>
        </span>
        <Button size="sm" onClick={cancel}>Cancel</Button>
        <Button size="sm" variant="primary" onClick={save}>Apply</Button>
      </div>
    </div>
  )
})

/* ── the one cell ─────────────────────────────────────────────────────────────────────────────────── */

export interface SlotCellLike { value?: unknown; editable?: boolean; writable?: boolean }

/**
 * One position's mark text, exactly as that position's own cell would give it to `ProvenanceMark`: `from` (the source
 * by name, or the server's sentence for refused / pending / attention) and/or a whole `tooltip`.
 */
export interface SlotMarkText { from?: string | null; tooltip?: string }

export interface SlotListValueParams<T> {
  group: SlotGroup
  cellOf: (row: T, key: string) => SlotCellLike | null | undefined
  rowIdOf: (row: T) => string
  tracker?: CellSaveTracker
  provenanceOf?: (row: T, key: string) => CellProvenance
  required?: (row: T) => boolean
  /** One position's name (`Bullet`), for the mark's text on a mixed list. */
  itemLabel?: string
  /** One position's mark text, from the builder (its own cells' `from` / `tooltip`) — read for a UNIFORM list. */
  markOf?: (row: T, key: string) => SlotMarkText | null | undefined
}

const SAVE_ORDER: readonly CellSaveState[] = ['refused', 'unknown', 'waiting', 'saving', 'saved']

/** The worst save state across the positions, and the refusal sentences — what the one cell must say about its slots. */
export function slotListSaveState(tracker: CellSaveTracker | undefined, rowId: string, keys: readonly string[]): { state: CellSaveState | null; reasons: string[] } {
  if (!tracker) return { state: null, reasons: [] }
  const entries = keys.map((k) => tracker.get(rowId, k)).filter((e): e is NonNullable<typeof e> => !!e)
  const state = SAVE_ORDER.find((s) => entries.some((e) => e.state === s)) ?? null
  const reasons = [...new Set(entries.filter((e) => e.state === 'refused' && e.reason).map((e) => e.reason as string))]
  return { state, reasons }
}

/** Each FILLED position's provenance, position 1 first. An empty position says nothing about the list. */
function filledProvenance<T>(row: T, group: SlotGroup, values: readonly string[], provenanceOf: (row: T, key: string) => CellProvenance): { position: number; member: CellProvenance }[] {
  return group.keys.flatMap((k, i) => ((values[i] ?? '').trim() !== '' ? [{ position: i + 1, member: provenanceOf(row, k) }] : []))
}

/**
 * One provenance for the cell: the STRONGEST member among the filled positions, by `PROVENANCE_PRECEDENCE`
 * (refused › attention › pending › AI › outdated › formula › listing level › listing value › mapped › inherited › pinned).
 *
 * 🔴 2026-10-04: a mixed list used to wear NO mark (`own`), so a bullets cell with two pinned positions looked exactly
 * like one that simply follows. Now it wears the strongest member, and `slotListMarkText` names which positions carry
 * which member — the mark never claims the whole list when only part of it differs.
 */
export function slotListProvenance<T>(row: T, group: SlotGroup, values: readonly string[], provenanceOf?: (row: T, key: string) => CellProvenance): CellProvenance {
  if (!provenanceOf) return 'own'
  return strongestProvenance(filledProvenance(row, group, values, provenanceOf).map((p) => p.member))
}

/** "1", "1 and 3", "1, 3 and 4". */
function positionsText(positions: readonly number[]): string {
  return positions.length < 2 ? positions.join('') : `${positions.slice(0, -1).join(', ')} and ${positions[positions.length - 1]}`
}

/**
 * The mark's text for a MIXED list: every marked member with its positions, strongest first —
 * "Bullet 2: Pinned · Bullets 4 and 5: Inherited". `undefined` when every filled position shares one member (the mark's
 * own label says it) or nothing is marked. Positions with no mark (`own`) are not listed: no mark means they follow.
 */
export function slotListMarkText<T>(row: T, group: SlotGroup, values: readonly string[], provenanceOf?: (row: T, key: string) => CellProvenance, itemLabel = 'Position'): string | undefined {
  if (!provenanceOf) return undefined
  const filled = filledProvenance(row, group, values, provenanceOf)
  const members = new Set(filled.map((p) => p.member))
  if (members.size < 2) return undefined
  const parts = PROVENANCE_PRECEDENCE.filter((m) => m !== 'own' && members.has(m)).map((m) => {
    const positions = filled.filter((p) => p.member === m).map((p) => p.position)
    return `${itemLabel}${positions.length > 1 ? 's' : ''} ${positionsText(positions)}: ${provenanceLabel(m)}`
  })
  return parts.length ? parts.join(' · ') : undefined
}

/**
 * The one bullets cell's mark text, on both scopes (2026-10-04):
 *
 *   MIXED list (filled positions carry different members) → "Bullet 2: Pinned · Bullets 4 and 5: Inherited" — the
 *     mark never claims the whole list when only part of it differs.
 *   UNIFORM list (every filled position shares one member) → the FIRST filled position's own text (`markOf`), so the
 *     cell reads exactly as that position's own cell would: a refusal keeps the server's reason verbatim (#780),
 *     pending / attention keep their sentence, a pin names what it no longer follows. With no `markOf`, the member's
 *     own sentence with no source.
 *
 * `{}` when nothing is marked.
 */
export function slotListMark<T>(
  row: T, group: SlotGroup, values: readonly string[], provenanceOf?: (row: T, key: string) => CellProvenance,
  markOf?: (row: T, key: string) => SlotMarkText | null | undefined, itemLabel = 'Position',
): SlotMarkText {
  if (!provenanceOf) return {}
  const mixed = slotListMarkText(row, group, values, provenanceOf, itemLabel)
  if (mixed) return { tooltip: mixed }
  const first = filledProvenance(row, group, values, provenanceOf)[0]
  if (!first || first.member === 'own' || !markOf) return {}
  return markOf(row, group.keys[first.position - 1]) ?? {}
}

/** `3 of 10 · First bullet` — the count of filled positions and the first one. */
export function slotListSummary(values: readonly string[], max: number): { filled: number; first: string | null; text: string } {
  const filledValues = values.filter((v) => v.trim() !== '')
  const first = filledValues[0] ?? null
  return { filled: filledValues.length, first, text: `${filledValues.length} of ${max}${first ? ` · ${first}` : ''}` }
}

export function SlotListValue<T>(p: ICellRendererParams<T> & SlotListValueParams<T>) {
  const row = p.data
  const { group, tracker } = p
  const rowId = row ? p.rowIdOf(row) : ''
  const subscribe = useCallback((changed: () => void) => tracker?.subscribe(changed) ?? (() => {}), [tracker])
  const snapshot = useCallback(() => {
    const s = slotListSaveState(tracker, rowId, group.keys)
    return `${s.state ?? ''}\u0000${s.reasons.join('\u0001')}`
  }, [tracker, rowId, group.keys])
  const saveKey = useSyncExternalStore(subscribe, snapshot, snapshot)
  const [stateText, reasonText] = saveKey.split('\u0000')
  const state = (stateText || null) as CellSaveState | null
  /* The cell's own class rules read the same aggregate; a writer repaints the SLOT columns only, so this cell asks AG to
     re-apply its classes when the aggregate moves (and only then). */
  const lastState = useRef(saveKey)
  useEffect(() => {
    if (lastState.current === saveKey) return
    lastState.current = saveKey
    if (p.node && p.column && !p.api?.isDestroyed?.()) p.api?.refreshCells({ rowNodes: [p.node], columns: [p.column], force: true })
  }, [saveKey, p.api, p.node, p.column])
  const values = useMemo(() => slotListValue(row ? group.keys.map((k) => p.cellOf(row, k)?.value) : [], group.max), [row, group, p.value]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!row || group.keys.every((k) => !p.cellOf(row, k))) return null
  const summary = slotListSummary(values, group.max)
  const provenance = slotListProvenance(row, group, values, p.provenanceOf)
  const mark = slotListMark(row, group, values, p.provenanceOf, p.markOf, p.itemLabel)
  /* 2026-10-04 — `MarkedValue`, the ONE marked-cell layout every sheet cell draws (Shared and channel scopes), not a
     hand copy of it: same mark, spacing and save-mark slot as the cells beside it. */
  return (
    <MarkedValue
      provenance={provenance}
      tooltip={mark.tooltip}
      from={mark.from}
      after={<>
        <CellSaveReason reason={reasonText || undefined} />
        <CellSaveMark state={state} />
      </>}
    >
      {summary.filled === 0
        ? <>{`0 of ${group.max} `}{p.required?.(row) ? <RequiredValue /> : <EmptyValue />}</>
        : summary.text}
    </MarkedValue>
  )
}
