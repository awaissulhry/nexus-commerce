/**
 * W9.1 — Export renderer dispatch.
 *
 * Pure: no DB. Each renderer takes the rows + column-spec and
 * returns the encoded bytes. v0 ships CSV; XLSX / JSON / PDF land
 * in W9.2.
 */

export type ExportFormat = 'csv' | 'xlsx' | 'json' | 'pdf'

export interface ColumnSpec {
  /** Field id on the row. Resolves dot-paths
   *  (categoryAttributes.material). */
  id: string
  /** Header label rendered in the file's first row / column titles. */
  label: string
  /** Optional formatter token for renderers that care:
   *  'currency' → 2-decimal numeric for CSV; '€'-prefixed in PDF.
   *  'date' → ISO date stringification.
   *  Default = String coerce. */
  format?: 'currency' | 'date' | 'number' | 'text'
}

export interface RenderInput {
  format: ExportFormat
  columns: ColumnSpec[]
  rows: Record<string, unknown>[]
  /** Used by the XLSX renderer to name the sheet + the filename
   *  emitted on download. */
  filename: string
}

export interface RenderOutput {
  bytes: Uint8Array
  contentType: string
}

function readPath(row: Record<string, unknown>, path: string): unknown {
  if (path in row) return row[path]
  const idx = path.indexOf('.')
  if (idx > 0) {
    const head = path.slice(0, idx)
    const tail = path.slice(idx + 1)
    const inner = row[head]
    if (inner && typeof inner === 'object') {
      return (inner as Record<string, unknown>)[tail]
    }
  }
  return undefined
}

function formatCell(value: unknown, format: ColumnSpec['format']): string {
  if (value === null || value === undefined) return ''
  if (format === 'currency') {
    const n = typeof value === 'number' ? value : parseFloat(String(value))
    return Number.isFinite(n) ? n.toFixed(2) : ''
  }
  if (format === 'date') {
    if (value instanceof Date) return value.toISOString().slice(0, 10)
    const d = new Date(String(value))
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
  }
  if (format === 'number') {
    const n = typeof value === 'number' ? value : parseFloat(String(value))
    return Number.isFinite(n) ? String(n) : ''
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * RFC 4180 CSV cell encoder. Mirrors the same helper the W1.6
 * clipboard pipeline uses on the frontend so paste-into-Excel
 * roundtrips cleanly.
 */
function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"'
  }
  return value
}

function renderCsv(input: RenderInput): RenderOutput {
  const lines: string[] = []
  lines.push(input.columns.map((c) => csvCell(c.label)).join(','))
  for (const row of input.rows) {
    const cells = input.columns.map((c) =>
      csvCell(formatCell(readPath(row, c.id), c.format)),
    )
    lines.push(cells.join(','))
  }
  const text = lines.join('\n') + '\n'
  return {
    bytes: new TextEncoder().encode(text),
    contentType: 'text/csv',
  }
}

async function renderXlsx(input: RenderInput): Promise<RenderOutput> {
  // W9.2 — exceljs already a dep (used by W8.2 import parser).
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  // Excel sheet names: max 31 chars, no [ ] : * ? / \
  const safeSheet =
    (input.filename ?? 'Export')
      .slice(0, 31)
      .replace(/[\[\]:*?/\\]/g, '_') || 'Export'
  const ws = wb.addWorksheet(safeSheet)
  ws.addRow(input.columns.map((c) => c.label))
  ws.getRow(1).font = { bold: true }
  for (const row of input.rows) {
    ws.addRow(input.columns.map((c) => readPath(row, c.id) ?? ''))
  }
  // Tighten column widths against header label so a 200-row export
  // doesn't open with everything jammed against column A.
  input.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1)
    col.width = Math.max(c.label.length + 2, 10)
  })
  const buffer = await wb.xlsx.writeBuffer()
  return {
    bytes: new Uint8Array(buffer as ArrayBuffer),
    contentType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
}

async function renderPdf(input: RenderInput): Promise<RenderOutput> {
  // W9.2 — pdfkit already a dep (used by F1.8 customs declaration).
  const PDFKitMod = await import('pdfkit')
  const PDFKit = (PDFKitMod as any).default ?? PDFKitMod
  const doc = new PDFKit({ size: 'A4', margin: 36, layout: 'landscape' })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done: Promise<Buffer> = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', (err: Error) => reject(err))
  })

  doc
    .fontSize(14)
    .text(input.filename ?? 'Export', { align: 'left' })
    .moveDown(0.25)
    .fontSize(9)
    .fillColor('#666')
    .text(`${input.rows.length} rows · ${new Date().toISOString().slice(0, 10)}`)
    .moveDown(0.5)
    .fillColor('#000')

  const PAGE_WIDTH =
    doc.page.width - doc.page.margins.left - doc.page.margins.right
  const colWidth = PAGE_WIDTH / Math.max(input.columns.length, 1)
  const rowHeight = 16

  function drawHeader(y: number) {
    doc.fontSize(8).font('Helvetica-Bold')
    input.columns.forEach((c, i) => {
      doc.text(c.label, doc.page.margins.left + i * colWidth, y, {
        width: colWidth - 4,
        ellipsis: true,
      })
    })
    doc.font('Helvetica')
  }

  drawHeader(doc.y)
  doc.moveDown(0.6)
  for (const row of input.rows) {
    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage()
      drawHeader(doc.y)
      doc.moveDown(0.6)
    }
    const y = doc.y
    input.columns.forEach((c, i) => {
      const cell = formatCell(readPath(row, c.id), c.format)
      doc.text(cell, doc.page.margins.left + i * colWidth, y, {
        width: colWidth - 4,
        ellipsis: true,
      })
    })
    doc.moveDown(0.4)
  }
  doc.end()
  const buffer = await done
  return {
    bytes: new Uint8Array(buffer),
    contentType: 'application/pdf',
  }
}

export async function renderExport(input: RenderInput): Promise<RenderOutput> {
  if (input.format === 'csv') return renderCsv(input)
  if (input.format === 'json') {
    const out = input.rows.map((row) => {
      const o: Record<string, unknown> = {}
      for (const c of input.columns) {
        o[c.id] = readPath(row, c.id) ?? null
      }
      return o
    })
    return {
      bytes: new TextEncoder().encode(JSON.stringify(out, null, 2)),
      contentType: 'application/json',
    }
  }
  if (input.format === 'xlsx') return renderXlsx(input)
  if (input.format === 'pdf') return renderPdf(input)
  throw new Error(`Renderer for ${input.format} not yet implemented`)
}

// Helpers exported for unit tests + the W9.2 renderer module.
export const _internal = { readPath, formatCell, csvCell }
