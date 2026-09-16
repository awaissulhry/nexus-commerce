/**
 * BP.S1b — a READ grant must never yield a usable credential.
 *
 * Migration 20260916a lets a GUEST business SELECT a shared connection row. RLS
 * cannot hide the credential columns from it (owner and guest share the single
 * database role `nexus_workspace_runtime`, so a column GRANT cannot tell them
 * apart), so `token.service.assertCredentialOwner` is the refusal.
 *
 * This runs against a REAL disposable PostgreSQL with the real generated policies,
 * not a fake: the point is the interaction between the policy that grants the read
 * and the guard that refuses the use. A mocked prisma would let the guard pass
 * while the policy was wrong, or the reverse, and neither would be visible.
 *
 * `db.js` is mocked to a Proxy that forwards to the disposable client, because
 * token.service imports its client directly and takes no injection.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

process.env.NEXUS_CREDENTIAL_ENC_KEY = randomBytes(32).toString('base64')
delete process.env.NEXUS_KMS_KEY_ID

let database: Awaited<ReturnType<typeof formulaDatabase>>
// vitest may run several files in one worker, so this file must leave process.env
// exactly as it found it; the sibling token.service test asserts the profiles-off
// behaviour and would silently change meaning if this leaked.
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
// Resolved at call time: the client does not exist when vi.mock's factory runs.
vi.mock('../../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, {
    get: (_target, property) => (database.client as unknown as Record<string, unknown>)[property as string],
  }),
}))

const OWNER = 'ws_owner_bps1b'
const GUEST = 'ws_guest_bps1b'
const OUTSIDER = 'ws_outsider_bps1b'
const ACCESS_TOKEN = 'test-access-token-not-a-real-credential'

/** Contexts carry no actor, so the policies' `actor IS NULL` arm applies; the
 *  membership arm is proven separately by the BP.S1a PostgreSQL rehearsal. */
const ctx = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] as string[] })

