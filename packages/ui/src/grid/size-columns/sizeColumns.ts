/**
 * SizeColumns (B-W2b-207, design part SizeColumns) — the column kind for a decimal per size: one AG column per size of the
 * range, built ONCE here for BOM quantities by size, measurement specs, grade rules, sample measurements, cost by size and
 * price lists, so every grid of sizes types, writes, pastes and marks the same way.
 *
 *   const columns = [
 *     { colId: 'pom', headerName: t('pom'), field: 'name', pinned: 'left' },
 *     sizeColumnGroup({ sizes: ['S', 'M', 'L'], base: 'M', unit: 'cm', value: (row, size) => row.bySize[size] ?? null,
 *                       editable: canEdit, onChange: (row, size, value) => save(row.id, size, value), locale, labels: ds.sizeColumns }),
 *   ]
 *
 * - The value per size is a decimal STRING ("62.5") or null; the cell writes it in the page's language ("62,5").
 * - The base size is marked by more than colour: its header says "M · base" and its cells take the base tone.
 * - A missing value reads "— missing" in the error tone (never 0); a row that does not need the size (`required` false)
 *   reads "—" in the plain tone.
 * - Typing: the cell opens a decimal text field on the value as the person types it (`SizeValueEditor`); a comma or a point
 *   is the decimal separator; an empty text clears. A text that is not a number is refused: the value is kept and
 *   `onRefused` lets the page say why (`labels.notNumber`). Paste (a grid with cell selection) goes through the same rule
 *   (`valueParser`); the typed text is parsed again in `valueSetter` (AG36 does not parse a custom editor's value).
 * - `onChange(row, size, value)` is called once per changed cell; the page saves it and passes new rows (data in, events
 *   out): the column never changes the row itself.
 * - `isOverride` marks a value typed by hand among graded ones (a dot after the number and "typed by hand" in its tooltip).
 * Fill from the base by an increment is `SizeFill` (a form the page opens) over `fillFromBase`.
 */
import type { CellClassParams, ColDef, ColGroupDef, ITooltipParams, ValueFormatterParams, ValueGetterParams, ValueParserParams, ValueSetterParams } from 'ag-grid-community'

import { mergeLabels } from '../../lib/labels'
import { SIZE_COLUMNS_LABELS, type SizeColumnsLabels } from './SizeColumnsLabels'
import { parseSizeValue, sizeValueOf, sizeValueText, type SizeValue } from './sizeColumnsModel'
import { SizeValueEditor } from './SizeValueEditor'
import './sizeColumns.css'

export interface SizeColumnsOptions<T> {
  /** The sizes in scale order (the range of the style, the scale of the price list). */
  sizes: readonly string[]
  /** The base size (marked; where a grade or a fill starts). */
  base?: string | null
  /** The unit every value is in ("cm", "m²", "pcs"); said in the header's tooltip and the cells'. */
  unit?: string | null
  /** A row's value for a size: a decimal (string or number) or null / undefined for missing. */
  value: (row: T, size: string) => string | number | null | undefined
  /** May this cell be typed into? Default false (read only). */
  editable?: boolean | ((row: T, size: string) => boolean)
  /** A changed cell: the new decimal ("62.5") or null (cleared). Called once per cell, for a typed value and for a paste. */
  onChange?: (row: T, size: string, value: SizeValue) => void
  /** A typed or pasted text that is not a number: the value was kept. Say `labels.notNumber(size, text)`. */
  onRefused?: (row: T, size: string, text: string) => void
  /** Is a missing value a problem for this row? Default true ("— missing" in the error tone); false: "—". */
  required?: boolean | ((row: T) => boolean)
  /** Was this value typed by hand among graded ones (a manual override)? Marked. */
  isOverride?: (row: T, size: string) => boolean
  /** The most decimals typed and shown (default 4). */
  scale?: number
  /** Negative values allowed (a grade rule's increments). Default false. */
  negative?: boolean
  /** The page's language for numbers (default en-GB). */
  locale?: string
  /** The column ids: `${prefix}${size}` (default `size:`). */
  colIdPrefix?: string
  /** A fixed column width in px. Default: the size columns share the grid's free width (flex), at least 80 px each. */
  width?: number
  /** The cell's name for the editor: "Chest width, size M". Default: the size. */
  cellLabel?: (row: T, size: string) => string
  labels?: Partial<SizeColumnsLabels>
}

/** The classes a size cell may carry (one stylesheet, `sizeColumns.css`). */
export const SIZE_COLUMN_CLASSES = {
  cell: 'nds-sizecol',
  base: 'nds-sizecol-base',
  missing: 'nds-sizecol-missing',
  notNeeded: 'nds-sizecol-notneeded',
  override: 'nds-sizecol-override',
  head: 'nds-sizecol-head',
  headBase: 'nds-sizecol-head-base',
} as const

const decided = <A extends unknown[]>(rule: boolean | ((...args: A) => boolean) | undefined, fallback: boolean) => (...args: A): boolean =>
  typeof rule === 'function' ? rule(...args) : rule ?? fallback

