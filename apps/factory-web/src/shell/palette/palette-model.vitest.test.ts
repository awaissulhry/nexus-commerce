import { describe, expect, it } from 'vitest'
import { formatScanId } from '@nexus/factory-domain/numbering/scan-id'
import { DEMO_TAG, OTHER_TAG, typo } from '../design-data'
import { isOpenable, looksLikeLabel, matchPages, moveHighlight, paletteResults, type PalettePage } from './palette-model'

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
    expect(paletteResults(hide, source)).toEqual([{ kind: 'label', id: `label:${hide}`, type: 'HIDE', text: hide, ref: 4215 }])
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
    expect(paletteResults('FT-2026-00042', source)).toEqual([{ kind: 'number', id: 'number:FT-2026-00042', text: 'FT-2026-00042' }])
  })

  it('opens pages only: labels and numbers are said until their records exist (no API call in W0)', () => {
    expect(paletteResults(hide, source).some(isOpenable)).toBe(false)
    expect(paletteResults('users', source).filter(isOpenable).map((r) => r.page.id)).toEqual(['users'])
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
