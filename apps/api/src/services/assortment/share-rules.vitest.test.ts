/**
 * AE.2 — the share rules in TypeScript, and their parity with the database copy.
 *
 * The transition table is also driven through the REAL trigger, every combination, in
 * assortment-share.vitest.test.ts. This file pins the pure behaviour and the field-group list.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_FIELD_GROUPS, FIELD_GROUPS, SHARE_STATUSES, canTransition, followerTarget, isFollowerDecision, isOwnerAction,
  normaliseFieldGroups, ownerTarget, transitionRefusal,
} from './share-rules.js'

const sqlPath = fileURLToPath(new URL('../../../../../packages/database/workspaces/assortment-share.sql', import.meta.url))

describe('AE.2 share rules — parity with the database', () => {
  it('the field groups are EXACTLY the list the database CHECK allows (one rule, two copies)', () => {
    const sql = readFileSync(sqlPath, 'utf8')
    const match = /"fieldGroups" <@ ARRAY\[([^\]]+)\]::text\[\]/.exec(sql)
    expect(match, 'the CHECK on AssortmentShare.fieldGroups was not found in assortment-share.sql').not.toBeNull()
    const inSql = [...match![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])
    expect(inSql.length).toBeGreaterThan(0)
    expect(inSql).toEqual([...FIELD_GROUPS])
  })

  it('the statuses are EXACTLY the list the database CHECK allows', () => {
    const sql = readFileSync(sqlPath, 'utf8')
    const match = /CHECK \(status IN \(([^)]+)\)\)/.exec(sql)
    expect(match).not.toBeNull()
    expect([...match![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])).toEqual([...SHARE_STATUSES])
  })
})

describe('AE.2 share rules — transitions', () => {
  const allowed = new Set([
    'owner:pending:revoked', 'owner:active:paused', 'owner:active:revoked', 'owner:paused:active', 'owner:paused:revoked',
    'follower:pending:active', 'follower:pending:declined', 'follower:active:revoked', 'follower:paused:revoked',
  ])

  it('allows exactly the nine transitions of the contract, and nothing else (50 combinations)', () => {
    let checked = 0
    for (const side of ['owner', 'follower'] as const) {
      for (const from of SHARE_STATUSES) {
        for (const to of SHARE_STATUSES) {
          expect(canTransition(side, from, to), `${side} ${from} → ${to}`).toBe(allowed.has(`${side}:${from}:${to}`))
          checked++
        }
      }
    }
    expect(checked).toBe(50)
  })

  it('🔴 the OWNER can never make a pending share active — only the follower accepts', () => {
    expect(canTransition('owner', 'pending', 'active')).toBe(false)
    expect(canTransition('follower', 'pending', 'active')).toBe(true)
  })

  it('an ended share stays ended for both sides', () => {
    for (const side of ['owner', 'follower'] as const) {
      for (const ended of ['declined', 'revoked'] as const) {
        for (const to of SHARE_STATUSES) expect(canTransition(side, ended, to)).toBe(false)
      }
    }
  })

  it('actions map to their target statuses, and each side only recognises its own actions', () => {
    expect([ownerTarget('pause'), ownerTarget('resume'), ownerTarget('revoke')]).toEqual(['paused', 'active', 'revoked'])
    expect([followerTarget('accept'), followerTarget('decline'), followerTarget('leave')]).toEqual(['active', 'declined', 'revoked'])
    expect(['pause', 'resume', 'revoke'].every(isOwnerAction)).toBe(true)
    expect(['accept', 'decline', 'leave'].every(isFollowerDecision)).toBe(true)
    expect(isOwnerAction('accept')).toBe(false)
    expect(isFollowerDecision('revoke')).toBe(false)
    expect(isOwnerAction('toString')).toBe(false)
    expect(isFollowerDecision('constructor')).toBe(false)
  })

  it('refusals explain the state in words', () => {
    expect(transitionRefusal('owner', 'resume', 'pending')).toMatch(/waits for the other business to accept/)
    expect(transitionRefusal('follower', 'accept', 'revoked')).toMatch(/has ended/)
    expect(transitionRefusal('follower', 'leave', 'pending')).toMatch(/declined, not left/)
  })
})

describe('AE.2 share rules — field groups input', () => {
  it('no list → the defaults: everything except price and status', () => {
    expect(normaliseFieldGroups(undefined)).toEqual([...DEFAULT_FIELD_GROUPS])
    expect(DEFAULT_FIELD_GROUPS).not.toContain('price')
    expect(DEFAULT_FIELD_GROUPS).not.toContain('status')
  })

  it('a valid list is de-duplicated and put in the canonical order', () => {
    expect(normaliseFieldGroups(['media', 'identity', 'media'])).toEqual(['identity', 'media'])
  })

  it('an empty, unknown or malformed list is refused, never narrowed or widened', () => {
    for (const bad of [[], ['listings'], ['identity', 42], 'identity', {}]) {
      expect(() => normaliseFieldGroups(bad)).toThrow(expect.objectContaining({ code: 'invalid_field_groups', statusCode: 400 }))
    }
  })
})
