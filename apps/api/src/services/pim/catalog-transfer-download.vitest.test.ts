import { afterEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import type { TransferRow } from '@nexus/shared/catalog-transfer'
import * as workbook from './catalog-transfer-file.js'
import { writeTransferDownload } from './catalog-transfer-download.js'

const row = (sku: string, field: string, extra: Partial<TransferRow> = {}): TransferRow => ({ row: 0, entity: 'Products', sku, channel: '', accountId: '', marketplace: '', aliasKey: '', locale: '', field, action: 'SET', value: '00123', ...extra })
async function* products(groups: TransferRow[][]) { yield* groups }
async function bytes(data: Buffer | NodeJS.ReadableStream) {
  if (Buffer.isBuffer(data)) return data
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    data.on('data', chunk => chunks.push(Buffer.from(chunk)))
    data.once('error', reject)
    data.once('end', () => resolve(Buffer.concat(chunks)))
  })
}
afterEach(() => vi.restoreAllMocks())

describe('catalog download batching', () => {
  it('keeps a small export as an ordinary importable workbook', async () => {
    const rows = [row('SKU', 'name'), row('SKU', 'material', { value: ['Cotton', 'Linen'] }), row('SKU', 'flag', { value: false })]
    const result = await writeTransferDownload(products([rows]))
    expect(result.filename).toBe('nexus-catalog-editing.xlsx')
    const parsed = await workbook.readTransferFile(await bytes(result.data), result.filename)
    expect(parsed.issues).toEqual([])
    expect(parsed.rows.map(r => r.value)).toEqual(rows.map(r => r.value))
  })

  it('exports more than 50,000 attribute rows without dropping or splitting a product', async () => {
    const groups = ['A', 'B'].map((sku, i) => Array.from({ length: 25_000 + i }, (_, field) => row(sku, `attribute_${field}`)))
    const result = await writeTransferDownload(products(groups))
    expect(result.filename).toBe('nexus-catalog-editing.zip')
    expect(result.contentType).toBe('application/zip')
    const zip = await JSZip.loadAsync(await bytes(result.data))
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
    expect(manifest).toMatchObject({ productCount: 2, attributeRows: 50_001 })
    expect(manifest.files).toHaveLength(2)
    let count = 0
    for (const [index, file] of manifest.files.entries()) {
      const data = await zip.file(file.filename)!.async('nodebuffer')
      expect(data.length).toBeLessThanOrEqual(workbook.TRANSFER_MAX_FILE_BYTES)
      const parsed = await workbook.readTransferFile(data, file.filename)
      expect(parsed.issues).toEqual([])
      expect(parsed.rows.length).toBeLessThanOrEqual(workbook.TRANSFER_MAX_ROWS)
      expect(parsed.rows.map(r => [r.sku, r.field, r.value])).toEqual(groups[index].map(r => [r.sku, r.field, r.value]))
      count += parsed.rows.length
    }
    expect(count).toBe(50_001)
    expect(await zip.file('README.txt')!.async('string')).toContain('each XLSX separately')
  }, 60_000)

  it('automatically creates another workbook after 500 products instead of refusing the selection', async () => {
    const result = await writeTransferDownload(products(Array.from({ length: 501 }, (_, i) => [row(`SKU-${i}`, 'name')])))
    const zip = await JSZip.loadAsync(await bytes(result.data))
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
    expect(manifest.productCount).toBe(501)
    expect(manifest.files.map((file: { productCount: number }) => file.productCount)).toEqual([500, 1])
  })

  it('splits a workbook by product when encoded file size exceeds the import limit', async () => {
    const original = workbook.writeTransferWorkbook
    vi.spyOn(workbook, 'writeTransferWorkbook').mockImplementation(async (rows, dictionary, effective) => {
      if (new Set(rows.map(r => r.sku)).size > 1) throw new workbook.TransferWorkbookLimitError('bytes')
      return original(rows, dictionary, effective)
    })
    const result = await writeTransferDownload(products([[row('A', 'name')], [row('B', 'name')]]))
    const zip = await JSZip.loadAsync(await bytes(result.data))
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
    expect(manifest.files.map((file: { skus: string[] }) => file.skus)).toEqual([['A'], ['B']])
  })

  it('keeps a listing category and its override in the same file when an oversized product must split', async () => {
    const original = workbook.writeTransferWorkbook
    vi.spyOn(workbook, 'writeTransferWorkbook').mockImplementation(async (rows, dictionary, effective) => {
      if (rows.length > 2) throw new workbook.TransferWorkbookLimitError('bytes')
      return original(rows, dictionary, effective)
    })
    const channel = { channel: 'AMAZON', accountId: 'account-a', marketplace: 'IT', aliasKey: 'alias-a', version: 7 }
    const result = await writeTransferDownload(products([[
      row('A', 'name'),
      row('A', 'productType', { ...channel, entity: 'Listings', value: 'OUTERWEAR' }),
      row('A', 'item_name', { ...channel, entity: 'Overrides', action: 'INHERIT', value: undefined }),
    ]]))
    const zip = await JSZip.loadAsync(await bytes(result.data))
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
    const listingFile = manifest.files[1].filename
    const parsed = await workbook.readTransferFile(await zip.file(listingFile)!.async('nodebuffer'), listingFile)
    expect(parsed.rows.map(r => r.entity)).toEqual(['Listings', 'Overrides'])
    expect(parsed.rows.every(r => r.accountId === 'account-a' && r.aliasKey === 'alias-a' && r.version === 7)).toBe(true)
    expect(parsed.rows[1].action).toBe('INHERIT')
  })

  it('refuses a single oversized record instead of generating imports that invalidate one another', async () => {
    vi.spyOn(workbook, 'writeTransferWorkbook').mockRejectedValue(new workbook.TransferWorkbookLimitError('bytes'))
    await expect(writeTransferDownload(products([[row('A', 'name'), row('A', 'description')]]))).rejects.toThrow('cannot be split safely')
  })

  it('does not disguise unrelated workbook errors as a batch limit', async () => {
    vi.spyOn(workbook, 'writeTransferWorkbook').mockRejectedValue(new Error('serialization failure'))
    await expect(writeTransferDownload(products([[row('A', 'name')], [row('B', 'name')]]))).rejects.toThrow('serialization failure')
  })

  it('marks effective exports as review-only in every batch', async () => {
    const result = await writeTransferDownload(products(Array.from({ length: 501 }, (_, i) => [row(`SKU-${i}`, 'name')])), true)
    expect(result.filename).toBe('nexus-catalog-effective.zip')
    const zip = await JSZip.loadAsync(await bytes(result.data))
    expect(await zip.file('README.txt')!.async('string')).toContain('cannot be imported')
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
    const file = manifest.files[0].filename
    const parsed = await workbook.readTransferFile(await zip.file(file)!.async('nodebuffer'), file)
    expect(parsed.rows).toEqual([])
  })
})
