/**
 * GDS — the sheet's editing helpers: the long-text editor, the validation states a cell can carry,
 * and header-matched paste. Pure where it can be (tested), AG-typed where it must be.
 */
/* The ONE editor sizing function. A VALUE import, and permitted under the rule below because
   `editorBox.ts` imports NOTHING — no AG runtime, no `.tsx`, no DOM at module scope — so it adds
   nothing to what a node test must load. Verified by the node suites that reach this file through
   `renderers/longTextState.ts` still running. */
import { editorBox, roomToRightOf, type EditorBox, type EditorKind } from './editorBox'
/**
 * 🔴 `import type` ONLY for the line below, and it must stay that way. `renderers/longTextState.ts`
 * imports the length evaluator from this file, and that renderer is reachable from node tests; a
 * VALUE import from `ag-grid-community` here would drag AG's runtime into every one of them. This is
 * the same constraint that decides what is testable in this repo — nothing on the import path may
 * pull a runtime (or a `.tsx`) that the node environment cannot load.
 */
import type { CellClassParams, CellClassRules, ColDef, ProcessDataFromClipboardParams } from 'ag-grid-community'

/** AG's large-text editor as a popup, capped: a description edits in a box, not a one-line input. */
export const longTextEditor = (opts: { maxLength?: number; rows?: number; cols?: number } = {}): Pick<ColDef, 'editable' | 'cellEditor' | 'cellEditorParams' | 'cellEditorPopup'> => ({
  editable: true,
  cellEditor: 'agLargeTextCellEditor',
  cellEditorPopup: true,
  /*
   * 🔴 No `?? 4000`. `agLargeTextCellEditor` passes `maxLength` to a real `<textarea>`, which the
   * BROWSER enforces — so an invented default is not advisory, it silently stops the operator
   * typing at a limit no channel asked for, with no counter and no message. Absent means no
   * attribute at all. This is the same invented cap `columns.tsx` stopped sending; removing it
   * there and leaving it here would have changed nothing, which is exactly what FE.1 measured
   * (three long-text columns still reading 4000 at the DOM). Second consumer, same defect.
   */
  /**
   * 🔴 A FUNCTION, and the timing is the reason (Owner's Phase 1, 2026-09-03).
   *
   * The old value was the constant `{ rows: 8, cols: 60 }` — a **488×158 box whatever the content**,
   * identical for a 20-character `care_instructions` and a 2,000-character `product_description`.
   * Measured: on `product_description` (cell at x=1314 in a 1600px viewport) AG slid that box
   * **202px to the LEFT of its own cell**, because AG hardcodes `keepWithinBounds: true` for editor
   * popups and a 488px box does not fit in 286px of room. The editor floated over three other
   * columns while the cell it was editing sat blank underneath it.
   *
   * The size must therefore be right **before AG measures and positions**, and this is the only
   * hook that runs there: AG resolves `cellEditorParams` inside `mergeParams`
   * (`main.esm.mjs:3096` — `typeof userParams === 'function'` ⇒ called with the grid params), which
   * runs in `_getCellEditorDetails` **before** the component is created and before `addPopup`. A
   * resize afterwards is too late: AG has already clamped, and it does not re-widen.
   *
   * 🔴 `agLargeTextCellEditor` takes only `rows`/`cols` — CHARACTER counts, not pixels — so the
   * exact box is published as CSS custom properties that `grid.css` applies to the textarea, and
   * rows/cols are derived alongside as the fallback for the case where that rule does not load.
   * Both are computed from ONE function (`editorBox`), so they cannot disagree about the intent.
   */
  cellEditorParams: (p: { eGridCell?: HTMLElement; column?: { getActualWidth(): number } }) => {
    const box = publishEditorBox(p, 'longtext')
    return {
      ...(opts.maxLength ? { maxLength: opts.maxLength } : {}),
      // Kept, and deliberately NOT the old 8×60: if the CSS rule is ever absent these are what the
      // operator gets, and they should be the same size the rule would have produced.
      rows: opts.rows ?? Math.max(3, Math.round(box.height / LINE_HEIGHT_PX)),
      cols: opts.cols ?? Math.max(12, Math.round(box.width / CHAR_WIDTH_PX)),
    }
  },
})

/** Rough metrics for the grid's editor font, used ONLY for the rows/cols fallback above. The
 *  authoritative size is the pixel box in the CSS custom properties. */
const LINE_HEIGHT_PX = 19
const CHAR_WIDTH_PX = 7.5

/**
 * Compute the box for THIS cell and publish it where CSS can reach it.
 *
 * 🔴 The properties go on `document.documentElement`, not on the popup: AG's editor popups are
 * parented to `document.body` (`NexusGrid`'s `popupParent`) and do not exist yet at this point in
 * the lifecycle — that is the whole reason this runs here. Exactly one cell editor is open at a
 * time (AG stops the previous before starting the next), so a single pair of properties is a
 * sufficient channel rather than a leak between editors. Stated because a reader will reasonably
 * wonder: this is a deliberate single-slot channel, not global state that accumulates.
 */
