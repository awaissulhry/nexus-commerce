'use client'

/**
 * PES.4.3 — the whole record as a form, grouped the way the sheet groups its columns.
 *
 * The groups are `SheetColumn.group`, not a second taxonomy invented here: the drawer and the
 * sheet must agree about what "Content" contains, or an operator who cannot find a field in one
 * will look for it under a different heading in the other.
 *
 * It renders from the row object the grid ALREADY holds. No fetch on open — `SheetRow` carries the
 * resolved value, its provenance, readiness and completeness for every column.
 */

import { columnForCategory } from '@nexus/shared/master-sheet'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { GalleryStrip, type GalleryImage } from '../fields/GalleryStrip'
import { RecordField } from '../fields/RecordField'
import type {
  DrawerFormulas,
  DrawerScope,
  ReadinessIssue,
  RecordWriteResult,
  SheetColumn,
  SheetRow,
} from '../types'
import type { FormulaCandidate } from '@/design-system/grid'
import { buildFormulaCandidates } from '../formulaCandidates'
import { PressableRow } from '@/design-system/components/PressableRow'
import styles from '../drawer.module.css'

/**
 * #166's quiet sub-form: `?? []` mints a NEW array on every render and does not look like a
 * literal, so it survives the grep that catches `return {`. Harmless until the child memoises —
 * and then it is a memo that never hits, for a reason nobody can see at the call site. Frozen so
 * the shared instance cannot be mutated by a consumer that assumes it owns its props.
 */
const NO_IMAGES: readonly GalleryImage[] = Object.freeze([])

export interface RecordPaneProps {
  row: SheetRow
  columns: SheetColumn[]
  scope: DrawerScope
  focusKey?: string
  images?: readonly GalleryImage[]
  /** Parent label when `images` are inherited; null when they are the record's own. */
  imagesInheritedFrom?: string | null
  /** Why the gallery is absent, when it is absent because the read FAILED. */
  imagesError?: string | null
  /** Per-field save state, keyed by `SheetColumn.key`. Owned by the host's write queue. */
  writeStates: Record<string, RecordWriteResult>
  onWrite: (column: SheetColumn, value: unknown, intent: 'set' | 'pin') => void
  onReset: (column: SheetColumn) => void
  onHistory: (column: SheetColumn) => void
  /** D16 formulas, supplied by the host sheet. Absent = no formula affordances (#708/#775). */
  formulas?: DrawerFormulas
  /** A formula was stored or removed — the host refetches, because the VALUE is the server's. */
  onFormulaSaved?: () => void
  /** Why this scope refuses writes wholesale. Suppresses formula AUTHORING; see `RecordDrawerProps`. */
  writesRefused?: string
}

