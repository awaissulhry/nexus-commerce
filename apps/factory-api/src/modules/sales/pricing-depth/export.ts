import ExcelJS from 'exceljs'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import type { NumberFormat } from '@nexus/factory-domain/imports/cells'
import { SHEET_TYPES } from '@nexus/factory-domain/imports/job'
import { PRICE_LIST_COLUMNS, priceListImporter, priceRecordValues } from '@nexus/factory-domain/sales/pricing-depth/importer'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { dayText, ENTRY_COLUMNS, priceOf } from '../pricelists/store'
import { officeContextOf } from '../quotes/store'
import { readVersionFor } from './store'
// B-W2b-380 (XF6:04): the version's own row (style *) and the styles' size surcharges go in the file too.
import { styleSurchargesOf, surchargedStyleIds, surchargesRowValues, versionPartsOf, versionRowValues } from '../pricelists/import-version'

/**
 * The price list export (B-W2b-325; SAL-183; design sales.pricelists "Export ▾", the record's prices): one version's
 * prices (any status: exporting reads only) in the price list import's columns (factory-domain sales/pricing-depth/
 * importer), in its order, with its labels as the header, so the file goes back through the import unchanged into the
 * list's next draft: a UTF-8 CSV with `;` between cells and numbers in the format asked (Italian by default), or an Excel
 * workbook with numbers as numbers and a second sheet that explains each column. Prices are the price grain: without it
 * the export is refused (the file is nothing but prices). pricelists.view over the list's company. Made on request,
 * stored nowhere.
 */

export type PriceExportFormat = 'csv' | 'xlsx'

