'use client'

/**
 * GDS / VT.2 — `AxesPanelEditor`: the variation-theme editor. ONE component, TWO hosts.
 *
 * Design `docs/2026-09-13-variation-theme-column-design.md` §3.5; canvas artboards 2–4 (master,
 * Amazon·DE, eBay·IT) are the screen truth; contract `docs/vt1-contracts.md` §1 and §3.
 *
 * ## The two hosts
 *
 * `AxesPanelEditor` is the AG cell editor: a popup (`cellEditorPopup: true` on the ColDef, because
 * `isPopup` cannot be supplied by a ref — see `SelectPanelEditor`'s header), sized by the shared
 * `editorBox` at kind `axes`, reporting through `onValueChange` and discarding an untouched edit
 * through `useGridCellEditor({ isCancelAfterEnd })`.
 *
 * `AxesPanel` is the same panel with no AG hooks at all, for the Variants dock (design §3.5's last
 * clause, D-VT4). The split exists ONLY because `useGridCellEditor` reads a context AG provides and
 * a hook cannot be called conditionally — the panel, its state machine and every string are one
 * definition (`feedback_shared_components_no_copy_props`). One test file covers both.
 *
 * ## The AG facts this is designed around, all measured (memory)
 *
 * 1. `props.onValueChange` on EVERY change. A ref `getValue` is never read by AG 36's React proxy
 *    (`reference_ag36_react_editor_onvaluechange`), so a panel that held its draft for AG to collect
 *    would commit nothing and issue no request — the exact defect measured on `SelectPanelEditor`.
 * 2. **Report nothing until the operator changes something.** Reporting on mount ARMS a write: AG
 *    fires `cellValueChanged` for the reported value, the SheetWriter queues it, and opening a cell
 *    to look at it would save it. `touched` is that gate, and `isCancelAfterEnd` is its second half.
 * 3. **Enter, Tab and Esc are AG's** inside a popup (`reference_ag_popup_editor_owns_keys`). Nothing
 *    here listens for them: Enter commits the LAST REPORTED value and Esc discards, which is exactly
 *    the contract the footer advertises. `,` and `/` (D-VT7) are not AG's and are handled where they
 *    are typed — in the candidate filter's own input. No `suppressKeyboardEvent` is declared because
 *    none was needed on screen; adding one unmeasured would take a key from AG for no reason.
 * 4. The FILL HANDLE is disabled on this column in `shapeColumn.ts`
 *    (`reference_ag_fill_handle_swallows_dblclick`): its double-click handler swallows the open
 *    gesture AND fills the column down, and a projection filled down 20 rows is 20 silent writes.
 * 5. `cellEditorParams` is a STABLE object built once per column build
 *    (`reference_ag_react_inline_options_rerun_column_model`).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { useGridCellEditor } from 'ag-grid-react'
import { ChevronDown, ChevronRight, Plus, Search } from 'lucide-react'

import { Banner, Listbox, OrderedList } from '../../components'
import { AxisChip, Button, InfoTip, Input, MappingChip, Tag } from '../../primitives'
import { channelDisplayName } from '../../lib/account-identity'
import {
  isMasterProjection,
  variationThemeText,
  variationThemeProvenanceMember,
  type VariationThemeAxis,
  type VariationThemeCell,
} from '../renderers/variationTheme'
import { ProvenanceMark } from '../renderers/provenanceMark'
import { editorBox } from './editorBox'
import { variationThemeChange } from './sheetWriter'

/* ── copy (Appendix A, verbatim — one source for every lane) ──────────────────────────────── */

export const AXES_EDITOR_COPY = {
  title: 'Variation theme',
  keys: 'Esc discards · ⏎ saves',
  override: 'Override',
  resetToRule: 'Use inherited axes',
  theme: 'Theme',
  coversAll: 'Covers every axis',
  dropsAn: 'Drops an axis',
  deprecated: 'Deprecated',
  axesOnChannel: 'Axes on this channel',
  orderFromTheme: 'order from the theme',
  /**
   * VT.2c — the SHORT phrase for the one-line section hint when a LIVE coordinate refuses a
   * reorder. The full sentence is the server's `locked.reason` and it is on the element's `title`
   * and in the lock Banner; this line only has room for the fact. `ASSUMED:` — Appendix A has no
   * sentence for it, recorded in the ledger rather than invented silently.
   */
  orderLockedShort: 'order fixed while live',
  droppedHere: 'dropped on this channel',
  addAxis: '+ Add axis',
  addSpecific: '+ Add a specific',
  addOption: '+ Add an option',
  addsHint: ', or / adds the highlighted one',
  /** Canvas artboard 2's master strapline — master has no `source.label` to show (contract §1.2). */
  masterStrap: "The family's axes — every channel projects these. Drag to order.",
  masterFooter: 'children keep their values',
  /**
   * VT.2c — the two held-`+ Add` sentences and the two target-control aria sentences, VERBATIM from
   * VP.4's `SpecificsSection` (spec §4.4.1 / §4.4.4). They travel WITH the control into the shared
   * panel: copy that stays behind in the host is how two hosts of one control start disagreeing
   * (`feedback_shared_components_no_copy_props`).
   */
  atLimit: (channel: string, limit: number, plural: string) => `${channel} allows up to ${limit} ${plural} per listing.`,
  everyAxisMapped: (noun: string) => `Every shared axis is already ${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}. Add an axis on the shared product first.`,
  targetAria: (channel: string, noun: string, axis: string) => `The ${channel} ${noun} for ${axis}`,
  targetLockedAria: (channel: string, noun: string, axis: string, target: string, reason: string) =>
    `${axis} is the ${channel} ${noun} ${target}, locked: ${reason}`,
} as const

/* ── pure decisions, exported so the suite reads exactly what the panel reads ─────────────── */

/** `Variation theme · Amazon · DE` / `Variation theme · Shared product`, from the WIRE. */
export function axesEditorScopeLabel(cell: VariationThemeCell): string {
  if (isMasterProjection(cell)) return 'Shared product'
  /* VT.2c: the server's own composed label first — a host whose `write` is null (the dock owns its
     save) has no coordinate inside `write` and read `This coordinate` for its own panel's aria name. */
  if (cell.coordinateNames) return cell.coordinateNames.scope
  const c = cell.write?.coordinate
  if (!c || !c.channel) return 'This coordinate'
  return `${channelDisplayName(c.channel)} · ${c.market}`
}

/** The section heading over the axis rows. Amazon says `Axes on this channel`; everyone else uses their own noun. */
export function axesSectionTitle(cell: VariationThemeCell): string {
  if (isMasterProjection(cell)) return 'Axes'
  return cell.candidates?.kind === 'theme-enum' ? AXES_EDITOR_COPY.axesOnChannel : cell.vocabulary.sectionTitle
}

/** `+ Add axis` · `+ Add a specific` · `+ Add an option` — the channel's own noun (Appendix A). */
export function axesAddLabel(cell: VariationThemeCell): string {
  if (isMasterProjection(cell)) return AXES_EDITOR_COPY.addAxis
  return `+ Add a${/^[aeiou]/i.test(cell.vocabulary.axisNoun) ? 'n' : ''} ${cell.vocabulary.axisNoun}`
}

export type ThemeGroup = 'coversAll' | 'drops' | 'deprecated'

/**
 * The theme list's three groups (design §3.5, Appendix A headings).
 *
 * Grouped by the WIRE's own flags, in this order, and `deprecated` WINS over `coversAll`: a
 * deprecated spelling that happens to cover every axis is still the one an operator must be warned
 * about, and VT.0 measured that this is the common case rather than a corner (32 canonical keys on
 * this catalogue carry two spellings, and on OUTERWEAR the `_NAME` twin is the deprecated one).
 */
export function themeGroupOf(item: { coversAll: boolean; deprecated: boolean }): ThemeGroup {
  if (item.deprecated) return 'deprecated'
  return item.coversAll ? 'coversAll' : 'drops'
}

export const THEME_GROUP_ORDER: readonly ThemeGroup[] = ['coversAll', 'drops', 'deprecated']

