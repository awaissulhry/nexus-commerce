import { describe, expect, it } from 'vitest'
import { locationsImporter } from './importer'
import { archiveProblems, locationProblems, locationTree, normalizeLocationCode, wouldCycle } from './rules'

const loc = (id: string, parentId: string | null, code: string) => ({ id, parentId, code })

describe('the location tree (SCM-176)', () => {
  const rows = [loc('bin2', 'zone', 'A1-02'), loc('store', null, 'STORE'), loc('dock', null, 'DOCK'), loc('zone', 'store', 'A1'), loc('bin1', 'zone', 'A1-01'), loc('lost', 'gone', 'LOST')]

  it('orders depth first, children by code, with depth and path; a parent not in the list puts it at the top', () => {
    expect(locationTree(rows).map((row) => [row.id, row.depth, row.path.join('/')])).toEqual([
      ['dock', 0, 'DOCK'],
      ['lost', 0, 'LOST'],
      ['store', 0, 'STORE'],
      ['zone', 1, 'STORE/A1'],
      ['bin1', 2, 'STORE/A1/A1-01'],
      ['bin2', 2, 'STORE/A1/A1-02'],
    ])
  })

  it('never puts a location inside itself or its own children', () => {
    expect(wouldCycle('store', 'bin1', rows)).toBe(true)
    expect(wouldCycle('zone', 'zone', rows)).toBe(true)
    expect(wouldCycle('bin1', 'dock', rows)).toBe(false)
    expect(wouldCycle('bin1', null, rows)).toBe(false)
  })

  it('checks a code and a name', () => {
    expect(normalizeLocationCode(' a1-store-01 ')).toBe('A1-STORE-01')
    expect(locationProblems({ code: 'A1-STORE-01', name: 'Leather rack 1' })).toEqual([])
    expect(locationProblems({ code: 'a 1', name: ' ' }).map((issue) => issue.path)).toEqual(['code', 'name'])
    expect(locationProblems({ code: 'X'.repeat(41) }).map((issue) => issue.path)).toEqual(['code'])
  })

  it('archives only an empty location with nothing active inside it', () => {
    expect(archiveProblems({ status: 'ACTIVE', holdsStock: false, activeChildren: 0 })).toEqual([])
    expect(archiveProblems({ status: 'ACTIVE', holdsStock: true, activeChildren: 2 })).toHaveLength(2)
    expect(archiveProblems({ status: 'ARCHIVED', holdsStock: false, activeChildren: 0 })).toEqual(['The location is archived already.'])
  })
})

describe('the locations import', () => {
  it('matches by site and code, and refuses a bad code or a location inside itself', () => {
    expect(locationsImporter.key).toBe('inventory.locations')
    expect(locationsImporter.keyColumns).toEqual(['site', 'code'])
    expect(Object.values(locationsImporter.columns).some((column) => 'grain' in column)).toBe(false)
    expect(locationsImporter.validateRow({ site: 'A1', code: 'A1-01', name: 'Bin', kind: 'BIN', parent: 'A1' })).toEqual([])
    expect(locationsImporter.validateRow({ site: 'A1', code: 'A1/01', name: 'Bin', kind: 'BIN', parent: 'A1/01' }).map((issue) => issue.column)).toEqual(['code', 'parent'])
  })

  it('plans a new location, a change, or nothing', () => {
    const row = { site: 'A1', code: 'A1-01', name: 'Bin 1', kind: 'BIN', parent: 'A1' }
    expect(locationsImporter.plan(row, null)).toEqual({ action: 'CREATE', after: row })
    expect(locationsImporter.plan(row, { id: 'x', values: { ...row, name: 'Old' } })).toEqual({ action: 'UPDATE', before: { name: 'Old' }, after: { name: 'Bin 1' } })
    expect(locationsImporter.plan(row, { id: 'x', values: row })).toEqual({ action: 'UNCHANGED' })
  })
})
