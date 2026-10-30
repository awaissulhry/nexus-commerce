import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { templateOf } from '../auth/roles/templates'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { assertTransition } from '../state/machine'
import { cellText, csvText, decimalText, EXPORT_LIMITS, exportFileName, exportMachine, instantText, minorText, omittedNote, pickColumns } from './exports'
import { VIEWS_PERMISSIONS } from './permissions'
import { changeRefusal, menuOrder, roleDefaultFor, sharingProblems, viewSeenBy, type ViewFacts, type ViewReader } from './rules'
import { listKeyOf, normaliseState, sameState, viewQuery, viewStateSchema } from './state'

/** Saved views and the export of any list (B-W2a-23; PLT-163, PLT-179): the pure rules the API and the list frame share. */

const me = 'u-me'
const other = 'u-other'
const sales = 'r-sales'
const finance = 'r-finance'
const reader = (over: Partial<ViewReader> = {}): ViewReader => ({ userId: me, roleIds: [sales], save: true, manage: false, ...over })
const view = (over: Partial<ViewFacts & { id: string; name: string }> = {}): ViewFacts & { id: string; name: string } => ({ id: 'v', name: 'A', ownerId: me, audience: 'ONLY_ME', roleId: null, roleDefault: false, ...over })

describe('what a view keeps (state)', () => {
  it('a list key is the Office page with dots; a record page has none', () => {
    expect(listKeyOf('/sales/orders')).toBe('sales.orders')
    expect(listKeyOf('/production/work-orders')).toBe('production.work-orders')
    expect(listKeyOf('/sales/orders/[id]')).toBeNull()
    expect(listKeyOf('/')).toBeNull()
  })

  it('keeps the list terms, never a record opened over it, a dialog, a cursor or a link', () => {
    expect(viewQuery('?q=rossi&late=true&open=0190&savedView=abc&export=def&cursor=x')).toBe('late=true&q=rossi')
    expect(viewQuery('new=1&order=SO-1&status=DRAFT')).toBe('status=DRAFT')
    expect(viewQuery('order=SO-1')).toBe('order=SO-1')
    expect(viewQuery('q=&status=OPEN')).toBe('status=OPEN')
    // Two addresses of one view compare equal.
    expect(viewQuery('b=2&a=1')).toBe(viewQuery('a=1&b=2'))
  })

  it('stores only what was chosen; repeats and empty layouts go', () => {
    expect(normaliseState({ query: 'q=x', columns: { order: [], hidden: [], pinned: [] } })).toEqual({ query: 'q=x' })
    expect(normaliseState({ query: '', columns: { order: ['a', 'a', 'b'], hidden: ['c', 'c'], pinned: [] }, density: 'compact' })).toEqual({ query: '', columns: { order: ['a', 'b'], hidden: ['c'], pinned: [] }, density: 'compact' })
    expect(sameState({ query: 'b=2&a=1', columns: { order: [], hidden: ['x', 'y'], pinned: [] } }, { query: 'a=1&b=2', columns: { order: [], hidden: ['y', 'x'], pinned: [] }, density: 'cozy' })).toBe(true)
    expect(sameState({ query: 'a=1' }, { query: 'a=2' })).toBe(false)
    expect(sameState({ query: '', columns: { order: ['a', 'b'], hidden: [], pinned: [] } }, { query: '', columns: { order: ['b', 'a'], hidden: [], pinned: [] } })).toBe(false)
  })

  it('the schema refuses unknown parts and odd column ids', () => {
    expect(viewStateSchema.safeParse({ query: '', mode: 'board' }).success).toBe(false)
    expect(viewStateSchema.safeParse({ query: '', columns: { order: ['<script>'], hidden: [], pinned: [] } }).success).toBe(false)
    expect(viewStateSchema.safeParse({ query: 'late=true', columns: { order: ['number', 'customer'], hidden: ['quote'], pinned: ['number'] }, density: 'spacious' }).success).toBe(true)
  })
})