export function publishEditorBox(
  p: { eGridCell?: HTMLElement; column?: { getActualWidth(): number } },
  kind: EditorKind,
): EditorBox {
  const rect = p.eGridCell?.getBoundingClientRect()
  const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth
  const box = editorBox({
    cellWidth: rect?.width ?? p.column?.getActualWidth() ?? 0,
    cellHeight: rect?.height ?? 0,
    roomToRight: rect ? roomToRightOf(rect.left, viewportWidth) : viewportWidth,
    kind,
  })
  if (typeof document !== 'undefined') {
    const root = document.documentElement.style
    root.setProperty('--nds-editor-w', `${Math.round(box.width)}px`)
    root.setProperty('--nds-editor-h', `${Math.round(box.height)}px`)
  }
  return box
}

export type CellValidity = 'error' | 'warn' | null

export interface SheetValidation<T> {
  /** `null` = fine; `warn` = accepted but flagged (an off-list value a channel may reject); `error` = a channel will refuse. */
  validate: (value: unknown, data: T, colId: string) => { level: CellValidity; message?: string }
}

/**
 * `cellClassRules` for a sheet column: `.nds-cell-is-invalid` / `.nds-cell-is-warned` (a corner
 * triangle + tint, never colour alone), `.nds-cell-is-inherited` when the value comes from the
 * parent, `.nds-cell-is-locked` when the column definition locks it. Pair with `validationTitle`
 * so the reason is on hover.
 */
export function sheetClassRules<T>(v: SheetValidation<T>, inherited?: (data: T, colId: string) => boolean): CellClassRules<T> {
  const level = (p: CellClassParams<T>) => (p.data ? v.validate(p.value, p.data, p.colDef.colId ?? p.colDef.field ?? '').level : null)
  return {
    'nds-cell-is-invalid': (p) => level(p) === 'error',
    'nds-cell-is-warned': (p) => level(p) === 'warn',
    /* 🔴 `nds-cell-is-inherited` is emitted ONLY when a caller supplies `inherited` — never as an
       always-false rule. Provenance owns that class on every sheet that renders provenance (hub #11:
       one definition of what "inherited" looks like), and the studio sheets call this with ONE
       argument. The old shape still emitted the key, permanently false, and a key that exists is a
       key that COLLIDES: spread before `provenanceClassRules` it was shadowed, spread after it would
       have shadowed — the same defect shape as `nds-cell-is-refused` (2026-09-04), caught here by
       the disjointness test the moment it existed. The two legacy callers that pass `inherited`
       (`products/_sheet/MasterSheet.tsx`, the grid lab) keep exactly the behaviour they had. */
    ...(inherited
      ? { 'nds-cell-is-inherited': (p: CellClassParams<T>) => !!p.data && inherited(p.data, p.colDef.colId ?? p.colDef.field ?? '') }
      : {}),
  }
}

/** Off-list handling the eBay flat file taught: WARN, never block — the operator can always type a value. */
export const selectValidation = <T,>(options: readonly string[], mode: 'strict' | 'open' = 'strict', required = false): SheetValidation<T> => ({
  validate: (value) => {
    const s = value == null ? '' : String(value).trim()
    if (!s) return required ? { level: 'error', message: 'Required' } : { level: null }
    if (mode === 'open') return { level: null }
    const hit = options.some((o) => o.toLowerCase() === s.toLowerCase())
    return hit ? { level: null } : { level: 'warn', message: `"${s}" is not in the channel's list — it may be rejected at publish` }
  },
})

/**
 * `max: null` means UNCAPPED, and it has to be expressible.
 *
 * 🔴 Measured: 36 of 102 master columns declare `maxLength`; the other 66 were being validated
 * against a cap the caller invented with `?? 4000` — and a second call site invented `?? 2000` for
 * the same absent value, so one field could warn at one limit and truncate at another. A wire
 * field's ABSENCE is data: the server declaring no cap can only mean there is none. Filling it in
 * turns a silence into a fabricated rule, and the message even attributes it — "the channel cap" —
 * to a channel that never asked (BE-10).
 *
 * Required-ness is unaffected: an empty required field still errors whether or not a cap exists.
 */
/**
 * The caps a column declares, as the wire states them. `null` means UNCAPPED **in that unit** —
 * which is not the same as uncapped, and not a gap to fill with an invented number.
 */
export interface LengthCaps {
  characters: number | null
  bytes: number | null
  /** Which channel imposes it, for a mark that has to name its source. */
  capFrom?: string | null
}

