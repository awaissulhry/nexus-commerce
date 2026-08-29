/**
 * MS.7 — handing a channel field back to the master.
 *
 * The shape of the Prisma `data` IS the contract here, so it is asserted directly. The failure that
 * matters most is destroying a live listing's real value while "tidying up": for rows predating the
 * Phase 20 SSOT split the pinned price lives in the DIRECT `price` column, which is also what the
 * channel is carrying right now. Clearing it would erase the record of a live listing's price.
 */
import { describe, it, expect } from 'vitest'
import {
  FOLLOWABLE_FIELDS,
  followFlagColumn,
  followUpdateData,
  isFollowableField,
  overrideColumn,
  pinnedFields,
} from '../pim/channel-follows.service.js'

describe('followUpdateData', () => {
  it('hands a field back to the master and clears only the EXPLICIT override', () => {
    // `price` (the direct column) is what the channel is actually carrying — not ours to erase.
    expect(followUpdateData('price', true)).toEqual({ followMasterPrice: true, priceOverride: null })
    expect(followUpdateData('price', true)).not.toHaveProperty('price')
  })

  it('pins a field without inventing a value for it', () => {
    // Pinning keeps whatever the channel already has; writing a value here would be a guess.
    expect(followUpdateData('price', false)).toEqual({ followMasterPrice: false })
  })

  it('never clears an override when pinning', () => {
    for (const f of FOLLOWABLE_FIELDS) {
      const data = followUpdateData(f, false)
      expect(Object.values(data)).toEqual([false])
    }
  })

  it('maps every followable field to its own flag, with no collisions', () => {
    const flags = FOLLOWABLE_FIELDS.map(followFlagColumn)
    expect(new Set(flags).size).toBe(FOLLOWABLE_FIELDS.length)
    expect(flags).toContain('followMasterBulletPoints')
    expect(flags).toContain('followMasterImages')
  })

  it('handles images, which have a flag but no override column', () => {
    // A gallery is a relation, not a scalar — inventing an `imagesOverride: null` would throw.
    expect(overrideColumn('images')).toBeNull()
    expect(followUpdateData('images', true)).toEqual({ followMasterImages: true })
  })

  it('clears the override for every field that has one', () => {
    for (const f of FOLLOWABLE_FIELDS) {
      const col = overrideColumn(f)
      const data = followUpdateData(f, true)
      expect(data[followFlagColumn(f)]).toBe(true)
      if (col) expect(data[col]).toBeNull()
      else expect(Object.keys(data)).toEqual([followFlagColumn(f)])
    }
  })
})

describe('isFollowableField', () => {
  it('accepts exactly the six fields that carry a flag', () => {
    for (const f of FOLLOWABLE_FIELDS) expect(isFollowableField(f)).toBe(true)
  })

  it('rejects a JSONB attribute, which has no flag at all', () => {
    // The design's known limit: attributes derive follow-ness from the resolver's source, and a
    // route that pretended to pin one would write a column that does not exist.
    expect(isFollowableField('material')).toBe(false)
    expect(isFollowableField('attr_material')).toBe(false)
    expect(isFollowableField('country_of_origin')).toBe(false)
  })

  it('rejects nonsense rather than coercing it', () => {
    expect(isFollowableField(undefined)).toBe(false)
    expect(isFollowableField(null)).toBe(false)
    expect(isFollowableField(1)).toBe(false)
    expect(isFollowableField('')).toBe(false)
    expect(isFollowableField('followMasterPrice')).toBe(false)
  })
})

describe('pinnedFields', () => {
  it('names the fields a listing has taken off the master', () => {
    expect(pinnedFields({ followMasterTitle: false, followMasterPrice: false, followMasterQuantity: true })).toEqual(['title', 'price'])
  })

  it('treats an absent flag as following, matching the schema default', () => {
    // The column defaults to true; an undefined flag must not read as "pinned".
    expect(pinnedFields({})).toEqual([])
    expect(pinnedFields({ followMasterPrice: undefined })).toEqual([])
  })

  it('reports nothing pinned when every flag follows', () => {
    const all = Object.fromEntries(FOLLOWABLE_FIELDS.map((f) => [followFlagColumn(f), true]))
    expect(pinnedFields(all)).toEqual([])
  })

  it('reports all six when everything is pinned', () => {
    const none = Object.fromEntries(FOLLOWABLE_FIELDS.map((f) => [followFlagColumn(f), false]))
    expect(pinnedFields(none).sort()).toEqual([...FOLLOWABLE_FIELDS].sort())
  })
})