describe('who sees and keeps a view (rules)', () => {
  it('own views always; EVERYONE to all; ROLE to its holders; another person’s ONLY_ME to nobody', () => {
    expect(viewSeenBy(view(), reader())).toBe(true)
    expect(viewSeenBy(view({ ownerId: other }), reader())).toBe(false)
    expect(viewSeenBy(view({ ownerId: other, audience: 'EVERYONE' }), reader())).toBe(true)
    expect(viewSeenBy(view({ ownerId: other, audience: 'ROLE', roleId: sales }), reader())).toBe(true)
    expect(viewSeenBy(view({ ownerId: other, audience: 'ROLE', roleId: finance }), reader())).toBe(false)
  })

  it('sharing: a role you hold with views.save; everyone and role defaults with views.manage', () => {
    expect(sharingProblems({ audience: 'ONLY_ME', roleId: null, roleDefault: false }, reader())).toEqual([])
    expect(sharingProblems({ audience: 'ROLE', roleId: sales, roleDefault: false }, reader())).toEqual([])
    expect(sharingProblems({ audience: 'ROLE', roleId: finance, roleDefault: false }, reader()).map((issue) => issue.path)).toEqual(['body/roleId'])
    expect(sharingProblems({ audience: 'ROLE', roleId: finance, roleDefault: false }, reader({ manage: true }))).toEqual([])
    expect(sharingProblems({ audience: 'EVERYONE', roleId: null, roleDefault: false }, reader()).map((issue) => issue.path)).toEqual(['body/audience'])
    expect(sharingProblems({ audience: 'ROLE', roleId: sales, roleDefault: true }, reader()).map((issue) => issue.path)).toEqual(['body/roleDefault'])
    expect(sharingProblems({ audience: 'ROLE', roleId: sales, roleDefault: true }, reader({ manage: true }))).toEqual([])
    expect(sharingProblems({ audience: 'ONLY_ME', roleId: null, roleDefault: true }, reader({ manage: true })).map((issue) => issue.path)).toEqual(['body/roleDefault'])
    expect(sharingProblems({ audience: 'ROLE', roleId: null, roleDefault: false }, reader()).map((issue) => issue.path)).toEqual(['body/roleId'])
    expect(sharingProblems({ audience: 'ONLY_ME', roleId: null, roleDefault: false }, reader({ save: false })).map((issue) => issue.path)).toEqual(['body'])
  })

  it('the owner changes their views; views.manage the shared ones; nobody another person’s own', () => {
    expect(changeRefusal(view(), reader())).toBeNull()
    expect(changeRefusal(view({ audience: 'EVERYONE' }), reader())).toMatch(/views.manage/)
    expect(changeRefusal(view({ audience: 'ROLE', roleId: sales, roleDefault: true }), reader())).toMatch(/views.manage/)
    expect(changeRefusal(view({ ownerId: other, audience: 'ROLE', roleId: sales }), reader())).toMatch(/Only its owner/)
    expect(changeRefusal(view({ ownerId: other, audience: 'ROLE', roleId: sales }), reader({ manage: true }))).toBeNull()
    expect(changeRefusal(view({ ownerId: other }), reader({ manage: true }))).toMatch(/not yours/)
  })

  it('the list opens on the default of the first role held that has one; the menu lists own views first', () => {
    const views = [view({ id: 'f', ownerId: other, audience: 'ROLE', roleId: finance, roleDefault: true }), view({ id: 's', ownerId: other, audience: 'ROLE', roleId: sales, roleDefault: true })]
    expect(roleDefaultFor(views, reader({ roleIds: [finance, sales] }))?.id).toBe('f')
    expect(roleDefaultFor(views, reader({ roleIds: [sales] }))?.id).toBe('s')
    expect(roleDefaultFor(views, reader({ roleIds: [] }))).toBeNull()
    const listed = menuOrder([view({ id: '1', name: 'Zeta', ownerId: other, audience: 'EVERYONE' }), view({ id: '2', name: 'beta' }), view({ id: '3', name: 'Alfa' }), view({ id: '4', name: 'Hidden', ownerId: other })], reader())
    expect(listed.map((entry) => entry.id)).toEqual(['3', '2', '1'])
  })
})

