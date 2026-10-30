import { describe, expect, it } from 'vitest'
import { formatScanId } from '@nexus/factory-domain/numbering/scan-id'
import { DEMO_TAG, OTHER_TAG, typo } from '../design-data'
import { groupOf, hrefOf, isOpenable, looksLikeLabel, matchPages, moveHighlight, nextGroupStart, paletteResults, type PalettePage, type PaletteRecord, type PaletteRecords } from './palette-model'

const pages: PalettePage[] = [
  { id: 'users', label: 'Users', area: 'Admin', href: '/w/DEMO/admin/users' },
  { id: 'roles', label: 'Roles', area: 'Admin', href: '/w/DEMO/admin/roles' },
  { id: 'mail', label: 'Mail to sort', area: 'Home', href: '/w/DEMO/home/mail-to-sort' },
  { id: 'numbering', label: 'Numerazioni', area: 'Amministrazione', href: '/w/DEMO/admin/numbering' },
]
const source = { pages, tenantTag: DEMO_TAG }
const hide = formatScanId({ type: 'HIDE', tenantTag: DEMO_TAG, ref: 4215 })

describe('the palette reads scanned and typed label codes (PLT-155, PLT-126)', () => {
  it('says what a label of this factory is: its type and reference', () => {
    expect(paletteResults(hide, source)).toEqual([{ kind: 'label', id: `label:${hide}`, type: 'HIDE', text: hide, ref: 4215, record: null, looking: false }])
  })

  it('reads a label typed in lower case, without hyphens, with O for 0', () => {
    const typed = hide.toLowerCase().replace(/-/g, '').replace(/0/g, 'o')
    const [result] = paletteResults(typed, source)
    expect(result).toMatchObject({ kind: 'label', type: 'HIDE', text: hide, ref: 4215 })
  })

  it('catches one wrong character by the check symbol', () => {
    const [result] = paletteResults(typo(hide), source)
    expect(result).toMatchObject({ kind: 'label-refused', problem: 'check', type: 'HIDE' })
  })

  it('refuses a label of another factory (the tenant tag)', () => {
    const lot = formatScanId({ type: 'LOT', tenantTag: OTHER_TAG, ref: 77 })
    expect(paletteResults(lot, source)).toEqual([{ kind: 'label-refused', id: expect.any(String), problem: 'tenant', text: lot, type: 'LOT' }])
    // Without the session's tag the same code is read (the API still checks its tenant).
    expect(paletteResults(lot, { pages, tenantTag: null })[0]).toMatchObject({ kind: 'label', type: 'LOT', ref: 77 })
  })

  it('reads every label type and a long reference', () => {
    for (const type of ['BUNDLE', 'LOT', 'BATCH', 'SERIAL', 'CARTON', 'LOCATION', 'WORK_ORDER'] as const) {
      const code = formatScanId({ type, tenantTag: DEMO_TAG, ref: 1_048_577 })
      expect(paletteResults(code, source)[0]).toMatchObject({ kind: 'label', type, ref: 1_048_577 })
    }
  })

  it('treats only label-shaped input as a label; anything else with a digit is a number to find', () => {
    expect(looksLikeLabel(hide)).toBe(true)
    expect(looksLikeLabel('FT-2026-00042')).toBe(false)
    expect(looksLikeLabel('users')).toBe(false)
    expect(paletteResults('FT-2026-00042', source)).toEqual([{ kind: 'number', id: 'number:FT-2026-00042', text: 'FT-2026-00042', looking: false }])
  })

  it('without a record found, labels and numbers are said, not opened; pages open', () => {
    expect(paletteResults(hide, source).some(isOpenable)).toBe(false)
    expect(paletteResults('users', source).filter(isOpenable).map(hrefOf)).toEqual(['/w/DEMO/admin/users'])
  })
})

describe('the palette jumps to pages', () => {
  it('lists every page for an empty query', () => {
    expect(matchPages(pages, '  ').map((p) => p.id)).toEqual(['users', 'roles', 'mail', 'numbering'])
  })

  it('matches every word against the page and its area, names starting with the query first', () => {
    expect(matchPages(pages, 'admin').map((p) => p.id)).toEqual(['users', 'roles'])
    expect(matchPages(pages, 'sort mail').map((p) => p.id)).toEqual(['mail'])
    expect(matchPages(pages, 'r').map((p) => p.id)).toEqual(['roles', 'users', 'mail', 'numbering'])
    expect(matchPages(pages, 'numerazióni').map((p) => p.id)).toEqual(['numbering'])
    expect(paletteResults('zzz', source)).toEqual([])
  })

  it('moves the highlight around the list', () => {
    expect(moveHighlight(-1, 3, 1)).toBe(0)
    expect(moveHighlight(-1, 3, -1)).toBe(2)
    expect(moveHighlight(2, 3, 1)).toBe(0)
    expect(moveHighlight(0, 3, -1)).toBe(2)
    expect(moveHighlight(0, 0, 1)).toBe(-1)
  })
})

