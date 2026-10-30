import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'
import type { FactoryClient } from '@nexus/factory-db'
import { fromMinorUnits, minorPlaces } from '@nexus/factory-domain/core/money'
import { pageLabel } from '@nexus/factory-domain/documents/compose'
import { legalFooter, legalLines, legalName } from '@nexus/factory-domain/documents/legal'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import {
  COUNT_PAPER_WORDS,
  countSheetPaper,
  valuedList,
  valuedListPaper,
  valuedListRows,
  type CountPaper,
  type PaperCompany,
  type PaperCount,
  type SheetCell,
  type ValuedList,
} from '@nexus/factory-domain/inventory/counts/documents'
import { finalCount } from '@nexus/factory-domain/inventory/counts/rules'
import type { ValuationMethod } from '@nexus/factory-domain/inventory/ledger/valuation'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { companyLegalOf } from '../../../platform/documents/documents'
import { PDF_CREATOR, winAnsi } from '../../../platform/documents/pdf'
import { siteLocations, unitCostOf, unitCostsOf } from './ledger-at'
import { readLines, type CountRow } from './store'
import { factsOf } from './views'

/**
 * The counts' papers (B-W2a-15; design warehouse.counts cn-tab-sheets, cn-tab-valued): the count sheets (PDF, with or
 * without the expected quantities) and the year-end valued list (PDF and XLSX), composed by factory-domain
 * inventory/counts/documents and painted here on A4 landscape with pdfkit's standard fonts (the documents platform's
 * WinAnsi rule), the company's art. 2250 lines at the top and on every page. The sheets and a valued list before the
 * sign-off are made on request and stored nowhere; the sign-off stores its list as files of the count.
 */

type Client = FactoryClient | CommandTx

const REGULAR = 'Helvetica'
const BOLD = 'Helvetica-Bold'
const TEXT = '#111111'
const MUTED = '#555555'
const RULE = '#9a9a9a'
const SHADE = '#ececec'
const MARGIN = { top: 36, bottom: 54, left: 36, right: 36 } as const
const FOOTER_TOP = 44

export async function renderCountPaper(paper: CountPaper): Promise<Buffer> {
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
  paint(pdf, paper)
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}

