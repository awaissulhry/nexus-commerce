import { describe, expect, it } from 'vitest'
import { labelZpl } from '../../labels/zpl'
import { LOCATION_KINDS } from '../locations/rules'
import { blockHolds, blockProblems, countBlockNote, countBlocksPlaces, isACountsBlock, placesToBlock, placesToRelease, unblockProblems } from './blocks'
import { defaultProblems, resolveDefault, type DefaultRow } from './defaults'
import { events } from '../../inventory-locations/events'
import { customerPlaceProblems, holdRefusal, kindProfiles, LOCATION_KIND_PROFILES, mayHold, placementProblems, retypeProblems } from './kinds'
import { binLabel, labelCodeProblems, normalizeLabelCode, suggestedLabelCode } from './labels'
import { subtreeIds } from './tree'

/** Locations in depth (B-W2b-289; SCM-177, SCM-178, SCM-179, SCM-181), the pure rules. Made-up codes only. */

describe('location types (SCM-177)', () => {
  it('profiles every kind, in LOCATION_KINDS order', () => {
    expect(kindProfiles().map((profile) => profile.kind)).toEqual([...LOCATION_KINDS])
    // The database refuses a default at an outside or transit place: no profile offers one.
    for (const kind of ['SUBCONTRACTOR', 'CUSTOMER', 'TRANSIT'] as const) expect(LOCATION_KIND_PROFILES[kind]).toMatchObject({ purposes: [], labelled: false, blockable: false, fixed: true })
  })

  it('says what a place holds, in words', () => {
    expect(mayHold('BIN', 'FINISHED')).toBe(true)
    expect(mayHold('PRODUCTION', 'FINISHED')).toBe(false)
    expect(mayHold('FINISHED_GOODS', 'LINING')).toBe(false)
    expect(mayHold('CUSTOMER', 'FINISHED')).toBe(true)
    expect(holdRefusal({ code: 'A1-CUT', kind: 'PRODUCTION' }, 'FINISHED', 'finished garments (FG-1)')).toBe('Location A1-CUT is a line-side place: it holds materials only, not finished garments (FG-1).')
    expect(holdRefusal({ code: 'A1-PF', kind: 'PICK_FACE' }, 'TRIM', 'materials (T-1)')).toBeNull()
  })

  it('puts a customer or transit place at the top, nothing inside an outside place or a pick face', () => {
    expect(placementProblems('CUSTOMER', { code: 'A1-STORE', kind: 'WAREHOUSE' })).toEqual([{ path: 'parentId', message: expect.stringContaining('top of the site') }])
    expect(placementProblems('CUSTOMER', null)).toEqual([])
    expect(placementProblems('BIN', { code: 'A1-PF', kind: 'PICK_FACE' })).toEqual([{ path: 'parentId', message: 'Nothing sits inside A1-PF (a pick face).' }])
    expect(placementProblems('BIN', { code: 'A1-STORE', kind: 'WAREHOUSE' })).toEqual([])
  })

  it('never retypes an outside or transit place, nor into one; a pick face holds no places inside', () => {
    expect(retypeProblems('CUSTOMER', 'BIN', { hasParent: false, children: 0 })[0]!.message).toContain('stays one')
    expect(retypeProblems('BIN', 'TRANSIT', { hasParent: false, children: 0 })[0]!.message).toContain('transit place stays one')
    expect(retypeProblems('ZONE', 'PICK_FACE', { hasParent: true, children: 2 })[0]!.message).toContain('2 location(s) sit inside it')
    expect(retypeProblems('ZONE', 'BULK', { hasParent: true, children: 2 })).toEqual([])
    expect(retypeProblems('BIN', 'BIN', { hasParent: true, children: 0 })).toEqual([])
  })

  it("checks a customer's place's party", () => {
    const party = { roles: ['CUSTOMER'], status: 'ACTIVE', companyId: null }
    expect(customerPlaceProblems('p', party, 'c')).toEqual([])
    expect(customerPlaceProblems('p', { ...party, roles: ['BRAND'], companyId: 'c' }, 'c')).toEqual([])
    expect(customerPlaceProblems(null, null, 'c')[0]!.message).toContain('name it')
    expect(customerPlaceProblems('p', { ...party, roles: ['SUPPLIER'] }, 'c')[0]!.message).toContain('no customer or brand')
    expect(customerPlaceProblems('p', { ...party, status: 'ARCHIVED' }, 'c')[0]!.message).toBe('The customer is archived.')
    expect(customerPlaceProblems('p', { ...party, companyId: 'other' }, 'c')[0]!.message).toBe('The customer belongs to another company.')
  })
})

