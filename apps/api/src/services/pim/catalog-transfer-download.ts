import JSZip from 'jszip'
import { transferTargetKey, type TransferRow } from '@nexus/shared/catalog-transfer'
import { TRANSFER_MAX_ROWS, TransferWorkbookLimitError, writeTransferWorkbook } from './catalog-transfer-file.js'
import { checkWorkbookSize } from './catalog-source-file.js'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const MAX_PRODUCTS_PER_WORKBOOK = 500

/** Prefer whole products. Only an oversized product is split at its independent listing targets. */
function targetGroups(rows: TransferRow[]) {
  const groups = new Map<string, TransferRow[]>()
  for (const row of rows) {
    const key = transferTargetKey(row)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }
  return [...groups.values()]
}

/** Consume bounded product batches and return one workbook, or numbered importable workbooks. */
export async function writeTransferDownload(products: AsyncIterable<TransferRow[]>, effective = false, writer?: (rows: TransferRow[]) => Promise<Buffer>, productEditor = false) {
  const base = `nexus-catalog-${effective ? 'effective' : 'editing'}`
  const parts: { data: Buffer; rows: number; skus: string[] }[] = []
  const allSkus = new Set<string>()
  let pending: TransferRow[][] = [], count = 0
  let totalRows = 0, totalBytes = 0, expandedBytes = 0

  const append = async (groups: TransferRow[][]): Promise<void> => {
    const rows = groups.flat()
    try {
      const data = await (writer ? writer(rows) : writeTransferWorkbook(rows, [], effective))
      let expanded = 0
      if (productEditor) {
        try { expanded = await checkWorkbookSize(data) } catch (e) {
          if (e instanceof Error && e.message.startsWith('Expanded workbook')) throw new TransferWorkbookLimitError('rows')
          throw e
        }
      }
      expandedBytes += expanded
      if (productEditor && expandedBytes > 128 * 1024 * 1024) throw new Error('This workbook batch expands beyond the import limit. Choose fewer products, destinations or attributes.')
      totalBytes += data.length
      if (productEditor && (totalBytes > 49 * 1024 * 1024 || parts.length >= 50)) throw new Error('This editing export exceeds the complete ZIP import limit. Choose fewer products, destinations or attributes.')
      const skus = [...new Set(rows.map(row => row.sku))]
      skus.forEach(sku => allSkus.add(sku))
      parts.push({ data, rows: rows.length, skus })
    } catch (error) {
      if (!(error instanceof TransferWorkbookLimitError)) throw error
      const smaller = groups.length > 1 ? groups : targetGroups(groups[0])
      if (smaller.length < 2) throw new Error(`${rows[0]?.sku ?? 'This product'}: one product or listing record exceeds the ${error.limit === 'rows' ? '50,000 attribute row' : '10 MB'} workbook limit. Its fields cannot be split safely across imports.`)
      const middle = Math.ceil(smaller.length / 2)
      await append(smaller.slice(0, middle))
      await append(smaller.slice(middle))
    }
  }

  for await (const rows of products) {
    if (!rows.length) continue
    totalRows += rows.length
    if (productEditor && totalRows > 250_000) throw new Error('Export at most 250,000 attribute values for one product import. Choose fewer products, destinations or attributes.')
    if (pending.length && (count + rows.length > TRANSFER_MAX_ROWS || pending.length >= MAX_PRODUCTS_PER_WORKBOOK)) {
      await append(pending)
      pending = []; count = 0
    }
    pending.push(rows); count += rows.length
  }
  if (pending.length) await append(pending)
  if (!parts.length) await append([])
  if (parts.length === 1) return { data: parts[0].data, filename: `${base}.xlsx`, contentType: XLSX }

  const zip = new JSZip()
  const manifest = parts.map((part, index) => {
    const filename = `${base}-${String(index + 1).padStart(3, '0')}.xlsx`
    zip.file(filename, part.data)
    return { filename, attributeRows: part.rows, productCount: part.skus.length, skus: part.skus }
  })
  zip.file('manifest.json', JSON.stringify({ formatVersion: 1, purpose: effective ? 'effective' : 'editing', productCount: allSkus.size, attributeRows: parts.reduce((total, part) => total + part.rows, 0), files: manifest }, null, 2))
  zip.file('README.txt', [
    `Nexus catalog ${effective ? 'review' : 'editing'} export — ${parts.length} workbooks.`,
    'Your complete selection is included. Each workbook contains at most 50,000 attribute rows and is at most 10 MB.',
    effective ? 'Effective values are for review only. They cannot be imported.' : productEditor ? 'Edit the XLSX parts, keep every part and manifest.json in this ZIP, then upload the complete ZIP to this product editor. All parts are reviewed together.' : 'Extract this ZIP, edit the workbooks, then preview and apply each XLSX separately in Catalog import & export.',
    effective ? '' : 'For an existing catalog, choose Update. Keep SKU, account, marketplace, alias and version cells intact.',
    effective ? '' : productEditor ? 'Edit value cells directly. Blank or unchanged cells preserve data. Unhide action columns for explicit SET, CLEAR or INHERIT. Return this export within 30 days.' : 'Keep SET, CLEAR and INHERIT actions unchanged unless you intend to change that value or its inheritance.',
    'Products are kept together wherever possible. An oversized product can occupy multiple files; a single product or listing record is never split.',
    'manifest.json lists the workbooks, SKUs and row counts. No rows are truncated.',
  ].filter(Boolean).join('\r\n'))
  // XLSX is already compressed. Stream the outer ZIP without a second full archive buffer.
  return { data: zip.generateNodeStream({ streamFiles: true, compression: 'STORE' }), filename: `${base}.zip`, contentType: 'application/zip' }
}
