import { describe, expect, it } from 'vitest'

import { blockingIssues, isPhotoChangeId, type StudioPublishIssue } from './studio-publication.js'

const id = (field: string) => JSON.stringify(['parent', field])
const season: StudioPublishIssue = { productId: 'parent', field: 'season', severity: 'error', message: 'Season: Season contains an unaccepted value.' }
const account: StudioPublishIssue = { severity: 'error', message: 'Reconnect this account before publishing.' }

describe('photos-only publishing (Images rebuild P4c)', () => {
  it('knows the photo fields of the change review', () => {
    expect([id('pictures'), id('Pictures'), id('variationPictures')].every(isPhotoChangeId)).toBe(true)
    expect(isPhotoChangeId(id('title'))).toBe(false)
    expect(isPhotoChangeId('not json')).toBe(false)
  })
  it('an error on another field does not block a photos-only selection; it blocks any other', () => {
    expect(blockingIssues([season], [id('pictures'), id('Pictures')])).toEqual([])
    expect(blockingIssues([season], [id('pictures'), id('title')])).toEqual([season])
    expect(blockingIssues([season], [])).toEqual([season])
  })
  it('an error that names no field blocks everything, photos included; warnings never block', () => {
    expect(blockingIssues([season, account], [id('pictures')])).toEqual([season, account])
    expect(blockingIssues([{ ...season, severity: 'warning' }], [id('title')])).toEqual([])
  })
})
