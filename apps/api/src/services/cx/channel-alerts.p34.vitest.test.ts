/**
 * P3.4 — *each alert fired once in a test.* That is the plan row's done-when, so each
 * of the five has its own test, on a real PostgreSQL with the generated schema and the
 * real profile policies, profiles ON.
 *
 * Four of the five fire from a real source. The fifth, `channel-deprecation`, has **no
 * producer** — P3.5 is the package that teaches the gateway to read `Deprecation` and
 * `Sunset` headers — so it is tested through its shape only, and labelled as such
 * rather than presented as working.
 *
 * The counts the sources hold today, measured before this was written:
 *   dead letters        0   (none has ever reached dlq)
 *   signature failures  7   (real, and nothing had ever looked at them)
 *   feed rejections     0   (the P3.2 store went live with P3.2)
 *   app secrets         0   (no app has an expiry date set)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, { get: (_t, p) => (database.client as unknown as Record<string, unknown>)[p as string] }),
}))

const WS = 'nexus_legacy_workspace'
const OTHER_WS = 'ws_other_business'
const OWNER = 'user-owner'
const OWNER_2 = 'user-owner-2'
const MEMBER = 'user-plain-member'
const OTHER_OWNER = 'user-other-business-owner'
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED

const inWorkspace = <T>(workspaceId: string, actorUserId: string | null, work: () => Promise<T>) =>
  withWorkspace({ workspaceId, actorUserId, membershipId: null, roleKeys: [] }, work)
const inWs = <T>(work: () => Promise<T>) => inWorkspace(WS, null, work)

describe('P3.4 — channel alerts reach the owning profile’s owners', () => {
  let svc: typeof import('./channel-alerts.service.js')
  const q = (sql: string, params: unknown[] = []) => database.db.query(sql, params)

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    svc = await import('./channel-alerts.service.js')

    // The real model names: UserProfile (not User), Role (not WorkspaceRole),
    // WorkspaceMemberRole (not WorkspaceMembershipRole). Taken from the schema rather
    // than guessed — the first version of this test invented all three and the suite
    // failed to LOAD, which reads as "19 skipped", not as a failure.
    await q(`INSERT INTO "UserProfile" (id, email, "displayName", status, "updatedAt") VALUES
      ($1,'owner@test.local','Owner','active',CURRENT_TIMESTAMP),
      ($2,'owner2@test.local','Owner Two','active',CURRENT_TIMESTAMP),
      ($3,'member@test.local','Member','active',CURRENT_TIMESTAMP),
      ($4,'other@test.local','Other','active',CURRENT_TIMESTAMP)`, [OWNER, OWNER_2, MEMBER, OTHER_OWNER])
    await q(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES
      ($1,'This business','active',$3,'p34-this',CURRENT_TIMESTAMP),
      ($2,'Another business','active',$4,'p34-other',CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO NOTHING`, [WS, OTHER_WS, OWNER, OTHER_OWNER])
    const roleId = 'role-owner-p34'
    await q(`INSERT INTO "Role" (id, key, name, permissions, "updatedAt") VALUES ($1,'OWNER','Owner',ARRAY[]::text[],CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO NOTHING`, [roleId])
    const ownerRoleId = (await q<{ id: string }>(`SELECT id FROM "Role" WHERE key = 'OWNER' LIMIT 1`)).rows[0].id
    const addMember = async (id: string, ws: string, userId: string, owner: boolean) => {
      await q(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1,$2,$3,'active',CURRENT_TIMESTAMP)`, [id, ws, userId])
      if (owner) await q(`INSERT INTO "WorkspaceMemberRole" ("membershipId", "roleId") VALUES ($1,$2)`, [id, ownerRoleId])
    }
    await addMember('m-owner', WS, OWNER, true)
    await addMember('m-owner-2', WS, OWNER_2, true)
    await addMember('m-member', WS, MEMBER, false)
    await addMember('m-other', OTHER_WS, OTHER_OWNER, true)
  }, 120_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  })

  beforeEach(async () => {
    await q(`DELETE FROM "Notification"`)
    for (const k of ['NEXUS_ALERT_DLQ_THRESHOLD', 'NEXUS_ALERT_SIGNATURE_THRESHOLD', 'NEXUS_ALERT_REJECTION_THRESHOLD', 'NEXUS_ALERT_SECRET_EXPIRY_DAYS']) delete process.env[k]
  })

  const notices = async (type?: string) =>
    (await q<{ userId: string; type: string; severity: string; title: string; body: string; entityId: string }>(
      `SELECT "userId", type, severity, title, body, "entityId" FROM "Notification" ${type ? 'WHERE type = $1' : ''} ORDER BY "userId"`,
      type ? [type] : [])).rows

  /* ── the done-when: each alert fired once ────────────────────────────────────────── */

  describe('each of the five alerts fires', () => {
    it('1. dead-letter growth', async () => {
      const alert = svc.deadLetterAlert('AMAZON', 7, 24)
      expect(alert).not.toBeNull()
      const r = await inWs(() => svc.raiseChannelAlert(alert!))
      expect(r.created).toBe(2) // both owners
      const rows = await notices('channel-dead-letters')
      expect(rows).toHaveLength(2)
      expect(rows[0].severity).toBe('danger')
      expect(rows[0].title).toContain('7 AMAZON events gave up')
      // "Dead letter" is the table's word. What matters to a person is that nothing
      // will try them again.
      expect(rows[0].body).toContain('Nothing will try them again')
    })

    it('2. signature failures', async () => {
      const alert = svc.signatureFailureAlert('SHOPIFY', 7, 24)
      expect(alert).not.toBeNull()
      await inWs(() => svc.raiseChannelAlert(alert!))
      const rows = await notices('channel-signature-failures')
      expect(rows).toHaveLength(2)
      expect(rows[0].title).toContain('could not verify')
      // Must NOT claim an attack: a rotated secret looks identical from here.
      expect(rows[0].body).toContain('signing secret')
      expect(rows[0].body.toLowerCase()).not.toContain('attack')
    })

    it('3. feed rejections over a threshold', async () => {
      const alert = svc.feedRejectionAlert('AMAZON', 140, 48, 24)
      expect(alert).not.toBeNull()
      await inWs(() => svc.raiseChannelAlert(alert!))
      const rows = await notices('channel-feed-rejections')
      expect(rows).toHaveLength(2)
      expect(rows[0].title).toContain('rejected 48 listings')
      expect(rows[0].severity).toBe('warn')
    })

    it('4. secret expiry', async () => {
      const alert = svc.secretExpiryAlert('AMAZON_SP', 'production', 7)
      expect(alert).not.toBeNull()
      await inWs(() => svc.raiseChannelAlert(alert!))
      const rows = await notices('channel-secret-expiry')
      expect(rows).toHaveLength(2)
      expect(rows[0].title).toContain('expires in 7 days')
      // Keyed per environment: two environments of one channel are two secrets.
      expect(rows[0].entityId).toBe('AMAZON_SP:production')
    })

    it('5. deprecation headers (SHAPE — P3.5 builds the producer)', async () => {
      const alert = svc.deprecationAlert('EBAY', '/sell/inventory/v1/offer', '2027-02-01')
      await inWs(() => svc.raiseChannelAlert(alert))
      const rows = await notices('channel-deprecation')
      expect(rows).toHaveLength(2)
      expect(rows[0].body).toContain('stops working on 2027-02-01')
      expect(rows[0].body).toContain('Nexus still calls it')
    })
  })

  /* ── who is told ─────────────────────────────────────────────────────────────────── */

  describe('recipients are THIS business’s owners, never everyone', () => {
    it('reaches both owners and not the plain member', async () => {
      await inWs(() => svc.raiseChannelAlert(svc.deadLetterAlert('EBAY', 9, 24)!))
      const got = (await notices()).map((r) => r.userId).sort()
      expect(got).toEqual([OWNER, OWNER_2])
      expect(got).not.toContain(MEMBER)
    })

    it('never reaches another business’s owner', async () => {
      await inWs(() => svc.raiseChannelAlert(svc.deadLetterAlert('EBAY', 9, 24)!))
      expect((await notices()).map((r) => r.userId)).not.toContain(OTHER_OWNER)
    })

    it('includes the actor when there is one', async () => {
      await inWorkspace(WS, MEMBER, () => svc.raiseChannelAlert(svc.deadLetterAlert('EBAY', 9, 24)!))
      const got = (await notices()).map((r) => r.userId).sort()
      expect(got).toEqual([MEMBER, OWNER, OWNER_2].sort())
    })

    it('says so, and does not throw, when a business has no active owner', async () => {
      const r = await inWorkspace(OTHER_WS, null, () => svc.raiseChannelAlert(svc.deadLetterAlert('EBAY', 9, 24)!))
      expect(r.recipients).toBe(1) // the other business DOES have one — control
      await q(`UPDATE "WorkspaceMembership" SET status = 'invited' WHERE id = 'm-other'`)
      const none = await inWorkspace(OTHER_WS, null, () => svc.raiseChannelAlert(svc.deadLetterAlert('EBAY', 9, 24)!))
      expect(none).toEqual({ created: 0, deduped: 0, recipients: 0 })
      await q(`UPDATE "WorkspaceMembership" SET status = 'active' WHERE id = 'm-other'`)
    })
  })

  /* ── the flood guard ─────────────────────────────────────────────────────────────── */

  describe('deduped, or it floods', () => {
    it('folds a repeat into the notice that is still unread', async () => {
      const alert = svc.deadLetterAlert('AMAZON', 7, 24)!
      const first = await inWs(() => svc.raiseChannelAlert(alert))
      const second = await inWs(() => svc.raiseChannelAlert(alert))
      expect(first.created).toBe(2)
      expect(second).toMatchObject({ created: 0, deduped: 2 })
      expect(await notices()).toHaveLength(2)
    })

    it('notifies again once the first was READ — a recurrence is new information', async () => {
      const alert = svc.deadLetterAlert('AMAZON', 7, 24)!
      await inWs(() => svc.raiseChannelAlert(alert))
      await q(`UPDATE "Notification" SET "readAt" = CURRENT_TIMESTAMP`)
      const again = await inWs(() => svc.raiseChannelAlert(alert))
      expect(again.created).toBe(2)
      expect(await notices()).toHaveLength(4)
    })

    it('keeps two channels apart — one bad channel does not silence the other', async () => {
      await inWs(() => svc.raiseChannelAlert(svc.deadLetterAlert('AMAZON', 7, 24)!))
      await inWs(() => svc.raiseChannelAlert(svc.deadLetterAlert('EBAY', 9, 24)!))
      expect(await notices()).toHaveLength(4)
    })
  })

  /* ── the thresholds ──────────────────────────────────────────────────────────────── */

  describe('thresholds — a notice an operator learns to dismiss is worse than none', () => {
    it('stays quiet below the dead-letter threshold', () => {
      expect(svc.deadLetterAlert('AMAZON', 4, 24)).toBeNull()
      expect(svc.deadLetterAlert('AMAZON', 5, 24)).not.toBeNull()
    })

    it('fires on ONE signature failure — an unverifiable payload is already worth saying', () => {
      expect(svc.signatureFailureAlert('EBAY', 0, 24)).toBeNull()
      expect(svc.signatureFailureAlert('EBAY', 1, 24)).not.toBeNull()
    })

    it('stays quiet below the rejection threshold', () => {
      expect(svc.feedRejectionAlert('AMAZON', 9, 3, 24)).toBeNull()
      expect(svc.feedRejectionAlert('AMAZON', 10, 3, 24)).not.toBeNull()
    })

    it('says nothing about a secret that is not due yet', () => {
      expect(svc.secretExpiryAlert('AMAZON_SP', 'production', 31)).toBeNull()
      expect(svc.secretExpiryAlert('AMAZON_SP', 'production', 30)).not.toBeNull()
    })

    it('escalates an ALREADY EXPIRED secret to danger and says it in the past tense', () => {
      const alert = svc.secretExpiryAlert('AMAZON_SP', 'production', -3)!
      expect(alert.severity).toBe('danger')
      expect(alert.title).toContain('has expired')
      expect(alert.body).toContain('3 days ago')
    })

    it('reads each threshold from its env override', () => {
      process.env.NEXUS_ALERT_DLQ_THRESHOLD = '20'
      expect(svc.deadLetterAlert('AMAZON', 19, 24)).toBeNull()
      expect(svc.deadLetterAlert('AMAZON', 20, 24)).not.toBeNull()
    })

    it('ignores a nonsense override rather than alerting on everything', () => {
      process.env.NEXUS_ALERT_DLQ_THRESHOLD = 'abc'
      expect(svc.thresholds.deadLetters()).toBe(5)
    })
  })

  /* ── the sweep, over the real sources ───────────────────────────────────────────── */

  describe('the sweep reads the real sources', () => {
    let job: typeof import('../../jobs/channel-alerts.job.js')
    const NOW = Date.UTC(2026, 8, 20, 12, 0, 0)
    const ago = (h: number) => new Date(NOW - h * 3_600_000)

    beforeAll(async () => { job = await import('../../jobs/channel-alerts.job.js') })

    const webhookEvent = (id: string, channel: string, o: { status?: string; signatureOk?: boolean | null; at: Date }) =>
      q(`INSERT INTO "WebhookEvent" ("workspaceId", id, channel, "externalId", "eventType", payload, "isProcessed", status, "signatureOk", "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$2,'test','{}'::jsonb,false,$4,$5,$6,$6)`,
        [WS, id, channel, o.status ?? 'done', o.signatureOk ?? null, o.at])

    beforeEach(async () => {
      await q(`DELETE FROM "Notification"`)
      await q(`DELETE FROM "WebhookEvent"`)
      await q(`DELETE FROM "ListingIssue"`)
      await q(`DELETE FROM "ChannelApp"`)
    })

    it('raises nothing when every source is quiet — and says so as belowThreshold', async () => {
      const r = await inWs(() => job.runChannelAlertSweep(NOW))
      expect(r.created).toBe(0)
      expect(await notices()).toHaveLength(0)
    })

    it('finds dead letters per channel, and keeps two channels apart', async () => {
      for (let i = 0; i < 6; i++) await webhookEvent(`d-amz-${i}`, 'AMAZON', { status: 'dlq', at: ago(2) })
      for (let i = 0; i < 5; i++) await webhookEvent(`d-ebay-${i}`, 'EBAY', { status: 'dlq', at: ago(2) })
      // Below the threshold on its own channel — must NOT be folded into the others.
      for (let i = 0; i < 2; i++) await webhookEvent(`d-shop-${i}`, 'SHOPIFY', { status: 'dlq', at: ago(2) })
      await inWs(() => job.runChannelAlertSweep(NOW))
      const rows = await notices('channel-dead-letters')
      expect(rows).toHaveLength(4) // 2 channels over threshold × 2 owners
      expect(new Set(rows.map((r) => r.entityId))).toEqual(new Set(['AMAZON', 'EBAY']))
    })

    it('ignores dead letters older than the window', async () => {
      for (let i = 0; i < 9; i++) await webhookEvent(`old-${i}`, 'AMAZON', { status: 'dlq', at: ago(48) })
      await inWs(() => job.runChannelAlertSweep(NOW))
      expect(await notices('channel-dead-letters')).toHaveLength(0)
    })

    it('finds a signature failure — one is enough', async () => {
      await webhookEvent('sig-1', 'SHOPIFY', { signatureOk: false, at: ago(1) })
      await inWs(() => job.runChannelAlertSweep(NOW))
      const rows = await notices('channel-signature-failures')
      expect(rows).toHaveLength(2)
      expect(rows[0].entityId).toBe('SHOPIFY')
    })

    it('does not read a verified event as a failure', async () => {
      await webhookEvent('sig-ok', 'SHOPIFY', { signatureOk: true, at: ago(1) })
      // `signatureOk: null` is "we never checked", which is also not a failure.
      await webhookEvent('sig-null', 'SHOPIFY', { signatureOk: null, at: ago(1) })
      await inWs(() => job.runChannelAlertSweep(NOW))
      expect(await notices('channel-signature-failures')).toHaveLength(0)
    })

    it('counts feed rejections through the LISTING, because ListingIssue names no channel', async () => {
      await q(`INSERT INTO "Product" ("workspaceId", id, sku, name, "basePrice", "updatedAt") VALUES ($1,'P-A','SKU-A','A',10,CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`, [WS])
      await q(`INSERT INTO "ChannelListing" ("workspaceId", id, "productId", "channelMarket", channel, region, marketplace, "updatedAt")
               VALUES ($1,'L-A','P-A','AMAZON_IT','AMAZON','IT','IT',CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`, [WS])
      for (let i = 0; i < 12; i++) {
        await q(`INSERT INTO "ListingIssue" ("workspaceId", id, "listingId", code, severity, message, "attributeNames", categories, source, fingerprint, "firstSeenAt", "lastSeenAt")
                 VALUES ($1,$2,'L-A','90220','ERROR','x',ARRAY['a${'$'}{i}']::text[],ARRAY[]::text[],'amazon-feed',$3,$4,$4)`,
          [WS, `i-${i}`, `90220::a${i}`, ago(2)])
      }
      await inWs(() => job.runChannelAlertSweep(NOW))
      const rows = await notices('channel-feed-rejections')
      expect(rows).toHaveLength(2)
      expect(rows[0].entityId).toBe('AMAZON')
      expect(rows[0].title).toContain('rejected 1 listing')
    })

    it('finds an app secret that is nearly out of time', async () => {
      await q(`INSERT INTO "ChannelApp" (id, "channelKey", environment, "clientId", "secretExpiresAt", "updatedAt")
               VALUES ('app-1','AMAZON_SP','production','client-1',$1,CURRENT_TIMESTAMP)`, [new Date(NOW + 5 * 86_400_000)])
      await inWs(() => job.runChannelAlertSweep(NOW))
      const rows = await notices('channel-secret-expiry')
      expect(rows).toHaveLength(2)
      expect(rows[0].title).toContain('expires in 5 days')
    })

    it('stays quiet about a secret with months left', async () => {
      await q(`INSERT INTO "ChannelApp" (id, "channelKey", environment, "clientId", "secretExpiresAt", "updatedAt")
               VALUES ('app-2','AMAZON_SP','production','client-2',$1,CURRENT_TIMESTAMP)`, [new Date(NOW + 120 * 86_400_000)])
      await inWs(() => job.runChannelAlertSweep(NOW))
      expect(await notices('channel-secret-expiry')).toHaveLength(0)
    })

    it('a second sweep tells nobody twice', async () => {
      await webhookEvent('sig-2', 'EBAY', { signatureOk: false, at: ago(1) })
      const first = await inWs(() => job.runChannelAlertSweep(NOW))
      const second = await inWs(() => job.runChannelAlertSweep(NOW))
      expect(first.created).toBe(2)
      expect(second.created).toBe(0)
      expect(second.deduped).toBe(2)
      expect(await notices()).toHaveLength(2)
    })

    it('daysUntil is whole days, and negative once it has passed', () => {
      expect(job.daysUntil(new Date(NOW + 5 * 86_400_000), NOW)).toBe(5)
      expect(job.daysUntil(new Date(NOW - 3 * 86_400_000), NOW)).toBe(-3)
    })
  })
})