describe('the export (cells, columns, file)', () => {
  it('moves QUEUED → RUNNING → DONE → EXPIRED; a stopped worker retries RUNNING → QUEUED; FAILED and EXPIRED are final', () => {
    expect(() => assertTransition(exportMachine, 'QUEUED', 'RUNNING', undefined)).not.toThrow()
    expect(() => assertTransition(exportMachine, 'RUNNING', 'QUEUED', undefined)).not.toThrow()
    expect(() => assertTransition(exportMachine, 'DONE', 'EXPIRED', undefined)).not.toThrow()
    expect(() => assertTransition(exportMachine, 'QUEUED', 'DONE', undefined)).toThrow()
    expect(exportMachine.finals).toEqual(expect.arrayContaining(['FAILED', 'EXPIRED']))
  })

  it('cells in the file’s language: no float, no grouping, days ISO, instants on the site’s clock', () => {
    expect(minorText(123450, 'it')).toBe('1234,50')
    expect(minorText(123450, 'en')).toBe('1234.50')
    expect(minorText(-5, 'it')).toBe('-0,05')
    expect(minorText(0, 'en')).toBe('0.00')
    expect(decimalText('12.5000', 'it')).toBe('12,5')
    expect(decimalText('12.0000', 'en')).toBe('12')
    expect(cellText({ day: '2026-10-30' }, 'it')).toBe('2026-10-30')
    expect(instantText('2026-10-30T09:42:00.000Z')).toBe('2026-10-30 10:42')
    expect(instantText('2026-07-30T09:42:00.000Z')).toBe('2026-07-30 11:42')
    expect(cellText(null, 'en')).toBe('')
    expect(cellText(7, 'it')).toBe('7')
    expect(cellText({ minor: 990, currency: 'EUR' }, 'en')).toBe('9.90')
  })

  it('field security: a money column whose grain the person lacks is left out and named; unknown columns are not part of a file', () => {
    const known = { number: {}, net: { grain: 'price' as const }, value: { grain: 'cost' as const } }
    const asked = [
      { key: 'number', label: 'Number' },
      { key: 'net', label: 'Net' },
      { key: 'value', label: 'Value' },
      { key: 'more', label: '' },
      { key: 'number', label: 'Twice' },
    ]
    const picked = pickColumns(known, asked, new Set(['price']))
    expect(picked.columns.map((column) => [column.key, column.grain])).toEqual([
      ['number', null],
      ['net', 'price'],
    ])
    expect(picked.omitted).toEqual([{ key: 'value', label: 'Value' }])
    expect(picked.unknown).toEqual(['more'])
    expect(omittedNote(['Value'], 'it')).toBe('Colonne escluse dai tuoi permessi: Value')
    expect(omittedNote([], 'en')).toBeNull()
  })

  it('the CSV: BOM, the language’s separator, quoted fields, the note above the header', () => {
    const text = csvText({ locale: 'it', note: 'Colonne escluse dai tuoi permessi: Valore', header: ['Numero', 'Cliente'], rows: [['SO-1', 'Rossi; Figli'], ['SO-2', 'Detto "Bianchi"']] })
    expect(text.charCodeAt(0)).toBe(0xfeff)
    expect(text.slice(1).split('\r\n')).toEqual(['Colonne escluse dai tuoi permessi: Valore', 'Numero;Cliente', 'SO-1;"Rossi; Figli"', 'SO-2;"Detto ""Bianchi"""', ''])
    expect(csvText({ locale: 'en', header: ['A', 'B'], rows: [['1,5', 'x']] }).slice(1)).toBe('A,B\r\n"1,5",x\r\n')
  })

  it('names the file after the list and the day', () => {
    expect(exportFileName('Ordini di vendita', 'CSV', '2026-10-30')).toBe('ordini-di-vendita-2026-10-30.csv')
    expect(exportFileName('Qualità à la carte', 'XLSX', '2026-10-30')).toBe('qualita-a-la-carte-2026-10-30.xlsx')
    expect(exportFileName('', 'XLSX_REIMPORT', '2026-10-30')).toBe('export-reimport-2026-10-30.xlsx')
    expect(EXPORT_LIMITS.keepDays).toBe(7)
  })
})

describe('declared once, given to the roles that work on lists', () => {
  it('the three permissions are declared; the office templates save and export, the administrator also manages', () => {
    for (const name of VIEWS_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    expect(templateOf('admin')?.permissions).toEqual(expect.arrayContaining(['views.save', 'views.manage', 'views.export']))
    for (const key of ['finance', 'sales', 'planner', 'buyer', 'warehouse', 'production_manager', 'quality_inspector', 'floor_supervisor']) {
      expect(templateOf(key)?.permissions, key).toEqual(expect.arrayContaining(['views.save', 'views.export']))
      expect(templateOf(key)?.permissions, key).not.toContain('views.manage')
    }
    expect(templateOf('owner')?.permissions).toEqual(expect.arrayContaining(['views.save', 'views.manage', 'views.export']))
    // Read-only changes nothing: it uses the views shared with it, saves none and exports nothing.
    expect(templateOf('read_only')?.permissions.some((name) => name.startsWith('views.'))).toBe(false)
    expect(templateOf('operator')?.permissions.some((name) => name.startsWith('views.'))).toBe(false)
  })

  it('the export events are declared, with no live rule (an export is the person’s own)', () => {
    for (const type of ['export.requested', 'export.finished']) {
      const definition = EVENT_CATALOGUE.find(type, 1)
      expect(definition, type).toBeDefined()
      expect(definition?.live ?? null).toBeNull()
    }
  })
})
