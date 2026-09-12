'use client'

/**
 * PES.2 — the master sheet's column factory.
 *
 * 🔴 **It builds EVERY column the server returns — all 102 of them on the real catalogue.** The old
 * sheet built only the 26 flagged `defaultVisible`, which meant the other 76 had no column
 * definition at all: not in the grid, not in the Customise dialog, not reachable by any control.
 * Visibility is a VIEW's decision (`views.ts` → `prefsToColumnState`), never a build-time filter.
 * A column that is not built cannot be shown, and nothing on screen explains its absence.
 *
 * Every cell renders its provenance through the DS (`classifyProvenance` + `ProvenanceMark`), so
 * the master sheet, PES.3's channel scopes and PES.4's drawer reach the same verdict about the
 * same cell.
 */
import { StructuredAttributeEditor, parseRecordValue, recordSummary } from '../StructuredAttributeEditor'
import { SourceIndicator } from '@/design-system/components'
import { ImpactProtectorsEditor, protectorSummary } from '../ImpactProtectorsInput'
import { AttributeShapeEditor } from '../AttributeShapeInput'
import { formulaAvailability, formulaCellEditorSelector, SelectPanelEditor, suppressFormulaKeys, type FormulaWiring } from '@/design-system/grid'
import { CellSaveReason, composeCellTooltip, longTextTooltipLine, EmptyValue, RequiredValue, LongTextCell, ShapeValue, isEmptyShape, shapeColumnDef, shapeEditorSpec, shapeTooltipLine, ProvenanceMark, classifyProvenance, longTextEditor, numericColumn, provenanceClassRules, provenanceTooltip, roundTripClassRules, selectEditor, SelectChevron, SELECT_CELL_CLASS, sheetValidationFor, composeSheetCellClassRules, type CellSaveTracker, type ColDef, type ColGroupDef, type ICellRendererParams, type ValueGetterParams, type ValueSetterParams } from '@/design-system/grid'
import type { CellClassParams } from '@/design-system/grid'

import { scalarColumnDef, booleanLabel, BOOLEAN_OPTIONS, SHEET_NUMBER_EDITOR_PARAMS } from '@/design-system/grid/editors/scalarValue'
import { columnRequiredByAny, isProductRelationshipColumn } from '@nexus/shared/master-sheet'

import { cellIsEditable, cellOf, sourceLabel, validationApplies, widthFor } from './columnRules'
import { optionLabel } from '../optionLabel'
import { parseReferenceOrScalarValue, referenceColumnDef, referenceTooltip } from '../referenceLabels'
import { isReferenceField } from '../referenceOptions'
import { ReferenceSelectEditor } from '../ReferenceSelectEditor'
import type { SheetColumn, StudioRow } from './types'

export interface BuildColumnsOptions {
  columns: SheetColumn[]
  tracker: CellSaveTracker
  locale: string
  market?: string
  /**
   * Is this cell one the ACTIVE view chip counted? Read through a REF by the caller, never captured
   * — a chip click must not rebuild a hundred column definitions (AG re-runs its whole column model
   * for a new `columnDefs` identity). The class rule reads it at paint time and the caller repaints.
   */
  isChipCell?: (rowId: string, colId: string) => boolean
  /**
   * PES.8's AI draft for this cell, if there is one. Read through a REF for the same reason.
   *
   * 🔴 The draft is RENDERED; it is not the cell's VALUE. `valueGetter` keeps returning the
   * resolved value, so the diff PES.8 needs stays reachable, an edit saves what the operator typed
   * rather than a suggestion they never accepted, and approving a draft remains an explicit act
   * through their own apply path. A draft that quietly became the value would be exactly the
   * "lands as confirmed fact without review" the layout forbids.
   */
  draftFor?: (rowId: string, colId: string) => AiDraft | null
  /**
   * Group the columns under their `group` header band. **Default `false` — AG.1-d.**
   *
   * The band cost 30px of header on every screen and broke twice over:
   *  1. it renders its header TWICE the moment an operator pins any attribute column (measured —
   *     `productType` → Pin Left draws "IDENTITY" over the pinned block AND over the centre), which
   *     the old comment below asserted could not happen;
   *  2. `marryChildren` makes AG discard a whole column ORDERING rather than move a column out of
   *     its group (AG warning #39), which is what forced `applyOrder: false` on every view and made
   *     the layout spec's §9.2 ordering rule unimplementable.
   *
   * Grouping survives where it earns its place: the Customise dialog builds its own grouped list
   * from `SheetColumn.group`, and that is the one surface where ~100 columns genuinely need
   * headings — once, in a modal, instead of 30px on every screen forever.
   */
  grouped?: boolean
  /** Column ids the SHEET renders itself (the pinned identity block). Never built twice. */
  reservedColumnIds?: readonly string[]
  /**
   * D16 — `=` formula editing on text columns (#730). Absent ⇒ the plain text editor, unchanged.
   *
   * 🔴 Supplied by the LANE, never assembled here, because every call needs `market`: the preview
   * route refuses without it (#729) and the key set a `$ref` may name differs per market.
   */
  formula?: MasterFormulaWiring
}