function paint(pdf: PDFKit.PDFDocument, paper: CountPaper): void {
  const left = MARGIN.left
  const right = pdf.page.width - MARGIN.right
  const width = right - left
  const bottom = (): number => pdf.page.height - MARGIN.bottom
  const text = (value: string, x: number, y: number, options: PDFKit.Mixins.TextOptions & { font?: string; size?: number; color?: string } = {}): number => {
    const { font = REGULAR, size = 8.5, color = TEXT, ...rest } = options
    pdf.font(font).fontSize(size).fillColor(color).text(winAnsi(value), x, y, { lineGap: 1, ...rest })
    return pdf.y
  }
  const heightOf = (value: string, w: number, font = REGULAR, size = 8.5): number => pdf.font(font).fontSize(size).heightOfString(winAnsi(value), { width: w, lineGap: 1 })

  const companyWidth = Math.round(width * 0.55)
  let y: number = MARGIN.top
  y = text(paper.issuer.name, left, y, { font: BOLD, size: 12, width: companyWidth })
  for (const line of paper.issuer.lines) y = text(line, left, y + 0.5, { size: 7.5, color: MUTED, width: companyWidth })
  const identityLeft = left + companyWidth + 12
  const identityWidth = right - identityLeft
  let identityY = text(paper.title, identityLeft, MARGIN.top, { font: BOLD, size: 14, width: identityWidth, align: 'right' })
  identityY = text(paper.number, identityLeft, identityY + 2, { size: 11, width: identityWidth, align: 'right' })
  y = Math.max(y, identityY) + 8

  if (paper.banner) {
    const height = heightOf(paper.banner, width - 12, BOLD, 10) + 10
    pdf.save().rect(left, y, width, height).fillColor('#fde8e8').fill().restore()
    text(paper.banner, left + 6, y + 5, { font: BOLD, size: 10, color: '#a40000', width: width - 12, align: 'center' })
    y += height + 6
  }

  // The facts, four per row.
  const perRow = 4
  const cellWidth = width / perRow
  for (let start = 0; start < paper.facts.length; start += perRow) {
    const row = paper.facts.slice(start, start + perRow)
    const height = Math.max(...row.map((fact) => heightOf(fact.label, cellWidth - 8, REGULAR, 6.5) + heightOf(fact.value, cellWidth - 8, BOLD, 8.5))) + 7
    row.forEach((fact, index) => {
      const x = left + index * cellWidth
      pdf.save().rect(x, y, cellWidth, height).lineWidth(0.4).strokeColor(RULE).stroke().restore()
      const valueTop = text(fact.label, x + 4, y + 3, { size: 6.5, color: MUTED, width: cellWidth - 8 })
      text(fact.value, x + 4, valueTop + 1, { font: BOLD, size: 8.5, width: cellWidth - 8 })
    })
    y += height
  }
  y += 8

  const columns = paper.table.columns.map((column) => ({ ...column, width: (width * column.width) / 1000 }))
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
  const newPage = (): number => {
    pdf.addPage()
    return text(`${paper.issuer.name} · ${paper.title} ${paper.number} (${paper.footer.continued})`, left, MARGIN.top, { size: 8, color: MUTED, width }) + 6
  }
  y = header(y)
  for (const row of paper.table.rows) {
    // Room to write a count by hand: at least 16 points a row.
    const height = Math.max(16, ...row.map((cell, index) => heightOf(cell, columns[index]!.width - 6, REGULAR, 8))) + 4
    if (y + height > bottom()) y = header(newPage())
    let x = left
    row.forEach((cell, index) => {
      const column = columns[index]!
      text(cell, x + 3, y + 3, { size: 8, width: column.width - 6, align: column.align })
      x += column.width
    })
    y += height
    pdf.save().moveTo(left, y).lineTo(right, y).lineWidth(0.4).strokeColor(RULE).stroke().restore()
  }
  y += 8

  if (paper.totals.length > 0) {
    const boxWidth = 300
    const boxLeft = right - boxWidth
    if (y + paper.totals.length * 14 > bottom()) y = newPage()
    for (const total of paper.totals) {
      const font = total.strong ? BOLD : REGULAR
      text(total.label, boxLeft, y, { font, size: 8.5, width: boxWidth - 120 })
      text(total.value, boxLeft + boxWidth - 120, y, { font, size: 8.5, width: 120, align: 'right' })
      y += 14
      if (total.strong) pdf.save().moveTo(boxLeft, y - 2).lineTo(right, y - 2).lineWidth(0.4).strokeColor(RULE).stroke().restore()
    }
    y += 6
  }
  for (const note of paper.notes) {
    if (y + heightOf(note, width, REGULAR, 8) > bottom()) y = newPage()
    y = text(note, left, y, { size: 8, color: MUTED, width }) + 4
  }
  if (paper.signatures.length > 0) {
    const gap = 24
    const boxWidth = Math.min(240, (width - gap * (paper.signatures.length - 1)) / paper.signatures.length)
    if (y + 56 > bottom()) y = newPage()
    paper.signatures.forEach((caption, index) => {
      const x = left + index * (boxWidth + gap)
      pdf.save().moveTo(x, y + 36).lineTo(x + boxWidth, y + 36).lineWidth(0.6).strokeColor(TEXT).stroke().restore()
      text(caption, x, y + 40, { size: 7.5, color: MUTED, width: boxWidth, align: 'center' })
    })
  }

  const range = pdf.bufferedPageRange()
  for (let index = range.start; index < range.start + range.count; index++) {
    pdf.switchToPage(index)
    const savedBottom = pdf.page.margins.bottom
    pdf.page.margins.bottom = 0
    const top = pdf.page.height - FOOTER_TOP
    pdf.save().moveTo(left, top).lineTo(right, top).lineWidth(0.4).strokeColor(RULE).stroke().restore()
    text(paper.footer.legal, left, top + 4, { size: 6.5, color: MUTED, width: width - 90 })
    text(pageLabel(paper.footer.page, index - range.start + 1, range.count), right - 86, top + 4, { size: 7.5, color: MUTED, width: 86, align: 'right' })
    pdf.page.margins.bottom = savedBottom
  }
}

// ---- what the papers print ------------------------------------------------------------------------------------------------

async function companyOf(caller: CommandCaller, companyId: string, language: DocumentLanguage): Promise<PaperCompany & { currency: string }> {
  const legal = await companyLegalOf(caller, companyId)
  return { name: legalName(legal, language), lines: legalLines(legal, language), legal: legalFooter(legal, language), currency: legal.currency }
}

