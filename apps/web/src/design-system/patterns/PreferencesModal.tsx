'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  defaultDropAnimationSideEffects, DndContext, DragOverlay, KeyboardSensor, MeasuringStrategy, MouseSensor, TouchSensor, useSensor, useSensors,
  type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { canLandOn, DragCard, dragId, followPointer, parseDragId, pointerFirst, SLIDE, Sortable, type DragKind } from './preferencesDnd'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GripVertical, Lock, Plus, Search, Unlock, X } from 'lucide-react'
// The component FILE, not the `../components` barrel: that barrel exports
// `DataGrid`, which now imports this module, and a barrel import here would
// close that loop into a real circular dependency.
import { Modal } from '../components/Modal'
import { Tabs } from '../components/Tabs'
import { Button, Checkbox, FilterChip, Input } from '../primitives'
import {
  addColumns as addColumnsTo,
  effectiveLocks,
  inViewCount,
  moveVisible,
  moveAttributeColumn,
  moveAttributeGroup,
  moveAttributesToGroup,
  placeColumns,
  normalizeGroupedPreferences,
  orderedForDisplay as orderForDisplay,
  removeColumns as removeColumnsFrom,
  resetAttributeGroups,
  resolveAttributeGroups,
  setHas as setIsIn,
  toggleColumn as toggleColumnIn,
  toggleLock as toggleLockIn,
  togglableKeysOf,
} from './preferencesLogic'

/**
 * PreferencesModal — the two-panel grid "Customise" dialog (ported to the DS
 * from the live /products workspace). Left panel: optional page-size · sticky
 * first/last column · optional sort · a `workspaceSlot` escape hatch. Right
 * panel: the column list. Edits are held in a local draft and committed
 * atomically on Save; Cancel discards; Reset reverts to defaults.
 *
 * CHOOSING and ORDERING are split across the two panels: a grouped tick-list on
 * the left picks which columns are in the view; the right panel holds only the
 * chosen ones, in order, each with a drag handle, a padlock and a ✕. This
 * replaced a single list of switches — there is no second shape.
 *
 * Pure DS — no app i18n / utils. Optional sections collapse when their option
 * list is empty (pass `pageSizeChoices={[]}` / `sortFieldOptions={[]}`).
 */

export interface PreferencesColumnSpec {
  key: string
  /**
   * What the operator reads. Falls back to `key` where a caller leaves it empty — measured
   * 2026-09-02 while retiring the grid-lens fork: `/fulfillment/purchase-orders` ships
   * `label: ''` on its `select` and `actions` columns and leaned on the fork's own
   * `label || key`, so rendering `label` alone put two blank rows in the list. A row with no
   * name is not a column the operator can reason about — and the same is true of the aria-label
   * on its lock and remove buttons, which is why the fallback is applied through `nameOf` rather
   * than at one call site.
   */
  label: string
  /**
   * IMMUTABLE lock: the column is pinned to an edge of the grid and the dialog offers no lock
   * control for it. Distinct from `defaultLocked`, which the operator can undo.
   */
  locked?: boolean
  /**
   * Where this column's OPERATOR lock starts out. A column can be unlocked from the dialog and
   * then reordered or removed like any other — that is the whole point of the lock control.
   */
  defaultLocked?: boolean
  /**
   * Which EDGE an operator lock freezes this column to. Default `left` — the frozen block after the
   * grid's own leading columns. `right` is for a trailing bookend (an actions column) that the
   * caller pins right when locked: the dialog lists it at the END of "In view", in screen order, and
   * a drag between the two edges is refused. The grid's pin itself is the caller's to state.
   */
  lockSide?: 'left' | 'right'
  /**
   * Heading this column sits under in the dialog.
   *
   * Columns without one collect under `listLabel`, so a grid that declares no
   * groups renders exactly ONE section and looks identical to a grouped-unaware
   * build. That is the whole migration story: grouping is opt-in per caller and
   * costs the other callers nothing.
   */
  group?: string
  /** Stable schema-owned group identity; labels are for display only. */
  groupKey?: string
  /**
   * The group's colour, a `--nds-grid-tone-<tone>-*` name (2026-10-01: the product sheet's groups wear the old flat
   * file's colours). The group heading takes its tint, so the dialog and the grid header match colour for colour.
   * Absent ⇒ the heading is drawn as before.
   */
  groupTone?: string
  /**
   * Listed and tickable, but left out of every count the dialog prints ("240 columns", "In view · n of N") —
   * a column that is not one of the things the host counts (2026-09-27: the sheet's progress columns, so the dialog
   * and the toolbar agree on "236 attributes").
   */
  uncounted?: boolean
  /**
   * Always on screen, yet the operator's to MOVE and pin (2026-09-27: the sheet's variation theme). The tick is held
   * on ("Always shown"), the In-view row has no ✕, and every hide — a group's Clear, Clear all, bulk Hide — passes
   * it by. Unlike `locked`, it keeps its place in its group and in the order.
   */
  alwaysShown?: boolean
}

export interface PreferencesValue {
  visibleColumns: string[]
  /**
   * Columns the OPERATOR has locked: not removable, not draggable, until they unlock it.
   *
   * Optional so every caller that predates the lock keeps compiling and keeps its behaviour —
   * absent falls back to each column's `defaultLocked`.
   */
  lockedColumns?: string[]
  /** Complete attribute order, including hidden fields. */
  columnOrder?: string[]
  groupOrder?: string[]
  /** View-local column key → schema group key. Does not change product mappings. */
  groupOverrides?: Record<string, string>
  stickyFirstColumn: boolean
  stickyLastColumn: boolean
  pageSize: number
  sortBy: string
  sortDir: 'asc' | 'desc'
  /**
   * Row grouping, outermost first, by column key. Present only for a grid that offers
   * `groupByOptions`; the grid engine turns it into its own group state.
   */
  rowGroups?: string[]
  /** The aggregate shown on a group row per column key, for a grid that offers `aggregationOptions`. */
  aggregations?: Record<string, PreferencesAggFunc>
}

export type PreferencesAggFunc = 'sum' | 'avg' | 'min' | 'max' | 'count'
const AGG_LABELS: Record<PreferencesAggFunc, string> = { sum: 'Sum', avg: 'Average', min: 'Minimum', max: 'Maximum', count: 'Count' }

/**
 * A QUICK PICK — a set of columns derived from a column FACT ("Required here", "Axes", "Has
 * data"), offered as a toggle above the tick-list. Pressed when every column it names is in the
 * view; click adds the set or removes it. Sets compose: Required + Axes is their union. The
 * caller derives them from its own contract; the dialog never guesses what a column IS.
 */
export interface PreferencesQuickPick {
  id: string
  label: string
  columns: readonly string[]
  /** One line on hover — what the fact is. */
  hint?: string
}

/**
 * The dialog as a VIEW BUILDER: save the draft as a named view from the footer (design V.4c).
 * `activeName` names the saved view the grid is currently on, which enables "Update". Both
 * callbacks may throw — the reason is shown in the footer and the dialog stays open.
 */
export interface PreferencesViewSave {
  activeName: string | null
  /** Apply the draft AND write it under `name`. The dialog closes on success; `onConfirm` is NOT called. */
  onSaveAs: (name: string, value: PreferencesValue) => Promise<unknown>
  /** Apply the draft AND overwrite the active view with it. Same contract. */
  onUpdate?: (value: PreferencesValue) => Promise<unknown>
  /**
   * Open with the view-name field already showing — the dialog was opened by a views menu's
   * "New view…", so the job is to name what gets built here (2026-09-26). Read when the dialog opens.
   */
  startNaming?: boolean
}

