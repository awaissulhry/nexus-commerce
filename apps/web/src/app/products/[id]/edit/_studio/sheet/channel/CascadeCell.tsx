'use client'

/**
 * A channel cell: the resolved value, and a mark only where it matters (2026-10-04, channel cell marks).
 *
 * The SAME part and the SAME rule as the Shared scope's cells (`master/columns.tsx` `withMark`): `MarkedValue` draws
 * the mark, the value, the chevron and the save marks in one layout. No mark on a cell that simply follows the Shared
 * product; a small mark only where the value differs from it or the next action differs — `channelCellProvenance`
 * decides which, the one verdict the tint, the bullets mark and Cell details also read. Cell details (right-click
 * "Cell details…", Shift+F10, the toolbar ⋯) explains every cell, marked or not.
 */
import { memo, useCallback, useSyncExternalStore } from 'react'
import { CellAction } from '@/design-system/components'

import type { CellSaveTracker, ICellRendererParams } from '@/design-system/grid'
import { CellSaveReason, EmptyValue, LongTextCell, MarkedValue, MetafieldValue, RequiredValue, ShapeValue, isShaped, SelectChevron, openCellEditor, saveNote } from '@/design-system/grid'
import { CellSaveMark } from '@/design-system/grid/renderers/CellSaveMark'

import { isReferenceField } from '../referenceOptions'
import { channelCellDrawsRequired, channelCellMark, channelCellPresent, channelCellProvenance } from './channelCellProvenance'
import { isProductRelationshipColumn } from '@nexus/shared/master-sheet'
import type { ChannelSheetRow, SheetColumn } from './types'

export interface CascadeCellParams {
  tracker?: CellSaveTracker
  formattedPreview?: boolean
  openEditor?: (row: ChannelSheetRow, column: SheetColumn, anchor: HTMLElement | null) => void
  column: SheetColumn
  /**
   * Whether this mapping RUN was product-grain (`meta.mapping.productLevelOnly`).
   *
   * Supplied by the sheet rather than read from the cell, because the wire carries it once per run
   * and the verdict needs it per cell — the consumer bridges the two (#379).
   */
  productLevelOnly?: boolean
  /**
   * #780 — reads the SERVER'S reason this cell's formula produced nothing, or `null`.
   *
   * A FUNCTION read at paint time, not a value: the refusal arrives with the formula batch after
   * first paint, and a value here would either freeze the first load's answer or rebuild the column
   * model to change it — the same discipline `exprFor` already follows on both sheets.
   */
  refusedReasonFor?: (productId: string, fieldKey: string) => string | null
  /**
   * The row's listing alias label as the server reports it, or null — names the listing a value comes from in the
   * mark's sentence. A function read at paint time for the same reason as `refusedReasonFor`: a renamed alias must not
   * rebuild the column model.
   */
  aliasLabelOf?: (aliasId: string | null) => string | null
}

/** A stored Shopify value as its wire text: JSON for lists and structured values. */
const storedText = (value: unknown): string | null => value == null ? null : typeof value === 'object' ? JSON.stringify(value) : String(value)

