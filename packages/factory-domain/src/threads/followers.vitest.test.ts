import { describe, expect, it } from 'vitest'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { autoFollows, followChange, FOLLOW_REASONS } from './followers'

describe('followers of a record (B-W2a-20: COL-011)', () => {
  it('follows on its own only when the person has no follow row (a muted one stays muted)', () => {
    expect(autoFollows(null)).toBe(true)
    expect(autoFollows({ muted: true })).toBe(false)
    expect(autoFollows({ muted: false })).toBe(false)
    expect(FOLLOW_REASONS).toEqual(['CREATOR', 'ASSIGNEE', 'MENTIONED', 'CHOSE'])
  })

  it('my own follow: add, remove (unfollow), mute, unmute, or nothing', () => {
    expect(followChange(null, { following: true, muted: false })).toBe('ADD')
    expect(followChange(null, { following: true, muted: true })).toBe('ADD')
    expect(followChange(null, { following: false, muted: false })).toBeNull()
    expect(followChange({ muted: false }, { following: false, muted: false })).toBe('REMOVE')
    expect(followChange({ muted: false }, { following: true, muted: true })).toBe('MUTE')
    expect(followChange({ muted: true }, { following: true, muted: false })).toBe('UNMUTE')
    expect(followChange({ muted: true }, { following: true, muted: true })).toBeNull()
    expect(EVENT_CATALOGUE.get('thread.followers_changed', 1).live?.permission).toBe('threads.read')
  })
})
