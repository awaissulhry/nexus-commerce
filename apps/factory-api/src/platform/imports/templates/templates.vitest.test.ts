import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import type { Grain } from '@nexus/factory-domain/auth/grains/grains'
import { mapHeaders } from '@nexus/factory-domain/imports/headers'
import { importTemplate } from '@nexus/factory-domain/imports/templates'
import { parseRow } from '@nexus/factory-domain/imports/plan'
import { IMPORTERS } from '../registry'
import { examplesOf } from './examples'
import { templateFile } from './template'

/**
 * Every importer's template (B-W2a-41; PLT-177): its header maps back to the importer's columns, every example row
 * reads without a problem in both number formats, and a money column appears only with its grain.
 */
const ALL: readonly Grain[] = ['price', 'cost', 'margin', 'wages']

describe('import templates', () => {
  for (const adapter of IMPORTERS) {
    for (const numberFormat of ['it', 'en'] as const) {
      it(`${adapter.importer.key} (${numberFormat}): the header maps back and every example row reads cleanly`, () => {
        const { examples, formatted } = examplesOf(adapter.importer.key, numberFormat)
        const template = importTemplate(adapter.importer, { numberFormat, grains: ALL, examples, formatted })
        const mapping = mapHeaders(adapter.importer.columns, template.header)
        expect(mapping.issues).toEqual([])
        expect(mapping.columns).toHaveLength(Object.keys(adapter.importer.columns).length)
        expect(template.rows.length).toBeGreaterThan(0)
        template.rows.forEach((cells, index) => {
          const parsed = parseRow(adapter.importer, mapping.columns, { rowNumber: index + 2, cells }, { numberFormat })
          expect(parsed.errors).toEqual([])
        })
      })
    }
  }

  it('leaves out a money column without its grain, and says so', () => {
    const materials = IMPORTERS.find((adapter) => adapter.importer.key === 'product.materials')!
    const { examples } = examplesOf('product.materials', 'it')
    const template = importTemplate(materials.importer, { numberFormat: 'it', grains: [], examples })
    expect(template.header).not.toContain('Standard cost')
    expect(template.leftOut).toEqual([{ label: 'Standard cost', grain: 'cost' }])
    expect(importTemplate(materials.importer, { numberFormat: 'it', grains: ['cost'], examples }).rows[0]).toContain('18,50')
  })

  it('writes CSV with ; between cells and an Excel workbook with a Columns sheet', async () => {
    const parties = IMPORTERS.find((adapter) => adapter.importer.key === 'parties.parties')!
    const { examples } = examplesOf('parties.parties', 'it')
    const template = importTemplate(parties.importer, { numberFormat: 'it', grains: [], examples })
    const csv = await templateFile(template, 'csv')
    expect(csv.name).toBe('parties-parties-template.csv')
    expect(csv.body.toString('utf8').split('\r\n')[0]).toBe(template.header.join(';'))
    const xlsx = await templateFile(template, 'xlsx')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(xlsx.body as never)
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Customers and suppliers', 'Columns'])
    expect(workbook.getWorksheet('Columns')!.getRow(2).getCell(1).value).toBe('Code')
  })
})
