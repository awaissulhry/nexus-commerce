/**
 * CX.1 — placeGrant: which connection row a fresh grant lands on (the MAP.4
 * rules, channel-agnostic). The resolver helpers it calls
 * (findAccountByExternalId / countUnidentifiedAccounts) run for real against an
 * in-memory prisma so the where-clauses they build are exercised too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface Row {
  id: string
  channelType: string
  isActive: boolean
  externalAccountId: string | null
}

const rows: Row[] = []

function matches(row: Row, where: Record<string, unknown>): boolean {
  if (where.channelType !== undefined && row.channelType !== where.channelType) return false
  if (where.isActive !== undefined && row.isActive !== where.isActive) return false
  if (where.externalAccountId !== undefined && row.externalAccountId !== where.externalAccountId) return false
  const not = where.NOT as { id?: string } | undefined
  if (not?.id && row.id === not.id) return false
  return true
}

const prismaMock = {
  channelConnection: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null),
    count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, where)).length),
  },
}

vi.mock('../../db.js', () => ({ default: prismaMock }))

const { placeGrant, IdentityRefusal } = await import('./identity.service.js')

const LABEL = 'eBay'
const identity = (userId: string, username?: string) => ({ userId, username })

async function refusal(p: Promise<unknown>): Promise<InstanceType<typeof IdentityRefusal>> {
  try {
    await p
  } catch (err) {
    if (err instanceof IdentityRefusal) return err
    throw err
  }
  throw new Error('expected placeGrant to refuse')
}

beforeEach(() => {
  rows.length = 0
  vi.clearAllMocks()
})

describe('placeGrant — identity known', () => {
  it('an active row already carrying this identity → reconsent onto that row', async () => {
    rows.push({ id: 'c1', channelType: 'EBAY', isActive: true, externalAccountId: 'U1' })
    rows.push({ id: 'c2', channelType: 'EBAY', isActive: true, externalAccountId: 'U2' })
    const r = await placeGrant({ channelType: 'EBAY', channelLabel: LABEL, identity: identity('U2', 'shop2') })
    expect(r).toEqual({ kind: 'reconsent', connectionId: 'c2' })
  })

  it('reconsent wins even when the operator named a different target', async () => {
    rows.push({ id: 'c1', channelType: 'EBAY', isActive: true, externalAccountId: 'U1' })
    rows.push({ id: 'c9', channelType: 'EBAY', isActive: true, externalAccountId: null })
    const r = await placeGrant({ channelType: 'EBAY', channelLabel: LABEL, identity: identity('U1'), targetConnectionId: 'c9' })
    expect(r).toEqual({ kind: 'reconsent', connectionId: 'c1' })
  })

  it('an inactive row with the same identity does not count as a match', async () => {
    rows.push({ id: 'old', channelType: 'EBAY', isActive: false, externalAccountId: 'U1' })
    const r = await placeGrant({ channelType: 'EBAY', channelLabel: LABEL, identity: identity('U1') })
    expect(r).toEqual({ kind: 'new' })
  })

  it('a match on another channel is not a match', async () => {
    rows.push({ id: 'amz', channelType: 'AMAZON', isActive: true, externalAccountId: 'U1' })
    const r = await placeGrant({ channelType: 'EBAY', channelLabel: LABEL, identity: identity('U1') })
    expect(r).toEqual({ kind: 'new' })
  })

  it('no match + a valid target of the same channel → adopt onto the target', async () => {
    rows.push({ id: 'c1', channelType: 'EBAY', isActive: true, externalAccountId: null })
    const r = await placeGrant({ channelType: 'EBAY', channelLabel: LABEL, identity: identity('U1'), targetConnectionId: 'c1' })
    expect(r).toEqual({ kind: 'adopt', connectionId: 'c1' })
  })

  it('no match + no unidentified rows → new', async () => {
    rows.push({ id: 'c1', channelType: 'EBAY', isActive: true, externalAccountId: 'U1' })
    const r = await placeGrant({ channelType: 'EBAY', channelLabel: LABEL, identity: identity('U2') })
    expect(r).toEqual({ kind: 'new' })
  })

  it('no match + an unidentified ACTIVE row → IDENTITY_UNMATCHED naming the grant\'s username', async () => {
    rows.push({ id: 'legacy', channelType: 'EBAY', isActive: true, externalAccountId: null })
    const err = await refusal(placeGrant({ channelType: 'EBAY', channelLabel: LABEL, identity: identity('U7', 'seller7') }))
    expect(err.code).toBe('IDENTITY_UNMATCHED')
    expect(err.identityUsername).toBe('seller7')
    expect(err.message).toContain('"seller7"')
    expect(err.message).toContain('Reconnect')
  })

  it('IDENTITY_UNMATCHED falls back to the userId when the channel gave no username', async () => {
    rows.push({ id: 'legacy', channelType: 'EBAY', isActive: true, externalAccountId: null })
    const err = await refusal(placeGrant({ channelType: 'EBAY', channelLabel: LABEL, identity: { userId: 'U7' } }))
    expect(err.code).toBe('IDENTITY_UNMATCHED')
    expect(err.identityUsername).toBe('U7')
  })

  it('an unidentified but INACTIVE row does not block a new connection', async () => {
    rows.push({ id: 'legacy', channelType: 'EBAY', isActive: false, externalAccountId: null })
    const r = await placeGrant({ channelType: 'EBAY', channelLabel: LABEL, identity: identity('U7') })
    expect(r).toEqual({ kind: 'new' })
  })

  it('an unidentified row on another channel does not block either', async () => {
    rows.push({ id: 'amz', channelType: 'AMAZON', isActive: true, externalAccountId: null })
    const r = await placeGrant({ channelType: 'EBAY', channelLabel: LABEL, identity: identity('U7') })
    expect(r).toEqual({ kind: 'new' })
  })

  it('a target that does not exist → ADOPT_TARGET_INVALID', async () => {
    const err = await refusal(placeGrant({ channelType: 'EBAY', channelLabel: LABEL, identity: identity('U1'), targetConnectionId: 'ghost' }))
    expect(err.code).toBe('ADOPT_TARGET_INVALID')
  })

  it('a target of the wrong channel → ADOPT_TARGET_INVALID', async () => {
    rows.push({ id: 'amz', channelType: 'AMAZON', isActive: true, externalAccountId: null })
    const err = await refusal(placeGrant({ channelType: 'EBAY', channelLabel: LABEL, identity: identity('U1'), targetConnectionId: 'amz' }))
    expect(err.code).toBe('ADOPT_TARGET_INVALID')
    expect(err.message).toContain('eBay')
  })
})

describe('placeGrant — no identity from the channel', () => {
  it('a valid target → adopt (the operator told us where it goes)', async () => {
    rows.push({ id: 'c1', channelType: 'EBAY', isActive: true, externalAccountId: null })
    const r = await placeGrant({ channelType: 'EBAY', channelLabel: LABEL, identity: null, targetConnectionId: 'c1' })
    expect(r).toEqual({ kind: 'adopt', connectionId: 'c1' })
  })

  it('a target of the wrong channel → ADOPT_TARGET_INVALID', async () => {
    rows.push({ id: 'amz', channelType: 'AMAZON', isActive: true, externalAccountId: null })
    const err = await refusal(placeGrant({ channelType: 'EBAY', channelLabel: LABEL, identity: null, targetConnectionId: 'amz' }))
    expect(err.code).toBe('ADOPT_TARGET_INVALID')
  })

  it('an unidentified active row already exists → IDENTITY_UNAVAILABLE', async () => {
    rows.push({ id: 'legacy', channelType: 'EBAY', isActive: true, externalAccountId: null })
    const err = await refusal(placeGrant({ channelType: 'EBAY', channelLabel: LABEL, identity: null }))
    expect(err.code).toBe('IDENTITY_UNAVAILABLE')
    expect(err.identityUsername).toBeUndefined()
    expect(err.message).toContain('did not return this account\'s identity')
  })

  it('an identity object without a userId is treated as no identity', async () => {
    rows.push({ id: 'legacy', channelType: 'EBAY', isActive: true, externalAccountId: null })
    const err = await refusal(placeGrant({ channelType: 'EBAY', channelLabel: LABEL, identity: { userId: '' } }))
    expect(err.code).toBe('IDENTITY_UNAVAILABLE')
  })

  it('no unidentified rows → new', async () => {
    rows.push({ id: 'c1', channelType: 'EBAY', isActive: true, externalAccountId: 'U1' })
    const r = await placeGrant({ channelType: 'EBAY', channelLabel: LABEL, identity: null })
    expect(r).toEqual({ kind: 'new' })
  })

  it('IdentityRefusal is a named Error subclass', async () => {
    rows.push({ id: 'legacy', channelType: 'EBAY', isActive: true, externalAccountId: null })
    const err = await refusal(placeGrant({ channelType: 'EBAY', channelLabel: LABEL, identity: null }))
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('IdentityRefusal')
  })
})
