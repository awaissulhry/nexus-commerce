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
  isOwnConnection,
  AmbiguousConnectionError,
  NoConnectionError,
} from './connection-resolver.service.js'
import { withWorkspace } from '../lib/workspace-context.js'

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

describe('chooseConnection — another business\'s account is never chosen for you (2026-09-28)', () => {
  // Business B sees its own accounts and, through a grant, one of business A's (each business has its own primary).
  const inB = <T>(work: () => T) => withWorkspace({ workspaceId: 'ws_b', actorUserId: null, membershipId: null, roleKeys: [] }, work)
  const own = (id: string, over: Partial<Row> = {}) => ({ ...conn(id, over), workspaceId: 'ws_b' })
  const shared = (id: string, over: Partial<Row> = {}) => ({ ...conn(id, over), workspaceId: 'ws_a' })

  it('the primary is this business\'s own, even when a shared account is primary in its owner', () => {
    // Before: two primaries → AmbiguousConnectionError on every primary lookup of B.
    expect(inB(() => chooseConnection([shared('a-primary', { isPrimary: true }), own('b-primary', { isPrimary: true })], { channel: 'EBAY', wantPrimary: true })).id).toBe('b-primary')
  })

  it('a shared primary never stands in for a business with no primary of its own', () => {
    // Before: B got A's account as "its" primary.
    expect(() => inB(() => chooseConnection([shared('a-primary', { isPrimary: true }), own('b1'), own('b2')], { channel: 'EBAY', wantPrimary: true }))).toThrow(AmbiguousConnectionError)
  })

  it('"the only account" is this business\'s only own account; a shared one is never the only one', () => {
    expect(inB(() => chooseConnection([shared('a1'), own('b1')], { channel: 'EBAY' })).id).toBe('b1')
    let error: unknown
    try { inB(() => chooseConnection([shared('a1')], { channel: 'EBAY' })) } catch (e) { error = e }
    expect(error).toBeInstanceOf(NoConnectionError)
    expect((error as Error).message).toContain('another business shares with this one can be used only when chosen by name')
  })

  it('a row read without its business (a caller\'s own select, a fixture) counts as its own', () => {
    expect(inB(() => isOwnConnection({}))).toBe(true)
    expect(inB(() => isOwnConnection({ workspaceId: 'ws_b' }))).toBe(true)
    expect(inB(() => isOwnConnection({ workspaceId: 'ws_a' }))).toBe(false)
  })
})

