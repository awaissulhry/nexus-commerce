import { describe, expect, it } from 'vitest'
import { ForbiddenError, ValidationError } from '../core/errors'
import { evidenceFor, evidenceNeeds, normalizeTypedName, typedNameProblem, userAgentOf } from './evidence'

const sentTo = { email: 'buyer@example.com' }
const noEmail = { email: null }

const issuesOf = (work: () => unknown): string[] => {
  try {
    work()
  } catch (error) {
    if (error instanceof ValidationError) return (error.issues ?? []).map((issue) => `${issue.path}: ${issue.message}`)
    throw error
  }
  return []
}

describe('the typed name', () => {
  it('is kept as typed, trimmed, with inner spaces collapsed (NFC)', () => {
    expect(normalizeTypedName('  Ada \t  Example ')).toBe('Ada Example')
    expect(normalizeTypedName('José Example')).toBe('José Example')
  })

  it('needs 2 to 200 characters with a letter and no control character', () => {
    expect(typedNameProblem('Ada Example')).toBeNull()
    expect(typedNameProblem('A')).toMatch(/2 to 200/)
    expect(typedNameProblem('x'.repeat(201))).toMatch(/2 to 200/)
    expect(typedNameProblem('12 34')).toMatch(/letters/)
    expect(typedNameProblem('Ada\u0007Example')).toMatch(/cannot be typed/)
  })
})

describe('evidenceFor', () => {
  it('accepts a quote with the typed name and the address it was sent to (ported evidence)', () => {
    expect(evidenceFor('QUOTE_ACCEPT', 'accept', sentTo, { typedName: ' Ada  Example ', email: ' Buyer@Example.com ' })).toEqual({
      action: 'ACCEPTED',
      counts: true,
      typedName: 'Ada Example',
      emailCheck: 'MATCHED',
    })
  })

  it('refuses an accept without a name, without the address, or with another address', () => {
    expect(issuesOf(() => evidenceFor('QUOTE_ACCEPT', 'accept', sentTo, {}))).toEqual([
      'typedName: Type your full name to confirm.',
      'email: Type the email address this link was sent to.',
    ])
    expect(issuesOf(() => evidenceFor('QUOTE_ACCEPT', 'accept', sentTo, { typedName: 'Ada Example', email: 'other@example.com' }))).toEqual([
      'email: This is not the address this link was sent to.',
    ])
    expect(issuesOf(() => evidenceFor('QUOTE_ACCEPT', 'accept', sentTo, { typedName: '7', email: 'buyer@example.com' }))).toEqual([
      expect.stringMatching(/^typedName: Type your full name \(2 to 200/),
    ])
  })

  it('records NOT_KNOWN when the link has no address to compare', () => {
    expect(evidenceFor('QUOTE_ACCEPT', 'accept', noEmail, { typedName: 'Ada Example', email: 'whatever@example.com' }).emailCheck).toBe('NOT_KNOWN')
  })

  it('lets a decline go without a name, and keeps one when given', () => {
    expect(evidenceFor('QUOTE_ACCEPT', 'decline', sentTo, {})).toEqual({ action: 'DECLINED', counts: true, typedName: null, emailCheck: 'NOT_ASKED' })
    expect(evidenceFor('PO_CONFIRM', 'confirm', sentTo, { typedName: 'Bo Example' }).typedName).toBe('Bo Example')
  })

  it('records an open without asking anything, counted only for the view purposes', () => {
    expect(evidenceFor('QUOTE_ACCEPT', 'open', sentTo, { typedName: 'ignored' })).toEqual({ action: 'OPENED', counts: false, typedName: null, emailCheck: 'NOT_ASKED' })
    expect(evidenceFor('DOCUMENT_VIEW', 'open', noEmail).counts).toBe(true)
  })

  it('refuses an action the purpose does not allow', () => {
    expect(() => evidenceFor('PO_CONFIRM', 'accept', sentTo, { typedName: 'Bo Example' })).toThrow(ForbiddenError)
    expect(() => evidenceFor('DOCUMENT_VIEW', 'confirm', sentTo)).toThrow(ForbiddenError)
  })

  it('tells the page what to ask', () => {
    expect(evidenceNeeds('QUOTE_ACCEPT', 'accept', sentTo)).toEqual({ typedName: 'required', email: true })
    expect(evidenceNeeds('QUOTE_ACCEPT', 'accept', noEmail)).toEqual({ typedName: 'required', email: false })
    expect(evidenceNeeds('PO_CONFIRM', 'accept', sentTo)).toEqual({ typedName: 'none', email: false })
  })
})

describe('userAgentOf', () => {
  it('caps at 300 characters, drops control characters, and is null without one', () => {
    expect(userAgentOf('x'.repeat(400))).toHaveLength(300)
    expect(userAgentOf('Agent/1.0\r\nInjected: yes')).toBe('Agent/1.0Injected: yes')
    expect(userAgentOf('   ')).toBeNull()
    expect(userAgentOf(undefined)).toBeNull()
  })
})
