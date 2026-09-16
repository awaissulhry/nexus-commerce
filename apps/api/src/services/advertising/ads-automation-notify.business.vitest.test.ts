/**
 * The ads automation notifier, against a REAL disposable PostgreSQL with the real generated
 * policies — because "only this business's people" is decided by membership rows and the
 * Notification isolation policy together, and a mocked prisma can satisfy neither.
 *
 * The measured defect this pins (2026-09-16): a DEACTIVATED user who belonged to ZERO
 * businesses had received 195,370 ads notices.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, { get: (_t, p) => (database.client as unknown as Record<string, unknown>)[p as string] }),
}))

const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const A = 'ws_ads_a'
const B = 'ws_ads_b'

describe('ads automation notices reach this business’s people, and only them', () => {
  let notify: typeof import('./ads-automation-notify.service.js')
  let inA: string, inB: string, inBoth: string, deactivatedInA: string, revokedInA: string, nobody: string

  const count = (workspaceId: string, userId: string) =>
    withWorkspace({ workspaceId, actorUserId: userId, membershipId: null, roleKeys: [] },
      () => database.client.notification.count({ where: { userId, type: 'ads-automation-rule' } }))

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    notify = await import('./ads-automation-notify.service.js')

    const role = randomUUID()
    await database.db.query(`INSERT INTO "Role" (id,key,name,"isSystem","updatedAt") VALUES ($1,'OWNER','Owner',true,CURRENT_TIMESTAMP)`, [role])
    for (const [id, name] of [[A, 'Business A'], [B, 'Business B']]) {
      await database.db.query(`INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$2,'active','t',$1,CURRENT_TIMESTAMP)`, [id, name])
    }
    const person = async (status = 'active') => {
      const id = randomUUID()
      await database.db.query(`INSERT INTO "UserProfile" (id,email,status,"updatedAt") VALUES ($1,$2,$3,CURRENT_TIMESTAMP)`, [id, `${id}@example.test`, status])
      return id
    }
    const member = async (ws: string, user: string, status = 'active') => {
      const m = randomUUID()
      await database.db.query(`INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)`, [m, ws, user, status])
      await database.db.query(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [m, role])
    }
    inA = await person(); await member(A, inA)
    inB = await person(); await member(B, inB)
    inBoth = await person(); await member(A, inBoth); await member(B, inBoth)
    deactivatedInA = await person('deactivated'); await member(A, deactivatedInA)
    revokedInA = await person(); await member(A, revokedInA, 'revoked')
    nobody = await person() // an active login that belongs to no business
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 30_000)

  it('an automation running in business A notifies A’s two active members', async () => {
    const r = await withWorkspace({ workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] },
      () => notify.notifyAutomationDetailed({ type: 'ads-automation-rule', severity: 'warn', title: 'Budget capped', body: 'campaign 1' }))
    expect(r).toEqual({ created: 2, deduped: false, wouldHaveReached: 2 })
    expect(await count(A, inA)).toBe(1)
    expect(await count(A, inBoth)).toBe(1)
  })

  it('🔴 a member of ONLY business B gets nothing', async () => {
    expect(await count(B, inB)).toBe(0)
  })

  it('🔴 someone in both businesses sees it in A — and NOT in B', async () => {
    expect(await count(A, inBoth)).toBe(1)
    expect(await count(B, inBoth)).toBe(0)
  })

  it('🔴 a DEACTIVATED member gets nothing — the measured 195,370', async () => {
    const raw = await database.db.query(`SELECT count(*)::int n FROM "Notification" WHERE "userId" = $1`, [deactivatedInA])
    expect(raw.rows[0].n).toBe(0)
  })

  it('a REVOKED member gets nothing', async () => {
    const raw = await database.db.query(`SELECT count(*)::int n FROM "Notification" WHERE "userId" = $1`, [revokedInA])
    expect(raw.rows[0].n).toBe(0)
  })

  it('🔴 a login that belongs to no business gets nothing (the old every-user fan-out)', async () => {
    const raw = await database.db.query(`SELECT count(*)::int n FROM "Notification" WHERE "userId" = $1`, [nobody])
    expect(raw.rows[0].n).toBe(0)
  })

  it('every row is stored in the business that produced it', async () => {
    const raw = await database.db.query(`SELECT DISTINCT "workspaceId" FROM "Notification" WHERE type = 'ads-automation-rule'`)
    expect(raw.rows.map(r => r.workspaceId)).toEqual([A])
  })

  it('the same notice again is suppressed for the people already holding it', async () => {
    const r = await withWorkspace({ workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] },
      () => notify.notifyAutomationDetailed({ type: 'ads-automation-rule', severity: 'warn', title: 'Budget capped', body: 'campaign 1' }))
    expect(r).toEqual({ created: 0, deduped: true, wouldHaveReached: 2 })
  })

  it('🔴 once ONE person reads theirs, only THEY get the recurrence — the other still holds an unread copy', async () => {
    await database.db.query(`UPDATE "Notification" SET "readAt" = now() WHERE "userId" = $1`, [inA])
    const r = await withWorkspace({ workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] },
      () => notify.notifyAutomationDetailed({ type: 'ads-automation-rule', severity: 'warn', title: 'Budget capped', body: 'campaign 1' }))
    expect(r).toEqual({ created: 1, deduped: false, wouldHaveReached: 2 })
    expect(await count(A, inA)).toBe(2)
    expect(await count(A, inBoth)).toBe(1)
  })
})
