import { describe, expect, it } from 'vitest'
import { askExcerpt, DESIGNER_ASK_EXCERPT, designerAskAuthor, designerAskNote, designerAskWords, isDesignerAskNote, mayAskOn } from './designer/rules' // B-CP-079
import { EVENT_DEFINITIONS } from '../events/catalogue' // B-CP-079
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
  noteMayGoToFloor,
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

describe('a note for the floor (B-W2b-F5)', () => {
  it('belongs to a work order, the one record with tablets working on it', () => {
    expect(noteMayGoToFloor('WorkOrder')).toBe(true)
    for (const type of ['Quote', 'SalesOrder', 'PurchaseOrder', 'workorder']) expect(noteMayGoToFloor(type), type).toBe(false)
  })
})

describe('thread status', () => {
  it('closes and reopens, and refuses a move to itself', () => {
    expect(() => assertTransition(threadMachine, 'OPEN', 'CLOSED')).not.toThrow()
    expect(() => assertTransition(threadMachine, 'CLOSED', 'OPEN')).not.toThrow()
    expect(() => assertTransition(threadMachine, 'CLOSED', 'CLOSED')).toThrow(InvalidStateError)
  })
})

// ---- B-CP-079 (customer page plan C7, D12; lead pick B6) ------------------------------------------------------------------------
describe('B-CP-079: asking the factory designer', () => {
  it('quotes at most the first 80 characters of the message, on one line, cut with "…"', () => {
    expect(askExcerpt('  Made-up:\n  a short question  ')).toBe('Made-up: a short question')
    const long = `${'x'.repeat(DESIGNER_ASK_EXCERPT)}and a price of 410.00 after it`
    expect(askExcerpt(long)).toBe(`${'x'.repeat(DESIGNER_ASK_EXCERPT)}…`)
    expect([...askExcerpt('é'.repeat(100))]).toHaveLength(DESIGNER_ASK_EXCERPT + 1)
    expect(designerAskNote('Brand Alpha', 'Made-up: the logo?')).toBe('Brand Alpha chiede al designer della fabbrica · asks the factory designer: «Made-up: the logo?»')
  })

  it('knows its own note by its shape: a SYSTEM internal note by "<customer> (portal)"', () => {
    const note = { direction: 'INTERNAL_NOTE', authorKind: 'SYSTEM', authorName: designerAskAuthor('Brand Alpha') }
    expect(isDesignerAskNote(note, 'Brand Alpha')).toBe(true)
    expect(isDesignerAskNote(note, 'Brand Beta')).toBe(false)
    expect(isDesignerAskNote({ ...note, authorName: null }, 'Brand Alpha')).toBe(false)
    expect(isDesignerAskNote({ ...note, authorKind: 'USER' }, 'Brand Alpha')).toBe(false)
  })

  it('asks only on the records a customer writes on; says why not in the portal’s words; ids only in its event', () => {
    for (const type of ['PortalOrderRequest', 'SalesOrder', 'Inquiry', 'SampleRound', 'Project', 'Party', 'ReturnAuthorisation', 'Complaint']) expect(mayAskOn(type), type).toBe(true)
    for (const type of ['WorkOrder', 'Invoice', 'Shipment']) expect(mayAskOn(type), type).toBe(false)
    expect(designerAskWords('ASKED', 'it', 'Giulia Verdi')).toBe('Abbiamo chiesto a Giulia Verdi.')
    expect(designerAskWords('NOT_HERE', 'en')).toBe('The factory designer cannot be asked here: your message reaches our team.')
    const event = EVENT_DEFINITIONS.find((definition) => definition.type === 'thread.factory_designer_asked')
    expect(event).toBeDefined()
    expect(event!.live ?? null).toBeNull()
    expect(Object.keys((event!.payload as unknown as { shape: Record<string, unknown> }).shape).sort()).toEqual(['messageId', 'noteId', 'recordId', 'recordType', 'threadId'])
  })
})
// ---- end B-CP-079