/** The count's header in the paper's words: its site and its scope. */
async function paperCountOf(client: Client, row: CountRow, language: DocumentLanguage): Promise<PaperCount> {
  const site = await client.site.findUnique({ where: { id: row.siteId }, select: { code: true, name: true } })
  const parts: string[] = []
  if (row.locationId) {
    const location = (await siteLocations(client, row.siteId)).get(row.locationId)
    parts.push(language === 'it' ? `${location?.path ?? ''} (e sottostanti)` : `${location?.path ?? ''} (and below)`)
  }
  if (row.itemId) {
    const item = await client.item.findUnique({ where: { id: row.itemId }, select: { code: true } })
    parts.push(item?.code ?? '')
  }
  if (row.lotId) {
    const lot = await client.lot.findUnique({ where: { id: row.lotId }, select: { code: true } })
    parts.push(`${language === 'it' ? 'lotto' : 'lot'} ${lot?.code ?? ''}`)
  }
  if (row.itemKind) parts.push(row.itemKind)
  return {
    number: row.number,
    kind: row.kind,
    site: site ? `${site.code} · ${site.name}` : '',
    scope: parts.length > 0 ? parts.join(' · ') : null,
    countTeam: row.countTeam,
    snapshotAt: row.snapshotAt,
    inventoryDate: row.inventoryDate ? row.inventoryDate.toISOString().slice(0, 10) : null,
  }
}

/** The count sheets' PDF: every line in walking order, with or without what the ledger expects. */
export async function countSheetsPdf(caller: CommandCaller, row: CountRow, options: { readonly withExpected: boolean; readonly language: DocumentLanguage; readonly at: Date }): Promise<{ pdf: Buffer; fileName: string }> {
  const company = await companyOf(caller, row.companyId, options.language)
  const { count, lines } = await caller.withClient(async (client) => {
    const lineRows = await readLines(client, row.id)
    const ids = (pick: (line: (typeof lineRows)[number]) => string | null) => [...new Set(lineRows.map(pick).filter((id): id is string => id !== null))]
    const items = new Map((await client.item.findMany({ where: { id: { in: ids((line) => line.itemId) } }, select: { id: true, code: true, name: true, baseUom: true } })).map((item) => [item.id, item]))
    const colours = new Map((await client.itemColour.findMany({ where: { id: { in: ids((line) => line.itemColourId) } }, select: { id: true, code: true } })).map((colour) => [colour.id, colour.code]))
    const lots = new Map((await client.lot.findMany({ where: { id: { in: ids((line) => line.lotId) } }, select: { id: true, code: true } })).map((lot) => [lot.id, lot.code]))
    const hides = new Map((await client.hide.findMany({ where: { id: { in: ids((line) => line.hideId) } }, select: { id: true, code: true } })).map((hide) => [hide.id, hide.code]))
    const locations = await siteLocations(client, row.siteId)
    return {
      count: await paperCountOf(client, row, options.language),
      lines: lineRows.map((line) => ({
        seq: line.seq,
        location: locations.get(line.locationId)?.code ?? '',
        itemCode: items.get(line.itemId)?.code ?? '',
        itemName: items.get(line.itemId)?.name ?? '',
        colour: line.itemColourId ? (colours.get(line.itemColourId) ?? null) : null,
        lot: line.lotId ? (lots.get(line.lotId) ?? null) : null,
        hide: line.hideId ? (hides.get(line.hideId) ?? null) : null,
        expected: line.expectedQuantity.toString(),
        uom: items.get(line.itemId)?.baseUom ?? '',
      })),
    }
  })
  const paper = countSheetPaper(count, lines, company, options)
  const words = COUNT_PAPER_WORDS[options.language]
  return { pdf: await renderCountPaper(paper), fileName: `${words.sheetTitle} ${row.number}.pdf` }
}

/**
 * The valued list of a count from its lines: what each line ended at (the recount, else the count; after the apply, the
 * ledger at the snapshot inside the scope), at the unit cost the ledger had by the snapshot.
 */