export interface PreferencesModalProps {
  open: boolean
  onClose: () => void
  value: PreferencesValue
  onConfirm: (next: PreferencesValue) => void | Promise<void>
  /** Full column registry (visible + hidden + locked), in canonical order. */
  allColumns: readonly PreferencesColumnSpec[]
  /** The "Reset" target visible-columns list. */
  defaultVisible: readonly string[]
  /** Sort field options. Empty ⇒ the Sort section is hidden. */
  sortFieldOptions?: ReadonlyArray<{ value: string; label: string }>
  /** Page-size choices. Empty ⇒ the Page-size section is hidden. */
  pageSizeChoices?: number[]
  /** Show the sticky first/last column toggles (default true). */
  showSticky?: boolean
  /** Columns rows can be grouped by. Empty/absent ⇒ the Group section is hidden. */
  groupByOptions?: ReadonlyArray<{ key: string; label: string }>
  /** Columns a group row can aggregate, with the functions each allows. Empty/absent ⇒ hidden. */
  aggregationOptions?: ReadonlyArray<{ key: string; label: string; funcs: readonly PreferencesAggFunc[] }>
  /** Modal title (default "Customise"). */
  title?: string
  className?: string
  /**
   * What the list is called. Default "Columns" — every grid keeps its wording unchanged.
   *
   * GX.7 opened this dialog for a page's SECTIONS, where a legend reading "Columns" describes
   * something the reader is not looking at. Forking the dialog to fix a noun would give the
   * platform two Customize dialogs, which is the thing it decided not to have.
   *
   * Doubles as the fallback heading for any column that declares no `group`.
   */
  listLabel?: string
  /** The hint under the tick-list legend (a line, or a line with its info tip). */
  listHint?: ReactNode
  /** Extra left-panel content (workspace-specific preferences). */
  workspaceSlot?: ReactNode
  /** Quick picks above the tick-list. Absent ⇒ nothing renders; every existing caller is unchanged. */
  quickPicks?: readonly PreferencesQuickPick[]
  /** "All / Clear" on every group heading. Default off. */
  groupToggles?: boolean
  /** "· n of N" beside the In-view legend. Default off. */
  inViewCount?: boolean
  /** Save-as-view in the footer. Absent ⇒ the footer is byte-identical to before. */
  viewSave?: PreferencesViewSave
  /** Organize both panes by editable attribute groups. Hosts must persist the layout fields. */
  attributeGroups?: boolean
  /** Explicit recovery after a rejected save, without replacing an in-progress draft automatically. */
  onReloadSaved?: () => Promise<PreferencesValue>
  /**
   * "Select all · Clear all" above the tick-list — with filter text, they act on the matches only. Default off;
   * every other caller is unchanged. (Owner, 2026-09-27: "I'm unable to select all attributes".)
   */
  bulkPick?: boolean
  /** Keep the filter text and the open/closed groups from one opening to the next. Default off. */
  rememberInteraction?: boolean
  /** The primary button's words. Default "Save". */
  confirmLabel?: string
}

const DEFAULT_PAGE_SIZE_CHOICES = [20, 50, 100, 250]

const SHARED_DEFAULTS: Omit<PreferencesValue, 'visibleColumns' | 'lockedColumns'> = {
  stickyFirstColumn: true,
  stickyLastColumn: true,
  pageSize: 100,
  sortBy: 'updated',
  sortDir: 'desc',
}

/** Everything the panes need; the modal and the popover both supply it. */
export interface PreferencesPanesOptions {
  value: PreferencesValue
  onChange: (next: PreferencesValue) => void
  allColumns: readonly PreferencesColumnSpec[]
  defaultVisible: readonly string[]
  sortFieldOptions?: ReadonlyArray<{ value: string; label: string }>
  pageSizeChoices?: number[]
  showSticky?: boolean
  groupByOptions?: ReadonlyArray<{ key: string; label: string }>
  aggregationOptions?: ReadonlyArray<{ key: string; label: string; funcs: readonly PreferencesAggFunc[] }>
  listLabel?: string
  listHint?: ReactNode
  workspaceSlot?: ReactNode
  quickPicks?: readonly PreferencesQuickPick[]
  groupToggles?: boolean
  inViewCount?: boolean
  attributeGroups?: boolean
  /** "Select all · Clear all" above the tick-list (see `PreferencesModalProps.bulkPick`). */
  bulkPick?: boolean
}

/**
 * The dialog's panes as a hook: the tick-list, the in-view list, the grouping zones and the
 * display sections, each a piece of JSX that edits `value` through `onChange`. The modal feeds
 * it a draft and commits on Save; the popover feeds it the grid's live state and every change
 * applies at once. ONE implementation of every control, whichever surface shows it.
 */
/**
 * Below this many columns the filter box costs more than it earns: it takes a row of a panel that
 * is already short, on a list you can read at a glance. Above it, scrolling is the only way to find
 * anything. A single DS-wide number, deliberately not a prop — see the note on `showSearch`.
 */
const SEARCH_MIN_COLUMNS = 12