// B-W2a-32: the record search's answer in the palette.
const hit = (recordType: string, number: string | null, match: PaletteRecord['match'] = 'words', n = 1): PaletteRecord => ({
  recordType,
  recordId: `0190f0e2-5555-7000-8000-${String(n).padStart(12, '0')}`,
  number,
  title: 'Pista Demo',
  subtitle: null,
  status: 'CONFIRMED',
  match,
  href: `/w/DEMO/records/${recordType}/${n}`,
})
const answered = (query: string, hits: PaletteRecord[], total = hits.length): PaletteRecords => ({ query, state: 'ready', hits, total, allHref: `/w/DEMO/search?q=${query}` })

describe('the palette finds records (B-W2a-32)', () => {
  it('puts a number typed whole under Exact number, opens it first, the rest under Records, then See all, then pages', () => {
    const records = answered('ORD-2026-00042', [hit('SalesOrder', 'ORD-2026-00042', 'number', 1), hit('Invoice', 'FT-2026-00031', 'words', 2)], 7)
    const results = paletteResults('ORD-2026-00042', { ...source, records })
    expect(results.map((result) => [result.kind, groupOf(result)])).toEqual([
      ['record', 'exact'],
      ['record', 'records'],
      ['all', 'records'],
    ])
    expect(hrefOf(results[0]!)).toBe('/w/DEMO/records/SalesOrder/1')
    expect(results[2]).toMatchObject({ kind: 'all', total: 7, href: '/w/DEMO/search?q=ORD-2026-00042' })
  })

  it('says a number nobody has, and that it is being looked for while the search answers', () => {
    expect(paletteResults('FT-2026-99999', { ...source, records: answered('FT-2026-99999', []) })).toEqual([{ kind: 'number', id: 'number:FT-2026-99999', text: 'FT-2026-99999', looking: false }])
    const loading: PaletteRecords = { query: 'FT-2026-99999', state: 'loading', hits: [], total: 0, allHref: null }
    expect(paletteResults('FT-2026-99999', { ...source, records: loading }).map((result) => result.kind)).toEqual(['number', 'records-state'])
    expect(paletteResults('FT-2026-99999', { ...source, records: loading })[0]).toMatchObject({ looking: true })
  })

  it('says nothing about a number that was not looked for (a query too short to search)', () => {
    expect(paletteResults('4', { ...source, records: { query: '', state: 'idle', hits: [], total: 0, allHref: null } }).map((result) => result.kind)).toEqual([])
  })

  it('shows an answer only for the query it answers (an older one is still loading)', () => {
    const results = paletteResults('pista r', { ...source, records: answered('pista', [hit('Party', 'CLI-1')]) })
    expect(results.map((result) => result.kind)).toEqual(['records-state'])
    expect(results[0]).toMatchObject({ state: 'loading' })
  })

  it('opens a scanned label through the record that has it as its number', () => {
    const results = paletteResults(hide, { ...source, records: answered(hide, [hit('Hide', hide, 'number', 9)]) })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ kind: 'label', type: 'HIDE', record: { recordType: 'Hide' } })
    expect(hrefOf(results[0]!)).toBe('/w/DEMO/records/Hide/9')
  })

  it('says the search is not answering in the Records group, pages still listed', () => {
    const results = paletteResults('users', { ...source, records: { query: 'users', state: 'error', hits: [], total: 0, allHref: null } })
    expect(results.map((result) => result.kind)).toEqual(['records-state', 'page'])
    expect(results[0]).toMatchObject({ state: 'error' })
    expect(isOpenable(results[0]!)).toBe(false)
  })

  it('Tab moves to the first result of the next group, Shift+Tab back, wrapping', () => {
    const records = answered('admin', [hit('Party', 'CLI-1', 'words', 1), hit('Party', 'CLI-2', 'words', 2)], 2)
    const results = paletteResults('admin', { ...source, records })
    expect(results.map((result) => groupOf(result))).toEqual(['records', 'records', 'records', 'pages', 'pages'])
    expect(nextGroupStart(results, 0, 1)).toBe(3)
    expect(nextGroupStart(results, 1, 1)).toBe(3)
    expect(nextGroupStart(results, 3, 1)).toBe(0)
    expect(nextGroupStart(results, 3, -1)).toBe(0)
    expect(nextGroupStart(results, 0, -1)).toBe(3)
    expect(nextGroupStart([], 0, 1)).toBe(-1)
  })
})
