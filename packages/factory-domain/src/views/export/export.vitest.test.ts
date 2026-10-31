import { describe, expect, it } from 'vitest'
import { cell } from '../../imports/cells'
import { mapHeaders } from '../../imports/headers'
import { defineImporter } from '../../imports/importer'
import { parseRow } from '../../imports/plan'
import { EXPORT_MAIL, exportLink, exportMailDue, exportMailText } from './mail'
import { jobProgress, totalAfter } from './progress'
import { reimportCell, reimportHelp, reimportKey, reimportLayout, reimportRow } from './reimport'

/**
 * B-W2b-11 (PLT-184; the W2a export follow-ups): job progress with a total, the e-mail of a finished export, and the
 * full file for re-import — pure rules the API's export worker uses.
 */

describe('background job progress with a total (PLT-184)', () => {
  it('a bar with "n of m" once counted, a moving bar while counting, the total follows a list that grew', () => {
    expect(jobProgress({ status: 'RUNNING', rowsDone: 0, rowCount: null })).toEqual({ determinate: false, done: 0, total: null, fraction: null })
    expect(jobProgress({ status: 'RUNNING', rowsDone: 38, rowCount: 61 })).toMatchObject({ determinate: true, done: 38, total: 61 })
    expect(jobProgress({ status: 'RUNNING', rowsDone: 38, rowCount: 61 }).fraction).toBeCloseTo(38 / 61)
    expect(jobProgress({ status: 'RUNNING', rowsDone: 70, rowCount: 61 })).toMatchObject({ total: 70, fraction: 1 })
    expect(jobProgress({ status: 'RUNNING', rowsDone: 0, rowCount: 0 })).toMatchObject({ total: 0, fraction: 1 })
    expect(jobProgress({ status: 'DONE', rowsDone: 61, rowCount: 61 })).toEqual({ determinate: true, done: 61, total: 61, fraction: 1 })
    expect(totalAfter(null, 5)).toBeNull()
    expect(totalAfter(61, 38)).toBe(61)
    expect(totalAfter(61, 70)).toBe(70)
  })
})

describe('the e-mail of a finished export', () => {
  const at = new Date('2026-10-31T09:00:00Z')
  const after = (ms: number) => new Date(at.getTime() + ms)

  it('is due for a DONE export that ran long enough for its window to be closed, once', () => {
    expect(exportMailDue({ status: 'DONE', createdAt: at, finishedAt: after(EXPORT_MAIL.afterMs), emailedAt: null })).toBe(true)
    expect(exportMailDue({ status: 'DONE', createdAt: at, finishedAt: after(EXPORT_MAIL.afterMs - 1), emailedAt: null })).toBe(false)
    expect(exportMailDue({ status: 'DONE', createdAt: at, finishedAt: after(60_000), emailedAt: after(61_000) })).toBe(false)
    expect(exportMailDue({ status: 'FAILED', createdAt: at, finishedAt: after(60_000), emailedAt: null })).toBe(false)
    expect(exportMailDue({ status: 'RUNNING', createdAt: at, finishedAt: null, emailedAt: null })).toBe(false)
  })

  it('links to the list with the job, never the file; words in the person’s language without a cell of the list', () => {
    expect(exportLink('https://factory.example.com/', 'SCA', '/sales/orders', 'job-1')).toBe('https://factory.example.com/w/SCA/sales/orders?export=job-1')
    expect(exportLink('https://factory.example.com', null, '/sales/orders', 'job-1')).toBe('https://factory.example.com/')
    const it_ = exportMailText({ locale: 'it', name: 'Ada', title: 'Ordini di vendita', viewName: 'In ritardo', rows: 1240, format: 'XLSX', link: 'https://x.example/w/SCA/sales/orders?export=j', deletedOn: '2026-11-07' })
    expect(it_.subject).toBe('La tua esportazione è pronta: Ordini di vendita · In ritardo')
    expect(it_.text).toContain('Ciao Ada,')
    expect(it_.text).toContain('(Excel, 1.240 righe)')
    expect(it_.text).toContain('fino al 07/11/2026')
    expect(it_.text).toContain('https://x.example/w/SCA/sales/orders?export=j')
    const en = exportMailText({ locale: 'en', name: '<Ada>', title: 'Orders', viewName: null, rows: 1, format: 'CSV', link: 'https://x.example/?a=1&b=2', deletedOn: '2026-11-07' })
    expect(en.subject).toBe('Your export is ready: Orders')
    expect(en.text).toContain('(CSV, 1 row)')
    expect(en.text).toContain('until 7 Nov 2026')
    expect(en.html).toContain('&lt;Ada&gt;')
    expect(en.html).toContain('href="https://x.example/?a=1&amp;b=2"')
  })
})

