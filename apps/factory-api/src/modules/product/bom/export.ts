import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'
import type { FactoryClient } from '@nexus/factory-db'
import { pageLabel } from '@nexus/factory-domain/documents/compose'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import type { NumberFormat } from '@nexus/factory-domain/imports/cells'
import { SHEET_TYPES } from '@nexus/factory-domain/imports/job'
import { BOM_COLUMNS, bomImporter, exportedValues, numberText, type ExportedLine } from '@nexus/factory-domain/product/bom/importer'
import { bomPaper, type BomPaper } from '@nexus/factory-domain/product/bom/paper'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { PDF_CREATOR, winAnsi } from '../../../platform/documents/pdf'
import { readColourways, readLines, readMaterials, readRevisionFor, type LineRecord } from './store'

/**
 * The BOM export (feature PRD-090; design style.bom.lines "Export XLSX / PDF"): one revision's BOM, any status (a
 * released one too: exporting reads only), as
 *
 *   csv / xlsx  the BOM import's columns (factory-domain product/bom/importer), in its order, with its labels as the
 *               header, so the file goes back through the import unchanged (UTF-8 CSV with `;` between cells, numbers
 *               in the number format asked, Italian by default; an Excel workbook with numbers as numbers and a second
 *               sheet that explains each column)
 *   pdf         the BOM sheet (factory-domain product/bom/paper), A4 landscape, pdfkit's standard fonts (the documents
 *               platform's WinAnsi rule)
 *
 * product.bom.view over the style's company. No money in either: a cost is the cost sheet's, with its grain. Made on
 * request, stored nowhere.
 */

type Client = FactoryClient | CommandTx

/** The lines as the export writes them: codes, not ids, in the order given. */
export async function exportedLines(client: Client, style: { readonly id: string; readonly code: string }, lines: readonly LineRecord[]): Promise<ExportedLine[]> {
  const { materials, colours } = await readMaterials(client, lines.map((line) => line.itemId))
  const colourways = new Map((await readColourways(client, style.id)).map((colourway) => [colourway.id, colourway.code]))
  const supplierIds = [...new Set(lines.map((line) => line.supplierId).filter((id): id is string => id !== null))]
  const suppliers = new Map((supplierIds.length === 0 ? [] : await client.party.findMany({ where: { id: { in: supplierIds } }, select: { id: true, code: true } })).map((party) => [party.id, party.code]))
  const colourCode = (id: string): string => colours.get(id)?.code ?? ''
  return lines.map((line) => ({
    style: style.code,
    seq: line.seq,
    material: materials.get(line.itemId)?.code ?? '',
    placement: line.placement,
    qty: line.qty,
    uom: line.uom,
    wastagePct: line.wastagePct,
    sizeDependent: line.sizeDependent,
    sizes: line.sizeDependent ? line.sizes.map((row) => ({ size: row.size, qty: row.qty })) : [],
    colourDependent: line.colourDependent,
    colours: line.colourDependent ? line.colours.map((cell) => ({ colourway: colourways.get(cell.colourwayId) ?? '', colour: colourCode(cell.itemColourId) })) : [],
    colour: line.colourDependent || line.itemColourId === null ? null : colourCode(line.itemColourId),
    colourway: line.colourwayId === null ? null : (colourways.get(line.colourwayId) ?? null),
    supplier: line.supplierId === null ? null : (suppliers.get(line.supplierId) ?? null),
    note: line.note,
  }))
}

export type ExportFormat = 'csv' | 'xlsx' | 'pdf'

export interface ExportFile {
  readonly fileName: string
  readonly contentType: string
  readonly body: Buffer
}