/**
 * 🔴 Identity-STABLE, and every member a FUNCTION. `buildMasterColumns` is memoised, and a new
 * `columnDefs` identity makes AG re-run its whole column model and take the operator's widths and
 * order with it. The formula batch and the function docs both land after the first paint, so a
 * wiring object carrying VALUES would rebuild 102 column definitions the moment either arrived.
 * `cellEditorParams` is evaluated when an editor OPENS, so reading through a ref there is the
 * freshest read available, not a stale one.
 *
 * The shape itself is the engine's `FormulaWiring<StudioRow>` — one definition, both scopes.
 */
export type MasterFormulaWiring = FormulaWiring<StudioRow>

/** PES.8 supplies these; PES.2 owns how they render. */
export interface AiDraft {
  draftValue: unknown
  baseValue?: unknown
  /** The underlying cell moved since the draft was generated — approving it overwrites an edit. */
  stale?: boolean
  unverified?: boolean
  violations?: string[]
}


/**
 * The one place a cell's provenance is decided on this sheet.
 *
 * A pending AI draft is layered ON TOP of whatever the cell already was: the operator needs to know
 * a machine is proposing something here before they need to know where the current value came from.
 */
const provOf = (row: StudioRow, key: string, draft?: AiDraft | null, hasFormula?: boolean, refusedReason?: string | null) =>
  classifyProvenance(
    { ...cellOf(row, key), aiDrafted: !!draft, aiStale: !!draft?.stale, formula: !!hasFormula, refusedReason },
    'master',
  )



/**
 * The `=` selector, from the ENGINE — not a local copy (#775, PES.3's request).
 *
 * 🔴 What it holds is policy, not wiring: which editor a cell opens, that a stored formula overrides
 * the gate whatever key started the edit, and that a refused column falls back. A copy per sheet
 * means the first person to fix one of those fixes it on one scope — the drift "shared = exactly the
 * same" exists to stop, and the same argument that moved `useCellFormulas` above both sheets.
 *
 * `rowIdOf` is the only thing it reads off a row, passed so the engine knows neither row shape.
 */
const formulaSelector = (
  wiring: MasterFormulaWiring,
  col: SheetColumn,
  fallback: { component: unknown; params?: Record<string, unknown>; popup?: boolean },
) => formulaCellEditorSelector<StudioRow>(wiring, col, fallback, (r) => r.id)