describe('bin labels (SCM-178)', () => {
  it('suggests a code unique in the tenant from the site and the place, and checks a typed one', () => {
    expect(suggestedLabelCode('A1', 'A1-STORE-01')).toBe('A1-STORE-01')
    expect(suggestedLabelCode('A1', 'R4-02')).toBe('A1-R4-02')
    expect(suggestedLabelCode('A1', 'A1')).toBe('A1')
    expect(normalizeLabelCode(' bin/a1:01 ')).toBe('BIN/A1:01')
    expect(labelCodeProblems('BIN/A1:01')).toEqual([])
    expect(labelCodeProblems('A 1')).toHaveLength(1)
    expect(labelCodeProblems(`A${'1'.repeat(64)}`)).toHaveLength(1)
  })

  it('lays the label out as the scan labels are, with the code as Code 128', () => {
    const label = binLabel({ labelCode: 'A1-R4-02', maker: 'Pelli Inventate', name: 'Rack 4, shelf 2', siteCode: 'A1', path: ['A1-STORE', 'R4-02'], kind: 'BIN', code: 'R4-02' }, 'it')
    expect(label).toEqual({
      language: 'it',
      heading: 'Ubicazione · Pelli Inventate',
      title: 'Rack 4, shelf 2',
      scanId: 'A1-R4-02',
      fields: [
        { label: 'Sito', value: 'A1' },
        { label: 'Tipo', value: 'Scaffale' },
        { label: 'Percorso', value: 'A1-STORE › R4-02' },
        { label: 'Codice', value: 'R4-02' },
      ],
    })
    const zpl = labelZpl(label, { dpi: 203, widthMm: 100, heightMm: 50 }, 2)
    expect(zpl).toContain('^BCN')
    expect(zpl).toContain('^FDA1-R4-02^FS')
    expect(zpl).toContain('^PQ2')
  })
})

describe('blocked locations (SCM-181)', () => {
  const place = { code: 'A1-R4', kind: 'BIN' as const, status: 'ACTIVE', blockReason: null, blockNote: null }
  it('blocks in words: OTHER says why, the until-day not before today, no outside place, never a count’s block', () => {
    expect(blockProblems(place, { reason: 'DAMAGE', until: '2026-11-12' }, '2026-11-11')).toEqual([])
    expect(blockProblems(place, { reason: 'OTHER', note: ' ' }, '2026-11-11')).toEqual([{ path: 'note', message: 'Say why in words (the reason is Other).' }])
    expect(blockProblems(place, { reason: 'DAMAGE', until: '2026-11-10' }, '2026-11-11')[0]!.path).toBe('until')
    expect(blockProblems({ ...place, kind: 'TRANSIT' }, { reason: 'DAMAGE' }, '2026-11-11')[0]!.path).toBe('location')
    expect(blockProblems({ ...place, status: 'ARCHIVED' }, { reason: 'DAMAGE' }, '2026-11-11')[0]!.path).toBe('location')
    expect(blockProblems({ ...place, blockReason: 'COUNT', blockNote: countBlockNote('CNT-1') }, { reason: 'DAMAGE' }, '2026-11-11')[0]!.message).toContain('The count unblocks it')
    expect(blockProblems(place, { reason: 'COUNT', note: countBlockNote('CNT-9') }, '2026-11-11')[0]!.path).toBe('note')
  })

  it('holds until the end of its until-day; a person lifts any block but a running count’s', () => {
    const at = new Date('2026-11-10T08:00:00Z')
    expect(blockHolds({ blockedAt: at, blockReason: 'DAMAGE', blockNote: null, blockedUntil: '2026-11-11' }, '2026-11-11')).toBe(true)
    expect(blockHolds({ blockedAt: at, blockReason: 'DAMAGE', blockNote: null, blockedUntil: '2026-11-11' }, '2026-11-12')).toBe(false)
    expect(blockHolds({ blockedAt: null, blockReason: null, blockNote: null, blockedUntil: null }, '2026-11-12')).toBe(false)
    expect(unblockProblems({ code: 'A1-R4', blockedAt: null, blockReason: null, blockNote: null, blockedUntil: null })[0]!.message).toBe('Location A1-R4 is not blocked.')
    expect(unblockProblems({ code: 'A1-R4', blockedAt: at, blockReason: 'COUNT', blockNote: 'Counting next week.', blockedUntil: null })).toEqual([])
    expect(isACountsBlock({ blockReason: 'COUNT', blockNote: countBlockNote('CNT-2026-0003') })).toBe(true)
  })

  it('a count of a place (nothing narrowing it) blocks its places not blocked already, and lifts only its own', () => {
    expect(countBlocksPlaces({ locationId: 'x', itemId: null, lotId: null, itemKind: null })).toBe(true)
    expect(countBlocksPlaces({ locationId: 'x', itemId: 'i', lotId: null, itemKind: null })).toBe(false)
    expect(countBlocksPlaces({ locationId: null, itemId: null, lotId: null, itemKind: null })).toBe(false)
    const at = new Date('2026-11-10T08:00:00Z')
    const free = { blockedAt: null, blockReason: null, blockNote: null, blockedUntil: null, status: 'ACTIVE' }
    const places = [
      { id: 'a', kind: 'BIN' as const, ...free },
      { id: 'b', kind: 'BIN' as const, ...free, blockedAt: at, blockReason: 'DAMAGE' as const },
      { id: 'c', kind: 'BIN' as const, ...free, blockedAt: at, blockReason: 'DAMAGE' as const, blockedUntil: '2026-11-10' },
      { id: 'd', kind: 'TRANSIT' as const, ...free },
      { id: 'e', kind: 'BIN' as const, ...free, status: 'ARCHIVED' },
    ]
    expect(placesToBlock(places, '2026-11-11').map((entry) => entry.id)).toEqual(['a', 'c'])
    const blocked = [
      { ...places[0]!, blockedAt: at, blockReason: 'COUNT' as const, blockNote: countBlockNote('CNT-1') },
      { ...places[0]!, id: 'f', blockedAt: at, blockReason: 'COUNT' as const, blockNote: countBlockNote('CNT-2') },
      places[1]!,
    ]
    expect(placesToRelease(blocked, 'CNT-1').map((entry) => entry.id)).toEqual(['a'])
  })

  it('finds a place and every place inside it', () => {
    const tree = [
      { id: 's', parentId: null, code: 'S' },
      { id: 'z', parentId: 's', code: 'Z' },
      { id: 'b', parentId: 'z', code: 'B' },
      { id: 'o', parentId: null, code: 'O' },
    ]
    expect(subtreeIds(tree, 's')).toEqual(['s', 'z', 'b'])
    expect(subtreeIds(tree, 'b')).toEqual(['b'])
    expect(subtreeIds(tree, 'nope')).toEqual([])
  })
})

