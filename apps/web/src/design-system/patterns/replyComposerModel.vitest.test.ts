import { describe, expect, it } from 'vitest'
import { REPLY_EMPTY_HELD, REPLY_SENT_HELD, replyHeldReason, replyLengthWords, replyOverWords } from './replyComposerModel'

const NO_PERMISSION = "You need 'Manage reviews' to reply."
const long = 'a'.repeat(538)

describe('replyHeldReason — the first reason that applies wins', () => {
  it('puts the page reason (no permission) first', () => {
    expect(replyHeldReason({ held: NO_PERMISSION, sent: true, text: long, limit: 500 })).toBe(NO_PERMISSION)
    expect(replyHeldReason({ held: NO_PERMISSION, text: '', limit: 500 })).toBe(NO_PERMISSION)
  })
  it('then a reply already sent', () => {
    expect(replyHeldReason({ sent: true, text: long, limit: 500 })).toBe(REPLY_SENT_HELD)
  })
  it('then a text over the limit, in words', () => {
    expect(replyHeldReason({ text: long, limit: 500 })).toBe('Cut 38 characters to send it (the limit is 500).')
    expect(replyHeldReason({ text: 'a'.repeat(501), limit: 500 })).toBe('Cut 1 character to send it (the limit is 500).')
  })
  it('then an empty reply', () => {
    expect(replyHeldReason({ text: '   ', limit: 500 })).toBe(REPLY_EMPTY_HELD)
    expect(replyHeldReason({ text: '', limit: null })).toBe(REPLY_EMPTY_HELD)
  })
  it('lets a reply within the limit (or with no limit) be sent', () => {
    expect(replyHeldReason({ text: 'Grazie Marco!', limit: 500 })).toBeNull()
    expect(replyHeldReason({ text: long, limit: null })).toBeNull()
    expect(replyHeldReason({ held: null, sent: false, text: 'a'.repeat(500), limit: 500 })).toBeNull()
  })
  it('counts characters as a person sees them', () => {
    expect(replyHeldReason({ text: '👍🏽'.repeat(500), limit: 500 })).toBeNull()
  })
})

describe('words', () => {
  it('says the length without a limit', () => {
    expect(replyLengthWords('Hi')).toBe('2 characters')
    expect(replyLengthWords('a')).toBe('1 character')
  })
  it('says how much to cut', () => {
    expect(replyOverWords(1200, 5000)).toBe('Cut 1,200 characters to send it (the limit is 5,000).')
  })
})