/** Read both caps off a column. Neither is preferred; both are kept. */
export function lengthCapOf(col: { maxLength?: number | null; maxBytes?: number | null; capFrom?: string | null }): LengthCaps {
  return { characters: col.maxLength ?? null, bytes: col.maxBytes ?? null, capFrom: col.capFrom ?? null }
}

/** The binding cap's reading. `null` when the column declares no cap in EITHER unit. */
export interface LengthReading {
  /** The value's length in the binding cap's unit. */
  n: number
  cap: number
  unit: 'characters' | 'bytes'
  capFrom: string | null
  /** `n / cap`. > 1 is over. */
  ratio: number
  over: boolean
  /**
   * The OTHER declared cap, when the column declares one in both units.
   *
   * PES.5 measured all 91 cached schemas: `maxLength` and `maxUtf8ByteLength` are **independent**
   * Amazon properties — 1,061 fields declare both across 14 distinct ratios, so neither is derived
   * from the other. A message naming a single number is therefore wrong on some column whichever it
   * picks, so where both exist the message names both.
   */
  other: { cap: number; unit: 'characters' | 'bytes' } | null
}

const byteLength = (s: string) => new TextEncoder().encode(s).length

/**
 * 🔴 **THE one length evaluator. Every cap the wire declares is enforced, each in its own unit, and
 * the WORST verdict binds** (hub #382).
 *
 * I first wrote this as "a declared byte cap IS the cap" — pick one unit and count in it. That is
 * wrong, because **neither cap always binds**. Live, `age_range_description` is
 * `maxLength: 1998, maxBytes: 2000`:
 *
 *   • 1999 ASCII characters — over the CHARACTER cap, inside the byte cap. "Bytes win" misses it.
 *   • 1001 × 'é' — 1001 characters (inside), 2002 bytes (over). "Characters win" misses it.
 *
 * Which cap binds depends on the CONTENT, so any rule that picks a unit up front is wrong for some
 * input. My diagnosis was right — a byte count was being compared against a character cap — and my
 * first cure was wrong in a quieter way: it stopped comparing across units by discarding one of
 * them. **Also worth naming: I noticed this exact gap and filed it as a question for PES.5 instead
 * of as a defect. A constraint the wire declares and the client ignores is not a question.**
 *
 * `n > cap` is over, so a cap of 200 allows exactly 200 — AG.1 aligned the cell's mark to this, an
 * `>=`/`>` disagreement neither side knew about.
 *
 * Lives here, in a pure `.ts` with no imports of its own, so the validator and AG.1's
 * `longTextState` mark cannot reach different verdicts about one cell.
 */
export function evaluateLengthCaps(text: string, caps: LengthCaps): LengthReading | null {
  const applicable: LengthReading[] = []
  const add = (n: number, cap: number | null, unit: 'characters' | 'bytes') => {
    // `> 0`: a cap of zero is not a cap anyone can satisfy, and treating it as one would mark every
    // non-empty cell over. It is read as "not declared" rather than silently failing the column.
    if (typeof cap === 'number' && cap > 0) {
      applicable.push({ n, cap, unit, capFrom: caps.capFrom ?? null, ratio: n / cap, over: n > cap, other: null })
    }
  }
  add(text.length, caps.characters, 'characters')
  add(byteLength(text), caps.bytes, 'bytes')
  if (applicable.length === 0) return null

  // The worst verdict binds, by how close each is to its OWN cap — the only comparison that is
  // meaningful across two units. Ties go to the first declared, so a single-cap column reads exactly
  // as it would have alone.
  const binding = applicable.reduce((worst, r) => (r.ratio > worst.ratio ? r : worst))
  const other = applicable.find((r) => r !== binding)
  return { ...binding, other: other ? { cap: other.cap, unit: other.unit } : null }
}

export const lengthValidation = <T,>(caps: LengthCaps, required = false): SheetValidation<T> => ({
  validate: (value) => {
    const s = value == null ? '' : String(value)
    if (!s) return required ? { level: 'error', message: 'Required' } : { level: null }
    const r = evaluateLengthCaps(s, caps)
    // No cap in either unit is NOT a pass — it is unchecked. It must never become an invented cap.
    if (!r?.over) return { level: null }
    // Names the cap that BOUND, with its unit — and the other one when the column declares both,
    // because the two are independent and an operator cutting to fit needs both numbers.
    const also = r.other ? ` (also max ${r.other.cap} ${r.other.unit})` : ''
    /*
     * 🔴 Names the SOURCE, from `capFrom` — not the phrase "the channel cap" (DS1-26).
     *
     * The reading has carried `capFrom` since §9.3a and this message ignored it, so every length
     * error said "the channel cap" whichever channel imposed it. On a family listed to several,
     * that tells an operator a limit exists and not whose it is — and a validator error is the one
     * thing here they must act on, so it is the worst place to be vague.
     *
     * Worse, my own comment forty lines up warns about exactly this hazard for the invented-cap
     * case, and the vague phrase survived directly beneath it. **A warning in a comment does not
     * inspect the code below it.** DS.1's grep found it; nothing I wrote was going to.
     *
     * Absent, it says so rather than implying a source we do not have — the same rule as the
     * unchecked state above: a cap whose origin was never stated is not "the channel's".
     */
    const from = r.capFrom ? ` — ${r.capFrom}` : ' — source not stated'
    return { level: 'error', message: `${r.n} of ${r.cap} ${r.unit}${from}${also}` }
  },
})

