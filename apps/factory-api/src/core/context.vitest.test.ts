import { describe, expect, it } from 'vitest'
import type { FactoryDatabase, FactoryScope } from '@nexus/factory-db'
import { UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import {
  actorOf,
  completeContext,
  isTestAuthenticator,
  noSessions,
  scopeForContext,
  SYSTEM_ACTOR_ID,
  testAuthenticator,
  withContextClient,
  type RequestContext,
  type SessionContext,
} from './context'

const TENANT = '0190f5c2-0000-7000-8000-000000000001'
const USER = '0190f5c2-0000-7000-8000-0000000000aa'
const SITE = '0190f5c2-0000-7000-8000-000000000101'
const OTHER_SITE = '0190f5c2-0000-7000-8000-000000000102'
const PARTY = '0190f5c2-0000-7000-8000-000000000201'
const LINK = '0190f5c2-0000-7000-8000-000000000301'
const DEVICE = '0190f5c2-0000-7000-8000-000000000401'
const all = { companies: 'all', sites: 'all', parties: 'all' } as const

const contexts: Record<RequestContext['audience'], SessionContext> = {
  office: { audience: 'office', tenantId: TENANT, actorId: USER, siteId: SITE, grants: [] },
  floor: { audience: 'floor', tenantId: TENANT, actorId: USER, siteId: SITE, deviceId: DEVICE, grants: [] },
  partner: { audience: 'partner', tenantId: TENANT, actorId: USER, partyId: PARTY, grants: [] },
  link: { audience: 'link', tenantId: TENANT, linkId: LINK, partyId: PARTY, record: { type: 'quote', id: USER }, grants: [] },
  platform: { audience: 'platform', actorId: USER, grants: [] },
  system: { audience: 'system', tenantId: TENANT, actorId: SYSTEM_ACTOR_ID, grants: [] },
}

describe('scopeForContext()', () => {
  it('maps each audience to its database scope', () => {
    const scope = (audience: RequestContext['audience']) => scopeForContext(completeContext(contexts[audience], 'r'))
    expect(scope('office')).toEqual({ audience: 'office', tenantId: TENANT, actorId: USER })
    expect(scope('floor')).toEqual({ audience: 'floor', tenantId: TENANT, actorId: USER, siteId: SITE })
    expect(scope('partner')).toEqual({ audience: 'partner', tenantId: TENANT, actorId: USER, partyId: PARTY })
    expect(scope('link')).toEqual({ audience: 'partner', tenantId: TENANT, actorId: LINK, partyId: PARTY })
    expect(scope('platform')).toEqual({ audience: 'platform' })
    expect(scope('system')).toEqual({ audience: 'office', tenantId: TENANT, actorId: SYSTEM_ACTOR_ID })
  })

  it('refuses an unknown audience', () => {
    expect(() => scopeForContext({ audience: 'guest' } as unknown as RequestContext)).toThrow(/Unknown audience/)
  })
})

describe('completeContext()', () => {
  it('adds the request id and freezes the context', () => {
    const context = completeContext(contexts.office, 'req-1')
    expect(context.requestId).toBe('req-1')
    expect(Object.isFrozen(context)).toBe(true)
  })

  it('refuses a context that lacks a field of its audience', () => {
    const broken = (session: unknown) => () => completeContext(session as SessionContext, 'r')
    expect(broken({ audience: 'floor', tenantId: TENANT, actorId: USER, deviceId: DEVICE, grants: [] })).toThrow(/siteId/)
    expect(broken({ audience: 'partner', tenantId: TENANT, actorId: USER, grants: [] })).toThrow(/partyId/)
    expect(broken({ audience: 'office', tenantId: '', actorId: USER, grants: [] })).toThrow(/tenantId/)
    expect(broken({ audience: 'office', tenantId: TENANT, actorId: USER })).toThrow(/grants/)
    expect(broken({ audience: 'link', tenantId: TENANT, linkId: LINK, partyId: PARTY, grants: [] })).toThrow(/record/)
    expect(broken({ audience: 'guest', grants: [] })).toThrow(/audience/)
    expect(broken(null)).toThrow(/audience/)
  })
})

describe('actorOf()', () => {
  it('pins the floor site and the partner party, not an office screen site', () => {
    const grants = [{ permissions: ['lots.view' as const], ...all }]
    const floor = actorOf(completeContext({ ...contexts.floor, grants }, 'r'))
    expect(floor).toEqual({ audience: 'floor', tenantId: TENANT, siteId: SITE, grants })
    expect(can(floor, 'lots.view', { siteId: OTHER_SITE })).toBe(false)
    const office = actorOf(completeContext({ ...contexts.office, grants }, 'r'))
    expect(office).toEqual({ audience: 'office', tenantId: TENANT, grants })
    expect(can(office, 'lots.view', { siteId: OTHER_SITE })).toBe(true)
    expect(actorOf(completeContext(contexts.link, 'r')).partyId).toBe(PARTY)
    expect(actorOf(completeContext(contexts.platform, 'r'))).not.toHaveProperty('tenantId')
  })
})

describe('withContextClient(): fail closed', () => {
  function recordingDatabase(): FactoryDatabase & { scopes: FactoryScope[] } {
    const scopes: FactoryScope[] = []
    return {
      scopes,
      async withScope(scope, work) {
        scopes.push(scope)
        return work({} as never)
      },
      async close() {},
    }
  }

  it('without a context, throws before the database is touched', async () => {
    const database = recordingDatabase()
    for (const missing of [null, undefined]) {
      await expect(withContextClient(database, missing, async () => 'rows')).rejects.toBeInstanceOf(UnauthenticatedError)
    }
    expect(database.scopes).toEqual([])
  })

  it('with a context, uses exactly its scope', async () => {
    const database = recordingDatabase()
    const result = await withContextClient(database, completeContext(contexts.floor, 'r'), async () => 'rows')
    expect(result).toBe('rows')
    expect(database.scopes).toEqual([{ audience: 'floor', tenantId: TENANT, actorId: USER, siteId: SITE }])
  })

  it('without a database, refuses instead of guessing', async () => {
    await expect(withContextClient(undefined, completeContext(contexts.office, 'r'), async () => 'rows')).rejects.toThrow(
      /database is not configured/,
    )
  })
})

describe('authenticators', () => {
  it('noSessions has no session for anyone', async () => {
    expect(await noSessions({} as never)).toBeNull()
  })

  it('a test authenticator is marked, a plain one is not', () => {
    expect(isTestAuthenticator(testAuthenticator(() => null))).toBe(true)
    expect(isTestAuthenticator(() => null)).toBe(false)
    expect(isTestAuthenticator(noSessions)).toBe(false)
  })
})
