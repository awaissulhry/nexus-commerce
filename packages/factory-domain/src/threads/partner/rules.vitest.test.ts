import { describe, expect, it } from 'vitest'
import { MAX_ATTACHMENTS, MAX_BODY_LENGTH } from '../rules'
import { composerOf, partnerLocaleOf, partnerThreadWords, PARTNER_THREAD_WORDS, postProblems, sideOf } from './rules'

describe('a record thread as the partner sees it (B-W2b-168; COL-059, COL-060)', () => {
  it('reads our side and theirs, never an internal note', () => {
    expect(sideOf('OUTBOUND')).toBe('COMPANY')
    expect(sideOf('INBOUND')).toBe('PARTNER')
    expect(() => sideOf('INTERNAL_NOTE')).toThrow(/never shown/)
  })

  it('offers the composer only to a person who may comment, on an open thread, outside a preview', () => {
    expect(composerOf({ threadStatus: 'OPEN', mayComment: true, preview: false })).toEqual({ canPost: true, reason: null })
    // No thread yet: the first post makes it.
    expect(composerOf({ threadStatus: null, mayComment: true, preview: false })).toEqual({ canPost: true, reason: null })
    expect(composerOf({ threadStatus: 'CLOSED', mayComment: true, preview: false })).toEqual({ canPost: false, reason: 'CLOSED' })
    expect(composerOf({ threadStatus: 'OPEN', mayComment: false, preview: false })).toEqual({ canPost: false, reason: 'NO_COMMENT' })
    // The first reason that holds: a preview says it is a preview, whatever else.
    expect(composerOf({ threadStatus: 'CLOSED', mayComment: false, preview: true })).toEqual({ canPost: false, reason: 'PREVIEW' })
  })

  it('says it in the person’s language, Italian unless English, with the company named', () => {
    expect(partnerLocaleOf('en')).toBe('en')
    expect(partnerLocaleOf('de')).toBe('it')
    expect(partnerLocaleOf(null)).toBe('it')
    expect(partnerThreadWords('CLOSED', 'en', 'Made-up Factory')).toBe('Made-up Factory closed this conversation: no new message can be added.')
    expect(partnerThreadWords('CLOSED', 'it', 'Made-up Factory')).toContain('Made-up Factory ha chiuso')
    expect(partnerThreadWords('REPLY_BY_EMAIL', 'en', 'x')).toBe('You can also answer our e-mails: your reply lands here.')
    for (const words of Object.values(PARTNER_THREAD_WORDS)) {
      expect(words.it.length).toBeGreaterThan(0)
      expect(words.en.length).toBeGreaterThan(0)
    }
  })

  it('needs text or a file, within the limits', () => {
    expect(postProblems({ bodyText: 'When does it ship?', attachments: [] })).toEqual([])
    expect(postProblems({ bodyText: '', attachments: ['f'] })).toEqual([])
    expect(postProblems({ bodyText: '', attachments: [] })).toEqual([{ path: 'body/body', message: 'Write something, or attach a file.' }])
    expect(postProblems({ bodyText: 'x'.repeat(MAX_BODY_LENGTH + 1), attachments: [] })[0]?.path).toBe('body/body')
    expect(postProblems({ bodyText: 'x', attachments: Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => `f${i}`) })[0]?.path).toBe('body/attachments')
  })
})
