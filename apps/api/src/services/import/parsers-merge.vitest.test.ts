// Incident #31 — merged cells expand across their range at parse.
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { parseXlsx } from './parsers.js'

describe('parseXlsx merged-cell expansion', () => {
  it('fills every row covered by a vertical merge with the master value', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('S')
    ws.addRow(['sku', 'team_name', 'color'])
    ws.addRow(['A-1', 'TEAM-X', 'Nero'])
    ws.addRow(['A-2', '', 'Nero'])
    ws.addRow(['A-3', '', 'Giallo'])
    ws.mergeCells('B2:B4') // team_name merged down across the three rows
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer())
    const parsed = await parseXlsx(bytes)
    expect(parsed.rows).toHaveLength(3)
    expect(parsed.rows.map((r) => r.team_name)).toEqual(['TEAM-X', 'TEAM-X', 'TEAM-X'])
    expect(parsed.rows.map((r) => r.color)).toEqual(['Nero', 'Nero', 'Giallo'])
  })
  it('leaves genuinely blank unmerged cells blank', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('S')
    ws.addRow(['sku', 'note'])
    ws.addRow(['A-1', 'x'])
    ws.addRow(['A-2', ''])
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer())
    const parsed = await parseXlsx(bytes)
    expect(parsed.rows[1].note ?? '').toBe('')
  })
})