const cellText = (value: string): string => (/[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
const numberText = (value: string, format: NumberFormat): string => (format === 'it' ? value.replace('.', ',') : value)

export async function priceListExportFile(caller: CommandCaller, listId: string, versionId: string, format: PriceExportFormat, numberFormat: NumberFormat) {
  const context = officeContextOf(caller)
  const { list, version } = await readVersionFor(caller, listId, versionId)
  if (!heldGrains(actorOf(context)).has('price')) throw new ForbiddenError("A price list's file holds its prices: your role does not see prices.")
  const rows = await caller.withClient(async (client) => {
    const entries = await client.priceListEntry.findMany({ where: { versionId }, select: ENTRY_COLUMNS })
    const breaks = await client.priceBreak.findMany({ where: { versionId, entryId: { not: null } }, select: { entryId: true, minQuantity: true, unitPrice: true, discountPct: true } })
    const parts = await versionPartsOf(client, [versionId])
    const styles = new Map((await client.style.findMany({ where: { id: { in: [...new Set([...entries.map((entry) => entry.styleId), ...surchargedStyleIds(parts, versionId)])] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const colourways = new Map((await client.colourway.findMany({ where: { id: { in: [...new Set(entries.flatMap((entry) => (entry.colourwayId ? [entry.colourwayId] : [])))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const styleRow = (entry: (typeof entries)[number]) => entry.colourwayId === null && entry.validFrom === null
    const prices = entries.map((entry) =>
      priceRecordValues({
        list: list.code,
        style: styles.get(entry.styleId) ?? '',
        colourway: entry.colourwayId ? (colourways.get(entry.colourwayId) ?? '') : null,
        validFrom: dayText(entry.validFrom),
        validTo: dayText(entry.validTo),
        unitPrice: priceOf(entry.unitPrice),
        breaks: breaks.filter((row) => row.entryId === entry.id).map((row) => ({ minQuantity: row.minQuantity, unitPrice: row.unitPrice === null ? null : priceOf(row.unitPrice), discountPct: row.discountPct === null ? null : row.discountPct.toString() })),
        // B-W2b-380: the style's surcharges on its row for every colourway from the start.
        ...(styleRow(entry) ? { sizeSurcharges: styleSurchargesOf(parts, versionId, entry.styleId) } : {}),
      }),
    )
    // B-W2b-380: a style surcharged without such a price gets a row of its surcharges alone; the version's own row (style *)
    // when it has breaks of every price or surcharges of every style.
    const alone = surchargedStyleIds(parts, versionId)
      .filter((styleId) => !entries.some((entry) => entry.styleId === styleId && styleRow(entry)))
      .map((styleId) => surchargesRowValues(list.code, styles.get(styleId) ?? '', versionId, styleId, parts))
    const own = versionRowValues(list.code, versionId, parts)
    const versionRow = own.breaks !== '-' || own.sizeSurcharges !== '-' ? [own] : []
    return [
      ...versionRow,
      ...[...prices, ...alone].sort((a, b) => (a.style < b.style ? -1 : a.style > b.style ? 1 : a.colourway < b.colourway ? -1 : a.colourway > b.colourway ? 1 : a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : (a.unitPrice === undefined ? -1 : 1))),
    ]
  })
  const base = `price-list-${list.code}-v${version.revision}`
  const header = PRICE_LIST_COLUMNS.map((column) => priceListImporter.columns[column].label)
  // No breaks (or no surcharges): a blank cell (the import reads it as "not given", so nothing changes); a column the row does
  // not carry (B-W2b-380: the version's own row has no price or days) is blank too.
  const shown = (column: (typeof PRICE_LIST_COLUMNS)[number], value: string | undefined): string => (value === undefined || ((column === 'breaks' || column === 'sizeSurcharges') && value === '-') ? '' : value)
  // A surcharge's value in the number format asked (the size before `=` is a code: never touched).
  const surchargeCell = (value: string): string => (numberFormat === 'it' ? value.split(';').map((pair) => (pair.includes('=') ? `${pair.slice(0, pair.indexOf('=') + 1)}${pair.slice(pair.indexOf('=') + 1).replace('.', ',')}` : pair)).join(';') : value)
  if (format === 'csv') {
    const lines = rows.map((row) =>
      PRICE_LIST_COLUMNS.map((column) => {
        const value = shown(column, row[column])
        if (column === 'unitPrice') return cellText(numberText(value, numberFormat))
        if (column === 'breaks') return cellText(numberFormat === 'it' ? value.replace(/(\d)\.(\d)/g, '$1,$2') : value)
        if (column === 'sizeSurcharges') return cellText(surchargeCell(value))
        return cellText(value)
      }).join(';'),
    )
    return { fileName: `${base}.csv`, contentType: `${SHEET_TYPES.csv}; charset=utf-8`, body: Buffer.from(`${[header.map(cellText).join(';'), ...lines].join('\r\n')}\r\n`, 'utf8') }
  }
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Prices')
  sheet.addRow(header)
  for (const row of rows) {
    sheet.addRow(
      PRICE_LIST_COLUMNS.map((column) => {
        const value = shown(column, row[column])
        // An Excel number for the price (at most 6 decimals: Excel reads it back as the same text); breaks stay text.
        if (column === 'unitPrice') return value === '' ? '' : Number(value)
        if (column === 'breaks') return numberFormat === 'it' ? value.replace(/(\d)\.(\d)/g, '$1,$2') : value
        if (column === 'sizeSurcharges') return surchargeCell(value)
        return value
      }),
    )
  }
  sheet.getRow(1).font = { bold: true }
  // Codes and days as text, so Excel never turns "-", "*" or "2027-02-01" into something else.
  for (const index of [1, 2, 3, 4, 5, 7, 8]) sheet.getColumn(index).numFmt = '@'
  const help = workbook.addWorksheet('Columns')
  help.addRow(['Column', 'Key', 'What it holds'])
  for (const column of PRICE_LIST_COLUMNS) {
    const spec = priceListImporter.columns[column]
    help.addRow([spec.label, priceListImporter.keyColumns.includes(column) ? 'yes' : '', 'description' in spec ? (spec.description ?? '') : ''])
  }
  help.getRow(1).font = { bold: true }
  return { fileName: `${base}.xlsx`, contentType: SHEET_TYPES.xlsx, body: Buffer.from(await workbook.xlsx.writeBuffer()) }
}
