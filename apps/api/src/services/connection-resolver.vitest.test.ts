/**
 * MAP.3 — the resolver's decision logic.
 *
 * `chooseConnection` is deliberately pure so the rule that matters — fail closed
 * on ambiguity, never pick — can be tested without a database, per the repo's
 * vitest convention.
 *
 * The single most important case here is `throws when two accounts are active and
 * the caller did not name one`. That is the behaviour the whole phase exists to
 * create; if it ever regresses to "returns the first", a push lands in the wrong
 * store and nothing complains.
 */

import { describe, it, expect } from 'vitest'
import {
  chooseConnection,
  AmbiguousConnectionError,
  NoConnectionError,
} from './connection-resolver.service.js'

type Row = { id: string; channelType: string; isActive: boolean; isPrimary: boolean }

const conn = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  channelType: 'EBAY',
  isActive: true,
  isPrimary: false,
  ...over,
})

describe('chooseConnection — one account (today, and every state until MAP.4)', () => {
  it('returns the single active account, primary or not', () => {
    expect(chooseConnection([conn('a')], { channel: 'EBAY' }).id).toBe('a')
    expect(chooseConnection([conn('a', { isPrimary: true })], { channel: 'EBAY' }).id).toBe('a')
  })

  it('ignores inactive rows — 9 of the 11 prod rows are revoked grants', () => {
    const rows = [conn('dead1', { isActive: false }), conn('live'), conn('dead2', { isActive: false })]
    expect(chooseConnection(rows, { channel: 'EBAY' }).id).toBe('live')
  })

  it('ignores other channels — the resolver is channel-scoped, never global', () => {
    const rows = [conn('amz', { channelType: 'AMAZON' }), conn('eb')]
    expect(chooseConnection(rows, { channel: 'EBAY' }).id).toBe('eb')
    expect(chooseConnection(rows, { channel: 'AMAZON' }).id).toBe('amz')
  })
})

describe('chooseConnection — the fail-closed rule', () => {
  it('THROWS when two accounts are active and the caller did not name one', () => {
    const rows = [conn('a'), conn('b')]
    expect(() => chooseConnection(rows, { channel: 'EBAY' })).toThrow(AmbiguousConnectionError)
  })

  it('never silently returns the first of several — the defect this replaces', () => {
    const rows = [conn('a'), conn('b'), conn('c')]
    let returned: unknown = 'NOTHING WAS RETURNED'
    try {
      returned = chooseConnection(rows, { channel: 'EBAY' })
    } catch {
      /* expected */
    }
    expect(returned).toBe('NOTHING WAS RETURNED')
  })

  it('names every candidate in the error, so the operator can see the fork', () => {
    const rows = [conn('a'), conn('b')]
    try {
      chooseConnection(rows, { channel: 'EBAY' })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AmbiguousConnectionError)
      const err = e as AmbiguousConnectionError
      expect(err.candidateIds).toEqual(['a', 'b'])
      expect(err.channel).toBe('EBAY')
      expect(err.code).toBe('AMBIGUOUS_CONNECTION')
    }
  })

  it('carries the caller hint into the message so the throw is traceable', () => {
    try {
      chooseConnection([conn('a'), conn('b')], { channel: 'EBAY', hint: 'while polling feeds' })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as Error).message).toContain('while polling feeds')
    }
  })
})

describe('chooseConnection — the declared primary', () => {
  it('resolves to the primary when several are active and primary was asked for', () => {
    const rows = [conn('a'), conn('b', { isPrimary: true }), conn('c')]
    expect(chooseConnection(rows, { channel: 'EBAY', wantPrimary: true }).id).toBe('b')
  })

  it('still throws when several are active and NONE is primary', () => {
    const rows = [conn('a'), conn('b')]
    expect(() => chooseConnection(rows, { channel: 'EBAY', wantPrimary: true })).toThrow(
      AmbiguousConnectionError,
    )
  })

  it('still throws when several claim primary — the DB index should prevent it, so say so loudly', () => {
    const rows = [conn('a', { isPrimary: true }), conn('b', { isPrimary: true })]
    try {
      chooseConnection(rows, { channel: 'EBAY', wantPrimary: true })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AmbiguousConnectionError)
      expect((e as Error).message).toContain('2 accounts claim to be primary')
    }
  })

  it('wantPrimary is irrelevant when only one account is active', () => {
    expect(chooseConnection([conn('only')], { channel: 'EBAY', wantPrimary: true }).id).toBe('only')
  })
})

describe('chooseConnection — nothing to resolve', () => {
  it('throws NoConnectionError when the channel has no active account', () => {
    expect(() => chooseConnection([], { channel: 'EBAY' })).toThrow(NoConnectionError)
    expect(() => chooseConnection([conn('x', { isActive: false })], { channel: 'EBAY' })).toThrow(
      NoConnectionError,
    )
  })

  it('distinguishes "none" from "too many" — they need different operator action', () => {
    const none = (() => {
      try {
        chooseConnection([], { channel: 'EBAY' })
      } catch (e) {
        return e
      }
    })()
    const many = (() => {
      try {
        chooseConnection([conn('a'), conn('b')], { channel: 'EBAY' })
      } catch (e) {
        return e
      }
    })()
    expect((none as NoConnectionError).code).toBe('NO_CONNECTION')
    expect((many as AmbiguousConnectionError).code).toBe('AMBIGUOUS_CONNECTION')
  })
})