describe('default locations (SCM-179)', () => {
  const row = (itemKind: DefaultRow['itemKind'], locationId: string, kind: DefaultRow['location']['kind'] = 'BIN', status = 'ACTIVE'): DefaultRow => ({ itemKind, locationId, location: { code: locationId.toUpperCase(), kind, status } })

  it("takes the kind's own default, then the fallback when it holds every kind, else none", () => {
    const rows = [row('LINING', 'bulk', 'BULK'), row('TRIM', 'pf', 'PICK_FACE'), row(null, 'dock', 'RECEIVING')]
    expect(resolveDefault(rows, ['LINING'])?.locationId).toBe('bulk')
    expect(resolveDefault(rows, ['LINING', 'LINING'])?.locationId).toBe('bulk')
    expect(resolveDefault(rows, ['LINING', 'TRIM'])?.locationId).toBe('dock')
    expect(resolveDefault(rows, ['LEATHER'])?.locationId).toBe('dock')
    expect(resolveDefault(rows, [])?.locationId).toBe('dock')
    expect(resolveDefault([row(null, 'cut', 'PRODUCTION')], ['FINISHED'])).toBeNull()
    expect(resolveDefault([row('LINING', 'gone', 'BIN', 'ARCHIVED'), row(null, 'dock', 'RECEIVING')], ['LINING'])?.locationId).toBe('dock')
    expect(resolveDefault([], ['LINING'])).toBeNull()
  })

  it('a default place serves its purpose and holds its kind', () => {
    const at = (kind: DefaultRow['location']['kind'], status = 'ACTIVE') => ({ code: 'X', kind, status, siteId: 's' })
    expect(defaultProblems('QUALITY', null, at('QUARANTINE'), 's')).toEqual([])
    expect(defaultProblems('QUALITY', null, at('BIN'), 's')[0]!.message).toBe('Location X is a bin; a quality default is a quarantine place.')
    expect(defaultProblems('ISSUE', 'FINISHED', at('PRODUCTION'), 's')[0]!.message).toContain('does not hold finished garments')
    expect(defaultProblems('RECEIVING', 'LINING', at('FINISHED_GOODS'), 's')[0]!.message).toContain('does not hold materials')
    expect(defaultProblems('RECEIVING', null, at('BIN', 'ARCHIVED'), 's')[0]!.message).toBe('Location X is archived.')
    expect(defaultProblems('RECEIVING', null, at('BIN'), 'other')[0]!.message).toBe('Not a location of this site.')
    expect(defaultProblems('RECEIVING', null, null, 's')[0]!.message).toBe('Not a location of this site.')
  })
})

describe('the events (B-W2b-289)', () => {
  it('declares three, each read live with inventory.locations.view', () => {
    expect(events.map((event) => [event.type, event.live?.permission])).toEqual([
      ['inventory.location_blocked', 'inventory.locations.view'],
      ['inventory.location_label_changed', 'inventory.locations.view'],
      ['inventory.default_location_changed', 'inventory.locations.view'],
    ])
  })
})
