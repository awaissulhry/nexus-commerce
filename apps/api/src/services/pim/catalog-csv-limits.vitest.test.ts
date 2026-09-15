import { describe, expect, it } from 'vitest'
import { readSourceFile } from './catalog-source-file.js'
import { readTransferFile, TRANSFER_MAX_FILE_BYTES, TRANSFER_MAX_ROWS } from './catalog-transfer-file.js'

const csv = (rows: string[][]) => Buffer.from(rows.map(row => row.map(value => `"${value.replace(/"/g, '""')}"`).join(',')).join('\r\n'))

describe('catalog CSV size boundaries', () => {
  it('preserves a wide source row above 256 KB with individually valid cells', async () => {
    const value = '<p>Text, with "quotes"\r\nand newlines.</p>'.repeat(5000)
    const input = csv([['SKU', 'Description', 'Details'], ['0001', value, value]])
    expect(input.length).toBeGreaterThan(256_000)
    expect(await readSourceFile(input, 'source.csv')).toEqual({
      headers: ['SKU', 'Description', 'Details'], records: [{ SKU: '0001', Description: value, Details: value }],
    })
  })

  it('counts source cell characters separately from UTF-8 record bytes', async () => {
    const value = 'é漢🙂'.repeat(40_000)
    expect(value.length).toBeLessThan(256_000)
    expect(Buffer.byteLength(value)).toBeGreaterThan(256_000)
    expect((await readSourceFile(csv([['SKU', 'Description'], ['0001', value]]), 'unicode.csv')).records[0].Description).toBe(value)
  })

  it('preserves an attribute value above 256 KB in editing CSVs', async () => {
    const value = '<p>Long, "quoted" description.</p>\r\n'.repeat(10_000)
    const parsed = await readTransferFile(csv([
      ['entity', 'sku', 'field', 'action', 'value', 'version'],
      ['Products', '0001', 'description', 'SET', value, '3'],
    ]), 'editing.csv')
    expect(parsed.issues).toEqual([])
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0]).toMatchObject({ sku: '0001', field: 'description', value, version: 3 })
  })

  it('accepts an editing CSV exactly at the file limit', async () => {
    const prefix = 'entity,sku,field,action,value\nProducts,0001,description,SET,'
    const value = 'x'.repeat(TRANSFER_MAX_FILE_BYTES - Buffer.byteLength(prefix))
    const parsed = await readTransferFile(Buffer.from(prefix + value), 'limit.csv')
    expect(parsed.issues).toEqual([])
    expect(parsed.rows[0].value).toBe(value)
  })

  it.each([['source', readSourceFile], ['editing', readTransferFile]] as const)('rejects %s files above 10 MB before parsing', async (_name, read) => {
    await expect(read(Buffer.alloc(TRANSFER_MAX_FILE_BYTES + 1, 'x'), 'too-large.csv')).rejects.toThrow('10 MB')
  })

  it('reports the source cell limit without leaking the parser record-size error', async () => {
    await expect(readSourceFile(csv([['SKU', 'Description'], ['0001', 'x'.repeat(256_001)]]), 'cell.csv'))
      .rejects.toThrow('A source cell exceeds 256,000 characters')
  })

  it('retains source row and column limits', async () => {
    await expect(readSourceFile(Buffer.from('SKU\n' + '0001\n'.repeat(TRANSFER_MAX_ROWS + 1)), 'rows.csv')).rejects.toThrow('50,000 rows')
    await expect(readSourceFile(csv([Array.from({ length: 201 }, (_, i) => `column${i}`)]), 'columns.csv')).rejects.toThrow('1–200')
  })

  it.each([['source', readSourceFile], ['editing', readTransferFile]] as const)('continues rejecting malformed %s CSV quoting', async (_name, read) => {
    await expect(read(Buffer.from('sku,value\n0001,"unfinished'), 'broken.csv')).rejects.toThrow('Quote Not Closed')
  })
})