export const CascadeCell = memo(function CascadeCell(
  p: ICellRendererParams<ChannelSheetRow> & CascadeCellParams,
) {
  const row = p.data
  const { column, productLevelOnly } = p
  // The tracker mutates independently of AG's memoized value props. Subscribe to this cell's
  // stable entry so waiting/unknown becomes visible even when its value has not changed.
  const subscribe = useCallback((changed: () => void) => p.tracker?.subscribe(changed) ?? (() => {}), [p.tracker])
  const snapshot = useCallback(() => row ? p.tracker?.get(row.rowId, column.key) : undefined, [p.tracker, row, column.key])
  const save = useSyncExternalStore(subscribe, snapshot, snapshot)

  const cell = row?.values?.[column.key]
  /* A list or a measure is "present" by its own rule — an empty array is not a value. */
  const present = channelCellPresent(column, cell?.value)

  if (!row) return null
  if (isProductRelationshipColumn(column.key)) return present ? <>{String(cell?.value)}</> : <EmptyValue />

  /* #780 — the refusal rides with the cell into the ONE verdict, exactly as the mapping run does. `row.rowId`, this
     scope's grid identity, is what the formula map is keyed on here (see `refusedReasonFor` in ChannelSheet). */
  const refusedReason = p.refusedReasonFor && row ? p.refusedReasonFor(row.rowId, column.key) : null
  /* `⚠ required` for an empty cell the channel requires (`channelCellDrawsRequired`: the SHARED rule master applies, the
     resolver's own "required" verdict, or a server sentence that says so) — this scope drew `—` for the same state until
     2026-09-04. The verdict reads the same flag: the server's "required" sentence adds no mark to a cell that already
     says "required" (Cell details keeps the sentence). */
  const drawsRequired = channelCellDrawsRequired(column, row, cell)
  const provenance = channelCellProvenance(cell, { productLevelOnly: productLevelOnly ?? false, refusedReason, drawsRequired, shape: column.shape })
  /* The mark's one input, as the Shared scope gives it: `from`, what the value follows or came from (a refusal, a waiting
     change or an attention cause: the server's sentence). The mark reads it into its one sentence. Nothing for a cell
     with no mark — and the alias label (a search over the aliases) is read only for a member that names the listing.
     A reusable rule also gives the whole sentence (`tooltip`), which names the rule apart from its source. */
  const mark = channelCellMark(cell, provenance, { refusedReason, row, aliasLabel: () => p.aliasLabelOf?.(row.aliasId) ?? null, drawsRequired })
  // Read only where the Shopify action needs it: a cell without the action asks AG nothing.
  const editable = !!p.openEditor && !!p.api.getColumn(column.key)?.isCellEditable(p.node)

  return (
    <MarkedValue
      provenance={provenance}
      from={mark.from}
      tooltip={mark.tooltip}
      /**
       * 🔴 D13's closed-list affordance (#710). The class is the cursor and the glyph is a NODE: without it, 63 select
       * cells on this scope rendered no chevron while master rendered one, and a closed list looked like free text.
       * `SelectChevron` is the engine's (`grid/editors/SelectCellEditor.tsx`), the same glyph master renders. It sits in
       * `MarkedValue`'s `trail`, a SIBLING of the ellipsizing text, so the value truncates before the glyph moves
       * (PES.2's #707: an icon inside the truncating box falls to a second line).
       */
      trail={(column.kind === 'select' || column.kind === 'boolean' || isReferenceField(column.key)) && !isShaped(column)
        ? <SelectChevron onOpen={openCellEditor(p.api, p.node, column.key)} /> : undefined}
      after={<>
        {/* Shopify columns: the editor opens from this action (revealed on hover by the column's `nds-reveal-row`). */}
        {p.openEditor && <CellAction label={`${editable ? 'Edit' : 'Details'}: ${row.sku}, ${column.label}`} description={cell?.writeBlockedReason != null ? cell.writeBlockedReason : editable ? 'Enter or F2 opens the editor.' : 'Read-only cell. The reason was not reported.'}
          onFocusCell={() => { if (p.node.rowIndex != null) { p.api.setFocusedCell(p.node.rowIndex, column.key); p.api.clearCellSelection(); p.api.addCellRange({ rowStartIndex: p.node.rowIndex, rowEndIndex: p.node.rowIndex, columns: [column.key] }) } }}
          onActivate={anchor => p.openEditor?.(row, column, anchor)} />}
        {/* P2 (I4-8) — mounted only for a cell with a save state: a horizontal scroll mounted both, empty, in every cell. */}
        {save && <CellSaveReason reason={saveNote(save)} />}
        {save && <CellSaveMark state={save.state} />}
      </>}
    >
      {/* `valueFormatted` first: a closed-list column maps its code to a label on the column
          (#669), and the renderer must show what the formatter resolved or the cell contradicts
          the dropdown that set it. Falls back to the raw value for every column that has no
          formatter, which is most of them. */}
      {present ? (
        /* 2026-09-24 — a store metafield is drawn by its TYPE (a file as a picture, a colour as a swatch, a
           reference as its name), the same rules for every store's fields. Native Shopify fields keep their text. */
        p.formattedPreview && column.shopifyField?.definition ? (
          <MetafieldValue type={column.shopifyField.type} raw={storedText(p.value ?? cell?.value)} labels={column.optionLabels} images={column.referenceImages} swatches={column.referenceSwatches} />
        ) : p.formattedPreview ? String(p.valueFormatted ?? p.value ?? '') : column.shape === 'list' || column.shape === 'measure' ? (
          /* AM.1 §A.3 — the engine's cell for the shape, the same one master's `withMark` wraps. */
          <ShapeValue shape={column.shape} value={p.value ?? cell?.value} optionLabels={column.optionLabels} />
        ) : column.kind === 'longtext' ? (
          /* master's long-text renderer — the text with its length mark — so a capped field reads the
             same on every scope (2026-09-04). `required` is never reached here (`present` is true);
             the required treatment of an EMPTY cell stays this renderer's below. */
          <LongTextCell {...p} maxLength={column.maxLength} maxBytes={column.maxBytes} capFrom={column.capFrom} required={column.requiredBy.length > 0} />
        ) : (
          String(p.valueFormatted ?? p.value ?? cell?.value ?? '')
        )
      ) : (
        drawsRequired ? <RequiredValue /> : <EmptyValue />
      )}
    </MarkedValue>
  )
})
