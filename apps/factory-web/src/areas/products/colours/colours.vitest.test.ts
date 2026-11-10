import { describe, expect, it } from 'vitest'
import { activeIn, archiveHeldKey, colourDraftOf, colourDraftProblems, coloursCan, createBodyOf, filtersOf, isFiltered, moved, newSetHeldKey, NO_FILTERS, otherNames, pageNotices, pictureAddress, referenceWords, searchOf, setChangeCount, setChangesOf, setDraftOf, setDraftProblems, suggestedCode, updateBodyOf, type BrandingSetView, type ColourLibraryRow } from './model'
import { designScreen } from './fixtures'

const row = (extra: Partial<ColourLibraryRow> = {}): ColourLibraryRow => ({
  id: '0190f0e2-4701-7000-8000-000000000001',
  companyId: null,
  code: 'NX-BLK',
  name: 'Nero',
  names: { it: 'Nero', en: 'Black' },
  system: 'RAL',
  reference: 'RAL 9005',
  family: 'nero',
  hex: '#111111',
  photo: null,
  use: { materialColours: 1, colourways: 2, brandingSets: 0, inUse: true },
  status: 'ACTIVE',
  version: 3,
  updatedAt: '2026-11-10T09:00:00.000Z',
  ...extra,
})

describe('Colours & artwork, the page rules (B-W2b-247)', () => {
  it('keeps the filters, the open set and a new form in the address', () => {
    const filters = filtersOf(new URLSearchParams('view=unused&q=9005&system=RAL&family=nero&sets=active'))
    expect(filters).toEqual({ view: 'unused', q: '9005', system: 'RAL', family: 'nero', sets: 'active' })
    expect(searchOf(filters, { open: 'S1' })).toBe('?view=unused&q=9005&system=RAL&family=nero&sets=active&open=S1')
    expect(searchOf(NO_FILTERS, { new: 'colour' })).toBe('?new=colour')
    expect(filtersOf(new URLSearchParams('view=gone&sets=gone'))).toEqual(NO_FILTERS)
    expect(isFiltered(NO_FILTERS)).toBe(false)
    expect(isFiltered({ ...NO_FILTERS, sets: 'archived' })).toBe(false)
    expect(isFiltered({ ...NO_FILTERS, system: 'XYZ' })).toBe(true)
  })

  it('says a reference with its system once, the other names that differ, and a picture only from the API or design data', () => {
    const word = (system: string) => ({ PANTONE: 'Pantone', RAL: 'RAL', NCS: 'NCS', OWN: 'Our own' })[system] ?? system
    expect(referenceWords(row(), word)).toBe('RAL 9005')
    expect(referenceWords(row({ system: 'PANTONE', reference: '18-1662 TCX' }), word)).toBe('Pantone 18-1662 TCX')
    expect(referenceWords(row({ system: 'OWN', reference: null }), word)).toBe('Our own')
    expect(otherNames(row())).toEqual([{ locale: 'en', name: 'Black' }])
    expect(pictureAddress('/product/colours/pictures/f1')).toBe('/api/product/colours/pictures/f1')
    expect(pictureAddress('//evil.example/x.png')).toBeNull()
    expect(pictureAddress('https://evil.example/x.png')).toBeNull()
    expect(pictureAddress('data:image/svg+xml;utf8,x')).toBe('data:image/svg+xml;utf8,x')
  })

  it('reads the rights; holds Archive N with the reason', () => {
    const can = coloursCan(['product.styles.view', 'product.branding.manage'])
    expect(can).toEqual({ view: true, colours: false, branding: true, materials: false, upload: false })
    expect(archiveHeldKey([row()], can)).toBe('held.noColours')
    expect(archiveHeldKey([row({ status: 'ARCHIVED' })], { ...can, colours: true })).toBe('held.noneActive')
    expect(archiveHeldKey([row()], { ...can, colours: true })).toBeNull()
  })

  it('the colour form: factory-domain’s problems as typed, the body of a new colour, only what changed', () => {
    const draft = { ...colourDraftOf(null, ''), code: 'nx teal', name: 'Petrolio', system: 'RAL' as const, hex: 'teal' }
    expect(colourDraftProblems(draft).map((issue) => issue.path)).toEqual(['code', 'hex', 'reference'])
    const ok = { ...draft, code: 'nx-teal', reference: '5021', hex: '1d5c63', en: 'Teal' }
    expect(colourDraftProblems(ok)).toEqual([])
    expect(createBodyOf(ok)).toEqual({ companyId: null, code: 'NX-TEAL', name: 'Petrolio', names: { it: null, en: 'Teal' }, system: 'RAL', reference: 'RAL 5021', family: null, hex: '#1D5C63' })
    const edited = { ...colourDraftOf(row(), null), hex: '#222', en: '' }
    expect(updateBodyOf(row(), edited)).toEqual({ version: 3, names: { it: 'Nero', en: null }, hex: '#222222' })
    expect(updateBodyOf(row(), colourDraftOf(row(), null))).toBeNull()
  })

  it('the branding set draft: what Save sends, how many changes, the rules’ problems, files moved', () => {
    const view: BrandingSetView = {
      id: 'S1',
      companyId: 'C1',
      party: { id: 'P1', code: 'DEMO-C1', name: 'Demo' },
      code: 'BS-1',
      name: 'One',
      logos: 1,
      artwork: 2,
      logo: null,
      colours: [{ id: 'K1', code: 'NX-BLK', name: 'Nero', hex: '#111111', status: 'ACTIVE' }],
      rules: 1,
      stylesLinked: 2,
      status: 'ACTIVE',
      version: 4,
      updatedAt: '2026-11-10T09:00:00.000Z',
      files: [
        { fileId: 'L1', role: 'LOGO', name: 'logo.png', contentType: 'image/png', kind: 'PHOTO', picture: true, available: true, url: '/product/colours/pictures/L1' },
        { fileId: 'A1', role: 'ARTWORK', name: 'label.pdf', contentType: 'application/pdf', kind: 'DOCUMENT', picture: false, available: true, url: null },
        { fileId: 'A2', role: 'ARTWORK', name: 'tag.png', contentType: 'image/png', kind: 'PHOTO', picture: true, available: true, url: '/product/colours/pictures/A2' },
      ],
      packagingRules: [{ key: 'polybag', text: 'One per bag', item: { id: 'I1', code: 'PKG', name: 'Bag', status: 'ACTIVE' }, quantity: '1', per: 'GARMENT' }],
      note: null,
      styles: [],
      stylesMore: false,
      activeOther: null,
      createdAt: '2026-11-10T09:00:00.000Z',
    }
    const draft = setDraftOf(view)
    expect(draft).toEqual({ name: 'One', note: '', colourIds: ['K1'], rules: [{ key: 'polybag', text: 'One per bag', itemId: 'I1', quantity: '1', per: 'GARMENT' }], logoIds: ['L1'], artworkIds: ['A1', 'A2'] })
    expect(setChangesOf(view, draft)).toBeNull()
    const changed = { ...draft, artworkIds: moved(draft.artworkIds, 'A2', -1), rules: [...draft.rules, { key: 'Hang Tag', text: 'On the zip', itemId: '', quantity: '', per: '' as const }] }
    expect(setChangesOf(view, changed)).toEqual({
      version: 4,
      labelArtworkFileIds: ['A2', 'A1'],
      packagingRules: [
        { key: 'polybag', text: 'One per bag', itemId: 'I1', quantity: '1', per: 'GARMENT' },
        { key: 'Hang Tag', text: 'On the zip', itemId: null, quantity: null, per: null },
      ],
    })
    expect(setChangeCount(view, changed)).toBe(2)
    expect(setDraftProblems(view, { ...draft, rules: [{ key: 'box', text: 'x', itemId: '0190f0e2-4706-7000-8000-000000000001', quantity: '', per: 'PACK' }] }).map((issue) => issue.path)).toEqual(['packagingRules/0/quantity'])
    expect(moved(['a', 'b'], 'a', -1)).toEqual(['a', 'b'])
  })

  it('a new set: held until a brand, a code and — for a brand with a set in use — the replace box', () => {
    const brand = { id: 'P1', code: 'DEMO-C1', name: 'Demo', active: [{ id: 'S1', code: 'BS-1', name: 'One', companyId: 'C1' }] }
    expect(newSetHeldKey({ brand: null, code: '', name: '', replace: false }, 'C1')).toBe('newSet.held.brand')
    expect(newSetHeldKey({ brand, code: 'BS 2', name: 'Two', replace: false }, 'C1')).toBe('newSet.held.fields')
    expect(newSetHeldKey({ brand, code: 'BS-2', name: 'Two', replace: false }, 'C1')).toBe('newSet.held.replace')
    expect(newSetHeldKey({ brand, code: 'BS-2', name: 'Two', replace: true }, 'C1')).toBeNull()
    expect(newSetHeldKey({ brand, code: 'BS-2', name: 'Two', replace: false }, 'C2')).toBeNull()
    expect(activeIn(brand, 'C1')?.code).toBe('BS-1')
    expect(suggestedCode(brand, 2027)).toBe('BS-DEMO-C1-2027')
  })

  it('shows the notices the most serious first, without the dismissed ones', () => {
    const counts = { tiles: { unused: 1, brandingSets: 1 }, brandsWithoutSet: { count: 2, brands: [] }, noHex: 3 }
    expect(pageNotices(['system=XYZ'], counts, new Set()).map((notice) => notice.kind)).toEqual(['IGNORED_FILTER', 'BRANDS_WITHOUT_SET', 'NO_HEX'])
    expect(pageNotices([], counts, new Set(['NO_HEX:3'])).map((notice) => notice.kind)).toEqual(['BRANDS_WITHOUT_SET'])
    expect(pageNotices([], null, new Set())).toEqual([])
  })

  it('the design cases are made-up and cover every state the design names', () => {
    const ids = designScreen.cases.map((entry) => entry.id)
    for (const id of ['owner', 'loading', 'error', 'empty', 'no-permission', 'offline', 'set', 'new-colour', 'new-set', 'notices-open']) expect(ids).toContain(id)
    expect(JSON.stringify(designScreen.cases)).not.toMatch(/@(?!example)[a-z]+\.[a-z]/)
  })
})