export const THEME_GROUP_LABEL: Record<ThemeGroup, string> = {
  coversAll: AXES_EDITOR_COPY.coversAll,
  drops: AXES_EDITOR_COPY.dropsAn,
  deprecated: AXES_EDITOR_COPY.deprecated,
}

/** Case-insensitive substring over the code AND the printed label — a filter that saw only one would hide half the list. */
export function axesFilterMatch(query: string, item: { code: string; label: string }): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return item.code.toLowerCase().includes(q) || item.label.toLowerCase().includes(q)
}

/**
 * Move the highlight, clamped. Returns the same index at either end rather than wrapping: a list an
 * operator is filtering has no stable length, and a wrap turns "I am at the bottom" into a jump to a
 * row they cannot see.
 */
export function moveHighlight(current: number, delta: number, length: number): number {
  if (length === 0) return 0
  return Math.min(length - 1, Math.max(0, current + delta))
}

/** Keys that ADD the highlighted candidate (D-VT7). `+` is deliberately absent — it is a value character. */
export const AXES_ADD_KEYS: readonly string[] = [',', '/']

/** Reorder, shared by master's chips and the channel's rows so there is ONE reorder rule. */
export function reorderAxes(axes: VariationThemeAxis[], order: string[]): VariationThemeAxis[] {
  const by = new Map(axes.map((a) => [a.axisKey, a]))
  const moved = order.map((k) => by.get(k)).filter((a): a is VariationThemeAxis => !!a)
  const rest = axes.filter((a) => !order.includes(a.axisKey))
  return [...moved, ...rest]
}

/* ── VT.2c: the TWO states the Variants dock carries, both read from the WIRE ─────────────── */

/**
 * The CHANNEL's own word for the coordinate (`eBay`), for the sentences that name it. One source:
 * the DS's `channelDisplayName`, never a local map — a second map is how one surface says `Ebay`.
 */
export function axesChannelWord(cell: VariationThemeCell): string {
  if (isMasterProjection(cell)) return 'Shared product'
  if (cell.coordinateNames) return cell.coordinateNames.channel
  const channel = cell.write?.coordinate.channel ?? null
  return channel ? channelDisplayName(channel) : 'This coordinate'
}

/**
 * Why THIS axis cannot be re-pointed or dropped — the server's own sentence — or `null` when it can.
 *
 * 🔴 `locked.lockedAxisKeys` ABSENT is not an empty list. It means this producer does not state
 * per-axis locks (the sheet cell's does not; the projection read does), so the panel renders the
 * unlocked arm rather than asserting a measurement nobody took.
 */
/**
 * Is THIS axis one the coordinate has already published? Then it keeps its row and loses its control.
 *
 * 🔴 VT.F item A5 — the match is over THREE spellings of the same axis, not one, and a literal
 * `includes(axisKey)` is a silent false negative on one of the two hosts. Measured on GALE eBay·IT the
 * moment the sheet cell started serving the field: `locked.lockedAxisKeys` is `["Colore","Taglia"]` —
 * the eBay aspect NAMES, which is what `__lastPublishedAxes` stores because that is what went out — while
 * the cell's `axes[].axisKey` is CANONICAL (`color`, `size`). The dock never saw it, because there the
 * mapping's axisKey IS the family spelling (`Colore`), so one compare worked on one host and failed on
 * the other for the same live listing. That is the shape of
 * `reference_combination_value_is_not_the_inherited_value`: one identity, three vocabularies.
 *
 * So the axis is matched on its canonical key, its FAMILY key and its delivered TARGET, case-insensitively
 * (the casing in `__lastPublishedAxes` is the channel's, not ours). A locked axis missed here would render
 * a live control over a frozen axis, which is the dangerous direction.
 */
export function axisLockReason(cell: VariationThemeCell, axisKey: string): string | null {
  const locked = cell.locked
  if (!locked?.lockedAxisKeys?.length) return null
  const axis = cell.axes.find((a) => a.axisKey === axisKey)
  const spellings = new Set(
    [axisKey, axis?.axisKey, axis?.familyKey, axis?.target]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .map((v) => v.toLowerCase()),
  )
  return locked.lockedAxisKeys.some((k) => spellings.has(String(k).toLowerCase())) ? locked.reason : null
}

export interface AxesOrderState {
  writable: boolean
  /** The FULL sentence — the tooltip, the aria text and the dock's own note. `null` when writable. */
  reason: string | null
  /** The SHORT phrase for the cell editor's one-line section hint. `null` when writable. */
  hint: string | null
}

/**
 * Is a REORDER a permitted commit on this coordinate, and if not, why not?
 *
 * FOUR rules, in this order, and the order is the measurement — every one of them was read off the
 * running local API on 2026-09-13 (`GET …/studio/projection`, three coordinates):
 *
 * 1. **Amazon's THEME fixes the segment order** (`candidates.kind === 'theme-enum'`, which after the
 *    dock adapter is the CELL host only). The rows are informational there, and the hint has said
 *    `order from the theme` since VT.2 — canvas artboard 3, measured at Δ0. It sits FIRST because it
 *    is the more specific mechanism AND the shorter line: the 11px `nowrap` hint slot cannot hold a
 *    lock sentence that names an ASIN and a child count, and that sentence is already on screen in
 *    the lock Banner two blocks below.
 * 2. **A LIVE coordinate that cannot revise its order** — `locked.orderChangeAllowed === false`.
 *    Measured: GALE `Amazon·IT` answers `locked { lockedAxisKeys: [], orderChangeAllowed: false,
 *    setChangeIs: 'new-parent' }` (VT.1b unified this with the cell's rule), while `eBay·IT` answers
 *    `orderChangeAllowed: true` on the SAME family — reordering a live eBay listing is a revise,
 *    which is the one change design §3.5 lets through a lock. A rule that read only the `order` block
 *    would have made the Amazon grips live on a live ASIN.
 * 3. **The endpoint's own statement**, `cell.order` (`docs/vp2-contracts.md` §4.1). Measured on
 *    GALE eBay·IT: `writableHere: true` with a `token` — so the dock's grips are LIVE there and its
 *    save carries `presentationOrder`. The adapter only relays this block when the server actually
 *    stated something; see `axesCellFromProjection`.
 * 4. Otherwise writable.
 */
export function axesOrderState(cell: VariationThemeCell): AxesOrderState {
  if (cell.candidates?.kind === 'theme-enum') {
    return { writable: false, reason: AXES_EDITOR_COPY.orderFromTheme, hint: AXES_EDITOR_COPY.orderFromTheme }
  }
  if (cell.locked && !cell.locked.orderChangeAllowed) {
    return { writable: false, reason: cell.locked.reason, hint: AXES_EDITOR_COPY.orderLockedShort }
  }
  if (cell.order) {
    return cell.order.writableHere
      ? { writable: true, reason: null, hint: null }
      : { writable: false, reason: cell.order.reason, hint: cell.order.reason }
  }
  return { writable: true, reason: null, hint: null }
}

/** Permitted → the next cell; refused → the sentence that refused it. Never a silent no-op. */
export type AxesEdit = { ok: true; next: VariationThemeCell } | { ok: false; refused: string }

/**
 * A SET change on one axis — its target, or whether it is delivered here.
 *
 * 🔴 The gate is here and not only on the control's `disabled`, because a disabled control is one
 * door: `onValueChange` must report only a PERMITTED change, and a report is what arms the write.
 */
export function axesSetAxis(cell: VariationThemeCell, axisKey: string, patch: Partial<VariationThemeAxis>): AxesEdit {
  const refused = axisLockReason(cell, axisKey)
  if (refused) return { ok: false, refused }
  return { ok: true, next: { ...cell, axes: cell.axes.map((a) => (a.axisKey === axisKey ? { ...a, ...patch } : a)) } }
}

/** A reorder — permitted whenever `axesOrderState` says the order is writable here. */
export function axesReorder(cell: VariationThemeCell, order: string[]): AxesEdit {
  const state = axesOrderState(cell)
  if (!state.writable) return { ok: false, refused: state.reason ?? 'The order cannot be changed here.' }
  return { ok: true, next: { ...cell, axes: reorderAxes(cell.axes, order) } }
}