export function RecordPane({
  row,
  columns,
  scope,
  focusKey,
  images,
  imagesInheritedFrom,
  imagesError,
  writeStates,
  onWrite,
  onReset,
  onHistory,
  formulas,
  onFormulaSaved,
  writesRefused,
}: RecordPaneProps) {
  /**
   * What a `$reference` may name on THIS record, with the value each column currently holds.
   *
   * 🔴 Built ONCE per record here rather than per field. There are ~100 fields in this pane and the
   * list is identical for every one of them; building it inside `RecordField` would mint a hundred
   * copies of the same array on every render and hand each memoised field a prop that differs by
   * identity every time — the exact shape FE.1 measured costing 178.8 ms of a 254 ms drawer open.
   *
   * It is a TYPING AID, never a verdict: the server resolves against the full per-market key set
   * and its answer overrides this list the moment it arrives. Deriving "unknown" from here alone
   * would mark a good reference wrong whenever the record shows fewer columns than the market has.
   */
  const formulaCandidates = useMemo<FormulaCandidate[]>(
    () => (formulas ? buildFormulaCandidates(columns, row.values, formulas.functions) : []),
    [formulas, columns, row.values],
  )

  const groups = useMemo(() => {
    const byGroup = new Map<string, SheetColumn[]>()
    for (const header of columns) {
      const col = columnForCategory(header, scope.kind === 'channel' ? Object.keys(header.channels ?? {})[0] ?? '' : 'Master', row.productType ?? null) 
      // A per-variant field on a parent row is shown, LOCKED, with the reason — not hidden. A
      // field that vanishes between two rows reads as a missing field, and the operator goes
      // looking for the bug instead of reading the explanation.
      const list = byGroup.get(col.group) ?? []
      list.push(col)
      byGroup.set(col.group, list)
    }
    return [...byGroup.entries()]
  }, [columns, scope.kind, row.productType])

  /** The group holding the cell the operator arrived on — the one group that starts open. */
  const arrivingGroup = useMemo(
    () => (focusKey ? (columns.find((c) => c.key === focusKey)?.group ?? null) : null),
    [columns, focusKey],
  )

  /**
   * Groups start COLLAPSED, except the one holding the arriving cell (UX.1, re-ruled #330).
   *
   * This reverses #283. The earlier reasoning — "a collapsed group hides the empty required fields
   * that are the work" — was sound about hiding and wrong about the arithmetic: SR.1 measured 97
   * fields over 21.3 screens, of which 4 are visible either way. Expanded does not show the work,
   * it buries it 21 screens deep. Collapsed is only acceptable BECAUSE the header carries its own
   * count ("Identity · 7 fields · 3 required missing"), so a closed group still states what is
   * inside it and one click reaches it. A collapsed group that said nothing would be the hiding
   * the first ruling was right to refuse.
   *
   * Open state is per RECORD and never persisted (#283 stands): carrying it to the next record
   * would decide, on a record nobody has seen, which fields are worth showing.
   */
  const [open, setOpen] = useState<Record<string, boolean>>({})
  useEffect(() => {
    setOpen(arrivingGroup ? { [arrivingGroup]: true } : {})
  }, [row.id, arrivingGroup])

  /**
   * This scope's issues, keyed by field.
   *
   * `row.readiness` is ONE `{state, issues}` for the scope the sheet is loaded for — not a map
   * keyed by coordinate. This used to `Object.values()` over it and read `.issues` off each,
   * which on the real payload iterates the STRING "missing" and throws. `?? []` is not
   * belt-and-braces either: a row whose readiness has not been computed omits `issues` entirely.
   */
  const issues = useMemo(() => {
    const out: Record<string, ReadinessIssue> = {}
    for (const issue of row.readiness?.issues ?? []) {
      // An error outranks a warn on the same field: the stricter verdict is the one that decides
      // whether this record can ship.
      if (!out[issue.key] || (out[issue.key].severity === 'warn' && issue.severity === 'error')) {
        out[issue.key] = issue
      }
    }
    return out
  }, [row.readiness])

  /**
   * Scroll the cell the operator arrived on into view — WITHOUT focusing it. They are still
   * navigating the grid; taking the caret would end that.
   *
   * 🔴 This used to run once and miss. A single query on `[focusKey, row.id]` fires in the commit
   * where those change, which is BEFORE the fields of a freshly-loaded record are in the DOM — and
   * now also before the arriving group has opened. `querySelector` returned null, nothing scrolled,
   * and the effect never ran again: SR.1 measured `scrollTop 11` with the target at 1,429. Nothing
   * reported an error, because not-scrolling looks exactly like already-in-view.
   *
   * So it retries across frames until the element exists, then scrolls once. Bounded at ~30 frames
   * so a `focusKey` naming a column this scope does not have gives up instead of spinning. The rAF
   * is cancelled on cleanup and restarted by the re-run, so StrictMode's double-invoke re-arms it
   * rather than latching it off.
   */
  const paneRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!focusKey) return
    let raf = 0
    let frames = 0
    let corrections = 0

    /**
     * The scroller is FOUND, not named.
     *
     * 🔴 This first asked for `.nds-drawer-b`, the DS drawer's scrolling body — and measured the
     * wrong box. Inside the dock that element is `scrollHeight === clientHeight`; the element that
     * actually scrolls is the pane below it, 9,468px of content in a 641px window. Hardcoding a
     * class made the check answer about a box that never moves, which would have reported a
     * landing for a field 8,000px away. Walking up for the first ancestor that can actually scroll
     * asks the question about whatever element is really doing the scrolling.
     */
    const scrollerOf = (el: HTMLElement): HTMLElement | null => {
      let n = el.parentElement
      while (n) {
        if (n.scrollHeight - n.clientHeight > 2 && /auto|scroll/.test(getComputedStyle(n).overflowY)) return n
        n = n.parentElement
      }
      return null
    }

    /** Landed = the operator can SEE the field, not merely that a scroll was requested. */
    const landed = (el: HTMLElement) => {
      const scroller = scrollerOf(el)
      // Nothing scrolls: there is no scrolling left to do, so the field is as visible as it gets.
      if (!scroller) return true
      const a = el.getBoundingClientRect()
      const b = scroller.getBoundingClientRect()
      // Fully inside — a field peeking one pixel over the fold is "in view" to an overlap test and
      // unreadable to a person. A field TALLER than the window can never be fully inside, so it
      // counts as landed once it covers the window.
      if (a.height >= b.height) return a.top <= b.top && a.bottom >= b.bottom
      return a.top >= b.top && a.bottom <= b.bottom
    }

    const tick = () => {
      const el = paneRef.current?.querySelector<HTMLElement>(`[data-field="${CSS.escape(focusKey)}"]`)
      if (!el) {
        if (frames++ < 30) raf = requestAnimationFrame(tick)
        return
      }
      if (landed(el)) return
      if (corrections++ >= 5) return
      // `auto`, not `smooth`: a smooth scroll is an animation, and every field that mounts
      // underneath it re-lays out the pane and can cancel it mid-flight — which is one of the two
      // candidate causes of the 0-and-3,804 reading (#336). An instant jump has no flight to
      // cancel. It also re-checks after each jump, so a jump that lands short corrects itself
      // instead of reporting success from having called the API.
      el.scrollIntoView({ block: 'center', behavior: 'auto' })
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // `columns.length` is in the deps because the fields cannot be found before the columns that
    // render them arrive, and on a cold load they arrive AFTER this effect's first run.
  }, [focusKey, row.id, columns.length])

  return (
    <div ref={paneRef}>
      {(images || imagesError) && (
        <div className={styles.group} style={{ padding: 12, marginBottom: 8 }}>
          {imagesError ? (
            <div className={`${styles.note} ${styles.noteError}`}>
              <span>The images could not be read: {imagesError}. This is not “this record has no images”.</span>
            </div>
          ) : (
            <GalleryStrip images={images ?? NO_IMAGES} inheritedFrom={imagesInheritedFrom} />
          )}
        </div>
      )}

      {groups.map(([group, cols]) => {
        const isOpen = open[group] === true
        const missing = cols.filter((c) => c.requiredBy.length > 0 && !row.values[c.key]?.value).length
        return (
          <section key={group} className={styles.group}>
            {/* A DISCLOSURE, so `expanded` — not `active`. `aria-pressed` here would tell a screen
                reader there is a toggle state where there is a section that opens beneath. */}
            <PressableRow
              className={styles.groupHead}
              expanded={isOpen}
              onClick={() => setOpen((o) => ({ ...o, [group]: !isOpen }))}
              label={
                <span>
                  {isOpen ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />} {group}
                </span>
              }
            >
              <span className={styles.groupCount}>
                {cols.length} field{cols.length === 1 ? '' : 's'}
                {missing > 0 ? ` · ${missing} required missing` : ''}
              </span>
            </PressableRow>

            {isOpen && (
              <div className={styles.groupBody}>
                {cols.map((col) => (
                  <RecordField
                    key={col.key}
                    column={col}
                    cell={row.values[col.key]}
                    focused={col.key === focusKey}
                    scopeKind={scope.kind}
                    lockedReason={
                      col.scope === 'per_variant' && row.isParent
                        ? 'This field belongs to each variation — edit it on a variation row.'
                        : undefined
                    }
                    issue={issues[col.key]}
                    state={writeStates[col.key]}
                    onWrite={onWrite}
                    onReset={onReset}
                    onHistory={onHistory}
                    rowId={row.id}
                    formulas={formulas}
                    candidates={formulaCandidates}
                    onFormulaSaved={onFormulaSaved}
                    writesRefused={writesRefused}
                  />
                ))}
              </div>
            )}
          </section>
        )
      })}

      {groups.length === 0 && (
        <div className={`${styles.note} ${styles.noteInfo}`}>
          <span>
            No columns for this scope
            {scope.kind === 'channel' ? ` (${scope.channel} ${scope.marketplace})` : ''}. The channel schema has not
            been fetched, or no product type is set on this record — the sheet reports the same gap.
          </span>
        </div>
      )}
    </div>
  )
}
