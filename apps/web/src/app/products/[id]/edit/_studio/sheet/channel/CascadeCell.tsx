'use client'

/** The resolved channel value and its source. Source controls open details before any change. */
import { memo, useCallback, useSyncExternalStore } from 'react'
import { CellAction } from '@/design-system/components'
import { SourceIndicator } from '@/design-system/components/SourceIndicator'

import type { CellSaveTracker, ICellRendererParams } from '@/design-system/grid'
import { CellSaveReason, EmptyValue, LongTextCell, RequiredValue, ShapeValue, classifyProvenance, isEmptyShape, isShaped, SelectChevron } from '@/design-system/grid'
import { CellSaveMark } from '@/design-system/grid/renderers/CellSaveMark'

import { hasValue } from './provenance'
import { withMappingRun } from './rows'
import { isReferenceField } from '../referenceOptions'
import { describeValueSource } from './cellDetailsSource'
import { columnRequiredByAny, isProductRelationshipColumn } from '@nexus/shared/master-sheet'
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
   * and `classifyProvenance` expects it per cell — the consumer bridges the two (#379).
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
  /** Inspecting a source never changes its value. Pin/reset are labelled actions in the details. */
  onDetails: (row: ChannelSheetRow, column: SheetColumn) => void
}

export const CascadeCell = memo(function CascadeCell(
  p: ICellRendererParams<ChannelSheetRow> & CascadeCellParams,
) {
  const row = p.data
  const { column, onDetails, productLevelOnly } = p
  // The tracker mutates independently of AG's memoized value props. Subscribe to this cell's
  // stable entry so waiting/unknown becomes visible even when its value has not changed.
  const subscribe = useCallback((changed: () => void) => p.tracker?.subscribe(changed) ?? (() => {}), [p.tracker])
  const snapshot = useCallback(() => row ? p.tracker?.get(row.rowId, column.key) : undefined, [p.tracker, row, column.key])
  const save = useSyncExternalStore(subscribe, snapshot, snapshot)

  const cell = row?.values?.[column.key]
  /* A list or a measure is "present" by its own rule — an empty array is not a value. */
  const present = column.shape === 'list' || column.shape === 'measure' ? !isEmptyShape(column.shape, cell?.value) : hasValue(cell?.value)

  if (!row) return null
  if (isProductRelationshipColumn(column.key)) return present ? <>{String(cell?.value)}</> : <EmptyValue />

  // A channel scope is never the master layer, so the classifier is told so. The run-level mapping
  // fact rides with the cell (`withMappingRun`) — without it `mappedShared` cannot be reached and
  // a product-grain derivation renders as an ordinary per-row `mapped`.
  /* #780 — the refusal rides with the cell into the ONE classifier, exactly as the mapping run
     does. Merged here rather than in `withMappingRun` because it comes from a different source (the
     formula batch, not the sheet payload) and folding it in there would imply the wire carries it. */
  /* `row.id`, the bare product id the formula map is keyed on — NOT `row.rowId`, this scope's grid
     identity. See the note on `refusedReasonFor` in ChannelSheet. */
  const refusedReason = p.refusedReasonFor && row ? p.refusedReasonFor(row.rowId, column.key) : null
  const provenance = classifyProvenance(
    { ...withMappingRun(cell, productLevelOnly ?? false), refusedReason },
    'channel',
  )
  // Blocking mapping errors remain visible beside the source; details come from the resolver.
  const mapped = cell?.mapped ?? null
  const mappingNote = mapped
    ? mapped.errors.length > 0
      ? `${(mapped.mappingErrors ?? mapped.errors).length ? 'Mapping error' : 'Field validation'}: ${mapped.errors.join(' · ')}`
      : mapped.warnings.length > 0
          ? `Mapped, with warnings: ${mapped.warnings.join(' · ')}`
          : null
    : null

  const source = describeValueSource(cell, provenance, refusedReason)
  const description = source.kind === 'warning' ? source.description
    : [source.description, mappingNote, cell?.writeBlockedReason]
      .filter((part): part is string => !!part).map(part => part.trim().replace(/\.+$/, '')).join('. ')

  return (
    <span className="nds-cascade nds-reveal-row">
      <span className="nds-cascade-value">
        {/* `valueFormatted` first: a closed-list column maps its code to a label on the column
            (#669), and the renderer must show what the formatter resolved or the cell contradicts
            the dropdown that set it. Falls back to the raw value for every column that has no
            formatter, which is most of them. */}
        {present ? (
          p.formattedPreview ? String(p.valueFormatted ?? p.value ?? '') : column.shape === 'list' || column.shape === 'measure' ? (
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
          /* `⚠ required`, by the SHARED rule master applies (`columnRequiredByAny`: the column applies
             to this row AND a channel requires it for this product type) — this scope drew `—` for the
             same state until 2026-09-04. */
          columnRequiredByAny(column, row) ? <RequiredValue /> : <EmptyValue />
        )}
      </span>
      {/**
        * 🔴 D13's closed-list affordance, on this scope at last (#710). The class was already here
        * — `ChannelSheet.tsx` applies `SELECT_CELL_CLASS` by KIND from the engine's own constant —
        * but the class is the cursor and the glyph is a NODE, so 63 select cells on this scope
        * rendered no chevron at all while master rendered one (measured by PES.2). A closed list
        * and a free-text cell looked identical at rest here, which is the exact defect the
        * affordance exists to remove: the capability was there and nothing on screen said so.
        *
        * `SelectChevron` is the engine's (`grid/editors/SelectCellEditor.tsx`), the same component
        * and the same lucide glyph master renders — never a second chevron with its own size.
        *
        * A SIBLING of `.nds-cascade-value`, never inside it: that span is the ellipsizing box
        * (`overflow:hidden; text-overflow:ellipsis`), and PES.2's #707 measured what happens to an
        * icon placed in there — it becomes inline content of a truncating block rather than a flex
        * item, and falls to a second line. `.nds-cascade` is `inline-flex` with `gap: 6px` and the
        * value is `flex: 1 1 auto`, so as a sibling the value truncates before the glyph moves.
        */}
      {(column.kind === 'select' || column.kind === 'boolean' || isReferenceField(column.key)) && !isShaped(column) && <SelectChevron />}
      {mapped && mapped.errors.length > 0 && (
        <span className="nds-cascade-maperr" aria-label={mappingNote ?? 'Mapping error'}>!</span>
      )}
      {p.openEditor && <CellAction label={`${p.api.getColumn(column.key)?.isCellEditable(p.node) ? 'Edit' : 'Details'}: ${row.sku}, ${column.label}`} description={cell?.writeBlockedReason != null ? cell.writeBlockedReason : p.api.getColumn(column.key)?.isCellEditable(p.node) ? 'Enter or F2 opens the editor.' : 'Read-only cell. The reason was not reported.'}
        onFocusCell={() => { if (p.node.rowIndex != null) { p.api.setFocusedCell(p.node.rowIndex, column.key); p.api.clearCellSelection(); p.api.addCellRange({ rowStartIndex: p.node.rowIndex, rowEndIndex: p.node.rowIndex, columns: [column.key] }) } }}
        onActivate={anchor => p.openEditor?.(row, column, anchor)} />}
      <SourceIndicator
        kind={source.kind}
        label={source.label}
        description={description}
        actionLabel={`Show cell details: ${row.sku}, ${column.label}`}
        onAction={() => onDetails(row, column)}
      />
      <CellSaveReason reason={save?.reason} />
      <CellSaveMark state={save?.state} />
    </span>
  )
})
