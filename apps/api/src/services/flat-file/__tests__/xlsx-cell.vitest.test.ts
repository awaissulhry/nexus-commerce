import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { writeCell, isoDate, joinArray } from '../xlsx-cell'

describe('xlsx-cell', () => {
  it('forces identifiers to text and preserves leading zeros', () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('t')
    const c = ws.getCell('A1')
    writeCell(c, { id: 'ean', kind: 'text', forcedText: true } as any, '08054323310123')
    expect(c.value).toBe('08054323310123')
    expect(c.numFmt).toBe('@')
  })

  it('writes decimals with fixed format, dates as ISO text, arrays joined', () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('t')
    const p = ws.getCell('A1')
    writeCell(p, { kind: 'decimal', decimals: 2 } as any, 189.9)
    expect(p.value).toBe(189.9)
    expect(p.numFmt).toBe('0.00')
    expect(isoDate('2026-07-05T10:00:00Z')).toBe('2026-07-05')
    expect(joinArray(['a', 'b'], ' | ')).toBe('a | b')
  })
})
