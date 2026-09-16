/**
 * BP.S3 — a guest may publish, but never into a coordinate another business holds.
 *
 * Real disposable PostgreSQL with the real generated policies: the primary key is
 * the exclusivity, so a test that mocked it would prove nothing about the thing
 * doing the work.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { formulaDatabase } from '../test-support/formula-database.js'
import { withWorkspace } from '../lib/workspace-context.js'

process.env.NEXUS_CREDENTIAL_ENC_KEY = randomBytes(32).toString('base64')
delete process.env.NEXUS_KMS_KEY_ID

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, { get: (_t, p) => (database.client as unknown as Record<string, unknown>)[p as string] }),
}))

const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const OWNER_WS = 'ws_owner_bps3'
const GUEST_WS = 'ws_guest_bps3'
const SOLO_WS = 'ws_solo_bps3'
const USER = 'user_bps3'
const ACCESS_TOKEN = 'test-access-token-not-a-real-credential'

const ctx = (workspaceId: string) => ({ workspaceId, actorUserId: USER, membershipId: null, roleKeys: ['OWNER'] })

describe('BP.S3 — publishing into a shared seller account', () => {
  let claims: typeof import('./listing-claim.service.js')
  let grants: typeof import('./channel-account-grant.service.js')
  let tokens: typeof import('./cx/token.service.js')
  let sharedConn: string, soloConn: string

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    claims = await import('./listing-claim.service.js')
    grants = await import('./channel-account-grant.service.js')
    tokens = await import('./cx/token.service.js')
    await import('./cx/connectors/ebay/spec.js')

    const ownerRole = randomUUID()
    await database.db.query(`INSERT INTO "Role" (id,key,name,"isSystem","updatedAt") VALUES ($1,'OWNER','Owner',true,CURRENT_TIMESTAMP)`, [ownerRole])
    await database.db.query(`INSERT INTO "UserProfile" (id,email,status,"updatedAt") VALUES ($1,$2,'active',CURRENT_TIMESTAMP)`, [USER, `${USER}@example.test`])
    for (const [id, name] of [[OWNER_WS, 'Owner business'], [GUEST_WS, 'Guest business'], [SOLO_WS, 'Solo business']]) {
      await database.db.query(`INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$2,'active','bps3',$1,CURRENT_TIMESTAMP)`, [id, name])
      const m = randomUUID()
      await database.db.query(`INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$3,'active',CURRENT_TIMESTAMP)`, [m, id, USER])
      await database.db.query(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [m, ownerRole])
    }

    const { blob, keyId } = await (await import('../lib/crypto.js')).encryptCredentials({
      accessToken: ACCESS_TOKEN, refreshToken: 'test-refresh',
      accessTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 864_000_000).toISOString(),
    })
    const connection = async (ws: string, seller: string) => {
      const id = randomUUID()
      await database.db.query(
        `INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","managedBy","authStatus","isActive","externalAccountId","credentialsEnc","credentialsKeyId","accessTokenExpiresAt","updatedAt")
         VALUES ($1,$2,'EBAY','oauth','connected',true,$3,$4,$5,$6,CURRENT_TIMESTAMP)`,
        [id, ws, seller, blob, keyId, new Date(Date.now() + 86_400_000)])
      return id
    }
    sharedConn = await connection(OWNER_WS, 'seller-shared-bps3')
    soloConn = await connection(SOLO_WS, 'seller-solo-bps3')
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 30_000)

  it("the owner can now grant 'publish', not only 'read'", async () => {
    const grant = await withWorkspace(ctx(OWNER_WS), () => grants.shareAccount({ connectionId: sharedConn, destinationWorkspaceId: GUEST_WS, mode: 'publish' }))
    expect(grant).toMatchObject({ mode: 'publish', workspaceId: GUEST_WS })
  })

  it('🔴 a publish grant admits the guest to the channel — a read grant does not', async () => {
    await withWorkspace(ctx(GUEST_WS), async () => {
      await expect(tokens.getAccessToken(sharedConn)).resolves.toBe(ACCESS_TOKEN)
    })
    await withWorkspace(ctx(OWNER_WS), () => grants.shareAccount({ connectionId: sharedConn, destinationWorkspaceId: GUEST_WS, mode: 'read' }))
    await withWorkspace(ctx(GUEST_WS), async () => {
      await expect(tokens.getAccessToken(sharedConn)).rejects.toMatchObject({ code: 'account_not_owned' })
    })
    // back to publish for the rest of the file
    await withWorkspace(ctx(OWNER_WS), () => grants.shareAccount({ connectionId: sharedConn, destinationWorkspaceId: GUEST_WS, mode: 'publish' }))
  })

  it('a revoked share stops working on the NEXT call, not at the next restart', async () => {
    await withWorkspace(ctx(OWNER_WS), () => grants.revokeShare({ connectionId: sharedConn, workspaceId: GUEST_WS }))
    await withWorkspace(ctx(GUEST_WS), async () => {
      // Stronger than `account_not_owned`: with the share gone the row is not
      // visible at all, so the token path never reaches the ownership question.
      await expect(tokens.getAccessToken(sharedConn)).rejects.toThrow(/not found/)
      expect(await database.client.channelConnection.findUnique({ where: { id: sharedConn } })).toBeNull()
    })
    await withWorkspace(ctx(OWNER_WS), () => grants.shareAccount({ connectionId: sharedConn, destinationWorkspaceId: GUEST_WS, mode: 'publish' }))
    await withWorkspace(ctx(GUEST_WS), async () => {
      await expect(tokens.getAccessToken(sharedConn)).resolves.toBe(ACCESS_TOKEN)
    })
  })

  it('the account counts as shared, and a solo account does not', async () => {
    await withWorkspace(ctx(OWNER_WS), async () => {
      expect([...await claims.sharedConnectionIds([sharedConn, soloConn])]).toEqual([sharedConn])
    })
  })

  it('the owner claims a coordinate', async () => {
    const out = await withWorkspace(ctx(OWNER_WS), () => claims.claimCoordinate({ connectionId: sharedConn, marketplace: 'IT', sellerSku: 'SKU-A' }))
    expect(out.result).toBe('acquired')
  })

  it('claiming it again is idempotent for the holder', async () => {
    const out = await withWorkspace(ctx(OWNER_WS), () => claims.claimCoordinate({ connectionId: sharedConn, marketplace: 'IT', sellerSku: 'SKU-A' }))
    expect(out.result).toBe('held')
  })

  it('🔴 the guest is BLOCKED from the same coordinate, and told who holds it', async () => {
    const out = await withWorkspace(ctx(GUEST_WS), () => claims.claimCoordinate({ connectionId: sharedConn, marketplace: 'IT', sellerSku: 'SKU-A' }))
    expect(out.result).toBe('blocked')
    expect(out.heldBy?.workspaceName).toBe('Owner business')
    expect(out.reason).toContain('Owner business')
  })

  it('CONTROL — the guest CAN claim a different sku on the same account', async () => {
    const out = await withWorkspace(ctx(GUEST_WS), () => claims.claimCoordinate({ connectionId: sharedConn, marketplace: 'IT', sellerSku: 'SKU-B' }))
    expect(out.result).toBe('acquired')
  })

  it('CONTROL — and the same sku on a DIFFERENT marketplace, which is a different coordinate', async () => {
    const out = await withWorkspace(ctx(GUEST_WS), () => claims.claimCoordinate({ connectionId: sharedConn, marketplace: 'DE', sellerSku: 'SKU-A' }))
    expect(out.result).toBe('acquired')
  })

  it('🔴 a listing with no single seller SKU is refused, never guessed', async () => {
    for (const sku of [null, '', '   ']) {
      const out = await withWorkspace(ctx(GUEST_WS), () => claims.claimCoordinate({ connectionId: sharedConn, marketplace: 'IT', sellerSku: sku }))
      expect(out.result).toBe('blocked')
      expect(out.reason).toContain('no single seller SKU')
    }
  })

  it('releasing frees the coordinate for the other business', async () => {
    expect(await withWorkspace(ctx(OWNER_WS), () => claims.releaseCoordinate({ connectionId: sharedConn, marketplace: 'IT', sellerSku: 'SKU-A' }))).toBe(true)
    const out = await withWorkspace(ctx(GUEST_WS), () => claims.claimCoordinate({ connectionId: sharedConn, marketplace: 'IT', sellerSku: 'SKU-A' }))
    expect(out.result).toBe('acquired')
  })

  it('a business cannot release a coordinate it does not hold', async () => {
    expect(await withWorkspace(ctx(OWNER_WS), () => claims.releaseCoordinate({ connectionId: sharedConn, marketplace: 'IT', sellerSku: 'SKU-A' }))).toBe(false)
    // CONTROL: the holder still can, so `false` means refused and not "no such row".
    expect(await withWorkspace(ctx(GUEST_WS), () => claims.releaseCoordinate({ connectionId: sharedConn, marketplace: 'IT', sellerSku: 'SKU-A' }))).toBe(true)
  })

  it('assertClaimed is a NO-OP on an account nobody shares', async () => {
    await withWorkspace(ctx(SOLO_WS), async () => {
      await expect(claims.assertClaimed({ connectionId: soloConn, marketplace: 'IT', sellerSku: 'ANYTHING' })).resolves.toBeUndefined()
      // and it wrote no claim, because a solo account needs none
      expect(await database.client.channelListingClaim.count({ where: { connectionId: soloConn } })).toBe(0)
    })
  })

  it('assertClaimed throws for a coordinate another business holds', async () => {
    await withWorkspace(ctx(GUEST_WS), () => claims.claimCoordinate({ connectionId: sharedConn, marketplace: 'IT', sellerSku: 'SKU-C' }))
    await withWorkspace(ctx(OWNER_WS), async () => {
      await expect(claims.assertClaimed({ connectionId: sharedConn, marketplace: 'IT', sellerSku: 'SKU-C' }))
        .rejects.toMatchObject({ code: 'listing_coordinate_claimed', statusCode: 409 })
    })
  })
})