describe('the full file for re-import reads back through its importer unchanged', () => {
  const importer = defineImporter({
    key: 'test.widgets',
    label: 'Widgets',
    columns: {
      code: { label: 'Code', aliases: ['codice'], required: true, type: cell.code({ upper: true }) },
      name: { label: 'Name', type: cell.text({ max: 80 }) },
      kind: { label: 'Kind', type: cell.oneOf(['LEATHER', 'TRIM'] as const) },
      factor: { label: 'Factor', type: cell.decimal({ scale: 6 }) },
      pieces: { label: 'Pieces', type: cell.integer() },
      since: { label: 'Since', type: cell.date() },
      ppe: { label: 'PPE', type: cell.boolean() },
      cost: { label: 'Cost', type: cell.decimal({ scale: 6 }), grain: 'cost' },
    },
    keyColumns: ['code'],
  })
  const record = { code: '0012-A', name: 'Fibbia 1.234', kind: 'TRIM', factor: '1.234', pieces: 1234, since: '2026-12-31', ppe: true, cost: '12.5' }

  it('the importer’s columns, a money column only with its grain (named on the second sheet, never above the header)', () => {
    const full = reimportLayout(importer, ['cost'])
    expect(full.columns.map((column) => column.name)).toEqual(['code', 'name', 'kind', 'factor', 'pieces', 'since', 'ppe', 'cost'])
    const without = reimportLayout(importer, [])
    expect(without.columns.map((column) => column.name)).not.toContain('cost')
    expect(without.leftOut).toEqual([{ label: 'Cost', grain: 'cost' }])
    const help = reimportHelp(without, 'it')
    expect(help[0]).toEqual(['Colonna', 'Obbligatoria', 'Contiene', 'Altre intestazioni lette'])
    expect(help.flat().join(' ')).toContain('Colonne escluse dai tuoi permessi: Cost')
  })

  it('numbers as numbers, days as ISO text, yes/no as booleans: the same values in either number format (UNCHANGED)', () => {
    const layout = reimportLayout(importer, ['cost'])
    const row = reimportRow(importer, layout, record)
    expect(row).toEqual(['0012-A', 'Fibbia 1.234', 'TRIM', 1.234, 1234, '2026-12-31', true, 12.5])
    const mapping = mapHeaders(importer.columns, layout.columns.map((column) => column.label)).columns
    for (const numberFormat of ['it', 'en'] as const) {
      const parsed = parseRow(importer, mapping, { rowNumber: 2, cells: row }, { numberFormat })
      expect(parsed.errors, numberFormat).toEqual([])
      expect(importer.plan(parsed.values, { id: 'w-1', values: record }), numberFormat).toEqual({ action: 'UNCHANGED' })
    }
  })

  it('an empty field stays an empty cell (re-importing never clears it); keys compare as text', () => {
    expect(reimportCell(importer.columns.name, null)).toBeNull()
    expect(reimportCell(importer.columns.name, '')).toBeNull()
    expect(reimportKey(['code'], { code: '0012-A' })).toBe(reimportKey(['code'], { code: '0012-A', name: 'x' }))
    expect(reimportKey(['site', 'code'], { site: 'A1', code: 7 })).toBe('["A1","7"]')
  })
})