describe('BP.S1b — a shared account is readable but never usable', () => {
  let tokenService: typeof import('./token.service.js')
  let connectionId: string
  let envAmazonId: string

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    tokenService = await import('./token.service.js')
    // `getAccessToken` resolves the channel spec BEFORE it returns a cached token,
    // and specs register as a side effect of importing their connector. Without
    // this the two success arms throw "No ChannelSpec registered for EBAY" — and a
    // control that cannot run makes the refusals below prove nothing.
    await import('./connectors/ebay/spec.js')

    for (const [id, name] of [[OWNER, 'Owner business'], [GUEST, 'Guest business'], [OUTSIDER, 'Outsider business']]) {
      await database.db.exec(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt")
        VALUES ('${id}', '${name}', 'active', 'bps1b', '${id}', CURRENT_TIMESTAMP)`)
    }

    // Written as the superuser so the fixture is not itself under test.
    const { blob, keyId } = await (await import('../../lib/crypto.js')).encryptCredentials({
      accessToken: ACCESS_TOKEN,
      refreshToken: 'test-refresh-token',
      // Far future, so getAccessToken returns from the envelope and never refreshes.
      accessTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 864_000_000).toISOString(),
    })
    connectionId = randomUUID()
    await database.db.query(
      `INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", "managedBy", "authStatus", "isActive", "externalAccountId", "credentialsEnc", "credentialsKeyId", "accessTokenExpiresAt", "updatedAt")
       VALUES ($1, $2, 'EBAY', 'oauth', 'connected', true, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
      [connectionId, OWNER, 'seller-bps1b', blob, keyId, new Date(Date.now() + 86_400_000)],
    )

    // The env-managed Amazon row: getAccessToken mints its token from the
    // environment and never reaches the decrypt path, so it needs its own arm.
    envAmazonId = randomUUID()
    await database.db.query(
      `INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", "managedBy", "authStatus", "isActive", "externalAccountId", "updatedAt")
       VALUES ($1, $2, 'AMAZON', 'env', 'connected', true, $3, CURRENT_TIMESTAMP)`,
      [envAmazonId, OWNER, 'seller-amazon-bps1b'],
    )

    for (const id of [connectionId, envAmazonId]) {
      await database.db.query(
        `INSERT INTO "ChannelAccountGrant" ("connectionId","workspaceId","ownerWorkspaceId","mode","grantedByUserId","grantedAt")
         VALUES ($1, $2, $3, 'read', 'bps1b', CURRENT_TIMESTAMP)`,
        [id, GUEST, OWNER],
      )
    }
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 30_000)

  it('CONTROL — the owner reads the account and gets its token', async () => {
    await withWorkspace(ctx(OWNER), async () => {
      const row = await database.client.channelConnection.findUnique({ where: { id: connectionId } })
      expect(row?.id).toBe(connectionId)
      await expect(tokenService.getAccessToken(connectionId)).resolves.toBe(ACCESS_TOKEN)
    })
  })

  it('the guest CAN see the shared account — otherwise the refusal below proves nothing', async () => {
    await withWorkspace(ctx(GUEST), async () => {
      const row = await database.client.channelConnection.findUnique({ where: { id: connectionId } })
      expect(row?.id).toBe(connectionId)
      expect(row?.workspaceId).toBe(OWNER)
    })
  })

  it('the guest CANNOT get an access token for it', async () => {
    await withWorkspace(ctx(GUEST), async () => {
      await expect(tokenService.getAccessToken(connectionId)).rejects.toMatchObject({ code: 'account_not_owned', statusCode: 403 })
    })
  })

  it('the guest CANNOT read its refresh token either', async () => {
    await withWorkspace(ctx(GUEST), async () => {
      await expect(tokenService.readRefreshToken(connectionId)).rejects.toMatchObject({ code: 'account_not_owned' })
    })
  })

  it('the guest CANNOT refresh it', async () => {
    await withWorkspace(ctx(GUEST), async () => {
      await expect(tokenService.refreshNow(connectionId)).rejects.toMatchObject({ code: 'account_not_owned' })
    })
  })

  it('the env-managed Amazon account is refused too — that branch skips the decrypt path', async () => {
    await withWorkspace(ctx(GUEST), async () => {
      await expect(tokenService.getAccessToken(envAmazonId)).rejects.toMatchObject({ code: 'account_not_owned' })
    })
  })

  it('a business with no grant at all cannot even see the account', async () => {
    await withWorkspace(ctx(OUTSIDER), async () => {
      const row = await database.client.channelConnection.findUnique({ where: { id: connectionId } })
      expect(row).toBeNull()
    })
  })

  it('a revoked grant takes the account away again', async () => {
    await database.db.query(`UPDATE "ChannelAccountGrant" SET "revokedAt" = CURRENT_TIMESTAMP WHERE "connectionId" = $1`, [connectionId])
    await withWorkspace(ctx(GUEST), async () => {
      expect(await database.client.channelConnection.findUnique({ where: { id: connectionId } })).toBeNull()
    })
    await database.db.query(`UPDATE "ChannelAccountGrant" SET "revokedAt" = NULL WHERE "connectionId" = $1`, [connectionId])
    await withWorkspace(ctx(GUEST), async () => {
      expect((await database.client.channelConnection.findUnique({ where: { id: connectionId } }))?.id).toBe(connectionId)
    })
  })

  it('the guard is inert while business profiles are off', async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '0'
    try {
      // Same guest context, same row. Only the flag changed, so a pass here shows
      // the guard — and nothing else — is what refuses above.
      await withWorkspace(ctx(GUEST), async () => {
        await expect(tokenService.getAccessToken(connectionId)).resolves.toBe(ACCESS_TOKEN)
      })
    } finally {
      process.env.NEXUS_WORKSPACES_ENABLED = '1'
    }
  })
})
