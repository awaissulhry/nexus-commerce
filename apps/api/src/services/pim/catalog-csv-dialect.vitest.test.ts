import { describe, expect, it } from 'vitest'
import { readSourceFile } from './catalog-source-file.js'
import { readTransferFile } from './catalog-transfer-file.js'

const HEADER = ['entity', 'sku', 'field', 'action', 'value', 'version']
const editing = (separator: string, value: string, prefix = '') =>
  Buffer.from(prefix + [HEADER.join(separator), ['Products', 'GALE-JACKET', 'name', 'SET', value, '3'].join(separator)].join('\r\n'))

describe('catalog CSV dialects', () => {
  // The reported failure: a spreadsheet saved the editing CSV with ";", so the header parsed as one
  // column and the first comma inside a value became a second cell — "expect 1, got 2 on line 2".
  it('imports a semicolon-separated editing CSV whose value contains a comma', async () => {
    const parsed = await readTransferFile(editing(';', 'Gale jacket, blue'), 'editing.csv')
    expect(parsed.issues).toEqual([])
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0]).toMatchObject({ sku: 'GALE-JACKET', field: 'name', value: 'Gale jacket, blue', version: 3 })
  })

  it('reads that same file as a source table', async () => {
    const table = await readSourceFile(editing(';', 'Gale jacket, blue'), 'source.csv')
    expect(table.headers).toEqual(HEADER)
    expect(table.records).toEqual([{ entity: 'Products', sku: 'GALE-JACKET', field: 'name', action: 'SET', value: 'Gale jacket, blue', version: '3' }])
  })

  it('imports a tab-separated editing CSV', async () => {
    expect((await readTransferFile(editing('\t', 'Gale jacket, blue'), 'editing.csv')).rows[0].value).toBe('Gale jacket, blue')
  })

  it.each([';', ','])('consumes an Excel "sep=%s" line instead of reading it as the header', async separator => {
    const parsed = await readTransferFile(editing(separator, 'Gale jacket', `sep=${separator}\r\n`), 'editing.csv')
    expect(parsed.issues).toEqual([])
    expect(parsed.rows[0]).toMatchObject({ field: 'name', value: 'Gale jacket' })
  })

  it('keeps the separator inside quoted cells', async () => {
    const csv = Buffer.from(`${HEADER.join(';')}\r\nProducts;GALE-JACKET;name;SET;"Gale; blue, warm";3`)
    expect((await readTransferFile(csv, 'editing.csv')).rows[0].value).toBe('Gale; blue, warm')
  })

  it.each([
    ['a quoted comma', '"Gale jacket, blue"', 'Gale jacket, blue'],
    ['a quoted semicolon', '"Gale; blue"', 'Gale; blue'],
    ['a quoted newline', '"line one\r\nline two"', 'line one\r\nline two'],
  ])('leaves a comma-separated file carrying %s unchanged', async (_name, cell, value) => {
    const csv = Buffer.from(`${HEADER.join(',')}\r\nProducts,GALE-JACKET,name,SET,${cell},3`)
    expect((await readTransferFile(csv, 'editing.csv')).rows[0].value).toBe(value)
    expect((await readSourceFile(csv, 'source.csv')).records[0].value).toBe(value)
  })

  it('still reads a single-column comma source', async () => {
    expect(await readSourceFile(Buffer.from('sku\r\nGALE-JACKET\r\n'), 'source.csv')).toEqual({ headers: ['sku'], records: [{ sku: 'GALE-JACKET' }] })
  })

  it.each([['transfer', readTransferFile], ['source', readSourceFile]] as const)('names the row, both counts and the separator when a %s row is not rectangular', async (_name, read) => {
    const csv = Buffer.from(`Nexus export\r\n${HEADER.join(',')}\r\nProducts,GALE-JACKET,name,SET,Gale jacket,3`)
    await expect(read(csv, 'editing.csv')).rejects.toThrow('Row 2 has 6 cells where the header has 1')
    await expect(read(csv, 'editing.csv')).rejects.not.toThrow('Invalid Record Length')
  })
})