export async function valuedListOf(client: Client, row: CountRow, companyCurrency: string): Promise<ValuedList> {
  const lines = await readLines(client, row.id)
  const ids = (pick: (line: (typeof lines)[number]) => string | null) => [...new Set(lines.map(pick).filter((id): id is string => id !== null))]
  const items = new Map((await client.item.findMany({ where: { id: { in: ids((line) => line.itemId) } }, select: { id: true, code: true, name: true, kind: true, baseUom: true } })).map((item) => [item.id, item]))
  const colours = new Map((await client.itemColour.findMany({ where: { id: { in: ids((line) => line.itemColourId) } }, select: { id: true, code: true } })).map((colour) => [colour.id, colour.code]))
  const lots = new Map((await client.lot.findMany({ where: { id: { in: ids((line) => line.lotId) } }, select: { id: true, code: true } })).map((lot) => [lot.id, lot.code]))
  const costs = await unitCostsOf(client, row.siteId, lines, row.snapshotAt)
  return valuedList(
    lines.map((line) => {
      const item = items.get(line.itemId)
      const cost = unitCostOf(costs, line)
      return {
        itemId: line.itemId,
        itemCode: item?.code ?? '',
        itemName: item?.name ?? '',
        itemKind: item?.kind ?? '',
        uom: item?.baseUom ?? '',
        colour: line.itemColourId ? (colours.get(line.itemColourId) ?? null) : null,
        lotId: line.lotId,
        lot: line.lotId ? (lots.get(line.lotId) ?? null) : null,
        hideId: line.hideId,
        quantity: (finalCount(factsOf(line)) ?? line.expectedQuantity).toString(),
        unitCost: cost.unitCost,
        method: cost.method as ValuationMethod | null,
        currency: cost.currency,
      }
    }),
    companyCurrency,
  )
}

export interface ValuedListFiles {
  readonly list: ValuedList
  readonly pdf: Buffer
  readonly sheet: Buffer
  readonly pdfName: string
  readonly sheetName: string
}

/** The valued list's PDF and spreadsheet (a preview carries a banner and is stored nowhere). */
export async function valuedListFiles(
  caller: CommandCaller,
  row: CountRow,
  options: { readonly language: DocumentLanguage; readonly preview: boolean; readonly signedOff: { readonly at: Date; readonly by: string } | null; readonly at: Date },
): Promise<ValuedListFiles> {
  const company = await companyOf(caller, row.companyId, options.language)
  const { count, list } = await caller.withClient(async (client) => ({ count: await paperCountOf(client, row, options.language), list: await valuedListOf(client, row, company.currency) }))
  const paper = valuedListPaper(count, list, company, options)
  const words = COUNT_PAPER_WORDS[options.language]
  return {
    list,
    pdf: await renderCountPaper(paper),
    sheet: await valuedListWorkbook(valuedListRows(list, options.language), `${words.listTitle} ${row.number}`, options.at),
    pdfName: `${words.listTitle} ${row.number}${options.preview ? ' (preview)' : ''}.pdf`,
    sheetName: `${words.listTitle} ${row.number}${options.preview ? ' (preview)' : ''}.xlsx`,
  }
}

/**
 * The valued list as a workbook: quantities and amounts as numbers in their cells (four decimals, the currency's
 * minor places), so the accounts can sum them; the PDF is the list as signed. A decimal becomes a spreadsheet number only
 * here, at the file's edge (Decimal(18,4) and Int amounts fit a double exactly as printed).
 */
async function valuedListWorkbook(rows: readonly SheetCell[][], title: string, at: Date): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = PDF_CREATOR
  workbook.created = at
  workbook.modified = at
  const sheet = workbook.addWorksheet(title.slice(0, 31).replace(/[\\/*?:[\]]/g, '-'))
  for (const row of rows) {
    const added = sheet.addRow(
      row.map((cell) => {
        if (cell === null || typeof cell === 'string') return cell
        if ('quantity' in cell) return Number(cell.quantity)
        if ('unitCost' in cell) return Number(cell.unitCost)
        return Number(fromMinorUnits(cell.minor, cell.currency).toFixed(minorPlaces(cell.currency)))
      }),
    )
    row.forEach((cell, index) => {
      if (cell === null || typeof cell === 'string') return
      added.getCell(index + 1).numFmt = 'quantity' in cell ? '0.0000' : 'unitCost' in cell ? '0.000000' : `0.${'0'.repeat(minorPlaces(cell.currency))}`
    })
  }
  sheet.getRow(1).font = { bold: true }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}
