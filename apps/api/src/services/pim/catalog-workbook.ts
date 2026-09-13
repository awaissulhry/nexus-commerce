import { languageHeader, parseHeader } from './import-diff.service.js'
import ExcelJS from 'exceljs'
import { transferCategoryField, transferCanonical, type TransferRow, type TransferIssue, type TransferEntity } from '@nexus/shared/catalog-transfer'
import { parseTransferRecords, TRANSFER_MAX_ROWS, TRANSFER_MAX_FILE_BYTES, TransferWorkbookLimitError } from './catalog-transfer-file.js'
import { workbookTable as table, workbookColors, fill, fitWorkbookRow, formatReferenceSheet, workbookLink } from './catalog-workbook-format.js'

export interface WorkbookField {
  field: string; label: string; type: string; required?: string; options?: string[]; help?: string
  editable?: boolean; maxLength?: number | null; unitOptions?: string[]; schemaVersion?: string | null; selectionOnly?: boolean
}
export interface WorkbookScope {
  sheet: string; entity: TransferEntity; channel: string; accountId: string; marketplace: string; locale: string
  category: string; fields: WorkbookField[]; rows: TransferRow[]; note?: string
}
const manifestColumns = ['sheet', 'entity', 'channel', 'accountId', 'marketplace', 'locale', 'category'] as const
const supporting = new Set(['Instructions', 'Dictionary', 'Valid values', 'Formula examples', 'Nexus workbook'])
const blank = (value: unknown) => value === null || value === undefined || value === ''
const actionPrefix = 'action:'
// Channel attributes can have the same names as workbook record coordinates.
const fieldHeader = (field: string) => ['sku', 'aliasKey', 'version', 'listing'].includes(field) || /^(?:value|action):/.test(field) ? `value:${field}` : field
export interface EditingWorkbookBaseline { id: string; scopes: WorkbookScope[]; aliasLabels?: Record<string, string>; exportedAt?: string; expiresAt?: string }
const choiceRule = (field: WorkbookField) => field.selectionOnly === true ? 'Listed values only' : field.selectionOnly === false ? 'Suggestions; custom values allowed' : 'Check current rules in Nexus'
function jsonEncodedFields(scope: WorkbookScope) {
  const types = new Map(scope.fields.map(f => [f.field, f.type]))
  return new Set(scope.rows.filter(r => r.action === 'SET' && typeof r.value === 'string'
    && (['list', 'measure', 'number', 'boolean', 'json'].includes(types.get(r.field) ?? '') || /[\r\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(r.value))).map(r => r.field))
}

/** One record per row; each sheet owns one explicit language or listing scope. */
export async function writeCatalogWorkbook(scopes: WorkbookScope[], productEditor = false, editing?: EditingWorkbookBaseline) {
  if (scopes.length > 100) throw new Error('Choose at most 100 workbook scopes per file')
  if (scopes.reduce((sum, s) => sum + s.rows.length, 0) > TRANSFER_MAX_ROWS) throw new TransferWorkbookLimitError('rows')
  const book = new ExcelJS.Workbook(); book.creator = 'Nexus Commerce'; book.calcProperties.fullCalcOnLoad = true
  const instructions = table(book, 'Instructions', ['Start here', productEditor ? 'Product editing workbook' : 'Catalog workbook'], [30, 108])
  instructions.properties.tabColor = { argb: workbookColors.header }
  instructions.addRows([
    ['1. Open a data sheet', productEditor ? 'Use the product, language or listing tabs to edit the existing selected records. Each named listing is a separate destination. Keep SKUs and listing identifiers intact.' : 'Use the product, language or listing tabs. Each sheet has its own destination. Keep SKUs and listing identifiers intact.'],
    ['2. Choose your values', 'Use the dropdown where available. Valid values has one row per attribute and destination, with each choice in its own column. Dictionary explains types, units and requirements.'],
    ['3. Import and review', productEditor ? 'Return to this product editor and choose Import. Nexus restores the workbook selection for review. Check every proposed change before saving. Only existing selected records can be updated.' : 'Open Nexus → Products → Import & export → Nexus workbook. Upload this file and review the proposed changes before saving.'],
    ['Editing cells', editing ? 'Edit value cells directly. Unchanged or blank cells preserve the original value and inheritance. A new nonblank value applies only at its listed destination. Blank inherited cells may still show a value in the grid; the import review explains the resolved result.' : 'A populated value with a blank action means SET. Blank value and blank action preserve the existing value. To change an exported INHERIT cell, fill its value and change its action to SET.'],
    ['Explicit actions', `${editing ? 'Unhide the grouped action columns when needed. ' : ''}SET writes the value; CLEAR explicitly empties a supported field; INHERIT removes the override. CLEAR and INHERIT require a blank value. Deleting a row or column does not delete products or values.`],
    ['Cell colors', 'Pale amber value cells are editable. Gray identifiers and managed values are reference cells. Amber action headers identify explicit SET, CLEAR and INHERIT controls. Header notes and the Dictionary also explain each field’s role.'],
    ['Long content', 'Data rows show a compact preview. The full value is preserved: select the cell and expand the formula bar to read or edit it, or increase the row height. This also applies to long descriptions and JSON lists.'],
    ['Sorting and filtering', 'Use the header filters to find records. Sort the whole data range, including hidden columns, so each value stays with its SKU and listing identity. Never sort a single column on its own. Hidden or filtered rows are still imported; remove a row or column from the file to exclude its edits. Removing them does not delete catalog data.'],
    ['Valid-value formats', 'Copy choices exactly as shown. Choice rule distinguishes fixed lists from suggestions that accept custom values. Other type and length rules still apply. For a JSON list, enter an array such as ["red","blue"]; Excel does not offer multiple selection here. Allowed units are in Dictionary. Nexus checks current rules on import.'],
    ['Reference sheets', 'Use the header filters in Dictionary and Valid values to find an attribute or destination, then copy the choices you need. These sheets and the hidden matching details are protected against accidental edits. Keep their contents and row order intact so dropdowns keep the correct choices.'],
    ['Shared products', productEditor ? 'Products sheets contain reusable facts. Shared edits can affect inheriting variants and listings outside the file. Existing listing overrides stay in place. Keep parentSku unchanged; manage parent relationships in the product relationship tools.' : 'Products sheets contain reusable facts. Use one row per SKU. Family is the stable family code; parentSku links a child to its parent. Do not infer a size or other fact from a SKU.'],
    ['Translations', 'Each language sheet has an explicit locale in Nexus workbook. Translate descriptive content only; preserve brand names, identifiers, dimensions and verified technical facts. Blank cells follow the per-language ignore / clear choice at import; ignore is the default. No automatic translation is performed.'],
    ['Channel destinations', `Each listing sheet belongs to one channel, account, marketplace and category. ${editing ? 'Listing names distinguish primary and named aliases.' : 'aliasKey is blank for the primary listing and identifies a named alias otherwise.'} The hidden Nexus workbook sheet holds the matching details; keep it intact. An Italian title never writes to another marketplace.`],
    ['Types', 'Keep SKUs, GTINs and category/account IDs as text, including leading zeros. Numbers and booleans are typed Excel values. Lists and measures use JSON, such as ["one","two"] and {"value":1.2,"unit":"kilograms"}. Zero and false are real values.'],
    ['Legacy values', 'Dictionary encoding=json means all values in that column use JSON, including quoted strings. This preserves older stored values exactly. Keep the encoding intact; preview validates any edited value against the current type.'],
    ['AI filling instructions', 'Keep sheet names, machine headers, scope coordinates and record versions intact. Use only verified source facts. Follow each sheet’s Dictionary and Valid values. Use the wire value, not a translated label. Leave unknown facts blank; never invent certifications, dimensions, identifiers, safety claims or translations.'],
    ['Requirements', 'Required and conditional requirements come from the selected category schema. This file is a snapshot; Nexus checks current rules during preview and apply. Conditional requirements need a complete product and are checked again before publication.'],
    ['Formulas', 'Formula examples are calculation helpers. Recalculate formulas, inspect their results, then paste values into the import sheets. Calculated formulas and errors are refused; cached results may be stale. TRUE() and FALSE() are accepted as boolean values, subject to the field’s type rules. Nexus cell formulas remain managed in the platform.'],
    ['Review and apply', productEditor ? 'Review the selected SKUs, accounts, markets, listings and every proposed change before saving. Record versions detect concurrent edits. This import updates Nexus only; it does not publish to a channel.' : 'Review every changed/refused value before applying. Record versions detect concurrent edits. New products/listings are drafts. This workbook is a Nexus import file; it is not an Amazon or eBay upload template.'],
    ['Commercial operations', 'Price, stock and publication retain their dedicated workflows and transactional checks. Their fields are listed as managed in the dictionary and cannot be changed by a catalog import.'],
  ])
  if (editing?.exportedAt && editing.expiresAt) instructions.addRow(['Workbook validity', `Exported ${editing.exportedAt}. Import before ${editing.expiresAt} using the same Nexus user and product editor. After expiry, download a fresh workbook. Concurrent product or listing edits may require a fresh export sooner.`])
  // Put the working sheets before reference material without changing their import names.
  for (const scope of scopes) {
    if (supporting.has(scope.sheet) || book.getWorksheet(scope.sheet)) throw new Error('Workbook sheet names must be unique')
    book.addWorksheet(scope.sheet)
  }
  const manifest = table(book, 'Nexus workbook', ['format', 'version', ...(editing ? ['exportId'] : [])], [30, 20, 40])
  manifest.state = 'hidden'
  manifest.addRow(['nexus-catalog-wide', editing ? 3 : 2, ...(editing ? [editing.id] : [])]); manifest.addRow([]); manifest.addRow([...manifestColumns])
  manifest.getCell('D2').value = 'escaped-field-headers-v1'
  ;[32, 20, 16, 38, 18, 14, 30].forEach((width, i) => { manifest.getColumn(i + 1).width = width })
  manifest.getRow(4).font = { name: 'Arial', size: 10, bold: true }; manifest.getRow(4).height = 24
  manifest.getCell('E2').value = 'language-key-row-v1'
  const dictionary = table(book, 'Dictionary', ['Sheet', 'Field key', 'Attribute', 'Type', 'Requirement', 'Editing', 'Max. length', 'Allowed units', 'Schema version', 'Guidance', 'Encoding'], [26, 36, 32, 16, 24, 20, 14, 30, 30, 64, 16])
  for (const column of ['Field key', 'Schema version', 'Encoding']) dictionary.getColumn(column).hidden = true
  dictionary.views = [{ state: 'frozen', ySplit: 1, xSplit: 3, showGridLines: false }]
  const maxOptions = scopes.reduce((max, s) => s.fields.reduce((n, f) => Math.max(n, f.options?.length ?? 0), max), 1)
  if (maxOptions > 16_379) throw new Error('An attribute has more than 16,379 valid values and cannot fit across an Excel row. Export fewer attributes or edit this attribute in Nexus.')
  const valueHeaders = ['Sheet', 'Attribute', 'Field key', 'Entry format', 'Choice rule', ...Array.from({ length: maxOptions }, (_, i) => `Value ${i + 1}`)]
  const values = table(book, 'Valid values', valueHeaders, valueHeaders.map((_, i) => i === 0 ? 26 : i === 1 ? 32 : i === 2 ? 36 : i === 3 ? 24 : i === 4 ? 32 : 22))
  values.getColumn('Field key').hidden = true
  values.views = [{ state: 'frozen', ySplit: 1, xSplit: 2, showGridLines: false }]
  let workbookCells = 0
  for (const scope of scopes) {
    manifest.addRow(manifestColumns.map(k => scope[k] || null))
    if (scope.note) instructions.addRow([scope.sheet, scope.note])
    const fields = [...new Map(scope.fields.filter(f => !['sku', 'aliasKey', 'version', 'listing'].includes(f.field) || scope.rows.some(r => r.field === f.field)).map(f => [f.field, { ...f }])).values()]
    const first = ['family', 'parentSku', 'name', 'productType', 'categoryId', 'item_name', 'brand', 'manufacturer', 'model_name', 'description', 'product_description', 'bulletPoints', 'bullet_point']
    const rank = (f: WorkbookField) => first.includes(f.field) ? first.indexOf(f.field) : f.required === 'required' ? 30 : f.required === 'requiredIfRelevant' ? 40 : 50
    fields.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
    // Existing catalog values may predate the current schema (a scalar stored for a list,
    // or a numeric string). Preserve their exact type on an unchanged editing round trip.
    const byField = new Map(fields.map(f => [f.field, f]))
    const jsonFields = jsonEncodedFields(scope)
    const keys = ['sku', ...(scope.entity === 'Products' ? [] : editing ? ['listing', 'aliasKey'] : ['aliasKey']), 'version']
    const editable = fields
    if (keys.length + editable.length * 2 > 2000) throw new Error(`${scope.sheet}: too many attribute columns`)
    const headers = [...keys, ...(editing ? [...editable.map(f => fieldHeader(f.field)), ...editable.map(f => `${actionPrefix}${fieldHeader(f.field)}`)] : editable.flatMap(f => [fieldHeader(f.field), `${actionPrefix}${fieldHeader(f.field)}`]))]
    const sheet = table(book, scope.sheet, headers, headers.map(h => h.startsWith(actionPrefix) ? 18 : h === 'version' ? 12 : 32))
    sheet.addRow([]) // Reserve D15.2 machine keys before data/validation addresses are assigned.
    sheet.columns.forEach(column => { column.alignment = { wrapText: true, vertical: 'top' } })
    sheet.getRow(1).alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' }
    sheet.properties.tabColor = { argb: workbookColors.editHeader }
    sheet.getRow(1).height = Math.max(36, ...headers.map((h, i) => Math.ceil(h.length / Math.max(10, (sheet.getColumn(i + 1).width ?? 32) - 3)) * 12))
    sheet.getColumn('sku').width = 30
    if (editing && scope.entity !== 'Products') sheet.getColumn('listing').width = 28
    for (const field of fields.filter(f => ['name', 'title', 'item_name'].includes(f.field))) {
      sheet.getColumn(field.field).width = 54
    }
    sheet.getColumn('sku').numFmt = '@'
    if (editing) {
      sheet.getColumn('version').hidden = true
      if (scope.entity !== 'Products') sheet.getColumn('aliasKey').hidden = true
      sheet.views = [{ state: 'frozen', ySplit: 1, xSplit: scope.entity === 'Products' ? 1 : 2, showGridLines: false }]
    }
    const groups = new Map<string, TransferRow[]>()
    for (const row of scope.rows) {
      const key = JSON.stringify([row.sku, row.aliasKey])
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(row)
    }
    for (const rows of groups.values()) {
      const record: Record<string, unknown> = { sku: rows[0].sku, aliasKey: rows[0].aliasKey, version: rows[0].version,
        ...(editing && scope.entity !== 'Products' ? { listing: editing.aliasLabels?.[rows[0].aliasKey] ?? (rows[0].aliasKey || 'Primary listing') } : {}) }
      for (const row of rows) {
        const header = fieldHeader(row.field)
        if (Object.prototype.hasOwnProperty.call(record, header)) throw new Error(`Duplicate workbook value: ${row.sku} / ${row.field}`)
        if (!byField.has(row.field)) throw new Error(`Missing dictionary field: ${scope.sheet} / ${row.field}`)
        record[header] = row.action === 'SET' ? jsonFields.has(row.field) || byField.get(row.field)?.type === 'json' || typeof row.value === 'object' && row.value !== null ? JSON.stringify(row.value) : row.value : null
        record[`${actionPrefix}${header}`] = editing ? null : row.action
      }
      const added = sheet.addRow(record)
      fitWorkbookRow(added, 72)
    }
    // Reserve a modest input area; imported blank rows never become mutations.
    const last = Math.max(editing ? 3 : 52, sheet.rowCount)
    workbookCells += last * headers.length
    if (workbookCells > 2_000_000) throw new TransferWorkbookLimitError('rows')
    for (const key of keys) {
      const col = sheet.getColumn(key)
      sheet.getCell(1, col.number).note = key === 'listing' ? 'Listing name for reference. Matching uses the hidden listing identity; changing this label does not change the destination.' : 'Record identity. Keep this value intact so Nexus can match your changes.'
      for (let r = 3; r <= last; r++) sheet.getCell(r, col.number).fill = fill(workbookColors.reference)
    }
    for (const f of fields) {
      const header = fieldHeader(f.field)
      const guidance = [f.label, `Type: ${f.type}. ${f.required ?? 'Optional'}.`, f.help,
        f.editable === false ? 'Reference or managed field. Existing read-only values cannot be changed here.' : editing ? 'Edit this value directly. Blank or unchanged values preserve data and inheritance. Unhide action columns for explicit SET, CLEAR or INHERIT.' : 'Enter a value to set it. Blank value and blank action preserve existing data. If the action says INHERIT, change it to SET when entering a value.',
        jsonFields.has(f.field) || ['list', 'measure', 'json'].includes(f.type) ? 'Use the JSON encoding described in Dictionary. Lists: ["first","second"]. Measures: {"value":1.2,"unit":"kilograms"}; use the units allowed for this field.' : '',
        f.maxLength ? `Maximum length: ${f.maxLength}.` : '', f.options?.length ? `${f.options.length} choices are listed in Valid values for this sheet and field. ${choiceRule(f)}.` : '',
        'Long content has a compact preview. Select the cell and expand the formula bar, or increase the row height, to see the full value.',
      ].filter(Boolean).join('\n\n')
      sheet.getCell(1, sheet.getColumn(header).number).note = guidance
      sheet.getCell(1, sheet.getColumn(`${actionPrefix}${header}`).number).note = `${f.label}: SET saves the value; CLEAR explicitly empties it; INHERIT removes the override. CLEAR and INHERIT require an empty value. Leave action and value blank to preserve existing data.`
      workbookCells += 11 + (f.options?.length ? f.options.length + 5 : 0)
      if (workbookCells > 2_000_000) throw new TransferWorkbookLimitError('rows')
      const dictionaryRow = dictionary.addRow([workbookLink(scope.sheet), f.field, f.label, f.type, f.required === 'required' ? 'Required' : f.required === 'requiredIfRelevant' ? 'Required when relevant' : f.required ?? 'Optional', f.editable === false ? 'Reference only' : 'Editable', f.maxLength ?? null, (f.unitOptions ?? []).join(', ') || null, f.schemaVersion || null, f.help || null, jsonFields.has(f.field) ? 'json' : 'cell'])
      dictionaryRow.getCell(1).font = { name: 'Arial', size: 10, color: { argb: workbookColors.link }, underline: true }
      let optionsName: string | undefined
      if (f.options?.length) {
        const options = f.options.map(option => jsonFields.has(f.field) ? JSON.stringify(option) : option)
        const choiceRow = values.addRow([workbookLink(scope.sheet, sheet.getCell(1, sheet.getColumn(header).number).address), f.label, f.field,
          f.type === 'list' ? 'JSON list items' : jsonFields.has(f.field) ? 'JSON value' : f.editable === false ? 'Reference only' : 'Single value', choiceRule(f), ...options])
        choiceRow.getCell(1).font = { name: 'Arial', size: 10, color: { argb: workbookColors.link }, underline: true }
        choiceRow.eachCell((cell, c) => { if (c >= 6) { cell.numFmt = '@'; values.getColumn(c).width = Math.min(44, Math.max(values.getColumn(c).width ?? 22, cell.text.length + 2)) } })
        optionsName = `NexusValues_${choiceRow.number}`
        const end = values.getColumn(5 + options.length).letter
        book.definedNames.add(`'Valid values'!$F$${choiceRow.number}:$${end}$${choiceRow.number}`, optionsName)
      }
      const col = sheet.getColumn(header), actionCol = sheet.getColumn(`${actionPrefix}${header}`)
      sheet.getCell(1, col.number).fill = fill(f.editable === false ? workbookColors.header : workbookColors.editHeader)
      sheet.getCell(1, col.number).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
      sheet.getCell(1, actionCol.number).fill = fill(workbookColors.actionHeader)
      if (editing || f.editable === false) { actionCol.hidden = true; actionCol.outlineLevel = 1 }
      if (!['number', 'boolean'].includes(f.type)) col.numFmt = '@'
      for (let r = 3; r <= last; r++) {
        sheet.getCell(r, col.number).fill = fill(f.editable === false ? workbookColors.reference : workbookColors.input)
        sheet.getCell(r, actionCol.number).fill = fill(workbookColors.reference)
        if (f.editable === false) continue
        sheet.getCell(r, actionCol.number).dataValidation = { type: 'list', allowBlank: true, formulae: ['"SET,CLEAR,INHERIT"'], showErrorMessage: true, error: 'Choose SET, CLEAR or INHERIT.' }
        if (optionsName && !['list', 'measure', 'json'].includes(f.type)) sheet.getCell(r, col.number).dataValidation = { type: 'list', allowBlank: true, formulae: [optionsName], showErrorMessage: f.selectionOnly === true,
          errorStyle: 'warning', errorTitle: 'Value outside the list', error: 'This field expects a listed value. An unlisted value may be refused by Nexus or the channel. Review the choices in Valid values.',
          showInputMessage: true, promptTitle: f.label.slice(0, 32), prompt: `${choiceRule(f)}. See this attribute’s row in Valid values. Nexus checks your edits again during import.` }
      }
    }
    // D15.2: labels are for people; the second row is the only write address.
    const machineHeaders = headers.map(h => keys.includes(h) ? h : h.startsWith(actionPrefix) ? `${actionPrefix}${languageHeader(h.slice(actionPrefix.length), scope)}` : languageHeader(h, scope))
    sheet.getRow(2).values = machineHeaders
    for (let c = 0; c < headers.length; c++) {
      const h = headers[c], action = h.startsWith(actionPrefix), field = (action ? h.slice(actionPrefix.length) : h).replace(/^value:/, '')
      sheet.getCell(1, c + 1).value = keys.includes(h) ? h === 'sku' ? 'SKU' : h : `${action ? 'Action · ' : ''}${fields.find(f => f.field === field)?.label ?? field}`
      sheet.getCell(2, c + 1).numFmt = '@'
    }
    sheet.getRow(2).font = { name: 'Aptos', size: 9, color: { argb: workbookColors.text } }
    sheet.views = [{ state: 'frozen', xSplit: keys.length, ySplit: 2 }]
    sheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: Math.max(3, sheet.rowCount), column: headers.length } }
  }
  const formulas = table(book, 'Formula examples', ['Brand', 'Model', 'Color', 'Title helper', 'Title length'], [24, 24, 24, 60, 18])
  formulas.addRow(['Example brand', 'Example model', 'Example color', { formula: 'A2&" "&B2&" - "&C2', result: 'Example brand Example model - Example color' }, { formula: 'LEN(D2)', result: 'Example brand Example model - Example color'.length }])
  formulas.addRow(['Replace these illustrative inputs. Paste verified results as values into the appropriate language or listing sheet.'])
  formulas.getRow(3).height = 32; formulas.mergeCells('A3:E3'); formulas.getCell('A3').alignment = { wrapText: true, vertical: 'middle' }
  formatReferenceSheet(dictionary)
  formatReferenceSheet(values)
  if (values.rowCount === 1) { values.addRow(['No fixed choices', 'See Dictionary for types and units.']); formatReferenceSheet(values, false) }
  formatReferenceSheet(instructions, false)
  instructions.getColumn(1).font = { name: 'Arial', size: 10, bold: true, color: { argb: workbookColors.text } }
  // Reapply the header after the label-column font so its white text stays legible.
  instructions.getCell('A1').font = { name: 'Arial', size: 10, bold: true, color: { argb: workbookColors.white } }
  instructions.views = [{ state: 'normal', showGridLines: false }]
  for (const cell of ['A2', 'B2', 'C2']) formulas.getCell(cell).fill = fill(workbookColors.input)
  for (const cell of ['D2', 'E2']) formulas.getCell(cell).fill = fill(workbookColors.reference)
  fitWorkbookRow(formulas.getRow(2))
  formulas.getRow(3).height = 36
  // Named dropdown ranges use fixed reference rows. Prevent accidental sorting or
  // edits there while preserving filtering, copying and resizing; no password needed.
  for (const sheet of [dictionary, values, manifest]) await sheet.protect('', { autoFilter: true, sort: false, formatColumns: true, formatRows: true })
  const buffer = Buffer.from(await book.xlsx.writeBuffer())
  if (buffer.length > TRANSFER_MAX_FILE_BYTES) throw new TransferWorkbookLimitError('bytes')
  return buffer
}