const cellText = (value: string): string => (/[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
const DECIMAL_COLUMNS = new Set<string>(['qty', 'wastagePct'])
const yesNo = (value: boolean, format: NumberFormat): string => (value ? (format === 'it' ? 'sì' : 'yes') : 'no')

/** One revision's BOM as a file (product.bom.view; a read). */
export async function bomExportFile(caller: CommandCaller, styleId: string, revisionId: string, format: ExportFormat, numberFormat: NumberFormat, language: DocumentLanguage): Promise<ExportFile> {
  const { style, revision } = await readRevisionFor(caller, styleId, revisionId)
  const { lines, materials } = await caller.withClient(async (client) => {
    const colourwayIds = (await readColourways(client, styleId)).map((colourway) => colourway.id)
    const stored = await readLines(client, revisionId, { sizes: style.sizes, colourwayIds })
    return { lines: await exportedLines(client, style, stored), materials: (await readMaterials(client, stored.map((line) => line.itemId))).materials }
  })
  const base = `bom-${style.code}-rev${revision.revision}`
  if (format === 'pdf') {
    const paper = bomPaper({
      style: { code: style.code, name: style.name },
      revision: { revision: revision.revision, status: revision.status },
      sizes: style.sizes,
      lines: lines.map((line) => ({ ...line, materialName: [...materials.values()].find((material) => material.code === line.material)?.name ?? '' })),
      printedAt: serverClock.now(),
      language,
    })
    return { fileName: paper.fileName, contentType: 'application/pdf', body: await renderBomPaper(paper) }
  }
  const header = BOM_COLUMNS.map((column) => bomImporter.columns[column].label)
  if (format === 'csv') {
    const rows = lines.map((line) => {
      const values = exportedValues(line, numberFormat)
      return BOM_COLUMNS.map((column) => {
        const value = values[column]
        if (value === undefined) return ''
        if (typeof value === 'boolean') return yesNo(value, numberFormat)
        return cellText(DECIMAL_COLUMNS.has(column) ? numberText(String(value), numberFormat) : String(value))
      }).join(';')
    })
    return { fileName: `${base}.csv`, contentType: `${SHEET_TYPES.csv}; charset=utf-8`, body: Buffer.from(`${[header.map(cellText).join(';'), ...rows].join('\r\n')}\r\n`, 'utf8') }
  }
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('BOM')
  sheet.addRow(header)
  for (const line of lines) {
    const values = exportedValues(line, numberFormat)
    sheet.addRow(
      BOM_COLUMNS.map((column) => {
        const value = values[column]
        if (value === undefined) return null
        if (typeof value === 'boolean') return yesNo(value, numberFormat)
        return DECIMAL_COLUMNS.has(column) ? Number(value) : value
      }),
    )
  }
  sheet.getRow(1).font = { bold: true }
  const help = workbook.addWorksheet('Columns')
  help.addRow(['Column', 'Required', 'What it holds'])
  for (const column of BOM_COLUMNS) {
    const spec = bomImporter.columns[column]
    help.addRow([spec.label, bomImporter.keyColumns.includes(column) ? 'yes' : '', 'description' in spec ? (spec.description ?? '') : ''])
  }
  help.getRow(1).font = { bold: true }
  return { fileName: `${base}.xlsx`, contentType: SHEET_TYPES.xlsx, body: Buffer.from(await workbook.xlsx.writeBuffer()) }
}

// ---- the PDF ------------------------------------------------------------------------------------------------------------

const REGULAR = 'Helvetica'
const BOLD = 'Helvetica-Bold'
const TEXT = '#111111'
const MUTED = '#555555'
const RULE = '#9a9a9a'
const SHADE = '#ececec'
const MARGIN = { top: 36, bottom: 54, left: 36, right: 36 } as const
const FOOTER_TOP = 44

export async function renderBomPaper(paper: BomPaper): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: MARGIN,
    bufferPages: true,
    compress: true,
    lang: paper.language,
    displayTitle: true,
    info: { Title: winAnsi(paper.meta.title), Subject: winAnsi(paper.meta.subject), Creator: PDF_CREATOR, Producer: PDF_CREATOR, CreationDate: new Date(paper.meta.createdAt) },
  })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })

  const left = MARGIN.left
  const right = pdf.page.width - MARGIN.right
  const width = right - left
  const bottom = (): number => pdf.page.height - MARGIN.bottom
  const text = (value: string, x: number, y: number, options: PDFKit.Mixins.TextOptions & { font?: string; size?: number; color?: string } = {}): number => {
    const { font = REGULAR, size = 8, color = TEXT, ...rest } = options
    pdf.font(font).fontSize(size).fillColor(color).text(winAnsi(value), x, y, { lineGap: 1, ...rest })
    return pdf.y
  }
  const heightOf = (value: string, w: number, font = REGULAR, size = 8): number => pdf.font(font).fontSize(size).heightOfString(winAnsi(value), { width: w, lineGap: 1 })

  let y = text(paper.title, left, MARGIN.top, { font: BOLD, size: 14, width })
  y = text(paper.subtitle, left, y + 1, { size: 10, color: MUTED, width }) + 8
  const cellWidth = width / paper.facts.length
  const factsHeight = Math.max(...paper.facts.map((fact) => heightOf(fact.label, cellWidth - 8, REGULAR, 6.5) + heightOf(fact.value, cellWidth - 8, BOLD, 8.5))) + 7
  paper.facts.forEach((fact, index) => {
    const x = left + index * cellWidth
    pdf.save().rect(x, y, cellWidth, factsHeight).lineWidth(0.4).strokeColor(RULE).stroke().restore()
    const valueTop = text(fact.label, x + 4, y + 3, { size: 6.5, color: MUTED, width: cellWidth - 8 })
    text(fact.value, x + 4, valueTop + 1, { font: BOLD, size: 8.5, width: cellWidth - 8 })
  })
  y += factsHeight + 10

  const columns = paper.columns.map((column) => ({ ...column, width: (width * column.width) / 1000 }))
  const header = (at: number): number => {
    const height = Math.max(...columns.map((column) => heightOf(column.label, column.width - 6, BOLD, 7.5))) + 6
    pdf.save().rect(left, at, width, height).fillColor(SHADE).fill().restore()
    let x = left
    for (const column of columns) {
      text(column.label, x + 3, at + 3, { font: BOLD, size: 7.5, width: column.width - 6, align: column.align })
      x += column.width
    }
    return at + height
  }
  y = header(y)
  for (const row of paper.rows) {
    const height = Math.max(...row.map((cell, index) => heightOf(cell, columns[index]!.width - 6))) + 6
    if (y + height > bottom()) {
      pdf.addPage()
      y = header(text(`${paper.title} (${paper.footer.continued})`, left, MARGIN.top, { size: 8, color: MUTED, width }) + 6)
    }
    let x = left
    row.forEach((cell, index) => {
      const column = columns[index]!
      text(cell, x + 3, y + 3, { width: column.width - 6, align: column.align })
      x += column.width
    })
    y += height
    pdf.save().moveTo(left, y).lineTo(right, y).lineWidth(0.4).strokeColor(RULE).stroke().restore()
  }

  const range = pdf.bufferedPageRange()
  for (let index = range.start; index < range.start + range.count; index++) {
    pdf.switchToPage(index)
    const savedBottom = pdf.page.margins.bottom
    pdf.page.margins.bottom = 0
    const top = pdf.page.height - FOOTER_TOP
    pdf.save().moveTo(left, top).lineTo(right, top).lineWidth(0.4).strokeColor(RULE).stroke().restore()
    text(paper.meta.subject, left, top + 4, { size: 6.5, color: MUTED, width: width - 90 })
    text(pageLabel(paper.footer.page, index - range.start + 1, range.count), right - 86, top + 4, { size: 7.5, color: MUTED, width: 86, align: 'right' })
    pdf.page.margins.bottom = savedBottom
  }
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}