export function buildMasterColumns(
  opts: BuildColumnsOptions,
  rowsRef: { current: StudioRow[] },
): (ColDef<StudioRow> | ColGroupDef<StudioRow>)[] {
  const { columns, tracker, grouped = false, reservedColumnIds = [], isChipCell, draftFor } = opts
  const rt = roundTripClassRules<StudioRow>(tracker, (r) => r.id)
  // ONE provenance rule set, and it is draft-aware. `draftFor` is a ref-reading function, so this
  // stays correct without rebuilding column defs when a draft arrives.
  /* `opts.formula.exprFor` is a REF-READING function (see `MasterFormulaWiring`), so the mark tracks
     the family's formulas as they load without rebuilding a hundred column definitions. */
  const prov = provenanceClassRules<StudioRow>((row, key) =>
    provOf(row, key, draftFor?.(row.id, key) ?? null, !!opts.formula?.exprFor(row.id, key), opts.formula?.errorFor?.(row.id, key)),
  )

  // Both now read from `columnRules.ts`, where they are tested — see that file for why the pure
  // decisions had to leave this `.tsx` to be reachable at all.
  const applies = (row: StudioRow, col: SheetColumn) => validationApplies(col, row)
  const requiredHere = (row: StudioRow, col: SheetColumn) => columnRequiredByAny(col, row)

  const build = (col: SheetColumn): ColDef<StudioRow> => {
    /* The validation, GATED on `applies` — one definition for master and the channel scopes
       (`sheetValidationFor`). The `?? 4000` lesson (BE-10: an absent wire cap means UNCAPPED,
       never a number invented here) lives with it. */
    const validation = sheetValidationFor<StudioRow>(col, (d) => applies(d, col))
    const editable = (p: { data?: StudioRow }) => cellIsEditable(col, p.data)

    /**
     * The mark + the value. One layout for every kind, so a column never loses its glyph.
     *
     * 🔴 `trail` is chrome that must sit on the value's LINE, pinned right — the select chevron.
     * It is a separate slot and not part of `body` because `body` goes inside
     * `.nds-cell-value-text`, which is the ellipsizing box (`overflow:hidden; text-overflow:
     * ellipsis; min-width:0`). Anything rendered in there is INLINE CONTENT of a truncating block,
     * not a flex item of the cell — so `.nds-ag-chev`'s `margin-left:auto; flex:none` were inert
     * and the glyph fell to a second line below the value (Owner, #707: "they should be on the same
     * row and not be a mess"). Measured before the fix on master·IT: value span 28.5px tall — two
     * line boxes in a 36px row — with the chevron's top 6.8px below the provenance glyph's.
     * `grid.css`'s own note on that rule says the icon "is a flex item rather than a block in a
     * line box, which is the trap that put the Pill's icon on its own line" — the rule was right and
     * the DOM had stopped matching it.
     */
    const withMark = (p: ICellRendererParams<StudioRow>, body: React.ReactNode, trail?: React.ReactNode) => {
      if (!p.data || isProductRelationshipColumn(col.key)) return body
      const draft = draftFor?.(p.data.id, col.key) ?? null
      /* #780 — the server's refusal reason, read at PAINT time through the ref-backed wiring, so a
         refusal that arrives with the formula batch repaints the mark without a column rebuild. */
      const refusedReason = opts.formula?.errorFor?.(p.data.id, col.key) ?? null
      const provenance = provOf(p.data, col.key, draft, !!opts.formula?.exprFor(p.data.id, col.key), refusedReason)
      // A drafted cell SHOWS the proposal; the value underneath is untouched and still what saves.
      const shown = draft ? <>{draft.draftValue == null || draft.draftValue === '' ? <EmptyValue /> : String(draft.draftValue)}</> : body
      return (
        <span className="nds-cell-value">
          {/* 🔴 `from` carries the SERVER'S REASON VERBATIM for a refused cell, and the source label
              for every other member. The mark's tooltip is the reason and nothing else (#780,
              hub-ruled) — no prefix, no field name, no client-side label logic, because the server
              is being fixed to name the field by the sheet's own label and a second voice here
              would put two labels back. */}
          {cellOf(p.data, col.key)?.translationState && cellOf(p.data, col.key)?.translationState !== 'current' && !draft && !refusedReason ? <SourceIndicator
            kind={cellOf(p.data, col.key)?.needsTranslation ? 'warning' : 'override'} tabIndex={-1}
            label={cellOf(p.data, col.key)?.translationState === 'fallback' ? 'Language fallback' : `${cellOf(p.data, col.key)?.translationState} content`}
            description={`Requested ${cellOf(p.data, col.key)?.requestedLocale}; showing ${cellOf(p.data, col.key)?.effectiveLocale}. ${cellOf(p.data, col.key)?.needsTranslation ? 'This content does not satisfy the requested language requirement.' : ''}`}
          /> : <ProvenanceMark
            provenance={provenance}
            from={provenance === 'refused' ? refusedReason : draft ? undefined : sourceLabel(p.data, col.key, rowsRef.current)}
          />}
          <span className="nds-cell-value-text">{shown}</span>
          {/* A SIBLING of the text, so it is a flex item of `.nds-cell-value` and the value
              truncates before it moves. */}
          {trail}
          {/* The tooltip's first paragraph, as text — for anything that cannot hover (#662). Same
              source as the getter reads, so the two cannot drift into two wordings. */}
          <CellSaveReason reason={tracker.get(p.data.id, col.key)?.reason} />
        </span>
      )
    }

    const emptyOrRequired = (p: ICellRendererParams<StudioRow>) =>
      p.data && applies(p.data, col) && requiredHere(p.data, col) ? <RequiredValue /> : <EmptyValue />

    const def: ColDef<StudioRow> = {
      ...scalarColumnDef<StudioRow>(col),
      ...referenceColumnDef<StudioRow>(col, row => cellOf(row, col.key)?.value),
      colId: col.key,
      headerName: col.label + (col.requiredBy.length > 0 ? ' *' : ''),
      headerTooltip:
        [
          col.requiredBy.length > 0 ? `Required by ${col.requiredBy.join(', ')}` : null,
          col.maxLength ? `Max ${col.maxLength} characters${col.capFrom ? ` (${col.capFrom})` : ''}` : null,
          col.maxBytes ? `Max ${col.maxBytes} bytes` : null,
          col.helpText,
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
      // §9.3's ruled widths win over the contract's for the columns it names — see `widthFor`.
      width: widthFor(col, col.kind === 'longtext' ? 240 : 150),
      editable,
      // A sheet filters in the browser; the DS predicates do the work (filterPredicates.ts).
      // Branched rather than passed a union: `gridFilterDef` is overloaded so that a `set` filter
      // cannot be built without its options, and a union argument would defeat exactly that check.
      valueGetter: (p: ValueGetterParams<StudioRow>) => (p.data ? cellOf(p.data, col.key)?.value ?? null : null),
      valueSetter: (p: ValueSetterParams<StudioRow>) => {
        if (!p.data || !applies(p.data, col)) return false
        // 🔴 AG rebuilds `newValue` by re-running the value getter on `params.data` the moment this
        // returns, so the row object must be MUTATED here — scheduling React state hands the save
        // path the OLD value (reference_ag_value_setter_must_mutate_params_data).
        const previous = cellOf(p.data, col.key)
        p.data.values = {
          ...p.data.values,
          [col.key]: {
            ...previous,
            // The row keeps a real `source` after an edit: this row now stores the value, so the
            // resolver would report it as the row's own on the next read.
            source: p.data.isParent ? 'master' : 'variant',
            value: parseReferenceOrScalarValue(col, p.newValue),
            // Editing a cell gives THIS row the value: it is no longer inherited, and on a child
            // that is exactly the layout's "edit to pin".
            inherited: false,
            inheritedFrom: null,
            layer: p.data.isParent ? 'master' : 'variant',
            pinned: !p.data.isParent,
            editable: previous?.editable ?? true,
            writeField: previous?.writeField ?? col.writeField,
            writeTarget: previous?.writeTarget ?? 'master',
          },
        }
        return true
      },
      /* 🔴 `editable`, NOT `applies` — the same predicate AG is given above, and that is the whole
         point. `applies` is `validationApplies`: it answers "does this column apply to this row",
         which is the right question for validation and for the required mark and the WRONG one
         here. `cellIsEditable` is three conditions (`col.editable` AND the column applies AND the
         cell's own flag) and this rule was testing only the middle one, so a column the server
         marks `editable: false` still painted as editable.
         MEASURED on screen (2026-09-03, master·DE·it, XAVIA): `condition_type` carries
         `editable: false` on the wire; AG correctly refuses to open an editor for Enter and for a
         printable key alike — and the cell rendered `nds-cell-is-editable` throughout. A cell that
         advertises an affordance it does not have is the disabled-control-that-cannot-explain-
         itself shape, and the operator's only feedback was a keystroke doing nothing.
         Re-deriving an "equivalent" test one line from the real one is how these diverge. */
      /* 🔴 Tab belongs to the completion panel while one is open, and to AG otherwise. Only this
         ColDef-level opt-out can take it: measured on screen, a React `preventDefault` on the
         editor's own input leaves `defaultPrevented: true` and AG still ends the edit and moves a
         column. On the base `def`, so every branch inherits it through `...def` — the same
         inheritance the editable/locked rule above relies on. */
      suppressKeyboardEvent: suppressFormulaKeys,
      cellClass: (p) => (cellIsEditable(col, p.data) ? 'nds-ag-cell nds-cell-is-editable' : 'nds-ag-cell nds-cell-is-locked'),
      /* THE order, fixed once for every scope: validation → provenance → round-trip → the sheet's own. */
      cellClassRules: composeSheetCellClassRules<StudioRow>({
        validation,
        provenance: prov,
        roundTrip: rt,
        extra: { 'nds-cell-chip-hit': (p) => !!p.data && !!isChipCell && isChipCell(p.data.id, col.key) },
      }),
      /*
       * The cell's ONE tooltip (#662). COMPOSED, not an early return: the save reason used to be
       * returned INSTEAD of everything else, so a refused cell lost its length figures, and those
       * figures survived only through a rival `title` the renderer put on its own span. Reason
       * first — what happened to the value you just typed outranks what the field's limits are.
       */
      tooltipValueGetter: (p) => {
        if (!p.data) return ''
        const own = (): string => {
          const v = validation.validate(p.value, p.data!, col.key)
          if (v.message) return v.message
          if (!applies(p.data!, col)) {
            return p.data!.isParent ? 'Belongs to each variation, not to the parent' : `Not part of ${p.data!.productType ?? 'this product type'}`
          }
          const draft = draftFor?.(p.data!.id, col.key) ?? null
          if (draft) {
            const base = draft.baseValue ?? cellOf(p.data!, col.key)?.value
            return [
              provenanceTooltip(provOf(p.data!, col.key, draft, !!opts.formula?.exprFor(p.data!.id, col.key))),
              base == null || base === '' ? 'The cell is empty now' : `Now: ${String(base)}`,
              draft.violations?.length ? `⚠ ${draft.violations.join(' · ')}` : null,
              draft.unverified ? 'Not verified against the channel' : null,
            ].filter(Boolean).join('\n')
          }
          return provenanceTooltip(
            provOf(p.data!, col.key, null, !!opts.formula?.exprFor(p.data!.id, col.key)),
            sourceLabel(p.data!, col.key, rowsRef.current),
          )
        }
        return composeCellTooltip(
          tracker.get(p.data.id, col.key)?.reason,
          own(),
          /* 🔴 "…and says why in the cell" (#753(b)). A `=` typed on a column the writer refuses
             falls through to the ordinary editor and becomes plain text, which is silent — the
             operator is left thinking formulas simply did not work. The reason rides on the cell's
             own tooltip, in the sheet's existing vocabulary, next to every other thing this cell has
             to say about itself. `formulaAvailability` owns the wording so the editor gate and this
             line can never describe the same refusal differently. */
          opts.formula && p.data
            ? (() => {
                const a = formulaAvailability({
                  formulaWritable: col.formulaWritable,
                  hasStoredFormula: !!opts.formula!.exprFor(p.data!.id, col.key),
                })
                if (a.kind === 'blocked') return a.reason
                /* 🔴 On a CLOSED LIST, say both halves (Owner, #775): that `=` works here at all —
                   which is not obvious on a cell that otherwise only offers a dropdown — and that
                   the answer still has to be one of the options. Telling them only the first invites
                   a formula the server will refuse; telling them only the second reads as "no
                   formulas". `select` covers Yes/No too: it is a two-member list. */
                return col.kind === 'select' || col.kind === 'boolean'
                  ? 'Type = for a formula. Its result must be one of this column\u2019s allowed options.'
                  : undefined
              })()
            : undefined,
          col.kind === 'longtext'
            ? longTextTooltipLine(p.value, { maxLength: col.maxLength, maxBytes: col.maxBytes, capFrom: col.capFrom })
            : undefined,
          shapeTooltipLine(col, p.value),
          referenceTooltip(p.value, col.optionLabels),
        )
      },
    }

    if (Array.isArray(col.validation?.recordFields)) return { ...def,
      cellEditor: StructuredAttributeEditor, cellEditorPopup: true, cellEditorParams: { attributeColumn: col },
      ...(opts.formula ? formulaSelector(opts.formula, col, { component: StructuredAttributeEditor, popup: true, params: { attributeColumn: col } }) : {}),
      valueParser: p => parseRecordValue(p.newValue), equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      valueFormatter: p => recordSummary(p.value, col.validation!.recordFields as any),
      cellRenderer: (p: ICellRendererParams<StudioRow>) => withMark(p, recordSummary(p.value, col.validation!.recordFields as any) || emptyOrRequired(p)),
    }
    if (col.key === 'impactProtectors') {
      return { ...def, cellEditor: ImpactProtectorsEditor, cellEditorPopup: true,
        ...(opts.formula ? formulaSelector(opts.formula, col, { component: ImpactProtectorsEditor, popup: true }) : {}),
        valueFormatter: p => protectorSummary(p.value),
        equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
        cellRenderer: (p: ICellRendererParams<StudioRow>) => withMark(p, protectorSummary(p.value) || emptyOrRequired(p)),
      }
    }

    if (col.shape === 'list' || col.shape === 'measure') {
      /* AM.1 §A.3 rows 3–4 — ONE rule in the engine (`shapeColumnDef`: editor, formatter, parser,
         filter value, equality), spread here and by the channel builder. A measure is a number and
         right-aligns like one; the cell class is composed by hand because `numericColumn.cellClass`
         is an array and would otherwise drop the editable/locked half of `def`'s function. */
      return {
        ...def,
        ...(col.shape === 'measure' ? numericColumn : {}),
        ...shapeColumnDef<StudioRow>(col, (d) => cellOf(d, col.key)?.value),
        ...(col.key === 'bulletPoints' ? { cellEditor: AttributeShapeEditor, cellEditorPopup: true, cellEditorParams: { attributeColumn: col } } : {}),
        ...(opts.formula ? formulaSelector(opts.formula, col, col.key === 'bulletPoints' ? { component: AttributeShapeEditor, popup: true, params: { attributeColumn: col } } : shapeEditorSpec(col)!) : {}),
        editable,
        cellClass: (p) => [...(col.shape === 'measure' ? numericColumn.cellClass : ['nds-ag-cell']), cellIsEditable(col, p.data) ? 'nds-cell-is-editable' : 'nds-cell-is-locked'].join(' '),
        cellRenderer: (p: ICellRendererParams<StudioRow>) =>
          withMark(p, isEmptyShape(col.shape, p.value) ? emptyOrRequired(p) : <ShapeValue shape={col.shape} value={p.value} optionLabels={col.optionLabels} />),
      }
    }

    if (col.kind === 'select' || isReferenceField(col.key)) {
      const options = (col.options ?? []).map((o) => ({ value: o, label: col.optionLabels?.[o] ?? o }))
      const reference = isReferenceField(col.key)
      const referenceParams = (row?: StudioRow) => ({ fieldKey: col.key, market: opts.market, productType: row?.productType })
      /**
       * 🔴 The code → label map lives on the COLUMN, not only in its renderer (AG.1-e).
       *
       * It used to exist solely inside `cellRenderer`, which meant only the SCREEN ever saw
       * "Pakistan" — every non-visual consumer of the column got the raw code. Measured: the first
       * CSV export wrote `PK` for `country_of_origin` and `not_applicable` for the hazmat column.
       * `valueFormatter` is where AG expects the mapping, so export, clipboard copy and anything
       * else that asks the grid for a displayed value all get the label from one declaration.
       *
       * The renderer still exists because it draws the provenance mark beside the text; it now
       * agrees with the formatter by construction rather than by both being written the same way.
       */
      // One definition, shared with IO.1's import diff — see `optionLabel` for why (#501).
      const label = (v: unknown) => optionLabel(v, col.optionLabels)
      return {
        ...def,
        ...selectEditor(options),
        ...(reference ? { cellEditor: ReferenceSelectEditor, cellEditorPopup: true, cellEditorParams: (p: { data?: StudioRow }) => referenceParams(p.data) } : {}),
        /* `=` opens the formula editor on a closed list too (Owner, #775). The option list is still
           the rule: the server refuses a result that is not one of them, naming them, and the cell
           shows that refusal with the formula kept for correction. */
        ...(opts.formula ? formulaCellEditorSelector<StudioRow>(opts.formula, col, row => reference
          ? { component: ReferenceSelectEditor, popup: true, params: referenceParams(row) }
          : { component: SelectPanelEditor, params: { options } }, row => row.id) : {}),
        editable,
        valueFormatter: (p) => label(p.value),
        /* D13 — the closed-list affordance, from the ENGINE and applied by KIND, never per column:
           every `kind === 'select'` gets it, so a lane cannot ship a select that looks like free
           text. `def.cellClass` is a function (locked vs editable), so it is composed rather than
           replaced — overwriting it here would have silently dropped the locked state. */
        cellClass: (p: CellClassParams<StudioRow>) => {
          const base = typeof def.cellClass === 'function' ? def.cellClass(p) : def.cellClass
          return [Array.isArray(base) ? base.join(' ') : base, SELECT_CELL_CLASS].filter(Boolean).join(' ')
        },
        cellRenderer: (p: ICellRendererParams<StudioRow>) =>
          withMark(
            p,
            p.value != null && p.value !== '' ? label(p.value) : emptyOrRequired(p),
            <SelectChevron />,
          ),
      }
    }
    if (col.kind === 'longtext') {
      return {
        ...def,
        /* Uncapped when the server declares no cap — see the note above. The editor simply does
           not limit what can be typed; the server remains the authority on what it will accept. */
        ...longTextEditor(col.maxLength ? { maxLength: Math.max(col.maxLength, 200) } : {}),
        /* `=` opens the formula editor here too — `item_name` and `product_description` are long-text
           and are exactly the fields D16's worked example is about. The large-text box stays the
           editor for ordinary edits. */
        ...(opts.formula
          ? formulaSelector(opts.formula, col, {
              component: 'agLargeTextCellEditor',
              popup: true,
              /* No `rows`/`cols` here: selector params merge LAST (`mergeParams`, main.esm.mjs:3102)
                 and a constant 8×60 silently overrode the per-cell size `longTextEditor()` computes
                 — the same 488×158 the sizing rule exists to remove, back through a second door.
                 The size is the ColDef's; the selector only names the component. */
              params: { ...(col.maxLength ? { maxLength: Math.max(col.maxLength, 200) } : {}) },
            })
          : {}),
        editable,
        cellRenderer: (p: ICellRendererParams<StudioRow>) =>
          /* 🔴 The RAW caps, not a cap plus a unit flag (AG.1, §9.3a). `countBytes={!!col.maxBytes}`
             passed the byte cap's EXISTENCE while dropping its VALUE, so `product_description`
             counted bytes against `undefined` and reported a capped field as uncapped.
             🔴 The wire OMITS an uncapped unit — it does not send `null`. Measured 2026-09-02 04:32
             (GALE-JACKET, master, DE/de, 96 columns): `maxLength` absent 60 / value 36 / **null 0**;
             `product_description` arrives as `{ maxBytes: 20000 }` with no `maxLength` key at all.
             The earlier "`maxLength: null`" in this comment was a relayed claim nobody had measured.
             The mirrors accept `null` defensively, never as the live shape. `capFrom` rides along because a mark that warns at 80% has to
             name whose cap it is. The remaining half — `lengthCapFor` and `lengthValidation` in the
             counted unit — is PES.2's. */
          withMark(p, <LongTextCell {...p} maxLength={col.maxLength} maxBytes={col.maxBytes} capFrom={col.capFrom} required={col.requiredBy.length > 0} />),
      }
    }
    if (col.kind === 'number') {
      return {
        ...def,
        ...numericColumn,
        cellEditor: 'agNumberCellEditor', cellEditorParams: SHEET_NUMBER_EDITOR_PARAMS,
        /* 🔴 `=` reaches this cell only through the SELECTOR (#775). `agNumberCellEditor` refuses the
           keystroke outright — it accepts digits — so the mode switch can never be typed once that
           editor is mounted. `cellEditorSelector` is resolved BEFORE any editor exists and sees
           `eventKey`, which is the only point where `=` on a numeric cell can still be caught. */
        ...(opts.formula
          ? formulaSelector(opts.formula, col, {
              component: 'agNumberCellEditor',
              params: SHEET_NUMBER_EDITOR_PARAMS,
            })
          : {}),
        editable,
        cellClass: (p) =>
          // Same correction as the text branch above — `cellIsEditable`, the predicate AG is given.
          [...numericColumn.cellClass, cellIsEditable(col, p.data) ? 'nds-cell-is-editable' : 'nds-cell-is-locked'].join(' '),
        cellRenderer: (p: ICellRendererParams<StudioRow>) => withMark(p, p.value == null ? emptyOrRequired(p) : <>{String(p.value)}</>),
      }
    }
    if (col.kind === 'boolean') {
      return {
        ...def,
        ...selectEditor(BOOLEAN_OPTIONS),
        ...(opts.formula
          ? formulaSelector(opts.formula, col, {
              component: SelectPanelEditor,
              params: { options: BOOLEAN_OPTIONS },
            })
          : {}),
        editable,
        valueFormatter: (p) => booleanLabel(p.value),
        cellRenderer: (p: ICellRendererParams<StudioRow>) =>
          withMark(p, p.value == null || p.value === '' ? emptyOrRequired(p) : <>{booleanLabel(p.value)}</>, <SelectChevron />),
      }
    }
    return {
      ...def,
      /**
       * D16 — the formula editor replaces the plain text editor when the lane wires it (#730/#753).
       *
       * 🔴 It is NOT a second editor the operator has to choose. It behaves as an ordinary text
       * field until the text starts with `=`, which is the mode switch §1.3 specifies and the only
       * one there is: the layout struck the formula bar at §1.4 precisely so there is one way to do
       * this. A column that offered both would need the operator to know in advance which they
       * wanted.
       *
       * `cellEditorPopup` is REQUIRED and its absence is silent — an editor that renders outside
       * the cell box without it is torn down the moment focus leaves the grid root, which is what
       * made the DS Listbox look "incompatible with AG" for a whole ruling (`SelectCellEditor`'s
       * header). This editor is far bigger than its cell: field, autocomplete, hint, preview.
       */
      cellEditor: 'agTextCellEditor',
      ...(opts.formula ? formulaSelector(opts.formula, col, { component: 'agTextCellEditor' }) : {}),
      editable,
      cellRenderer: (p: ICellRendererParams<StudioRow>) =>
        withMark(p, p.value != null && p.value !== '' ? <>{p.valueFormatted ?? optionLabel(p.value, col.optionLabels)}</> : emptyOrRequired(p)),
    }
  }

  // EVERY column, not the default-visible ones. See the header comment.
  //
  // One exclusion, and it is not a visibility decision: the sheet's own PINNED identity block
  // already renders `sku`, so building the schema's `sku` too gives AG two columns with one id —
  // it renames the second `sku_1` (warning #273, measured) and every view that names `sku` then
  // addresses a column the operator cannot see.
  const owned = new Set(reservedColumnIds)
  const buildable = columns.filter((c) => !owned.has(c.key))
  const built = buildable.map(build)
  if (!grouped) return built

  const order: string[] = []
  const byGroup = new Map<string, ColDef<StudioRow>[]>()
  buildable.forEach((c, i) => {
    const g = c.group || 'Other'
    if (!byGroup.has(g)) {
      byGroup.set(g, [])
      order.push(g)
    }
    byGroup.get(g)!.push(built[i])
  })
  return order.map((g) => ({
    groupId: g,
    headerName: g,
    /**
     * 🔴 `marryChildren` renders the group header TWICE once ANY child is pinned — measured on real
     * data, both before and after the claim below was written.
     *
     * The old comment here read: "The identity columns are pinned by the sheet and are NOT in these
     * groups, so no group here crosses the boundary." That is true at load and **false the moment
     * an operator uses the column menu's Pin Left on an attribute column** — pinning moves that
     * child across the boundary its group is married across, and "IDENTITY" draws twice. A comment
     * asserting a protection the code never had is worse than no comment; it is why the defect
     * survived a review (`reference_docs_describe_deleted_code`, the same class one step over).
     *
     * The path is kept for a caller that opts in with `grouped: true` and never pins, but the
     * studio sheet no longer does — see `BuildColumnsOptions.grouped`.
     */
    marryChildren: true,
    children: byGroup.get(g)!,
  }))
}