/** Parse the wide workbook into the same reviewed, transactional attribute contract as v1. */
export function readCatalogWorkbook(book: ExcelJS.Workbook, editing?: EditingWorkbookBaseline, options: { blankPolicy?: 'ignore' | 'clear' } = {}): { rows: TransferRow[]; issues: TransferIssue[] } | null {
  const manifest = book.getWorksheet('Nexus workbook')
  if (!manifest) return null
  const version = manifest.getCell('B2').text
  const escapedHeaders = manifest.getCell('D2').text === 'escaped-field-headers-v1'
  const keyRow = manifest.getCell('E2').text === 'language-key-row-v1' ? 2 : 1
  if (options.blankPolicy && !['ignore', 'clear'].includes(options.blankPolicy)) throw new Error('Blank cells must be ignored or cleared')
  if (manifest.getCell('A2').text !== 'nexus-catalog-wide' || !['2', '3'].includes(version)) throw new Error('Unsupported Nexus workbook version')
  if (version === '3' && (!editing || manifest.getCell('C2').text !== editing.id)) throw new Error('Return this editing workbook to its product editor. Its saved export baseline is required.')
  if (version !== '3' && editing) throw new Error('The editing workbook version was changed. Download a new workbook.')
  const logicalConstant = (cell: ExcelJS.Cell) => cell.type === ExcelJS.ValueType.Formula && /^(TRUE|FALSE)\(\)$/i.test(cell.formula) ? cell.formula.toUpperCase() === 'TRUE()' : undefined
  const literal = (cell: ExcelJS.Cell, valueCell = false) => {
    // LibreOffice writes native logical cells as TRUE()/FALSE(). These constants
    // need no calculation and we never trust their cached result. Keep formulas
    // forbidden in identities and metadata. Normal value type validation still
    // applies, including legacy booleans stored under a text field definition.
    const logical = valueCell ? logicalConstant(cell) : undefined
    if (logical !== undefined) return String(logical)
    if ([ExcelJS.ValueType.Formula, ExcelJS.ValueType.Error].includes(cell.type)) throw new Error(`${cell.fullAddress.sheetName}!${cell.address}: paste verified formula results as values before importing`)
    return cell.text
  }
  for (let c = 1; c <= manifestColumns.length; c++) if (literal(manifest.getCell(4, c)) !== manifestColumns[c - 1]) throw new Error('Nexus workbook scope headers were changed')
  const dictionary = book.getWorksheet('Dictionary')
  if (!dictionary || !['sheet', 'Sheet'].includes(dictionary.getCell('A1').text) || !['field', 'Field key'].includes(dictionary.getCell('B1').text) || !['type', 'Type'].includes(dictionary.getCell('D1').text)) throw new Error('Keep the workbook Dictionary intact')
  const types = new Map<string, string>()
  const encodings = new Map<string, string>()
  dictionary.eachRow((r, i) => { if (i > 1) {
    const key = JSON.stringify([literal(r.getCell(1)), literal(r.getCell(2))]), type = literal(r.getCell(4))
    if (types.has(key)) throw new Error('Duplicate dictionary field')
    types.set(key, type)
    const encoding = literal(r.getCell(11)) || 'cell'
    if (!['cell', 'json'].includes(encoding)) throw new Error('Dictionary encoding must be cell or json')
    encodings.set(key, encoding)
  } })
  const rows: TransferRow[] = [], issues: TransferIssue[] = [], consumed = new Set<string>()
  let scannedCells = 0
  for (let n = 5; n <= manifest.rowCount; n++) {
    const scope = Object.fromEntries(manifestColumns.map((k, i) => [k, literal(manifest.getCell(n, i + 1))])) as unknown as WorkbookScope
    if (!scope.sheet) { if (manifest.getRow(n).hasValues) throw new Error('A workbook scope is missing its sheet name'); continue }
    if (consumed.has(scope.sheet) || supporting.has(scope.sheet)) throw new Error('Duplicate or invalid workbook scope')
    consumed.add(scope.sheet)
    if (consumed.size > 100) throw new Error('Choose at most 100 workbook scopes per file')
    const sheet = book.getWorksheet(scope.sheet)
    if (!sheet) throw new Error(`Missing worksheet ${scope.sheet}`)
    const headerField = (header: string) => {
      let key = header
      if (keyRow === 2) {
        const parsed = parseHeader(header)
        if (!parsed || parsed.isFormulaColumn || parsed.form || (parsed.scope.channel ?? '') !== scope.channel || (parsed.scope.marketplace ?? '') !== scope.marketplace || (parsed.scope.locale ?? '') !== scope.locale) throw new Error(`${scope.sheet}: machine header destination changed`)
        key = parsed.fieldKey
      }
      return escapedHeaders && key.startsWith('value:') ? key.slice(6) : key
    }
    const originalScope = editing?.scopes.find(s => s.sheet === scope.sheet)
    if (editing && (!originalScope || manifestColumns.some(k => originalScope[k] !== scope[k]))) throw new Error(`${scope.sheet}: the exported destination was changed. Download a new workbook for this destination.`)
    const originalRows = new Map(originalScope?.rows.map(r => [JSON.stringify([r.sku, r.aliasKey, r.field]), r]))
    const originalEncodings = originalScope ? jsonEncodedFields(originalScope) : null
    if (sheet.rowCount > TRANSFER_MAX_ROWS + keyRow || sheet.columnCount > 2000) throw new Error('Worksheet exceeds the import limits')
    scannedCells += sheet.rowCount * sheet.columnCount
    if (scannedCells > 2_000_000) throw new Error('Workbook contains too many sparse cells; remove unused rows and columns or split the workbook')
    const headers = Array.from({ length: sheet.columnCount }, (_, i) => literal(sheet.getCell(keyRow, i + 1)))
    const coordinateKeys = ['sku', 'version', ...(scope.entity === 'Products' ? [] : editing ? ['listing', 'aliasKey'] : ['aliasKey'])]
    if (!headers.includes('sku') || new Set(headers).size !== headers.length || headers.some(h => !h)) throw new Error(`${scope.sheet}: use distinct, non-empty headers including sku`)
    const fieldHeaders = headers.filter(h => !coordinateKeys.includes(h) && !h.startsWith(actionPrefix))
    if (new Set(fieldHeaders.map(headerField)).size !== fieldHeaders.length) throw new Error(`${scope.sheet}: duplicate attribute headers`)
    if (originalScope) for (const header of fieldHeaders) {
      const field = headerField(header)
      const key = JSON.stringify([scope.sheet, field])
      if (types.get(key) !== originalScope.fields.find(f => f.field === field)?.type || encodings.get(key) !== (originalEncodings!.has(field) ? 'json' : 'cell')) throw new Error(`${scope.sheet}: keep the field Dictionary intact`)
    }
    const fieldColumns = new Map(headers.map((h, i) => [h, i + 1]))
    const valueFields = new Set(fieldHeaders)
    for (const h of headers) if (!coordinateKeys.includes(h) && !types.has(JSON.stringify([scope.sheet, headerField(h.replace(/^action:/, ''))]))) throw new Error(`${scope.sheet}: unknown column ${h}; update the template or map this source explicitly`)
    for (const h of headers.filter(h => h.startsWith(actionPrefix))) if (!fieldHeaders.includes(h.slice(actionPrefix.length))) throw new Error(`${scope.sheet}: action column has no value column`)
    for (let r = keyRow + 1; r <= sheet.rowCount; r++) {
      if (rows.length + issues.length > TRANSFER_MAX_ROWS) throw new TransferWorkbookLimitError('rows')
      const record = Object.fromEntries(headers.map((h, c) => [h, literal(sheet.getCell(r, c + 1), valueFields.has(h))]))
      if (Object.values(record).every(v => v === '')) continue
      if (!record.sku?.trim()) { issues.push({ row: r, sku: '', field: '', message: `${scope.sheet}: SKU is required` }); continue }
      if (editing && !/^\d+$/.test(record.version ?? '')) { issues.push({ row: r, sku: record.sku, field: 'version', message: `${scope.sheet}: keep the exported record version intact` }); continue }
      if (!editing && !scope.locale && scope.entity !== 'Products' && scope.category) {
        const categoryKey = transferCategoryField(scope.channel)
        const categoryHeader = fieldHeaders.find(h => headerField(h) === categoryKey) ?? categoryKey
        if (record[categoryHeader] && record[categoryHeader] !== scope.category) { issues.push({ row: r, sku: record.sku, field: categoryKey, message: `${scope.sheet}: this sheet is bound to category ${scope.category}. Download a template for the new category.` }); continue }
        if (!record[categoryHeader] && !record[`${actionPrefix}${categoryHeader}`]) {
          const category = parseTransferRecords([{ entity: 'Listings', sku: record.sku, version: record.version, channel: scope.channel, accountId: scope.accountId, marketplace: scope.marketplace, aliasKey: record.aliasKey ?? '', locale: scope.locale, field: categoryKey, action: 'SET', format: 'text', value: scope.category }])
          rows.push(...category.rows.map(row => ({ ...row, row: r }))); issues.push(...category.issues.map(issue => ({ ...issue, row: r })))
        }
      }
      for (const header of fieldHeaders) {
        const field = headerField(header)
        const cell = sheet.getCell(r, fieldColumns.get(header)!), raw = record[header]
        const original = originalRows.get(JSON.stringify([record.sku, record.aliasKey ?? '', field]))
        const source = { sheet: scope.sheet, column: cell.address.replace(/\d+$/, '') }
        if (editing && (!original || String(original.version) !== record.version)) { issues.push({ row: r, sku: record.sku, field, source, message: 'Keep the exported SKU, alias and version intact. Download a new workbook for a different record.' }); continue }
        const requested = record[`${actionPrefix}${header}`]
        if (editing && options.blankPolicy !== 'clear' && !requested && blank(raw)) { rows.push({ ...original!, row: r, source }); continue }
        const action = requested || (blank(raw) ? options.blankPolicy === 'clear' ? 'CLEAR' : '' : 'SET')
        if (!action && blank(raw)) continue
        const type = types.get(JSON.stringify([scope.sheet, field]))!
        if (editing && type !== originalScope?.fields.find(f => f.field === field)?.type) throw new Error(`${scope.sheet}: keep the field Dictionary intact`)
        const json = encodings.get(JSON.stringify([scope.sheet, field])) === 'json' || ['list', 'measure', 'number', 'boolean', 'json'].includes(type) || typeof cell.value === 'number' || typeof cell.value === 'boolean' || logicalConstant(cell) !== undefined
        const parsed = parseTransferRecords([{ entity: scope.entity !== 'Products' && field === transferCategoryField(scope.channel) ? 'Listings' : scope.entity, sku: record.sku, version: record.version, channel: scope.channel, accountId: scope.accountId,
          marketplace: scope.marketplace, locale: scope.locale, aliasKey: record.aliasKey ?? '', field, action, format: json ? 'json' : 'text', value: raw }])
        rows.push(...parsed.rows.map(row => ({ ...(editing && !requested && original?.action === 'SET' && transferCanonical(row.value) === transferCanonical(original.value) ? original : row), row: r, source })))
        issues.push(...parsed.issues.map(issue => ({ ...issue, row: r, source, message: `${scope.sheet}: ${issue.message}` })))
        if (rows.length + issues.length > TRANSFER_MAX_ROWS) throw new TransferWorkbookLimitError('rows')
      }
    }
  }
  if (rows.length + issues.length > TRANSFER_MAX_ROWS) throw new TransferWorkbookLimitError('rows')
  for (const sheet of book.worksheets) if (!consumed.has(sheet.name) && !supporting.has(sheet.name)) throw new Error(`Worksheet ${sheet.name} has no declared destination`)
  const targets = new Map<string, unknown>()
  for (const row of rows) {
    const key = JSON.stringify([row.entity, row.sku, row.channel, row.accountId, row.marketplace, row.aliasKey, row.locale, row.field])
    if (targets.has(key)) throw new Error(`Multiple sheets write the same attribute: ${row.sku} / ${row.field}`)
    targets.set(key, transferCanonical(row.value))
  }
  return { rows, issues }
}