export function usePreferencesPanes({
  value,
  onChange,
  allColumns,
  defaultVisible,
  sortFieldOptions = [],
  pageSizeChoices = DEFAULT_PAGE_SIZE_CHOICES,
  showSticky = true,
  groupByOptions = [],
  aggregationOptions = [],
  listLabel = 'Columns',
  listHint,
  workspaceSlot,
  quickPicks = [],
  /* Default ON since 2026-09-05 (Owner: "the identity column has 7 fields; I should be able to select
     all the columns at once") — every Customise dialog offers a group's All / Clear and says how
     many columns are in view. A caller may still switch either off. */
  groupToggles = true,
  inViewCount: showInViewCount = true,
  attributeGroups = false,
  bulkPick = false,
}: PreferencesPanesOptions) {
  // Offer padlocks only to hosts that persist them. Advertising adapters and product grids do;
  // section-layout hosts omit the field because their panels have no frozen-column behavior.
  const locksPersist = value.lockedColumns !== undefined

  // Where the operator's locks start if these prefs predate the control.
  const defaultLocked = useMemo(
    () => allColumns.filter((c) => c.defaultLocked).map((c) => c.key),
    [allColumns],
  )

  // `draft` is whatever the caller holds — a modal's uncommitted copy or a live grid's state —
  // and `setDraft` hands the next value back the same way React's own setter would.
  const draft = value
  const setDraft = (next: PreferencesValue | ((d: PreferencesValue) => PreferencesValue)) =>
    onChange(typeof next === 'function' ? next(value) : next)

  // Render order: structural lead → the operator's FROZEN block (lock order) → visible (draft order)
  // → hidden → structural trail. The rule is `preferencesLogic.orderedForDisplay`, tested in node.
  const orderedForDisplay = useMemo<PreferencesColumnSpec[]>(
    () => orderForDisplay(allColumns, draft, defaultLocked),
    [allColumns, draft, defaultLocked],
  )

  // Legacy callers retain their flat order list. Attribute layout hosts share effective groups
  // between both panes and the grid, including assignments for hidden fields.
  const headingOf = (c: PreferencesColumnSpec) => c.group?.trim() || listLabel
  const nameOf = (c: PreferencesColumnSpec) => c.label || c.key
  const attributeSections = useMemo(() => resolveAttributeGroups(allColumns, draft, listLabel), [allColumns, draft, listLabel])

  // Two kinds of locked, and they are not the same question. `c.locked` is the grid's own
  // immutable pin and offers no control; the operator's set is theirs to change.
  const operatorLocks = effectiveLocks(draft, defaultLocked)
  const isLocked = (c: PreferencesColumnSpec) => !!c.locked || operatorLocks.includes(c.key)
  /* The lock contract (2026-09-05): a lock FREEZES the column at the left of the scrolling band and
     implies visible; unlocking lands it right after the frozen block. `preferencesLogic.toggleLock`. */
  const toggleLock = (key: string) => setDraft((d) => toggleLockIn(d, key, defaultLocked))

  // The LEFT tick-list is the registry: what columns this grid has. It follows `allColumns`
  // canonical order and never reshuffles, because a row that jumps the moment you untick it
  // makes the operator lose their place — measured on /products/next, unticking Channels moved
  // it below Status. Order is the RIGHT panel's job; existence is this one's.
  const pickSections = useMemo(() => {
    if (attributeGroups) {
      const structural = allColumns.filter((c) => c.locked)
      return [
        ...(structural.length ? [{ key: '__grid_fixed', heading: 'Fixed columns', columns: structural, tone: undefined as string | undefined }] : []),
        // A group whose every column was moved into another lists nothing to tick: it is left out here (2026-09-27).
        // The In-view pane keeps it as a drop target, marked Empty.
        ...attributeSections.filter((g) => g.columns.length > 0).map((g) => ({ key: g.key, heading: g.label, columns: g.columns, tone: g.tone })),
      ]
    }
    const byHeading = new Map<string, PreferencesColumnSpec[]>()
    for (const c of allColumns) {
      const heading = headingOf(c)
      const bucket = byHeading.get(heading)
      if (bucket) bucket.push(c)
      else byHeading.set(heading, [c])
    }
    // A heading wears its group's colour here too (the Matrix, 2026-10-08): the first of its columns that names one.
    return [...byHeading.entries()].map(([heading, columns]) => ({ key: heading, heading, columns, tone: columns.find((c) => c.groupTone)?.groupTone }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allColumns, listLabel, attributeGroups, attributeSections])

  /**
   * FINDING a column, which on a wide grid is the whole job. Measured 2026-09-02 on the studio's
   * Customise: 98 checkboxes in a 258px viewport over 3,436px of content — 13.3 screens of
   * scrolling, with no way to jump. The dialog was usable on a 12-column grid and unusable on a
   * 98-column one, and nothing in it said which it was.
   *
   * 🔴 The filter matches the KEY as well as the label, and that is not a convenience. The studio's
   * attribute labels come from the marketplace in the MARKET's language — `Aufzählungspunkt`,
   * `Viñeta` — so an English-speaking operator cannot search for a word they do not have. The keys
   * are stable and English-ish (`bullet_point`), so typing "bullet" finds the German label. It does
   * not fix the localisation (that question is the Owner's), but it means the dialog is navigable
   * before that lands.
   */
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [viewCollapsed, setViewCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>())

  const needle = query.trim().toLowerCase()
  const filteredSections = useMemo(() => {
    if (!needle) return pickSections
    return pickSections
      .map((section) => ({
        key: section.key,
        heading: section.heading,
        tone: section.tone,
        columns: section.columns.filter(
          (c) => c.label.toLowerCase().includes(needle) || c.key.toLowerCase().includes(needle) || (attributeGroups && section.heading.toLowerCase().includes(needle)),
        ),
      }))
      .filter((section) => section.columns.length > 0)
  }, [pickSections, needle, attributeGroups])

  const totalCount = (attributeGroups ? allColumns.filter((c) => !c.locked) : allColumns).filter((c) => !c.uncounted).length
  const matchCount = useMemo(
    () => filteredSections.reduce((n, s) => n + s.columns.filter((c) => (!attributeGroups || !c.locked) && !c.uncounted).length, 0),
    [filteredSections, attributeGroups],
  )
  // Only worth its row on a list long enough to get lost in. One rule in the DS rather than a prop
  // each caller answers differently — "shared" has to mean the same dialog, not a configurable one.
  const showSearch = totalCount >= SEARCH_MIN_COLUMNS
  const allCollapsed = filteredSections.length > 0 && filteredSections.every((s) => collapsed.has(s.key))
  const toggleSection = (heading: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(heading)) next.delete(heading)
      else next.add(heading)
      return next
    })
  const setAllCollapsed = (on: boolean) =>
    setCollapsed(on ? new Set(pickSections.map((s) => s.key)) : new Set<string>())

  // The right panel holds ONLY what is in the view, as one flat ordered list. An operator-LOCKED
  // column is in the view whatever the tick-list says (a lock implies visible) — measured
  // 2026-09-05: filtering on the STRUCTURAL flag alone dropped master's locked identity column from
  // the list, so its frozen row and its padlock were nowhere to be found.
  const shownColumns = useMemo(
    () => orderedForDisplay.filter((c) => isLocked(c) || draft.visibleColumns.includes(c.key)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orderedForDisplay, draft.visibleColumns, operatorLocks.join(' ')],
  )

  // With one section the legend above the tick-list already names it; repeating it inside the
  // box would be a heading over the only thing there is.
  const showHeadings = pickSections.length > 1

  // ── Drag-reorder (dnd-kit since 2026-10-01; `preferencesDnd.tsx`) ──
  // Two orders live in one flat list: the frozen block (lock order) and the visible rest. A drop is
  // honoured only WITHIN a block — `preferencesLogic.moveVisible` refuses a cross-boundary drop by
  // returning the same value, and the list stays exactly as it was. In the grouped list a column lands
  // among columns or on a group (`placeColumns`); a group among groups.
  const sideOf = (key: string): 'left' | 'right' => (allColumns.find((c) => c.key === key)?.lockSide === 'right' ? 'right' : 'left')
  /** The drag in flight: what was lifted, and every column that moves with it (a ticked set). */
  const [drag, setDrag] = useState<{ kind: DragKind; key: string; keys: string[] } | null>(null)
  /** What just landed glows once, so the eye finds it. */
  const [justMoved, setJustMoved] = useState<ReadonlySet<string>>(() => new Set<string>())
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current)
    if (expandTimer.current) clearTimeout(expandTimer.current)
  }, [])
  // Escape during a drag cancels the DRAG, never the dialog: the dialog ignores an Escape already handled (measured on
  // :3650: Escape mid-drag closed Customise and dropped the draft).
  useEffect(() => {
    if (!drag || typeof window === 'undefined') return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') event.preventDefault() }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [drag])
  const [still, setStill] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setStill(query.matches)
    update()
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])
  // A mouse lifts after a 4 px move (a click stays a click); a finger after a short press, so a swipe still scrolls.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  /** The card floats above the dialog (`--nds-z-overlay`) and its menus (`--nds-z-popover`); dnd-kit's own 999 sat under it. */
  const overlayZ = useMemo(() => (typeof document === 'undefined' ? 1451
    : (Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--nds-z-popover'), 10) || 1450) + 1), [])
  const flash = (ids: string[]) => {
    setJustMoved(new Set(ids))
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setJustMoved(new Set<string>()), 900)
  }

  // An `alwaysShown` column is never hidden, by any route (see `PreferencesColumnSpec.alwaysShown`).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const alwaysShown = useMemo(() => new Set(allColumns.filter((c) => c.alwaysShown).map((c) => c.key)), [allColumns])
  const toggleColumn = (key: string) => { if (!alwaysShown.has(key) || !draft.visibleColumns.includes(key)) setDraft((d) => toggleColumnIn(d, key, defaultLocked)) }

  // ── SET-level edits: quick picks and group toggles (design V.4) ──
  // Only columns this grid HAS and the operator may toggle; a pick naming a column that is locked
  // or absent neither adds nor removes it, and counts as satisfied so the toggle can still read
  // "pressed" on a product type that lacks one of its columns.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const togglableKeys = useMemo(() => togglableKeysOf(allColumns).filter((k) => !operatorLocks.includes(k)), [allColumns, operatorLocks.join(' ')])
  const togglableSet = useMemo(() => new Set(togglableKeys), [togglableKeys])
  const addColumns = (keys: readonly string[]) => setDraft((d) => addColumnsTo(d, keys, togglableSet))
  const removeColumns = (keys: readonly string[]) => setDraft((d) => removeColumnsFrom(d, keys.filter((key) => !alwaysShown.has(key)), defaultLocked))
  const setHas = (keys: readonly string[]) => setIsIn(draft, keys, togglableSet)

  const selectableKeys = new Set(allColumns.filter((c) => !c.locked).map((c) => c.key))
  const selectedKeys = [...selected].filter((k) => selectableKeys.has(k))
  const selectKeys = (keys: readonly string[]) => setSelected((current) => {
    const eligible = keys.filter((key) => selectableKeys.has(key))
    const next = new Set(current)
    const clear = eligible.length > 0 && eligible.every((key) => current.has(key))
    for (const key of eligible) { if (clear) next.delete(key); else next.add(key) }
    return next
  })
  const setSelectedLocks = (pin: boolean) => setDraft((d) => {
    let next = d
    for (const key of selectedKeys) {
      if (effectiveLocks(next, defaultLocked).includes(key) !== pin) next = toggleLockIn(next, key, defaultLocked)
    }
    return next
  })
  const matchesColumn = (c: PreferencesColumnSpec, group = '') => !needle || nameOf(c).toLowerCase().includes(needle)
    || c.key.toLowerCase().includes(needle) || group.toLowerCase().includes(needle)
  const moveSelection = (target: string) => {
    if (target) setDraft((d) => moveAttributesToGroup(allColumns, d, selectedKeys, target))
  }
  const resetInteraction = () => {
    setQuery(''); setCollapsed(new Set()); setViewCollapsed(new Set()); setSelected(new Set()); setDrag(null)
  }
  /** Only what must never outlive a close: the bulk selection and a drag in flight. */
  const resetSelection = () => { setSelected(new Set()); setDrag(null) }

  /**
   * The grid's defaults, as a value — the modal drafts it, the popover applies it.
   *
   * A reset changes only what this dialog SHOWS. A caller with no sort control keeps its sort, one
   * with no sticky controls keeps its sticky flags, one with no page-size choice keeps its page size
   * — measured 2026-09-05 on /products/next (headers sort, no Display tab): Reset wrote
   * `sortBy: 'updated'` and `stickyLastColumn: true` from the shared defaults into a page that had
   * no control to show them, and the caller had to neutralise them after every confirm.
   */
  const resetValue = (): PreferencesValue => ({
      ...SHARED_DEFAULTS,
      ...(sortFieldOptions.length === 0 ? { sortBy: value.sortBy, sortDir: value.sortDir } : {}),
      ...(showSticky ? {} : { stickyFirstColumn: value.stickyFirstColumn, stickyLastColumn: value.stickyLastColumn }),
      ...(pageSizeChoices.length === 0 ? { pageSize: value.pageSize } : {}),
      // Clamp the default sort field to one this grid actually offers (the shared
      // default 'updated' isn't valid on every workspace); fall back to the first.
      ...(sortFieldOptions.length > 0
        ? {
            sortBy: sortFieldOptions.some((o) => o.value === SHARED_DEFAULTS.sortBy)
              ? SHARED_DEFAULTS.sortBy
              : sortFieldOptions[0]?.value ?? SHARED_DEFAULTS.sortBy,
          }
        : {}),
      visibleColumns: [...defaultVisible],
      lockedColumns: [...defaultLocked],
      ...(attributeGroups ? { columnOrder: [...defaultVisible], groupOrder: [], groupOverrides: {} } : {}),
      ...(groupByOptions.length ? { rowGroups: [] } : {}),
      ...(aggregationOptions.length ? { aggregations: {} } : {}),
    })

  // Does the left panel have ANY section to show? `workspaceSlot` counts — a caller can fill it
  // even when all three built-ins are off. The tick-list lives there too, so it is never empty —
  // the `single` one-column fallback below is kept for a caller that renders no list at all.
  const hasLeftPanel = true || groupByOptions.length > 0 || aggregationOptions.length > 0

  // The heading NAMES the rows under it for a screen reader, which a styled <p> above a list
  // does not. Withheld when there is one unnamed section, so nothing is announced twice.
  const groupProps = (heading: string) =>
    showHeadings ? ({ role: 'group', 'aria-label': heading } as const) : {}

  // ── The three panes, built once and placed by the layout below ─────────────────────────
  const displaySections = (
    <>
          {pageSizeChoices.length > 0 && (
            <fieldset className="nds-prefs-set">
              <legend>Rows per page</legend>
              <div className="nds-prefs-radios">
                {pageSizeChoices.map((n) => (
                  <label key={n}>
                    <input
                      type="radio"
                      name="ds-prefs-pagesize"
                      checked={draft.pageSize === n}
                      onChange={() => setDraft((d) => ({ ...d, pageSize: n }))}
                    />
                    <span>{n}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {showSticky && (
            <fieldset className="nds-prefs-set">
              <legend>Sticky columns</legend>
              <p className="nds-prefs-help">Keep the first / last column pinned while scrolling sideways.</p>
              <label className="nds-prefs-check">
                <input
                  type="checkbox"
                  checked={draft.stickyFirstColumn}
                  onChange={(e) => setDraft((d) => ({ ...d, stickyFirstColumn: e.target.checked }))}
                />
                <span>Pin first column</span>
              </label>
              <label className="nds-prefs-check">
                <input
                  type="checkbox"
                  checked={draft.stickyLastColumn}
                  onChange={(e) => setDraft((d) => ({ ...d, stickyLastColumn: e.target.checked }))}
                />
                <span>Pin last column</span>
              </label>
            </fieldset>
          )}

          {workspaceSlot}

          {sortFieldOptions.length > 0 && (
            <fieldset className="nds-prefs-set">
              <legend>Sort order</legend>
              <div className="nds-prefs-sort">
                <select
                  className="nds-select"
                  value={draft.sortBy}
                  onChange={(e) => setDraft((d) => ({ ...d, sortBy: e.target.value }))}
                >
                  {sortFieldOptions.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <select
                  className="nds-select"
                  value={draft.sortDir}
                  onChange={(e) => setDraft((d) => ({ ...d, sortDir: e.target.value as 'asc' | 'desc' }))}
                >
                  <option value="desc">↓ Descending</option>
                  <option value="asc">↑ Ascending</option>
                </select>
              </div>
            </fieldset>
          )}
    </>
  )
  const pickList = (
    <>
          {/* The CHOOSING half: every column the grid has, grouped, each a tick. */}
          {(
            <div className="nds-prefs-set nds-prefs-pickset">
              <legend>{listLabel}</legend>
              <p className="nds-prefs-help">{listHint ?? 'Tick a column to add it to the view.'}</p>
              {quickPicks.length > 0 && (
                <div className="nds-prefs-quick" role="group" aria-label="Quick picks">
                  <FilterChip
                    pressed={togglableKeys.length > 0 && togglableKeys.every((k) => draft.visibleColumns.includes(k))}
                    onClick={() => (togglableKeys.every((k) => draft.visibleColumns.includes(k)) ? removeColumns(togglableKeys) : addColumns(togglableKeys))}
                    title="Every column"
                  >
                    All
                  </FilterChip>
                  <FilterChip
                    pressed={draft.visibleColumns.filter((k) => togglableSet.has(k)).length === 0}
                    onClick={() => removeColumns(togglableKeys)}
                    title="Only the locked columns"
                  >
                    None
                  </FilterChip>
                  <span className="nds-prefs-quicksep" aria-hidden />
                  {quickPicks.map((q) => {
                    const on = setHas(q.columns)
                    const n = q.columns.filter((k) => togglableSet.has(k)).length
                    return (
                      <FilterChip
                        key={q.id}
                        pressed={on}
                        count={n}
                        title={q.hint}
                        onClick={() => (on ? removeColumns(q.columns) : addColumns(q.columns))}
                      >
                        {q.label}
                      </FilterChip>
                    )
                  })}
                </div>
              )}
              {showSearch && (
                <div className="nds-prefs-find">
                  <Input
                    size="sm"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter columns…"
                    aria-label={`Filter ${listLabel.toLowerCase()}`}
                    leadingIcon={<Search size={13} aria-hidden />}
                    fieldClassName="nds-prefs-findfield"
                  />
                  {/* The count is the answer to "is it not here, or am I not scrolled to it?" — the
                      question 13 screens of unlabelled scrolling cannot answer. It is stated in
                      both states, because "98 columns" is as much a fact as "3 of 98". */}
                  <span className="nds-prefs-findcount" role="status" aria-live="polite">
                    {needle ? `${matchCount} of ${totalCount}` : `${totalCount} columns`}
                  </span>
                  {showHeadings && !needle && pickSections.length > 1 && (
                    <button
                      type="button"
                      className="nds-prefs-findall"
                      onClick={() => setAllCollapsed(!allCollapsed)}
                    >
                      {allCollapsed ? 'Expand all' : 'Collapse all'}
                    </button>
                  )}
                </div>
              )}
              {bulkPick && (() => {
                /* The columns the operator can tick that the filter shows — every one, or the matches. A locked
                   column is in the view whatever this does, so it is never counted. */
                const keys = filteredSections.flatMap((section) => section.columns.filter((c) => !isLocked(c) && !c.alwaysShown && togglableSet.has(c.key)).map((c) => c.key))
                if (!keys.length) return null
                const shown = keys.filter((k) => draft.visibleColumns.includes(k)).length
                return (
                  <div className="nds-prefs-pickall" role="group" aria-label={needle ? 'Select the matching columns' : 'Select every column'}>
                    <button type="button" className="nds-prefs-findall" disabled={shown === keys.length} onClick={() => addColumns(keys)}>
                      {needle ? `Select ${keys.length === 1 ? 'the match' : `all ${keys.length} matches`}` : 'Select all'}
                    </button>
                    <button type="button" className="nds-prefs-findall" disabled={shown === 0} onClick={() => removeColumns(keys)}>
                      {needle ? `Clear ${keys.length === 1 ? 'the match' : `${keys.length} matches`}` : 'Clear all'}
                    </button>
                  </div>
                )
              })()}
              <div className="nds-prefs-cols nds-prefs-picks">
                {needle && filteredSections.length === 0 && (
                  <p className="nds-prefs-help nds-prefs-nomatch">No column matches “{query.trim()}”.</p>
                )}
                {filteredSections.map((section) => {
                  // 🔴 A filter OVERRIDES collapse. A section that stays shut while holding a match
                  // renders an empty result for a search that succeeded — the control would be
                  // lying about the answer, which is worse than not having the control.
                  const isCollapsed = showHeadings && !needle && collapsed.has(section.key)
                  const fullSection = pickSections.find((g) => g.key === section.key) ?? section
                  const sectionShown = fullSection.columns.filter((c) => isLocked(c) || draft.visibleColumns.includes(c.key)).length
                  const headingButton = showHeadings && (
                    <button
                      type="button"
                      className="nds-prefs-grouphd"
                      aria-expanded={!isCollapsed}
                      onClick={() => toggleSection(section.key)}
                    >
                      {isCollapsed ? <ChevronRight size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
                      <span className="nds-prefs-grouphd-text">{section.heading}</span>
                      <span className="nds-prefs-groupcount">{attributeGroups ? `${sectionShown}/${fullSection.columns.length} shown${needle ? ` · ${section.columns.length} match` : ''}` : section.columns.length}</span>
                    </button>
                  )
                  // The group's togglable keys; "All" when any is missing from the view, "Clear" when
                  // none is. A sibling of the heading button, never inside it — a button in a button
                  // is not HTML, and the heading keeps its own collapse job.
                  const groupKeys = section.columns.filter((c) => !isLocked(c) && !c.alwaysShown).map((c) => c.key)
                  const groupAllIn = groupKeys.length > 0 && groupKeys.every((k) => draft.visibleColumns.includes(k))
                  return (
                  <div key={section.key} className="nds-prefs-group" data-tone={section.tone} {...groupProps(section.heading)}>
                    {showHeadings && groupToggles && groupKeys.length > 0 ? (
                      <div className="nds-prefs-grouprow">
                        {headingButton}
                        <Button
                          size="xs"
                          variant="ghost"
                          className="nds-prefs-grouptoggle"
                          onClick={() => (groupAllIn ? removeColumns(groupKeys) : addColumns(groupKeys))}
                          aria-label={`${groupAllIn ? 'Remove' : 'Add'} ${needle ? 'matching' : 'every'} ${section.heading} column`}
                        >
                          {groupAllIn ? 'Clear' : 'All'}
                        </Button>
                      </div>
                    ) : (
                      headingButton
                    )}
                    {!isCollapsed && section.columns.map((c) => {
                      const locked = isLocked(c)
                      const held = locked || !!c.alwaysShown
                      return (
                        <div key={c.key} className={`nds-prefs-pick${held ? ' locked' : ''}`}>
                          {/* Disabled-and-ticked rather than absent: a locked column missing from
                              the list looks like a column the grid does not have, and a disabled
                              tick cannot be unticked, so the column cannot be lost. */}
                          <Checkbox
                            checked={held || draft.visibleColumns.includes(c.key)}
                            disabled={held}
                            onChange={() => !held && toggleColumn(c.key)}
                            label={
                              <span className="nds-prefs-picklbl">
                                <span className="nds-prefs-lbl">{nameOf(c)}</span>
                                {locked ? (
                                  <span className="nds-prefs-locked" title={c.locked ? 'Locked by the grid' : `Locked — frozen at the ${c.lockSide === 'right' ? 'right' : 'left'} while you scroll`}>
                                    <Lock size={11} aria-hidden /> Locked
                                  </span>
                                ) : c.alwaysShown && (
                                  <span className="nds-prefs-locked" title="Always on screen — move or pin it in In view">Always shown</span>
                                )}
                              </span>
                            }
                          />
                        </div>
                      )
                    })}
                  </div>
                  )
                })}
              </div>
            </div>
          )}
    </>
  )
  const selectionBox = (keys: readonly string[], label: string) => {
    const eligible = keys.filter((key) => selectableKeys.has(key))
    const count = eligible.filter((key) => selected.has(key)).length
    return <Checkbox aria-label={label} checked={eligible.length > 0 && count === eligible.length}
      disabled={!eligible.length} ref={(node) => { if (node) node.indeterminate = count > 0 && count < eligible.length }}
      onChange={() => selectKeys(eligible)} />
  }
  const renderViewRow = (c: PreferencesColumnSpec, peers: readonly PreferencesColumnSpec[], kind: DragKind) => {
    const locked = isLocked(c)
    const draggable = !c.locked
    const index = peers.findIndex((p) => p.key === c.key)
    const moveOne = (direction: -1 | 1) => {
      const target = peers[index + direction]
      if (!target || target.locked) return
      setDraft((d) => locked
        ? moveVisible(d, c.key, target.key, defaultLocked, sideOf)
        : moveAttributeColumn(allColumns, d, c.key, target.key, direction === 1))
    }
    const companion = !!drag && drag.key !== c.key && drag.keys.includes(c.key)
    return (
      <Sortable key={c.key} id={dragId(kind, c.key)} disabled={!draggable} still={still} toneOf={kind === 'col' ? toneOfTarget : undefined}
        grip={{ label: `Drag ${nameOf(c)} — Space to lift, arrow keys to move, Space to drop` }}
        className={['nds-prefs-row', draggable ? 'draggable' : '', locked ? 'locked' : '', selected.has(c.key) ? 'selected' : '',
          companion ? 'is-drag-companion' : '', justMoved.has(c.key) ? 'just-moved' : ''].filter(Boolean).join(' ')}>
        <>
          {attributeGroups && !c.locked && selectionBox([c.key], `Select ${nameOf(c)} for bulk actions`)}
          <span className="nds-prefs-lbl" title={nameOf(c)}>{nameOf(c)}</span>
          {attributeGroups && draggable && <span className="nds-prefs-orderbtns">
            <Button size="xs" variant="ghost" onClick={() => moveOne(-1)} disabled={index === 0 || !!peers[index - 1]?.locked} aria-label={`Move ${nameOf(c)} up`}><ArrowUp size={12} /></Button>
            <Button size="xs" variant="ghost" onClick={() => moveOne(1)} disabled={index === peers.length - 1 || !!peers[index + 1]?.locked} aria-label={`Move ${nameOf(c)} down`}><ArrowDown size={12} /></Button>
          </span>}
          {c.locked ? <span className="nds-prefs-locked">{attributeGroups ? 'Fixed' : 'Locked'}</span> : locksPersist ? (
            <button type="button" className={`nds-prefs-lockbtn${locked ? ' on' : ''}`} onClick={() => toggleLock(c.key)} aria-pressed={locked}
              aria-label={locked ? `Unlock ${nameOf(c)} — back into the scrolling columns` : `Lock ${nameOf(c)} — frozen while you scroll`}
              title={locked ? 'Unlock — back into the scrolling columns' : 'Lock — frozen while you scroll'}>
              {locked ? <Lock size={13} aria-hidden /> : <Unlock size={13} aria-hidden />}
            </button>
          ) : locked && <span className="nds-prefs-locked">Locked</span>}
          <span className="nds-prefs-xslot">{!locked && !c.alwaysShown && <button type="button" className="nds-prefs-x" onClick={() => toggleColumn(c.key)} aria-label={`Remove ${nameOf(c)} from the view`}><X size={13} aria-hidden /></button>}</span>
        </>
      </Sortable>
    )
  }
  const pinnedColumns = shownColumns.filter((c) => isLocked(c))
  const pinnedOn = (side: 'left' | 'right') => pinnedColumns.filter((c) => (c.lockSide === 'right' ? 'right' : 'left') === side && matchesColumn(c))
  const renderPinned = (side: 'left' | 'right') => {
    const columns = pinnedOn(side)
    const kind: DragKind = side === 'left' ? 'pin-left' : 'pin-right'
    return columns.length > 0 && <div className="nds-prefs-group" role="group" aria-label={side === 'left' ? 'Pinned columns' : 'Pinned right columns'}>
      <div className="nds-prefs-pinnedhd"><Lock size={12} /> {side === 'left' ? 'Pinned' : 'Pinned right'} · {columns.length}</div>
      <SortableContext items={columns.map((c) => dragId(kind, c.key))} strategy={verticalListSortingStrategy}>
        {columns.map((c) => renderViewRow(c, columns, kind))}
      </SortableContext>
    </div>
  }
  const matchingShown = shownColumns.filter((c) => matchesColumn(c, attributeSections.find((g) => g.columns.some((x) => x.key === c.key))?.label))
  const concealedSelected = selectedKeys.filter((key) => !matchingShown.some((c) => c.key === key)).length

  /* The grouped list, worked out once for the rows AND the drag: what each group shows, and in which order. A group
     being dragged folds every group to its heading, so it is placed among headings, not among 228 rows. */
  const groupDragging = drag?.kind === 'group'
  const viewSections = attributeSections.flatMap((group, groupIndex) => {
    const matching = group.columns.filter((c) => matchesColumn(c, group.label))
    if (needle && !matching.length) return []
    const visible = matching.filter((c) => !isLocked(c) && draft.visibleColumns.includes(c.key))
    const pinned = group.columns.filter((c) => isLocked(c)).length
    const shown = group.columns.filter((c) => isLocked(c) || draft.visibleColumns.includes(c.key)).length
    const isCollapsed = groupDragging || (!needle && viewCollapsed.has(group.key))
    return [{ group, groupIndex, matching, visible, pinned, shown, isCollapsed }]
  })
  const groupedIds = viewSections.flatMap((s) => [dragId('group', s.group.key), ...(s.isCollapsed ? [] : s.visible.map((c) => dragId('col', c.key)))])
  const toneOfColumn = (key: string) => attributeSections.find((g) => g.columns.some((c) => c.key === key))?.tone
  /** A lifted column takes the colour of the group it is over: the card's edge and the slot say where it will land. */
  const toneOfTarget = (overId: string | null) => {
    const over = parseDragId(overId)
    if (!over) return undefined
    return over.kind === 'group' ? attributeSections.find((g) => g.key === over.key)?.tone : toneOfColumn(over.key)
  }
  const labelOfDrag = (id: string | number | null | undefined) => {
    const p = parseDragId(id)
    if (!p) return ''
    if (p.kind === 'group') return attributeSections.find((g) => g.key === p.key)?.label ?? p.key
    const column = allColumns.find((c) => c.key === p.key)
    return column ? nameOf(column) : p.key
  }

  /** Only a place the lifted thing may go is a target: a column among columns or on a group; the rest among their own.
      The target is what is under the pointer (`pointerFirst`). */
  const companions = new Set((drag?.keys ?? []).filter((key) => key !== drag?.key).map((key) => dragId('col', key)))
  const collisionDetection = pointerFirst((id) => {
    const lifted = drag ? { kind: drag.kind } : null
    const over = parseDragId(id)
    return !!lifted && !!over && canLandOn(lifted.kind, over.kind) && !companions.has(id)
  })
  const onDragStart = ({ active }: DragStartEvent) => {
    const lifted = parseDragId(active.id)
    if (!lifted) return
    // A ticked row carries the whole ticked set with it, in the order the list shows them.
    const keys = lifted.kind === 'col' && selected.has(lifted.key) && selectedKeys.length > 1
      ? attributeSections.flatMap((g) => g.columns).filter((c) => selected.has(c.key) && !isLocked(c) && draft.visibleColumns.includes(c.key)).map((c) => c.key)
      : [lifted.key]
    setDrag({ kind: lifted.kind, key: lifted.key, keys })
  }
  const onDragOver = ({ over }: DragOverEvent) => {
    const id = over ? String(over.id) : null
    if (expandTimer.current) { clearTimeout(expandTimer.current); expandTimer.current = null }
    const target = parseDragId(id)
    // Held over a folded group, a column opens it — so it can land anywhere inside.
    if (drag?.kind === 'col' && target?.kind === 'group' && viewCollapsed.has(target.key)) {
      expandTimer.current = setTimeout(() => setViewCollapsed((prev) => { const next = new Set(prev); next.delete(target.key); return next }), 450)
    }
  }
  const endDrag = () => {
    if (expandTimer.current) { clearTimeout(expandTimer.current); expandTimer.current = null }
    setDrag(null)
  }
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const current = drag
    endDrag()
    const lifted = parseDragId(active.id), target = parseDragId(over?.id)
    if (!current || !lifted || !target || !over || active.id === over.id) return
    if (lifted.kind === 'group') {
      const ids = viewSections.map((s) => dragId('group', s.group.key))
      const from = ids.indexOf(String(active.id)), to = ids.indexOf(String(over.id))
      if (from < 0 || to < 0) return
      setDraft((d) => moveAttributeGroup(allColumns, d, lifted.key, target.key, to > from))
      flash([dragId('group', lifted.key)])
      return
    }
    if (lifted.kind === 'col') {
      // Where it lands is decided by its new neighbours: before the next column, after the previous one, or into the
      // group whose heading it now follows (an empty or folded group).
      const order = arrayMove(groupedIds, groupedIds.indexOf(String(active.id)), groupedIds.indexOf(String(over.id)))
      const at = order.indexOf(String(active.id))
      const moving = new Set(current.keys.map((key) => dragId('col', key)))
      const next = parseDragId(order.slice(at + 1).find((id) => !moving.has(id)))
      const previous = parseDragId(order.slice(0, at).reverse().find((id) => !moving.has(id)))
      const place = next?.kind === 'col' ? { before: next.key } : previous?.kind === 'col' ? { after: previous.key } : previous?.kind === 'group' ? { group: previous.key } : null
      setDraft((d) => placeColumns(allColumns, d, current.keys, place))
      flash(current.keys)
      return
    }
    // The frozen blocks and a grid without groups keep the within-block rule.
    setDraft((d) => moveVisible(d, lifted.key, target.key, defaultLocked, sideOf))
    flash([lifted.key])
  }
  const announcements = {
    onDragStart: ({ active }: DragStartEvent) => `Picked up ${labelOfDrag(active.id)}. Arrow keys move it, Space drops it, Escape cancels.`,
    onDragOver: ({ active, over }: DragOverEvent) => over ? `${labelOfDrag(active.id)} is over ${labelOfDrag(over.id)}.` : `${labelOfDrag(active.id)} is not over a place it can go.`,
    onDragEnd: ({ active, over }: DragEndEvent) => over ? `${labelOfDrag(active.id)} dropped at ${labelOfDrag(over.id)}.` : `${labelOfDrag(active.id)} put back.`,
    onDragCancel: ({ active }: DragEndEvent) => `Moving ${labelOfDrag(active.id)} cancelled. It is back where it was.`,
  }
  const draggedGroup = drag?.kind === 'group' ? attributeSections.find((g) => g.key === drag.key) : undefined
  const dragOverlay = drag && (draggedGroup
    ? <DragCard group label={draggedGroup.label} tone={draggedGroup.tone} count={draggedGroup.columns.length} />
    : <DragCard label={labelOfDrag(dragId(drag.kind, drag.key))} tone={toneOfColumn(drag.key)} toneOf={drag.kind === 'col' ? toneOfTarget : undefined} count={drag.keys.length} />)
  /** One drag context for the whole In-view list; the lifted card floats above the dialog (portalled, so a transformed
      ancestor cannot misplace it). */
  const withDrag = (list: ReactNode) => (
    <DndContext sensors={sensors} collisionDetection={collisionDetection} modifiers={[followPointer]} onDragStart={onDragStart} onDragOver={onDragOver}
      onDragEnd={onDragEnd} onDragCancel={endDrag} measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      autoScroll={{ threshold: { x: 0, y: 0.18 }, acceleration: 14 }}
      accessibility={{ announcements, screenReaderInstructions: { draggable: 'To move a column or a group, focus its grip and press Space. Arrow keys move it, Space drops it, Escape cancels.' } }}>
      {list}
      {typeof document !== 'undefined' && createPortal(
        <DragOverlay className="nds-prefs-dragoverlay" zIndex={overlayZ} dropAnimation={still ? null : { duration: 200, easing: SLIDE.easing, sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0' } } }) }}>
          {dragOverlay}
        </DragOverlay>, document.body)}
    </DndContext>
  )

  const groupedInView = <>
    <div className="nds-prefs-group-tools">
      {selectionBox(matchingShown.map((c) => c.key), needle ? 'Select matching columns in view' : 'Select all columns in view')}
      <span>Select {needle ? 'matching columns' : 'columns'} for bulk actions</span>
      <Button size="xs" variant="ghost" onClick={() => setViewCollapsed(viewCollapsed.size ? new Set() : new Set(attributeSections.map((g) => g.key)))}>{viewCollapsed.size ? 'Expand all' : 'Collapse all'}</Button>
    </div>
    {selectedKeys.length > 0 && <div className="nds-prefs-bulk" role="group" aria-label="Selected column actions">
      <span className="nds-prefs-bulk-count" role="status">{selectedKeys.length} selected{concealedSelected > 0 ? ` · ${concealedSelected} hidden from this list` : ''}</span>
      <Button size="xs" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
      <select className="nds-select" aria-label="Move selected columns to group" value="" onChange={(e) => moveSelection(e.target.value)}>
        <option value="" disabled>Move to group…</option>
        {attributeSections.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
      </select>
      <Button size="xs" variant="secondary" onClick={() => addColumns(selectedKeys)} disabled={selectedKeys.every((key) => draft.visibleColumns.includes(key) || operatorLocks.includes(key))}>Show</Button>
      <Button size="xs" variant="secondary" onClick={() => removeColumns(selectedKeys)} disabled={!selectedKeys.some((key) => draft.visibleColumns.includes(key) && !operatorLocks.includes(key) && !alwaysShown.has(key))}>Hide</Button>
      {locksPersist && <>
        <Button size="xs" variant="secondary" onClick={() => setSelectedLocks(true)} disabled={selectedKeys.every((key) => operatorLocks.includes(key))}>Pin</Button>
        <Button size="xs" variant="secondary" onClick={() => setSelectedLocks(false)} disabled={!selectedKeys.some((key) => operatorLocks.includes(key))}>Unpin</Button>
      </>}
      <Button size="xs" variant="ghost" onClick={() => setDraft((d) => resetAttributeGroups(d, selectedKeys))} disabled={!selectedKeys.some((key) => draft.groupOverrides?.[key])}>Reset group</Button>
    </div>}
    {withDrag(<div className={['nds-prefs-cols', 'nds-prefs-viewgroups', drag ? 'is-sorting' : ''].filter(Boolean).join(' ')}>
      {renderPinned('left')}
      <SortableContext items={groupedIds} strategy={verticalListSortingStrategy}>
        {viewSections.map(({ group, groupIndex, matching, visible, pinned, shown, isCollapsed }) => {
          const reorder = (direction: -1 | 1) => {
            const target = attributeSections[groupIndex + direction]
            if (target) setDraft((d) => moveAttributeGroup(allColumns, d, group.key, target.key, direction === 1))
          }
          const headingId = dragId('group', group.key)
          return <div key={group.key} className="nds-prefs-group" data-tone={group.tone} role="group" aria-label={`${group.label} in view`}>
            <Sortable id={headingId} still={still} heading grip={{ size: 13, label: `Drag the ${group.label} group — Space to lift, arrow keys to move, Space to drop` }}
              className={['nds-prefs-viewgrouphd', justMoved.has(headingId) ? 'just-moved' : ''].filter(Boolean).join(' ')}>
              <>
                {selectionBox(visible.map((c) => c.key), `Select ${needle ? 'matching ' : ''}${group.label} columns in view`)}
                <button type="button" className="nds-prefs-group-label" aria-expanded={!isCollapsed} onClick={() => setViewCollapsed((prev) => { const next = new Set(prev); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next })}>
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}<span>{group.label}</span>
                </button>
                <span className="nds-prefs-groupcount" title={`${shown} shown of ${group.columns.length} columns${pinned ? `, including ${pinned} pinned` : ''}`}>{shown}/{group.columns.length}{pinned > 0 ? ` · ${pinned} pinned` : ''}</span>
                <span className="nds-prefs-orderbtns">
                  <Button size="xs" variant="ghost" onClick={() => reorder(-1)} disabled={groupIndex === 0} aria-label={`Move ${group.label} group up`}><ArrowUp size={12} /></Button>
                  <Button size="xs" variant="ghost" onClick={() => reorder(1)} disabled={groupIndex === attributeSections.length - 1} aria-label={`Move ${group.label} group down`}><ArrowDown size={12} /></Button>
                </span>
              </>
            </Sortable>
            {!isCollapsed && <>
              {visible.map((c) => renderViewRow(c, visible, 'col'))}
              {visible.length === 0 && (group.columns.length === 0
                // Every column of this group was moved into another one: say so, and leave it as a drop target.
                ? <p className="nds-prefs-groupempty">Empty · drag a column here to put it back</p>
                : <p className="nds-prefs-groupempty">{pinned ? `${pinned} pinned above` : 'No scrolling columns in view'}<Button size="xs" variant="ghost" onClick={() => addColumns(matching.map((c) => c.key))} disabled={matching.every((c) => isLocked(c) || draft.visibleColumns.includes(c.key))}>Show {needle ? 'matches' : 'group'}</Button></p>)}
            </>}
          </div>
        })}
      </SortableContext>
      {renderPinned('right')}
      {needle && !matchingShown.length && <p className="nds-prefs-nomatch nds-prefs-help">No columns in view match “{query.trim()}”.</p>}
    </div>)}
  </>
  const inView = (
    <>
          <div className="nds-prefs-set">
            <legend>
              In view
              {showInViewCount && (
                <span className="nds-prefs-inview-n">
                  {' · '}{inViewCount(allColumns, draft, defaultLocked).shown} of {inViewCount(allColumns, draft, defaultLocked).total}
                </span>
              )}
            </legend>
            <p className="nds-prefs-help">{attributeGroups ? 'Select columns to move or edit together. Drag groups or columns to reorder.' : 'Drag to reorder · ✕ removes a column from the view.'}</p>
          </div>
          {attributeGroups ? groupedInView : withDrag(
            <div className={['nds-prefs-cols', drag ? 'is-sorting' : ''].filter(Boolean).join(' ')}>
              <SortableContext items={shownColumns.map((c) => dragId('flat', c.key))} strategy={verticalListSortingStrategy}>
                {shownColumns.map((c) => renderViewRow(c, shownColumns, 'flat'))}
              </SortableContext>
            </div>)}
    </>
  )

  // ── Grouping tab: two drop zones, AG's Columns-panel idea rendered by the DS ────────────
  const groups = draft.rowGroups ?? []
  const aggs = draft.aggregations ?? {}
  const availableGroups = groupByOptions.filter((o) => !groups.includes(o.key))
  const availableAggs = aggregationOptions.filter((o) => !(o.key in aggs))
  const addGroup = (key: string) => setDraft((d) => ({ ...d, rowGroups: [...(d.rowGroups ?? []).filter((k) => k !== key), key] }))
  const removeGroup = (key: string) => setDraft((d) => ({ ...d, rowGroups: (d.rowGroups ?? []).filter((k) => k !== key) }))
  const moveGroup = (key: string, before: string) =>
    setDraft((d) => {
      const next = (d.rowGroups ?? []).filter((k) => k !== key)
      const at = next.indexOf(before)
      next.splice(at < 0 ? next.length : at, 0, key)
      return { ...d, rowGroups: next }
    })
  const setAgg = (key: string, func: PreferencesAggFunc | null) =>
    setDraft((d) => {
      const next = { ...(d.aggregations ?? {}) }
      if (func) next[key] = func
      else delete next[key]
      return { ...d, aggregations: next }
    })
  // One drag at a time, typed by the zone it may land in; a dataTransfer type routes the drop.
  const [zoneDrag, setZoneDrag] = useState<{ kind: 'group' | 'agg'; key: string } | null>(null)
  const [zoneOver, setZoneOver] = useState<'group' | 'agg' | null>(null)
  const dragProps = (kind: 'group' | 'agg', key: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { setZoneDrag({ kind, key }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(`text/nds-${kind}`, key) },
    onDragEnd: () => { setZoneDrag(null); setZoneOver(null) },
  })
  const zoneProps = (kind: 'group' | 'agg') => ({
    onDragOver: (e: React.DragEvent) => { if (zoneDrag?.kind === kind) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setZoneOver(kind) } },
    onDragLeave: () => setZoneOver((z) => (z === kind ? null : z)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      const key = zoneDrag?.kind === kind ? zoneDrag.key : e.dataTransfer.getData(`text/nds-${kind}`)
      if (!key) return
      if (kind === 'group') addGroup(key)
      else if (!(key in aggs)) setAgg(key, aggregationOptions.find((o) => o.key === key)?.funcs[0] ?? 'sum')
      setZoneDrag(null); setZoneOver(null)
    },
  })
  const chipDropBefore = (before: string) => (e: React.DragEvent) => {
    if (zoneDrag?.kind !== 'group' || zoneDrag.key === before) return
    e.preventDefault(); e.stopPropagation()
    moveGroup(zoneDrag.key, before)
    setZoneDrag(null); setZoneOver(null)
  }
  const groupingTab = (
    <div className="nds-prefs nds-prefs-tabbed">
      <div className="nds-prefs-pane">
        <div className="nds-prefs-set">
          <legend>Row groups</legend>
          <p className="nds-prefs-help">Drag a column here to fold the rows into groups — outermost first. While grouped, families do not expand.</p>
        </div>
        <div className={['nds-prefs-zone', zoneOver === 'group' ? 'over' : '', groups.length ? '' : 'empty'].filter(Boolean).join(' ')} {...zoneProps('group')} role="list" aria-label="Row groups">
          {groups.length === 0 && <p className="nds-prefs-zonehint">No grouping · drop a column here</p>}
          {groups.map((key, i) => {
            const o = groupByOptions.find((x) => x.key === key)
            return (
              <div key={key} role="listitem" className={['nds-prefs-chip', 'draggable', zoneDrag?.key === key ? 'dragging' : ''].filter(Boolean).join(' ')} {...dragProps('group', key)} onDragOver={(e) => { if (zoneDrag?.kind === 'group') { e.preventDefault(); e.stopPropagation() } }} onDrop={chipDropBefore(key)}>
                <GripVertical size={14} className="nds-prefs-grip" aria-hidden />
                <span className="nds-prefs-chiplvl">{i + 1}</span>
                <span className="nds-prefs-lbl">{o?.label ?? key}</span>
                <button type="button" className="nds-prefs-x" onClick={() => removeGroup(key)} aria-label={`Stop grouping by ${o?.label ?? key}`}><X size={13} aria-hidden /></button>
              </div>
            )
          })}
        </div>
        <div className="nds-prefs-set">
          <legend>Columns you can group by</legend>
        </div>
        <div className="nds-prefs-cols nds-prefs-avail" role="list" aria-label="Columns you can group by">
          {availableGroups.length === 0 && <p className="nds-prefs-zonehint">Every groupable column is in use.</p>}
          {availableGroups.map((o) => (
            <div key={o.key} role="listitem" className="nds-prefs-chip draggable" {...dragProps('group', o.key)}>
              <GripVertical size={14} className="nds-prefs-grip" aria-hidden />
              <span className="nds-prefs-lbl">{o.label}</span>
              <button type="button" className="nds-prefs-add" onClick={() => addGroup(o.key)} aria-label={`Group by ${o.label}`}><Plus size={13} aria-hidden /></button>
            </div>
          ))}
        </div>
      </div>
      <div className="nds-prefs-pane">
        <div className="nds-prefs-set">
          <legend>Totals</legend>
          <p className="nds-prefs-help">What a group row shows for a column. Drag a column here and pick its total.</p>
        </div>
        <div className={['nds-prefs-zone', zoneOver === 'agg' ? 'over' : '', Object.keys(aggs).length ? '' : 'empty'].filter(Boolean).join(' ')} {...zoneProps('agg')} role="list" aria-label="Totals">
          {Object.keys(aggs).length === 0 && <p className="nds-prefs-zonehint">No totals · drop a column here</p>}
          {aggregationOptions.filter((o) => o.key in aggs).map((o) => (
            <div key={o.key} role="listitem" className="nds-prefs-chip">
              <span className="nds-prefs-lbl">{o.label}</span>
              <select className="nds-select nds-prefs-chipsel" aria-label={`Total for ${o.label}`} value={aggs[o.key]} onChange={(e) => setAgg(o.key, e.target.value as PreferencesAggFunc)}>
                {o.funcs.map((f) => <option key={f} value={f}>{AGG_LABELS[f]}</option>)}
              </select>
              <button type="button" className="nds-prefs-x" onClick={() => setAgg(o.key, null)} aria-label={`Remove the total for ${o.label}`}><X size={13} aria-hidden /></button>
            </div>
          ))}
        </div>
        <div className="nds-prefs-set">
          <legend>Columns you can total</legend>
        </div>
        <div className="nds-prefs-cols nds-prefs-avail" role="list" aria-label="Columns you can total">
          {availableAggs.length === 0 && <p className="nds-prefs-zonehint">Every column with a total is in use.</p>}
          {availableAggs.map((o) => (
            <div key={o.key} role="listitem" className="nds-prefs-chip draggable" {...dragProps('agg', o.key)}>
              <GripVertical size={14} className="nds-prefs-grip" aria-hidden />
              <span className="nds-prefs-lbl">{o.label}</span>
              <button type="button" className="nds-prefs-add" onClick={() => setAgg(o.key, o.funcs[0])} aria-label={`Add a total for ${o.label}`}><Plus size={13} aria-hidden /></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )

  // ── Layout: tabs when a grid offers grouping (five stacked sections clipped the tick-list to
  //    three of twelve rows); the two-panel page otherwise, byte-for-byte what it was. ─────
  const tabbed = groupByOptions.length > 0 || aggregationOptions.length > 0
  const groupingCount = groups.length + Object.keys(aggs).length
  const hasDisplay = pageSizeChoices.length > 0 || showSticky || sortFieldOptions.length > 0 || workspaceSlot != null

  return { pickList, inView, groupingTab, displaySections, resetValue, resetInteraction, resetSelection, tabbed, hasDisplay, hasLeftPanel, groupingCount }
}

export function PreferencesModal({
  open,
  onClose,
  value,
  onConfirm,
  allColumns,
  defaultVisible,
  sortFieldOptions = [],
  pageSizeChoices = DEFAULT_PAGE_SIZE_CHOICES,
  showSticky = true,
  groupByOptions = [],
  aggregationOptions = [],
  title = 'Customise',
  listLabel = 'Columns',
  listHint,
  workspaceSlot,
  quickPicks,
  groupToggles,
  inViewCount,
  viewSave,
  attributeGroups,
  onReloadSaved,
  bulkPick,
  rememberInteraction = false,
  confirmLabel = 'Save',
  className,
}: PreferencesModalProps) {
  // Draft mirrors `value`; reset on every open so a prior Cancel can't leak.
  const [draft, setDraft] = useState<PreferencesValue>(value)
  const [tab, setTab] = useState<'columns' | 'grouping' | 'display'>('columns')
  // The footer's save-as-view conversation: a name, a pending write, a reason it failed.
  const [naming, setNaming] = useState(false)
  const [viewName, setViewName] = useState('')
  const [viewBusy, setViewBusy] = useState(false)
  const [viewError, setViewError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const wasOpen = useRef(false)
  const { pickList, inView, groupingTab, displaySections, resetValue, resetInteraction, resetSelection, tabbed, hasDisplay, hasLeftPanel, groupingCount } = usePreferencesPanes({
    value: draft, onChange: (next) => { if (!busyRef.current) setDraft(next) }, allColumns, defaultVisible, sortFieldOptions, pageSizeChoices, showSticky, groupByOptions, aggregationOptions, listLabel, listHint, workspaceSlot, quickPicks, groupToggles, inViewCount, attributeGroups, bulkPick,
  })
  useEffect(() => {
    if (open && !wasOpen.current) {
      setDraft(value); setTab('columns'); setNaming(!!viewSave?.startNaming); setViewName(''); setViewBusy(false); setViewError(null); busyRef.current = false
      // The selection and a drag in flight never outlive a close; the filter and the open groups may (`rememberInteraction`).
      if (rememberInteraction) resetSelection(); else resetInteraction()
    }
    wasOpen.current = open
    // A parent refresh must never replace an unsaved draft. Only a new open or explicit Reload does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value])
  const resetAll = () => setDraft(resetValue())
  const close = () => { if (!busyRef.current) onClose() }
  /**
   * A view write is the CALLER's whole act: `onSaveAs` / `onUpdate` receive the draft, apply it and
   * write it, and the dialog only closes on success — it does NOT call `onConfirm` as well, or the
   * caller's "now on view X" would be overwritten by an ordinary "custom arrangement" apply a tick
   * later. A failure keeps the dialog open with the reason in the footer; the caller applies nothing
   * on a failed write, so the grid and the server never disagree about what was kept.
   */
  const runViewWrite = async (fn: () => unknown | Promise<unknown>, closeOnSuccess = true) => {
    if (busyRef.current) return
    busyRef.current = true
    setViewBusy(true)
    setViewError(null)
    try {
      await fn()
      if (closeOnSuccess) onClose()
    } catch (e: unknown) {
      setViewError(e instanceof Error ? e.message : String(e))
    } finally {
      busyRef.current = false
      setViewBusy(false)
    }
  }
  const confirmedDraft = () => attributeGroups ? normalizeGroupedPreferences(allColumns, draft, listLabel) : draft
  const handleConfirm = () => runViewWrite(() => onConfirm(confirmedDraft()))
  const saveAs = () => { const n = viewName.trim(); if (n && viewSave) runViewWrite(() => viewSave.onSaveAs(n, confirmedDraft())) }

  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      className={className}
      // The width follows the LAYOUT. `xl` (920px) is sized for two panels side by side; with the
      // left one collapsed it stretched a list of one-word column names to 884px, putting 748px
      // of empty space between each label and its control. `md` (560px) puts the list back at
      // roughly the width it had as a panel.
      size={hasLeftPanel ? 'xl' : 'md'}
      footer={
        <>
          <Button variant="ghost" onClick={resetAll} disabled={viewBusy} className="nds-prefs-reset">Reset to default</Button>
          {viewSave && !naming && (
            <>
              <Button variant="ghost" onClick={() => { setViewName(''); setNaming(true) }} disabled={viewBusy}>Save as view…</Button>
              {viewSave.activeName && viewSave.onUpdate && (
                <Button variant="ghost" onClick={() => runViewWrite(() => viewSave.onUpdate!(confirmedDraft()))} disabled={viewBusy}>
                  Update “{viewSave.activeName}”
                </Button>
              )}
            </>
          )}
          {viewSave && naming && (
            <span className="nds-prefs-saveview" role="group" aria-label="Save as view">
              <Input
                autoFocus
                size="sm"
                value={viewName}
                onChange={(e) => setViewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveAs(); if (e.key === 'Escape') setNaming(false) }}
                placeholder="View name"
                aria-label="View name"
                fieldClassName="nds-prefs-viewname"
                disabled={viewBusy}
              />
              <Button variant="primary" onClick={saveAs} disabled={!viewName.trim() || viewBusy}>Save view</Button>
              <Button variant="ghost" onClick={() => setNaming(false)} disabled={viewBusy}>Cancel</Button>
            </span>
          )}
          {viewError && <span className="nds-prefs-saveview-err" role="alert">{viewError}{onReloadSaved && <Button size="xs" variant="ghost" disabled={viewBusy} onClick={() => runViewWrite(async () => { setDraft(await onReloadSaved()); resetInteraction() }, false)}>Reload saved layout</Button>}</span>}
          <span className="grow" />
          <Button onClick={close} disabled={viewBusy}>Cancel</Button>
          <Button variant="primary" onClick={handleConfirm} disabled={viewBusy}>{viewBusy ? 'Saving…' : confirmLabel}</Button>
        </>
      }
    >
      <fieldset className="nds-prefs-draft" disabled={viewBusy} aria-busy={viewBusy}>
      {tabbed ? (
        <>
          <Tabs
            ariaLabel="Customise sections"
            className="nds-prefs-tabs"
            active={tab}
            onChange={(id) => setTab(id as typeof tab)}
            tabs={[
              { id: 'columns', label: 'Columns' },
              { id: 'grouping', label: 'Grouping', count: groupingCount > 0 ? groupingCount : null },
              ...(hasDisplay ? [{ id: 'display', label: 'Display' }] : []),
            ]}
          />
          {tab === 'columns' && (
            <div className={`nds-prefs nds-prefs-tabbed${attributeGroups ? ' nds-prefs-attributes' : ''}`}>
              <div className="nds-prefs-pane">{pickList}</div>
              <div className="nds-prefs-pane">{inView}</div>
            </div>
          )}
          {tab === 'grouping' && groupingTab}
          {tab === 'display' && (
            <div className="nds-prefs nds-prefs-tabbed single">
              <div className="nds-prefs-pane nds-prefs-col">{displaySections}</div>
            </div>
          )}
        </>
      ) : (
        <div className={`nds-prefs${hasLeftPanel ? '' : ' single'}${attributeGroups ? ' nds-prefs-attributes' : ''}`}>
          {hasLeftPanel && (
            <div className="nds-prefs-col">
              {displaySections}
              {pickList}
            </div>
          )}
          <div className="nds-prefs-col">{inView}</div>
        </div>
      )}
      </fieldset>
    </Modal>
  )
}

export const PREFERENCES_DEFAULTS = SHARED_DEFAULTS
