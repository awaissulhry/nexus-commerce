import { describe, expect, it } from 'vitest'
import { InvalidStateError } from '../core/errors'
import { assertTransition } from '../state/machine'
import {
  audienceOf,
  cleanBody,
  excerptOf,
  isReplyToken,
  MAX_ATTACHMENTS,
  MAX_BODY_LENGTH,
  MAX_MENTIONS,
  newReplyToken,
  noteProblems,
  REPLY_TOKEN_LENGTH,
  threadMachine,
  uniqueIds,
} from './rules'

describe('reply token (COL-020)', () => {
  it('is 26 lower-case base32 characters from 130 random bits', () => {
    const token = newReplyToken()
    expect(token).toHaveLength(REPLY_TOKEN_LENGTH)
    expect(isReplyToken(token)).toBe(true)
    expect(new Set(Array.from({ length: 200 }, () => newReplyToken())).size).toBe(200)
  })

  it('encodes the given bytes as RFC 4648 base32, lower case', () => {
    // 0x00… → all "a"; 0xff… → all "7"; one set bit at the top → "q" (16) then "a"s.
    expect(newReplyToken((bytes) => bytes.fill(0))).toBe('a'.repeat(26))
    expect(newReplyToken((bytes) => bytes.fill(0xff))).toBe('7'.repeat(26))
    expect(newReplyToken((bytes) => (bytes.fill(0), (bytes[0] = 0x80)))).toBe(`q${'a'.repeat(25)}`)
  })

  it('refuses what is not one', () => {
    for (const value of ['A'.repeat(26), 'a'.repeat(25), 'a'.repeat(27), `${'a'.repeat(25)}1`, `${'a'.repeat(25)}-`, null, 42]) {
      expect(isReplyToken(value)).toBe(false)
    }
  })
})

describe('who a message is for (COL-003)', () => {
  it('keeps an internal note to the office and shares the rest with the party', () => {
    expect(audienceOf('INTERNAL_NOTE')).toBe('OFFICE')
    expect(audienceOf('OUTBOUND')).toBe('PARTNER')
    expect(audienceOf('INBOUND')).toBe('PARTNER')
  })
})

describe('a note', () => {
  it('cleans its text: line breaks, control characters, outer space', () => {
    expect(cleanBody('  one\r\ntwo\rthree\u0000\u0007\tfour  \n')).toBe('one\ntwo\nthree\tfour')
  })

  it('needs text or a file, and stays within the limits', () => {
    expect(noteProblems({ bodyText: 'Hello', mentions: [], attachments: [] })).toEqual([])
    expect(noteProblems({ bodyText: '', mentions: [], attachments: ['x'] })).toEqual([])
    expect(noteProblems({ bodyText: '', mentions: [], attachments: [] })).toEqual([{ path: 'body/body', message: 'Write something, or attach a file.' }])
    const many = (n: number) => Array.from({ length: n }, (_, index) => String(index))
    const problems = noteProblems({ bodyText: 'x'.repeat(MAX_BODY_LENGTH + 1), mentions: many(MAX_MENTIONS + 1), attachments: many(MAX_ATTACHMENTS + 1) })
    expect(problems.map((problem) => problem.path)).toEqual(['body/body', 'body/mentions', 'body/attachments'])
  })

  it('takes each id once, in order', () => {
    expect(uniqueIds(['b', 'a', 'b', 'c', 'a'])).toEqual(['b', 'a', 'c'])
    expect(uniqueIds(undefined)).toEqual([])
  })

  it('shows one line of at most 280 characters on the timeline', () => {
    expect(excerptOf('one\n\n two   three')).toBe('one two three')
    const long = excerptOf('word '.repeat(100))
    expect(long).toHaveLength(280)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('thread status', () => {
  it('closes and reopens, and refuses a move to itself', () => {
    expect(() => assertTransition(threadMachine, 'OPEN', 'CLOSED')).not.toThrow()
    expect(() => assertTransition(threadMachine, 'CLOSED', 'OPEN')).not.toThrow()
    expect(() => assertTransition(threadMachine, 'CLOSED', 'CLOSED')).toThrow(InvalidStateError)
  })
})