/* ── the panel ────────────────────────────────────────────────────────────────────────────── */

export type AxesEditorHost = 'cell' | 'dock'

export interface AxesPanelProps {
  cell: VariationThemeCell
  host: AxesEditorHost
  /** Called on EVERY change with the whole edited cell. The cell host wires this to `onValueChange`. */
  onChange: (next: VariationThemeCell) => void
  /**
   * A locked coordinate whose axis SET (or theme) moved. VT.4 supplies the dry-run plan; until it
   * does, the panel HOLDS with the server's own reason on screen and writes nothing — never a silent
   * write and never a silent no-op.
   */
  onPlanRequired?: (info: { cell: VariationThemeCell; draft: VariationThemeCell; reason: string }) => void
  /** The dock's own footer (`Save mapping`) — it stays, so the panel renders whatever it is given. */
  footer?: ReactNode
  width?: number
  maxHeight?: number
  style?: CSSProperties
}

export function AxesPanel({ cell, host, onChange, onPlanRequired, footer, width, maxHeight, style }: AxesPanelProps) {
  /**
   * 🔴 The BASELINE is captured once, at open — it is NOT the `cell` prop.
   *
   * Measured on the lab, 2026-09-13: AG 36's React proxy sets `this.value` from `onValueChange` and
   * RE-RENDERS the editor with the new value as its `value` prop. So `cell` becomes whatever was last
   * reported, `variationThemeChange(cell, draft)` compares a value with itself, and the panel reported
   * `no change` immediately after a theme swap that had visibly happened on screen. The consequence is
   * worse than a wrong footer: the locked-coordinate PLAN gate is computed from the same pair, so a
   * second change on a live listing would have found "nothing moved" and written.
   *
   * `useState(cell)` with no setter is the capture — the value AG served when the editor opened, held
   * for the life of the editor.
   */
  const addReasonId = useId()
  const [baseline] = useState<VariationThemeCell>(cell)
  const [draft, setDraft] = useState<VariationThemeCell>(cell)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  /**
   * 🔴 The FIRST NON-EMPTY group opens, not always `Covers every axis`.
   *
   * Measured on the real Amazon·IT sheet (`VX-TEST-3AX`, product type SUIT, a three-axis family):
   * the editor opened with **zero visible options**. Nothing in that product type's enum covers all
   * three axes, so `Covers every axis` was empty — and it was the only group open, with `Drops an
   * axis` and `Deprecated` collapsed behind their disclosure. An operator would have read a picker
   * with 8 candidates in it as a channel that offers none.
   *
   * That is `candidates.state`'s "empty list that looks like none" defect (contract §1) reappearing
   * one level down, at the GROUP. So the default follows the data: the first group that has rows.
   */
  const [open, setOpen] = useState<Record<ThemeGroup, boolean>>(() => {
    const items = cell.candidates?.items ?? []
    const first = THEME_GROUP_ORDER.find((g) => items.some((i) => themeGroupOf(i) === g)) ?? 'coversAll'
    return { coversAll: first === 'coversAll', drops: first === 'drops', deprecated: first === 'deprecated' }
  })

  /**
   * 🔴 THE POPUP MUST TAKE FOCUS ON OPEN, whatever is inside it.
   *
   * AG owns Enter, Tab and Esc — but only while focus is inside the popup it owns
   * (`reference_ag_popup_editor_owns_keys`). Measured on the lab 2026-09-13: on the MASTER scope
   * neither Enter nor Esc did anything, and the header was advertising `Esc discards · ⏎ saves` the
   * whole time. The cause was data-shaped and would have been missed by any fixture with something
   * left to add: GALE's two master candidates are both already axes, so the candidate list — and its
   * input, the only autofocusing thing in the panel — did not render at all.
   *
   * So focus is taken by the PANEL, not by whichever control happens to exist: the first focusable
   * child if there is one, else the panel itself (`tabIndex={-1}`). Same shape as
   * `ListPanelEditor`'s own mount effect, and it cannot be un-done by a fixture.
   */
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (host !== 'cell') return
    const el = root.current
    if (!el) return
    const first = el.querySelector<HTMLElement>('input, button, [tabindex]:not([tabindex="-1"])')
    ;(first ?? el).focus()
  }, [host])

  /**
   * 🔴 R-VT-8 — where a target `Listbox`'s option panel is portalled.
   *
   * The DS `Listbox` portals to `document.body` by default, which is right on a page and WRONG inside an
   * AG popup editor: the panel lands outside the popup's DOM, so clicking an option is a click OUTSIDE the
   * editor, AG ends the edit, and `onChange` never reports. VT.2c measured exactly that on this panel's
   * target control and could not re-point an axis with the mouse.
   *
   * The container is DERIVED from the panel's own root (`closest('.ag-popup-editor, .ag-popup')`) rather
   * than passed in by a host: the cell host knows nothing about its popup's element, and hard-coding a
   * selector in a page would be the page-local fix the ruling forbids. `null` in the DOCK host and in any
   * non-AG host, where `document.body` is correct and is what the DS does by default.
   *
   * It is STATE, not a ref read during render: the popup ancestor does not exist on the first paint (the
   * ref is null), so a value read inline would be `null` for the life of the mount.
   */
  const [popupHost, setPopupHost] = useState<Element | null>(null)
  useEffect(() => {
    setPopupHost(agPopupHostOf(root.current))
  }, [host])

  const master = isMasterProjection(baseline)
  const amazon = draft.candidates?.kind === 'theme-enum'
  const change = variationThemeChange(baseline, draft)

  /**
   * 🔴 The ONE report path. Every mutation goes through here, so `onChange` cannot be forgotten on a
   * branch — which is how an editor ends up committing on three of its four controls.
   */
  const report = useCallback(
    (raw: VariationThemeCell) => {
      /* 🔴 Every reported value carries the BASELINE. The commit path cannot recover it — see the
         note on `VariationThemeCell.baseline` — and a commit that cannot tell what moved sends
         nothing while the editor's own footer says `order`. */
      const next: VariationThemeCell = { ...raw, baseline, collisions: variationThemeChange(baseline, raw).kind === 'none' ? baseline.collisions : null }
      setDraft(next)
      const moved = variationThemeChange(baseline, next)
      if (next.locked && moved.kind !== 'none' && !(moved.orderOnly && next.locked.orderChangeAllowed)) {
        onPlanRequired?.({ cell: baseline, draft: next, reason: next.locked.reason })
      }
      onChange(next)
    },
    [baseline, onChange, onPlanRequired],
  )

  /* ── the candidate list ─────────────────────────────────────────────────────────────────── */

  /** Master's candidates are the per-variant editable scalar columns (contract §1.2); a channel's are the wire's. */
  /**
   * The list the picker shows. FOUR sources, in this order, and the order is the fix for a defect this
   * file's own suite caught: `addableAxes` (VT.2c) is the ADD list, and putting it first made an empty
   * array — the honest answer for a coordinate where every family axis is already mapped — swallow
   * Amazon's THEME enum, so the cell editor's picker rendered its filter field over nothing.
   *
   * 1. Amazon's theme enum, on BOTH hosts (R-VT-9): the picker IS the mapping on Amazon — the theme
   *    decides the rows, their order and their attributes (design §3.5), and the dock's `saveMapping`
   *    now sends `theme` in the PATCH body.
   * 2. `addableAxes`: the FAMILY axes not yet delivered here — what `+ Add a <noun>` adds.
   * 3. master's per-variant editable scalar columns (contract §1.2).
   * 4. the channel's own target options, for a producer that serves no `addableAxes`.
   */
  const candidates = useMemo(() => {
    const chosen = new Set(draft.axes.map((a) => a.axisKey))
    /* R-VT-9: BOTH hosts. The gate is `amazon` (the wire carries a theme enum), not the host. */
    if (amazon) {
      return (draft.candidates?.items ?? []).map((i) => ({
        code: i.code,
        label: i.label,
        meta: i.drops.length > 0 ? `drops ${i.drops.join(', ')}` : i.label,
        group: themeGroupOf(i),
        drops: i.drops,
      }))
    }
    /**
     * 🔴 `+ Add a <noun>` adds an AXIS, and on a channel coordinate that is the FAMILY's axes minus
     * the delivered ones — never the channel's target options. Adding an aspect as an axis produces an
     * `axisKey` the family does not have; VT.4 measured the dock's own list (`page.axes` minus the
     * mapped ones) and it is EMPTY on every coordinate of this catalogue, because the server lists
     * every family axis in `mapping`. So a panel that offered the three eBay aspects here would offer
     * three bogus axes where the dock correctly offered none.
     */
    if (draft.addableAxes) {
      return draft.addableAxes
        .filter((c) => !chosen.has(c.axisKey))
        .map((c) => ({ code: c.axisKey, label: c.label, meta: `not a ${draft.vocabulary.axisNoun} yet`, group: 'coversAll' as ThemeGroup, drops: [] as string[] }))
    }
    if (master) {
      return (draft.masterCandidates ?? [])
        .filter((c) => !chosen.has(c.axisKey))
        .map((c) => ({ code: c.axisKey, label: c.label, meta: `attribute · ${c.valueCount} values`, group: 'coversAll' as ThemeGroup, drops: [] as string[] }))
    }
    return (draft.candidates?.items ?? [])
      .filter((i) => !draft.axes.some((a) => a.target === i.code))
      .map((i) => ({ code: i.code, label: i.label, meta: i.required ? 'required' : 'site aspect', group: 'coversAll' as ThemeGroup, drops: [] as string[] }))
  }, [draft, master, amazon, host])

  const visible = useMemo(() => {
    const matched = candidates.filter((c) => axesFilterMatch(query, c))
    /* A FILTERED list flattens: hiding matches inside a collapsed group would make typing look
       broken. With no query the groups honour their own disclosure state. */
    if (query.trim()) return matched
    return matched.filter((c) => open[c.group])
  }, [candidates, query, open])

  const add = useCallback(
    (code: string) => {
      if (amazon) {
        /* Amazon: the THEME decides the rows. Picking one re-projects the axes from that theme's own
           drops — the rows are informational, exactly as §3.5 says. */
        const item = draft.candidates?.items.find((i) => i.code === code)
        if (!item) return
        report({
          ...draft,
          theme: { code: item.code, label: item.label, deprecated: item.deprecated },
          axes: draft.axes.map((a) => ({ ...a, included: !item.drops.includes(a.axisKey) })),
          dropped: item.drops,
        })
        return
      }
      if (draft.addableAxes) {
        const c = draft.addableAxes.find((m) => m.axisKey === code)
        if (!c) return
        report({
          ...draft,
          axes: [...draft.axes, { axisKey: c.axisKey, familyKey: c.familyKey, label: c.label, channelName: c.label, target: null, included: true }],
        })
        return
      }
      if (master) {
        const c = (draft.masterCandidates ?? []).find((m) => m.axisKey === code)
        if (!c) return
        report({
          ...draft,
          axes: [...draft.axes, { axisKey: c.axisKey, familyKey: c.key, label: c.label, channelName: c.label, target: c.key, included: true }],
        })
        return
      }
      const aspect = draft.candidates?.items.find((i) => i.code === code)
      if (!aspect) return
      report({
        ...draft,
        axes: [...draft.axes, { axisKey: aspect.code, familyKey: aspect.code, label: aspect.label, channelName: aspect.label, target: aspect.code, included: true }],
      })
    },
    [amazon, master, host, draft, report],
  )

  /**
   * D-VT7 on the filter input. `,` and `/` add the HIGHLIGHTED candidate; the arrows move the
   * highlight. Neither is a key AG's popup owns, so they are handled where they are typed and no
   * `suppressKeyboardEvent` is declared. `preventDefault` stops the character reaching the field —
   * a comma left in the query would filter the list to nothing on the very keystroke that used it.
   */
  const onFilterKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) => moveHighlight(h, e.key === 'ArrowDown' ? 1 : -1, visible.length))
        return
      }
      if (AXES_ADD_KEYS.includes(e.key)) {
        e.preventDefault()
        const pick = visible[Math.min(highlight, Math.max(0, visible.length - 1))]
        if (pick) {
          add(pick.code)
          setQuery('')
          setHighlight(0)
        }
      }
    },
    [visible, highlight, add],
  )

  /* ── the axis rows ──────────────────────────────────────────────────────────────────────── */

  const included = draft.axes.filter((a) => a.included)
  const limit = draft.candidates?.limit ?? null
  /**
   * 🔴 VT.2c split ONE flag into the TWO facts it was conflating.
   *
   * `themeFixesSet` — Amazon's theme decides WHICH axes are delivered, so the include checkbox is
   * informational there (unchanged behaviour: it was `orderLocked = amazon`).
   * `orderState` — whether a REORDER is a permitted commit here, which is a different question with
   * three different answers on the wire (`axesOrderState`). The old flag answered it with `amazon`
   * alone, which is why the dock could not adopt this panel: eBay refuses a reorder through THIS
   * endpoint while being the one channel where a reorder on a live listing IS allowed.
   */
  const themeFixesSet = amazon
  const orderState = axesOrderState(draft)
  const channelWord = axesChannelWord(draft)
  /* `null` is "no limit this repository can source", never zero — so it can never hold the button. */
  const atLimit = limit != null && included.length >= limit

  /** The one sentence that explains a held `+ Add`, or `null` when the control is live. */
  const addHeldReason = atLimit
    ? AXES_EDITOR_COPY.atLimit(channelWord, limit as number, draft.vocabulary.axisNounPlural)
    : candidates.length === 0
      ? AXES_EDITOR_COPY.everyAxisMapped(draft.vocabulary.axisNoun)
      : null

  /** Every axis mutation goes through the gate, so a refusal can never report (and so never write). */
  const setAxis = useCallback(
    (axisKey: string, patch: Partial<VariationThemeAxis>) => {
      const edit = axesSetAxis(draft, axisKey, patch)
      if (edit.ok) report(edit.next)
    },
    [draft, report],
  )

  /**
   * '' is the `Listbox`'s own CLEAR row, and it must become `null`, not the empty string: the dock's
   * save filters its mapping on `target !== null`, so a `""` would have been sent to the server as a
   * chosen target. Measured on the type, not on the screen — which is why it is written down here.
   */
  const retarget = useCallback(
    (axis: VariationThemeAxis, raw: string) => {
      const target = raw === '' ? null : raw
      setAxis(axis.axisKey, {
        target,
        channelName: target ? draft.candidates?.items.find((i) => i.code === target)?.label ?? target : axis.label,
      })
    },
    [draft, setAxis],
  )

  const axisRow = (axisKey: string): ReactNode => {
    const a = draft.axes.find((x) => x.axisKey === axisKey)
    if (!a) return null
    if (master) {
      return (
        <AxisChip
          label={a.label}
          count={`${draft.masterCandidates?.find((m) => m.axisKey === a.axisKey)?.valueCount ?? 0} values`}
          grip={false}
          onClick={() => report({ ...draft, axes: draft.axes.filter((x) => x.axisKey !== a.axisKey) })}
          title={`Remove ${a.label}`}
        />
      )
    }
    /**
     * 🔴 VT.2c — the PER-AXIS lock (spec §4.4.4): a locked axis KEEPS its row and loses only its
     * target control, disabled with the server's own sentence ON the element the operator hovers and
     * IN the aria text a screen reader reaches. A reason that lives only in the banner further up is
     * the silent-disable shape `check-silent-disabled.mjs` exists to catch, and removing the row
     * would hide the very axis the banner is talking about.
     */
    const lockReason = axisLockReason(draft, a.axisKey)
    const noun = draft.vocabulary.axisNoun
    const ariaFor = (axis: typeof a) =>
      lockReason
        ? AXES_EDITOR_COPY.targetLockedAria(channelWord, noun, axis.label, axis.target ?? '', lockReason)
        : AXES_EDITOR_COPY.targetAria(channelWord, noun, axis.label)
    const target =
      draft.candidates?.kind === 'aspects' && (draft.candidates.items.length > 0) ? (
        <Listbox
          size="sm"
          value={a.target ?? ''}
          options={draft.candidates.items.map((i) => ({ value: i.code, label: i.label }))}
          /* `Choose a <noun>` as a PLACEHOLDER, not a value: an unmapped axis must not read as a
             chosen target (§4.2's `Mapping errors` rows are exactly the unmapped ones). */
          emptyLabel={`Choose a ${noun}`}
          emptyIsPlaceholder
          disabled={!!lockReason}
          width={host === 'dock' ? '100%' : undefined}
          /* R-VT-8: inside the AG popup, so choosing an option is not a click outside the editor. */
          portalTo={popupHost}
          onChange={(v) => retarget(a, v)}
          ariaLabel={ariaFor(a)}
        />
      ) : draft.candidates?.kind === 'free' ? (
        <Input
          size="sm"
          value={a.target ?? ''}
          maxLength={255}
          disabled={!!lockReason}
          onChange={(e) => retarget(a, e.target.value)}
          aria-label={ariaFor(a)}
        />
      ) : (
        <MappingChip from={a.label} to={<span className="nds-axes-mono">{a.target ?? '—'}</span>} title={lockReason ?? `${a.label} → ${noun}`} />
      )
    /**
     * The DOCK host's row is spec §4.4.1's: `grip · axis name (92px) · arrow · Listbox sm (grow)`.
     * It carries no include checkbox and no `(channelName)` meta, and that is a MEASURED refusal, not
     * an omission: the dock's draft has no per-axis `included` field, so a checkbox here would be a
     * control whose every click is discarded by `projectionDraftFromAxesCell` — a silent no-op.
     */
    if (host === 'dock') {
      return (
        <span className="nds-axes-row nds-axes-row-dock">
          <span className="nds-axes-dockname" title={a.label}>{a.label}</span>
          <span className="nds-axes-arrow" aria-hidden>→</span>
          <span className="nds-axes-docktarget" title={lockReason ?? undefined}>{target}</span>
        </span>
      )
    }
    /* 🔴 The label is drawn ONCE. `MappingChip` already carries the FROM side, so rendering a
       `.nds-axes-label` beside it printed `Color Color color (Farbe)` on screen — measured on the lab
       before this branch existed. The chip is used where the target is static (Amazon), and the
       72px label column where the target is a CONTROL (an eBay Listbox, a Shopify Input) and the chip
       cannot hold one. */
    const chipRow = draft.candidates?.kind !== 'aspects' && draft.candidates?.kind !== 'free'
    const inclusionReason = lockReason ?? (themeFixesSet ? 'The variation theme decides which axes are included.' : null)
    return (
      <span className="nds-axes-row">
        <InfoTip tip={inclusionReason ?? (a.included ? `${a.label} is delivered here` : `${a.label} is ${AXES_EDITOR_COPY.droppedHere}`)}>
        <input
          type="checkbox"
          checked={a.included}
          // Keep the held checkbox focusable; both pointer and Space refuse before changing it.
          aria-disabled={!!inclusionReason || undefined}
          aria-description={inclusionReason ?? undefined}
          title={inclusionReason ?? undefined}
          onClick={event => { if (inclusionReason) event.preventDefault() }}
          onChange={() => { if (!inclusionReason) setAxis(a.axisKey, { included: !a.included }) }}
          aria-label={a.included ? `${a.label} is delivered here` : `${a.label} is ${AXES_EDITOR_COPY.droppedHere}`}
        />
        </InfoTip>
        {!chipRow && <span className="nds-axes-label">{a.label}</span>}
        {target}
        <span className={a.unbound ? 'nds-axes-meta nds-axes-name-unbound' : 'nds-axes-meta'} title={a.unbound?.reason}>
          {a.unbound ? 'unbound' : a.included ? `(${a.channelName})` : AXES_EDITOR_COPY.droppedHere}
        </span>
      </span>
    )
  }

  /* ── chrome ─────────────────────────────────────────────────────────────────────────────── */

  const sourceAction =
    draft.source.kind === 'override' ? (
      <Button
        variant="quiet"
        size="sm"
        onClick={() => report({ ...draft, resetRequested: true })}
      >
        {AXES_EDITOR_COPY.resetToRule}
      </Button>
    ) : draft.source.kind === 'derived' || draft.source.kind === 'rule' ? (
      <Button variant="quiet" size="sm" onClick={() => report({ ...draft, source: { ...draft.source, kind: 'override', label: 'Overridden here' } })}>
        {AXES_EDITOR_COPY.override}
      </Button>
    ) : null

  return (
    <div
      ref={root}
      tabIndex={-1}
      className={host === 'dock' ? 'nds-axes-editor nds-axes-editor-dock' : 'nds-axes-editor'}
      style={{ width, maxHeight, ...style }}
      role="group"
      aria-label={`${AXES_EDITOR_COPY.title} — ${axesEditorScopeLabel(baseline)}`}
    >
      {/**
        * 🔴 VT.2c — the CELL host's popup chrome, and only the cell host's.
        *
        * In the dock this panel IS spec §4.4.1, one section inside a 420px dock that already has its
        * own `<h2>` header, its own `<h3>` section heading with the `2 of 5 used` tag, its own hint
        * line, its §4.4.4 lock `Banner` and its own `Cancel · Save mapping` footer. Rendering the
        * popup's header, source row, lock banner and footer there would be a SECOND copy of four
        * things the dock already states — the duplicate-banner shape, not a shared component.
        *
        * The `host` discriminant selects a whole coherent set on purpose
        * (`feedback_shared_components_no_copy_props`: a `kind` that selects a coherent set is fine,
        * a free-text prop is not). Everything below the chrome — the rows, the two lock states, the
        * reorder rule, the add path, every string — is ONE definition for both.
        */}
      {host === 'cell' && (
        <>
          <div className="nds-axes-head">
            <span className="nds-axes-title">{AXES_EDITOR_COPY.title}</span>
            <span className="nds-axes-scope">· {axesEditorScopeLabel(baseline)}</span>
            {/* The keys line is the CELL host's contract. In the dock nothing owns Enter or Esc, and
                advertising them there would promise a behaviour the dock does not have. */}
            <span className="nds-axes-keys">{AXES_EDITOR_COPY.keys}</span>
          </div>

          <div className="nds-axes-source">
            {!master && <ProvenanceMark provenance={variationThemeProvenanceMember(draft)} from={draft.source.label} />}
            {/* 🔴 `source.label` VERBATIM. Contract §1.1: the sentences are server-stated and this panel
                never composes one — the same rule `describeCellSource()` follows for every other cell. */}
            <span className="nds-axes-sourcetext">{master ? AXES_EDITOR_COPY.masterStrap : draft.source.label}</span>
            {sourceAction && <span className="nds-axes-sourceact">{sourceAction}</span>}
          </div>
        </>
      )}

      {/* 🔴 `unavailable` is NOT an empty list. Four states serialised identically before
          `candidates.state` existed, and an empty picker reads as "this channel offers none".
          `no-theme` (R-VT-7) is the fourth and it renders the same way: the server's own sentence. */}
      {(draft.candidates?.state === 'unavailable' || draft.candidates?.state === 'no-theme') && (
        <div className="nds-axes-banner">
          <Banner tone="warning">{draft.candidates.unavailableReason ?? 'This coordinate’s options could not be read.'}</Banner>
        </div>
      )}

      {/**
        * 🔴 R-VT-9 — the THEME picker renders on BOTH hosts. VT.2c held it out of the dock for a reason
        * that was true when it measured: the dock's `saveMapping` sent `{ expectedVersion, mapping, split }`
        * and dropped a picked theme silently — a no-op on the one field a live coordinate relists for. The
        * ruling closed it from the other end: `PATCH …/studio/projection` has always ACCEPTED `theme`
        * (`product-studio.routes.ts:206,225`), so the fix was to put it in the body, which
        * `projectionDraftFromAxesCell` + `saveMapping` now do. The picker is gated on `amazon` — the wire
        * carrying a theme enum — so a coordinate whose schema cannot be read still gets the aspect control
        * and its reason rather than an empty picker.
        */}
      {amazon && (
        <>
          <div className="nds-axes-sectionlabel">
            <span className="nds-axes-sectionname">{AXES_EDITOR_COPY.theme}</span>
            <span className="nds-axes-sectionhint">
              {draft.candidates?.schemaFetchedAt ? `schema from ${draft.candidates.schemaFetchedAt.slice(0, 10)}` : 'from the cached schema'}
            </span>
          </div>
          <div className="nds-axes-filter">
            <Search size={13} aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onFilterKey}
              placeholder={`Filter the ${draft.candidates?.items.length ?? 0} ${draft.vocabulary.axisNounPlural}…`}
              aria-label={`Filter ${draft.vocabulary.axisNounPlural}`}
            />
            <span className="nds-axes-filterhint">{AXES_EDITOR_COPY.addsHint}</span>
          </div>
          {THEME_GROUP_ORDER.map((g) => {
            const rows = candidates.filter((c) => c.group === g)
            if (rows.length === 0) return null
            const shown = visible.filter((c) => c.group === g)
            return (
              <div key={g}>
                <button type="button" className="nds-axes-group" aria-expanded={open[g]} onClick={() => setOpen((o) => ({ ...o, [g]: !o[g] }))}>
                  {open[g] ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                  <span>{THEME_GROUP_LABEL[g]}</span>
                  <span className="nds-axes-groupcount">· {rows.length}</span>
                </button>
                {shown.map((c) => {
                  const i = visible.indexOf(c)
                  return (
                    <button
                      type="button"
                      key={c.code}
                      className={`nds-axes-opt${i === highlight ? ' hl' : ''}${draft.theme?.code === c.code ? ' sel' : ''}`}
                      aria-pressed={draft.theme?.code === c.code}
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => add(c.code)}
                    >
                      <span className="nds-axes-radio" aria-hidden />
                      <span className="nds-axes-mono">{c.code}</span>
                      <span className="nds-axes-optmeta">{c.meta}</span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </>
      )}

      {/* The dock's own `<h3>` carries this section's title and its `<n> of <m> used` tag (§4.4.1),
          so the panel does not print a second heading over the same rows. */}
      {host === 'cell' && (
        <div className="nds-axes-sectionlabel">
          <span className="nds-axes-sectionname">{axesSectionTitle(draft)}</span>
          <span className="nds-axes-sectionhint" title={orderState.reason ?? undefined}>
            {orderState.hint ?? (
              <Tag tone="neutral">{limit != null ? `${included.length} of ${limit}` : `${included.length} ${included.length === 1 ? draft.vocabulary.axisNoun : draft.vocabulary.axisNounPlural}`}</Tag>
            )}
          </span>
        </div>
      )}

      {/* 🔴 In the dock there is no one-line hint slot, so an inert grip says why in its own line —
          the server's FULL sentence, which wraps. VP.4's section disabled the grips on
          `!order.writableHere` and stated nothing at all: a silent disable. */}
      {host === 'dock' && !orderState.writable && orderState.reason && (
        <p className="nds-axes-ordernote">{orderState.reason}</p>
      )}

      <div className="nds-axes-rows">
        {/* ONE reorder idiom: the DS's `OrderedList`, on every scope and in both hosts. Its `disabled`
            is `axesOrderState`'s answer — the theme's order on Amazon, the endpoint's own
            `writableHere` in the dock, a live listing that cannot revise its order — and each of the
            three has its sentence on screen, so an inert grip is never unexplained. `keyboardGrip` is
            the dock's grip (spec §4.4.1); the cell editor keeps its ↑/↓ buttons, which is the gesture
            VT.2b's witnessed master write went through. */}
        <OrderedList
          label={axesSectionTitle(draft)}
          items={draft.axes.map((a) => a.axisKey)}
          itemLabel={(k) => draft.axes.find((a) => a.axisKey === k)?.label ?? k}
          onChange={(order) => {
            const edit = axesReorder(draft, order)
            if (edit.ok) report(edit.next)
          }}
          renderItem={axisRow}
          disabled={!orderState.writable}
          keyboardGrip={host === 'dock'}
          compact
        />
      </div>

      {/* The dock's `+ Add` adds a FAMILY AXIS (`addableAxes`) and that is meaningful on every channel,
          Amazon included — VP.4's section rendered it unconditionally. In the CELL host on Amazon the
          rows are the theme's own projection, so there is nothing to add there. */}
      {(!amazon || master || host === 'dock') && (
        <div className="nds-axes-add">
          {/**
            * 🔴 HELD, with the reason ON the control — never silently inert. The two sentences are
            * VP.4's own (§4.4.1), carried into `AXES_EDITOR_COPY` with the button so the dock and the
            * cell cannot drift. `ghost` in the dock (spec §4.4.1's word), `quiet` in the popup: the
            * host discriminant selects the coherent set, not a style prop a caller can vary.
            */}
          <Button
            variant={host === 'dock' ? 'ghost' : 'quiet'}
            size="sm"
            aria-disabled={atLimit || candidates.length === 0 || undefined}
            title={addHeldReason ?? undefined}
            aria-describedby={addReasonId}
            onClick={() => { if (!atLimit && candidates.length > 0) setOpen((o) => ({ ...o, coversAll: !o.coversAll })) }}
            aria-expanded={open.coversAll}
          >
            <Plus size={13} aria-hidden /> {axesAddLabel(draft).replace(/^\+\s*/, '')}
          </Button>
          <span id={addReasonId} className="nds-axes-filterhint">
            {addHeldReason ? addHeldReason : `${candidates.length} available`}
          </span>
        </div>
      )}

      {!amazon && open.coversAll && candidates.length > 0 && (
        <>
          <div className="nds-axes-filter">
            <Search size={13} aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onFilterKey}
              placeholder="Type to filter…"
              aria-label={`Filter ${draft.vocabulary.axisNounPlural}`}
            />
            <span className="nds-axes-filterhint">{AXES_EDITOR_COPY.addsHint}</span>
          </div>
          {visible.map((c, i) => (
            <button
              type="button"
              key={c.code}
              className={`nds-axes-opt${i === highlight ? ' hl' : ''}`}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => add(c.code)}
            >
              <span className="nds-axes-check" aria-hidden />
              <span>{c.label}</span>
              <span className="nds-axes-optmeta">{c.meta}</span>
            </button>
          ))}
        </>
      )}

      {/* The lock reason is the SERVER's sentence (Appendix A's lock copy), never rebuilt here. In the
          dock it is section §4.4.4's own `LockBanner`, with the same sentence and a title — one
          banner, not two. */}
      {host === 'cell' && draft.locked && (
        <div className="nds-axes-banner">
          <Banner tone="warning">{draft.locked.reason}</Banner>
        </div>
      )}

      {draft.deliveryNote && <div className="nds-axes-banner"><Banner tone="info">{draft.deliveryNote}</Banner></div>}
      {host === 'cell' ? (
        <div className="nds-axes-foot">
          {master ? (
            <span>
              Updates the family’s shared axes · {AXES_EDITOR_COPY.masterFooter}
            </span>
          ) : (
            <span>{draft.collisions?.summary ?? (change.kind === 'none' ? 'Collisions have not been evaluated.' : 'Collisions will be checked when you save.')}</span>
          )}
          <span className="nds-axes-footright">
            {change.kind === 'none' ? <Tag tone="neutral">no change</Tag> : <Tag tone="info">{change.kind}</Tag>}
          </span>
          {footer}
        </div>
      ) : (
        /* The dock's `Cancel · Save mapping` footer is `MappingDock`'s own, outside this section — so
           the slot stays open for a host that has one and adds no chrome of its own. */
        footer
      )}
    </div>
  )
}

/* ── the DOCK host's adapter ──────────────────────────────────────────────────────────────── */

/**
 * The Variants dock speaks VP.2's `ProjectionPage` / `ProjectionDraft`; this panel speaks VT.1's
 * `VariationThemeCell`. ONE adapter, here, so the dock renders the SAME component (design §3.5's
 * last clause, D-VT4) without a second editor and without the design system importing an app type.
 *
 * 🔴 Structurally typed, like `VariationThemeWriteFacts`: the DS must not reach into
 * `_studio/variants/channel/types.ts`, and a structural parameter also means the dock can hand it a
 * page shape that has grown a field without this file caring.
 *
 * 🔴 It does NOT invent a `write` block. The dock owns its own save (`Save mapping`, its footer,
 * which stays), so `write: null` is the honest answer here and the panel simply reports drafts —
 * `writable` stays true because the dock's own control is what decides whether saving is offered.
 */
export interface ProjectionPageLike {
  variation?: VariationThemeCell
  version: number
  coordinate: { channel: string; marketplace?: string; market?: string; accountId?: string | null; channelLabel?: string | null; label?: string }
  vocabulary: { axisNoun: string; axisNounPlural: string; sectionTitle: string }
  limits: { axes: number | null }
  targetOptions: Array<{ value?: string; code?: string; label: string; required?: boolean }>
  /** R-VT-7 — why the list is what it is. `'ok'` never accompanies an empty list. */
  targetOptionsState?: 'ok' | 'freeform' | 'unavailable' | 'no-theme'
  targetOptionsReason?: string | null
  freeform: boolean
  theme?: {
    value: string | null
    options: Array<{ code: string; label: string; deprecated?: boolean; coversAll?: boolean; drops?: string[]; adds?: string[] }>
  } | null
  locked: {
    reason: string
    externalId?: string | null
    setChangeIs?: 'relist' | 'new-parent' | 'in-place'
    orderChangeAllowed?: boolean
    /** VP.2 §4.1 — the axes this coordinate has already published. */
    lockedAxisKeys?: string[]
  } | null
  axes?: Array<{ key: string; label: string }>
  /** VP.2 §4.1 — the presentation order, relayed read-only by this endpoint. */
  order?: { writableHere: boolean; reason: string }
}

export interface ProjectionDraftLike {
  mapping: Array<{ axisKey: string; axisLabel?: string; target: string | null; order: number }>
  /**
   * R-VT-9 — AMAZON only: the theme the dock's picker chose, carried back so `saveMapping` can put it
   * in the PATCH body. `undefined` = this draft never touched a theme (every non-Amazon coordinate, and
   * an Amazon one the operator only reordered), and the save omits the field entirely rather than
   * sending `null`, which the route reads as "clear the theme".
   */
  theme?: string | null
}

/**
 * R-VT-8 — the AG popup element a portalled panel must live inside, or `null` when there is none.
 *
 * Pure and exported so the node-only suite can pin the SELECTOR (`apps/web` vitest has no DOM, so the
 * element is injected). Two class names because AG uses `ag-popup-editor` for an editor popup and
 * `ag-popup` for the wrapper it sits in, and which one is the ancestor depends on `cellEditorPopup` and
 * the `popupParent`. Returning the nearest of either is correct for both.
 */
export function agPopupHostOf(el: { closest(selector: string): Element | null } | null | undefined): Element | null {
  return el?.closest(AG_POPUP_SELECTOR) ?? null
}

export const AG_POPUP_SELECTOR = '.ag-popup-editor, .ag-popup'

/** `ProjectionPage` + the dock's live draft → the cell this panel renders. */
export function axesCellFromProjection(page: ProjectionPageLike, draft: ProjectionDraftLike): VariationThemeCell {
  if (page.variation) {
    const baseline = page.variation
    const axes = [...draft.mapping].sort((a, b) => a.order - b.order).map(m => {
      const original = baseline.axes.find(a => a.familyKey === m.axisKey || a.axisKey === m.axisKey)
      return { ...original, axisKey: original?.axisKey ?? m.axisKey, familyKey: original?.familyKey ?? m.axisKey, label: original?.label ?? m.axisLabel ?? m.axisKey, channelName: page.targetOptions.find(o => (o.code ?? o.value) === m.target)?.label ?? m.target ?? original?.label ?? m.axisKey, target: m.target, included: !!m.target }
    })
    for (const axis of baseline.axes) if (!axes.some(a => a.familyKey === axis.familyKey)) axes.push({ ...axis, target: null, included: false })
    const theme = draft.theme === undefined ? baseline.theme : draft.theme ? { code: draft.theme, label: page.theme?.options.find(o => o.code === draft.theme)?.label ?? draft.theme, deprecated: false } : null
    return { ...baseline, axes, theme, write: null, coordinateNames: { channel: page.coordinate.channelLabel ?? channelDisplayName(page.coordinate.channel), scope: page.coordinate.label ?? [page.coordinate.channelLabel ?? channelDisplayName(page.coordinate.channel), page.coordinate.market ?? page.coordinate.marketplace].filter(Boolean).join(' · ') }, order: page.order, dropped: axes.filter(a => !a.included).map(a => a.axisKey), addableAxes: axes.filter(a => !a.included).map(a => ({ axisKey: a.axisKey, familyKey: a.familyKey, label: a.label })) }
  }
  const labels = new Map((page.axes ?? []).map((a) => [a.key, a.label]))
  const options = page.targetOptions.map((o) => ({
    code: o.value ?? o.code ?? o.label,
    label: o.label,
    coversAll: false,
    drops: [] as string[],
    deprecated: false,
    ...(o.required !== undefined ? { required: o.required } : {}),
  }))
  const optionLabel = new Map(options.map((o) => [o.code, o.label]))
  /**
   * R-VT-9 — Amazon's theme enum, when the wire carries one. `coversAll` / `drops` / `adds` /
   * `deprecated` are the SERVER's grouping (`classifyThemes` + `dropsForTheme`/`addsForTheme`), so the
   * dock groups `Covers every axis` · `Drops an axis` · `Deprecated` exactly as the sheet cell does and
   * neither host computes what a theme costs.
   */
  const amazonThemeEnum = (page.theme?.options?.length ?? 0) > 0
    ? page.theme!.options.map((o) => ({
        code: o.code,
        label: o.label,
        coversAll: o.coversAll ?? false,
        drops: o.drops ?? [],
        adds: o.adds ?? [],
        deprecated: o.deprecated ?? false,
      }))
    : null
  const ordered = [...draft.mapping].sort((a, b) => a.order - b.order)
  return {
    axes: ordered.map((m) => ({
      axisKey: m.axisKey,
      familyKey: m.axisKey,
      label: m.axisLabel ?? labels.get(m.axisKey) ?? m.axisKey,
      channelName: m.target ? optionLabel.get(m.target) ?? m.target : (m.axisLabel ?? labels.get(m.axisKey) ?? m.axisKey),
      target: m.target,
      /* An UNMAPPED axis is still delivered-in-intent — the dock's own row shows the dash. `included`
         is the drop flag, and a null target is "not chosen yet", which is a different fact. */
      included: true,
    })),
    theme: page.theme?.value ? { code: page.theme.value, label: page.theme.options.find((o) => o.code === page.theme!.value)?.label ?? page.theme.value, deprecated: false } : null,
    /* The dock has no `source.kind` on the wire, and this panel never composes a sentence — so the
       neutral member is used and the source ROW carries the dock's own hint through `footer`. */
    source: { kind: 'derived', ruleLabel: null, category: null, label: 'Derived from the family axes' },
    candidates: amazonThemeEnum
      ? {
          /**
           * 🔴 R-VT-9 (orchestrator, on VT.2c's QUESTION (c)) — the dock's AMAZON section carries the
           * theme picker, because on Amazon the theme IS the mapping: design §3.5 says "the theme picker
           * decides the rows; the rows are informational (order and attributes come from the theme)".
           * Two hosts, one control.
           *
           * VT.2c's note said `theme-enum` here "would arm a theme picker the dock's PATCH cannot
           * send" — and it was right at the time in both halves, which is why this branch is guarded by
           * the WIRE and not by the host: (a) the PATCH route has always accepted `theme`
           * (`product-studio.routes.ts:206,225`), the dock's `saveMapping` simply never put it in the
           * body — it does now; (b) every Amazon coordinate answered `theme: {value:null,options:[]}`
           * because the producer read a sheet column VT.1 had retired (R-VT-7, fixed in the same write),
           * so the picker would have rendered over nothing.
           *
           * The guard is therefore "the wire carries a theme enum with options in it", never
           * `channel === 'AMAZON'`: a coordinate whose schema cannot be read keeps the aspect branch and
           * says why, instead of showing an empty picker.
           */
          kind: 'theme-enum',
          items: amazonThemeEnum,
          limit: page.limits.axes,
          schemaFetchedAt: null,
          state: 'ok',
        }
      : {
          kind: page.freeform ? 'free' : 'aspects',
          items: options,
          limit: page.limits.axes,
          /**
           * 🔴 R-VT-7 — the state comes from the WIRE, and an empty list never reads `ok`. This used to
           * be `page.freeform ? 'freeform' : 'ok'`, so `targetOptions: []` — which VT.2c measured on
           * every Amazon coordinate — rendered as "this channel offers no targets", stated with
           * confidence. `undefined` from an older server is `unavailable`, not `ok`: not measured is
           * never a pass (`reference_could_not_measure_vs_measured_empty`).
           */
          state: page.targetOptionsState ?? (page.freeform ? 'freeform' : options.length > 0 ? 'ok' : 'unavailable'),
          schemaFetchedAt: null,
          ...(page.targetOptionsReason ? { unavailableReason: page.targetOptionsReason } : {}),
        },
    masterCandidates: null,
    dropped: [],
    collisions: null,
    /**
     * VT.2c — the FAMILY axes this coordinate may still add, which is what `+ Add a <noun>` adds.
     * `page.axes` minus the drafted mapping, exactly the set VP.4's section computed as `unmapped`;
     * the family's own spelling IS the key on this wire (`Colore`), so `familyKey === axisKey`.
     */
    addableAxes: (page.axes ?? [])
      .filter((a) => !ordered.some((m) => m.axisKey === a.key))
      .map((a) => ({ axisKey: a.key, familyKey: a.key, label: a.label })),
    locked: page.locked
      ? {
          reason: page.locked.reason,
          externalId: page.locked.externalId ?? null,
          setChangeIs: page.locked.setChangeIs ?? 'relist',
          /* eBay: reordering a live listing is a revise. The endpoint's own `order.writableHere` is
             the discriminator when the lock block does not carry the flag. */
          orderChangeAllowed: page.locked.orderChangeAllowed ?? page.order?.writableHere ?? false,
          lockedAxisKeys: page.locked.lockedAxisKeys ?? [],
        }
      : null,
    /**
     * 🔴 The DOCK always states the order's writability, and `true` when the server is silent is the
     * honest answer for THIS host rather than an invention: the dock's own `Save mapping` writes
     * `mapping[].order`, so an order change here IS writable unless the endpoint says otherwise —
     * which it does, per coordinate, in `order.writableHere` (§4.1). The absence of the field is what
     * tells the CELL host that Amazon's theme fixes the order instead.
     */
    /**
     * 🔴 `writableHere: false` with an EMPTY `reason` is "we did not look", NOT "refused".
     *
     * Measured in the producer: `family-projection.service.ts:1118` reads the presentation order for
     * `channel === 'EBAY'` only, and leaves `{ writableHere: false, reason: '' }` on every other
     * channel. Relaying that as a refusal would make the dock's grips inert on Amazon and Shopify —
     * where the dock's own `Save mapping` DOES write `mapping[].order` — and inert with no sentence
     * anywhere, which is the silent disable the DS gate exists to catch. It is also exactly VP.4's
     * own gate, which scoped its `disabled` to `channel === 'EBAY' && !writableHere` for this reason.
     *
     * So the block travels when the server STATED something (writable, or refused with a reason), and
     * otherwise the dock states its own truth: this host writes the order with its Save.
     */
    order: page.order && (page.order.writableHere || page.order.reason)
      ? { writableHere: page.order.writableHere, reason: page.order.reason }
      : { writableHere: true, reason: '' },
    /* The dock's `write` is null by design, so the coordinate's names travel here instead. */
    coordinateNames: (() => {
      const channel = page.coordinate.channelLabel ?? channelDisplayName(page.coordinate.channel)
      const market = page.coordinate.market ?? page.coordinate.marketplace ?? null
      /* A dangling separator reads as a missing value — the same rule `dockSubtitle` follows. */
      return { channel, scope: page.coordinate.label ?? [channel, market].filter(Boolean).join(' · ') }
    })(),
    write: null,
    writable: true,
    writeBlockedReason: null,
    vocabulary: page.vocabulary,
    separator: ' · ',
  }
}

/** The panel's edited cell → the dock's draft, PRESERVING every field the dock owns. */
export function projectionDraftFromAxesCell<D extends ProjectionDraftLike>(cell: VariationThemeCell, previous: D): D {
  const was = new Map(previous.mapping.map((m) => [m.axisKey, m]))
  return {
    ...previous,
    mapping: cell.axes.map((a, order) => ({
      ...(was.get(a.axisKey) ?? { axisKey: a.axisKey, axisLabel: a.label }),
      axisKey: a.axisKey,
      target: a.target,
      order,
    })),
    /* R-VT-9 — only when the panel actually carries a theme-enum cell (Amazon). On every other channel
       `cell.theme` is null by construction and the field must stay ABSENT, because the route treats an
       explicit `null` as "clear it". */
    ...(cell.candidates?.kind === 'theme-enum' ? { theme: cell.theme?.code ?? null } : {}),
  }
}

/* ── the AG cell host ─────────────────────────────────────────────────────────────────────── */

export interface AxesPanelEditorParams {
  value?: unknown
  column?: { getActualWidth(): number }
  stopEditing?: (cancel?: boolean) => void
  /** AG 36's ONLY route from an editor to the grid. */
  onValueChange?: (value: unknown) => void
  eGridCell?: HTMLElement
  onPlanRequired?: AxesPanelProps['onPlanRequired']
}

export function AxesPanelEditor(props: AxesPanelEditorParams) {
  const { value, column, onValueChange } = props
  /**
   * 🔴 `touched` is a REF, and `isCancelAfterEnd` reads it. AG calls that method after the edit
   * ends; a state variable would be read from the render that scheduled it. An untouched edit is
   * DISCARDED — opening a cell to read it must not arm a write (memory: reporting on mount).
   */
  const touched = useRef(false)
  useGridCellEditor({ isCancelAfterEnd: () => !touched.current })

  const cell = (value ?? null) as VariationThemeCell | null

  const [, refreshViewport] = useState(0)
  useEffect(() => {
    const onResize = () => refreshViewport(value => value + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const cellRect = props.eGridCell?.getBoundingClientRect()
  /**
   * 🔴 No bare `window`. There is no viewport in Node (SSR, and this file's own suite), and when there
   * is none the room cannot constrain anything — so the ROOM term is infinite and `editorBox`'s
   * `min(cap, room)` resolves to the cap, which is the honest answer rather than a guessed viewport
   * width. `SelectPanelEditor` and `ListPanelEditor` read `window.innerWidth` unguarded; they are
   * never rendered outside a browser today, so this is a new guard and not a fix to them.
   */
  const viewportWidth = typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth
  const viewportHeight = typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerHeight
  const box = editorBox({
    cellWidth: cellRect?.width ?? column?.getActualWidth() ?? 200,
    cellHeight: cellRect?.height ?? 0,
    // Reserve viewport gutters; this panel uses fixed placement below the anchor where it fits.
    roomToRight: Math.max(0, viewportWidth - 16),
    kind: 'axes',
  })

  const onChange = useCallback(
    (next: VariationThemeCell) => {
      touched.current = true
      onValueChange?.(next)
    },
    [onValueChange],
  )

  /* A child row has no projection to edit. `editable` on the ColDef already refuses to open here;
     this is the second door, because a renderer that can be reached two ways must answer both. */
  if (!cell) return null

  return <AxesPanel cell={cell} host="cell" onChange={onChange} onPlanRequired={props.onPlanRequired} width={box.width} maxHeight={Math.min(box.height, viewportHeight - 16)} style={cellRect ? { position: 'fixed', left: Math.max(8, Math.min(cellRect.left, viewportWidth - box.width - 8)), top: Math.max(8, Math.min(cellRect.bottom, viewportHeight - Math.min(box.height, viewportHeight - 16) - 8)) } : undefined} />
}

/** The text the grid shows for this cell — re-exported so a host never re-derives it. */
export { variationThemeText }
