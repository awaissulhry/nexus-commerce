import { describe, expect, it } from 'vitest'
import { adoptContentVersions, contentVersionsOf, preserveContentVersions } from './contentVersions'

const pin = { tier: 'pin', language: 'it' }
const row = () => ({
  id: 'p1',
  values: {
    bulletPoints_1: { contentAddress: pin, contentVersion: 4 },
    bulletPoints_2: { contentAddress: pin, contentVersion: 4 },
    title_de: { contentAddress: { tier: 'pin', language: 'de' }, contentVersion: 9 },
    shared: { contentAddress: { tier: 'language', language: 'it' }, contentVersion: 2 },
    material: { contentAddress: null },
  } as Record<string, { contentAddress: { tier: string; language?: string } | null; contentVersion?: number }>,
})

describe('replacement rows keep the versions already confirmed for their owners', () => {
  const snapshot = (productVersion = 8, listingId = 'listing-a', listingVersion = 83) => ({
    id: 'p1', version: productVersion, listing: { id: listingId, version: listingVersion },
    values: {
      title: { value: 'incoming text', contentAddress: { tier: 'language', language: 'de' }, contentVersion: 5 },
      bullet: { value: 'incoming bullet', contentAddress: { tier: 'pin', language: 'it' }, contentVersion: 9 },
      other: { value: 'other language', contentAddress: { tier: 'language', language: 'fr' }, contentVersion: 2 },
    },
  })
  it('preserves product, listing and content versions without replacing new values', () => {
    const previous = snapshot(), incoming = snapshot(7, 'listing-a', 82)
    previous.values.title.value = 'older displayed value'
    incoming.values.title.contentVersion = 4
    incoming.values.bullet.contentVersion = 8
    incoming.values.other.contentVersion = 12
    expect(preserveContentVersions(previous, incoming, 8)).toBe(incoming)
    expect(incoming.version).toBe(8)
    expect(incoming.listing.version).toBe(83)
    expect(incoming.values.title).toMatchObject({ value: 'incoming text', contentVersion: 5 })
    expect(incoming.values.bullet.contentVersion).toBe(9)
    expect(incoming.values.other.contentVersion).toBe(12)
  })
  it('keeps pins on their own listing when an account or alias changes', () => {
    const previous = snapshot(), incoming = snapshot(7, 'listing-b', 1)
    incoming.values.title.contentVersion = 4
    incoming.values.bullet.contentVersion = 1
    preserveContentVersions(previous, incoming, 8)
    expect(incoming.values.title.contentVersion).toBe(5)
    expect(incoming.listing.version).toBe(1)
    expect(incoming.values.bullet.contentVersion).toBe(1)
  })
  it('never carries versions to another product', () => {
    const previous = snapshot(), incoming = { ...snapshot(1, 'listing-b', 1), id: 'p2' }
    incoming.values.title.contentVersion = 1
    preserveContentVersions(previous, incoming, 8)
    expect(incoming.version).toBe(1)
    expect(incoming.values.title.contentVersion).toBe(1)
  })
  it('accepts recreated translations from a newer owner snapshot', () => {
    const incoming = snapshot(9, 'listing-a', 84)
    incoming.values.title.contentVersion = 1
    incoming.values.bullet.contentVersion = 1
    preserveContentVersions(snapshot(), incoming, 8)
    expect(incoming.values.title.contentVersion).toBe(1)
    expect(incoming.values.bullet.contentVersion).toBe(1)
  })
  it('uses the writer version when the previous master row has not been refreshed', () => {
    const previous = snapshot(7), incoming = snapshot(8)
    incoming.values.title.contentVersion = 4
    preserveContentVersions(previous, incoming, 8)
    expect(incoming.values.title.contentVersion).toBe(5)
  })
  it('finds the content owner across renamed language columns', () => {
    const previous = snapshot(), incoming = { ...snapshot(7), values: {
      description_de: { contentAddress: { tier: 'language', language: 'de' }, contentVersion: 4 },
      unaddressed: { contentAddress: null },
    } }
    preserveContentVersions(previous, incoming, 8)
    expect(incoming.values.description_de.contentVersion).toBe(5)
    expect(incoming.values.unaddressed).not.toHaveProperty('contentVersion')
  })
})

describe('a save moves the write token of every cell on the content row it wrote', () => {
  it('moves the pin cells of that language on that row, and nothing else', () => {
    const r = row()
    expect(adoptContentVersions(r, { contentVersions: [{ id: 'p1', tier: 'pin', language: 'it', version: 5 }] })).toEqual(['bulletPoints_1', 'bulletPoints_2'])
    expect(r.values.bulletPoints_1.contentVersion).toBe(5)
    expect(r.values.bulletPoints_2.contentVersion).toBe(5)
    expect(r.values.title_de.contentVersion).toBe(9)
    expect(r.values.shared.contentVersion).toBe(2)
    expect(r.values.material.contentVersion).toBeUndefined()
  })
  it('ignores another row, a malformed entry, and an answer without versions', () => {
    const r = row()
    expect(adoptContentVersions(r, { contentVersions: [{ id: 'p2', tier: 'pin', language: 'it', version: 5 }, { id: 'p1', tier: 'source', language: 'it', version: 5 }, { id: 'p1', tier: 'pin', language: 'it', version: '5' }] })).toEqual([])
    expect(adoptContentVersions(r, { updated: 1 })).toEqual([])
    expect(adoptContentVersions(null, { contentVersions: [] })).toEqual([])
    expect(contentVersionsOf({ contentVersions: 'x' })).toEqual([])
    expect(r.values.bulletPoints_1.contentVersion).toBe(4)
  })
  it('moves a shared language across aliases, keeping other products, languages and pins separate', () => {
    const primary = row(), alias = row(), other = { ...row(), id: 'p2' }
    alias.values.shared_de = { contentAddress: { tier: 'language', language: 'de' }, contentVersion: 9 }
    expect(adoptContentVersions(primary, { contentVersions: [{ id: 'p1', tier: 'language', language: 'it', version: 3 }] }, [primary, alias, other])).toEqual(['shared'])
    expect(primary.values.shared.contentVersion).toBe(3)
    expect(alias.values.shared.contentVersion).toBe(3)
    expect(alias.values.shared_de.contentVersion).toBe(9)
    expect(other.values.shared.contentVersion).toBe(2)
    adoptContentVersions(primary, { contentVersions: [{ id: 'p1', tier: 'pin', language: 'it', version: 5 }] }, [alias])
    expect(alias.values.bulletPoints_1.contentVersion).toBe(4)
    expect(primary.values.bulletPoints_1.contentVersion).toBe(5)
  })
})
