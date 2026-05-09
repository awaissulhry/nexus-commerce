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
  // W9.2 fills in xlsx + pdf.
  throw new Error(`Renderer for ${input.format} not yet implemented`)
}

// Helpers exported for unit tests + the W9.2 renderer module.
export const _internal = { readPath, formatCell, csvCell }