/**
 * Header-matched paste ("smart paste"): when the first pasted row matches ≥2 column headers or ids
 * (case-insensitive), the block is re-ordered onto those columns by NAME rather than landing by
 * position — the way a sheet exported from Excel comes back. Otherwise the block pastes as-is.
 *
 * 🔴 A target column the paste does NOT name comes back as `null`, meaning "leave this cell alone".
 * It used to come back as `''`, which AG pasted — so a two-column block from Excel BLANKED every
 * other visible column to its right, on every pasted row. On a 102-column sheet that is a lot of
 * silent data loss from one ⌘V, and the test that covered this asserted the empty strings, so it
 * described the implementation instead of protecting the operator. `sheetPasteProcessor` turns each
 * `null` back into the cell's CURRENT value, which makes AG's own equality check skip it: no
 * valueSetter, no event, no write.
 */
export function matchPasteToHeaders<T>(
  data: string[][],
  columns: ReadonlyArray<Pick<ColDef<T>, 'colId' | 'field' | 'headerName'>>,
  targetColIds: readonly string[],
): (string | null)[][] {
  if (data.length < 2) return data
  const header = data[0].map((h) => h.trim().toLowerCase())
  const byName = new Map<string, string>()
  for (const c of columns) {
    const id = c.colId ?? c.field
    if (!id) continue
    byName.set(id.toLowerCase(), id)
    if (c.headerName) byName.set(c.headerName.trim().toLowerCase(), id)
  }
  const matched = header.map((h) => byName.get(h) ?? null)
  if (matched.filter(Boolean).length < 2) return data
  // The paste lands on `targetColIds` (the focused cell's column onward); put each matched source
  // column under its target by id, and mark the rest UNTOUCHED (`null`) rather than blanking them.
  const srcIndexByCol = new Map<string, number>()
  matched.forEach((id, i) => { if (id) srcIndexByCol.set(id, i) })
  return data.slice(1).map((row) => targetColIds.map((id) => { const i = srcIndexByCol.get(id); return i == null ? null : (row[i] ?? '') }))
}

/**
 * AG's `processDataFromClipboard` wired to `matchPasteToHeaders`. Pass as a stable reference.
 *
 * AG applies the returned block POSITIONALLY from the focused cell, so there is no way to tell it
 * "skip this column" — every target gets whatever the array holds. So a column the paste did not
 * name is filled with the value that is already in it: AG compares, finds no change, and does not
 * call the valueSetter at all. The paste therefore touches exactly the columns the operator's block
 * actually named, which is what they meant by pasting it.
 */
export function sheetPasteProcessor<T>(columns: ReadonlyArray<Pick<ColDef<T>, 'colId' | 'field' | 'headerName'>>) {
  return (params: ProcessDataFromClipboardParams<T>): string[][] | null => {
    const focused = params.api.getFocusedCell()
    const all = params.api.getAllDisplayedColumns().map((c) => c.getColId())
    const start = focused ? all.indexOf(focused.column.getColId()) : 0
    const targets = all.slice(Math.max(0, start))
    const matched = matchPasteToHeaders(params.data, columns, targets)
    if (matched === (params.data as unknown)) return params.data

    const firstRow = focused?.rowIndex ?? 0
    return matched.map((row, r) =>
      row.map((cell, c) => {
        if (cell !== null) return cell
        // Untouched: hand back what is already there, so AG's equality check makes it a no-op.
        const node = params.api.getDisplayedRowAtIndex(firstRow + r)
        if (!node) return ''
        const current = params.api.getCellValue<unknown>({ rowNode: node, colKey: targets[c] })
        if (current == null) return ''
        // Only a primitive can round-trip through a clipboard array. A cell holding an OBJECT is a
        // read-only projection (a readiness verdict, a chip payload) — AG will not paste into it
        // because it is not editable, so the placeholder never reaches the row; stringifying it
        // would just put "[object Object]" in the block.
        const t = typeof current
        return t === 'string' || t === 'number' || t === 'boolean' ? String(current) : ''
      }),
    )
  }
}