/** One column per size. Add them to a grid's `columnDefs` after the row's own columns, or use `sizeColumnGroup`. */
export function sizeColumns<T>(options: SizeColumnsOptions<T>): ColDef<T>[] {
  const lw = mergeLabels(SIZE_COLUMNS_LABELS, options.labels)
  const prefix = options.colIdPrefix ?? 'size:'
  const unit = options.unit ?? null
  const scale = options.scale ?? 4
  const locale = options.locale ?? 'en-GB'
  const canEdit = decided<[T, string]>(options.editable, false)
  const needs = decided<[T]>(options.required, true)
  const parse = { scale, negative: options.negative ?? false, missingWords: [lw.missing, lw.notNeeded] }
  const rowOf = (params: { data?: T | null }): T | undefined => params.data ?? undefined

  return options.sizes.map((size): ColDef<T> => {
    const isBase = !!options.base && size === options.base
    const read = (row: T | undefined): SizeValue => (row === undefined ? null : sizeValueOf(options.value(row, size)))
    const typed = (row: T | undefined) => (row === undefined ? false : (options.isOverride?.(row, size) ?? false))
    return {
      colId: `${prefix}${size}`,
      headerName: isBase ? lw.baseHeader(size) : size,
      headerTooltip: lw.headerTooltip(size, unit, isBase),
      headerClass: ['nds-ag-head-num', SIZE_COLUMN_CLASSES.head, isBase ? SIZE_COLUMN_CLASSES.headBase : null].filter((name): name is string => !!name),
      type: 'rightAligned',
      // The sizes share the free width (no dead space on the right); the base column has room for "M · base".
      ...(options.width ? { width: options.width } : { flex: 1, minWidth: isBase ? 104 : 80 }),
      sortable: false,
      suppressHeaderMenuButton: true,
      cellDataType: false,
      cellClass: ['nds-ag-cell', 'nds-ag-num', SIZE_COLUMN_CLASSES.cell, isBase ? SIZE_COLUMN_CLASSES.base : null].filter((name): name is string => !!name),
      cellClassRules: {
        [SIZE_COLUMN_CLASSES.missing]: (params: CellClassParams<T>) => params.data != null && read(rowOf(params)) === null && needs(params.data),
        [SIZE_COLUMN_CLASSES.notNeeded]: (params: CellClassParams<T>) => params.data != null && read(rowOf(params)) === null && !needs(params.data),
        [SIZE_COLUMN_CLASSES.override]: (params: CellClassParams<T>) => read(rowOf(params)) !== null && typed(rowOf(params)),
      },
      valueGetter: (params: ValueGetterParams<T>) => read(rowOf(params)),
      valueFormatter: (params: ValueFormatterParams<T>) => {
        const text = sizeValueText(params.value as SizeValue, locale, scale)
        if (text !== null) return text
        if (params.data == null) return ''
        return needs(params.data) ? lw.missing : lw.notNeeded
      },
      tooltipValueGetter: (params: ITooltipParams<T>) => {
        const row = rowOf(params as { data?: T | null })
        if (row === undefined) return undefined
        return lw.cellTooltip(size, sizeValueText(read(row), locale, scale), unit, typed(row))
      },
      editable: (params) => params.data != null && canEdit(params.data, size),
      cellEditor: SizeValueEditor,
      cellEditorParams: (params: { data?: T | null }) => ({ locale, label: params.data != null && options.cellLabel ? options.cellLabel(params.data, size) : size }),
      valueParser: (params: ValueParserParams<T>) => {
        const text = params.newValue === null || params.newValue === undefined ? '' : String(params.newValue)
        const parsed = parseSizeValue(text, parse)
        if (parsed.ok) return parsed.value
        if (params.data == null) return null
        options.onRefused?.(params.data, size, text.trim())
        // The row's own value, not AG's `oldValue` (absent on some edit paths): a refused text never clears the cell.
        return read(params.data)
      },
      valueSetter: (params: ValueSetterParams<T>) => {
        if (params.data == null) return false
        // AG36 hands a custom editor's value to the setter as it was typed (its own editors call `parseValue`; a paste
        // goes through `valueParser`): the text is parsed here again, by the same rule, so a word never clears a cell.
        const text = params.newValue === null || params.newValue === undefined ? '' : String(params.newValue)
        const parsed = parseSizeValue(text, parse)
        if (!parsed.ok) {
          options.onRefused?.(params.data, size, text.trim())
          return false
        }
        const next = parsed.value
        if (next === read(params.data)) return false
        options.onChange?.(params.data, size, next)
        // The page saves and passes new rows: the column never changes the row itself.
        return false
      },
    }
  })
}

/**
 * The size of a size column (`size:M` → `M`), or null for another column. For a grid in `readOnlyEdit` (the factory's
 * sheets: `onCellEditRequest` instead of the column's `valueSetter`): the request's `newValue` has been through the
 * column's `valueParser`; parse it again with `parseSizeValue` when the source is not an edit.
 */
export function sizeColumnSize(colId: string | null | undefined, prefix = 'size:'): string | null {
  return colId && colId.startsWith(prefix) ? colId.slice(prefix.length) : null
}

/** The size columns under one header ("Per size (cm)"); `headerName` overrides it. */
export function sizeColumnGroup<T>(options: SizeColumnsOptions<T> & { groupId?: string; headerName?: string }): ColGroupDef<T> {
  const lw = mergeLabels(SIZE_COLUMNS_LABELS, options.labels)
  return {
    groupId: options.groupId ?? 'sizes',
    headerName: options.headerName ?? lw.group(options.unit ?? null),
    children: sizeColumns(options),
  }
}
