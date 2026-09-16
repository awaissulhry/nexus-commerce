/**
 * AE.2 — assortments and assortment shares, on a real disposable PostgreSQL with the real
 * generated policies, the status guard trigger and the answer function.
 *
 * Plan: docs/2026-09-16-assortment-engine-plan.md §14. The generator-built database used here was
 * proven catalogue-identical to "yesterday's schema + migration 20260916g" (policies, triggers,
 * constraints, indexes, grants, functions) before this suite was written — so these arms test the
 * rules production runs, not a second copy of them.
 *
 * Every refusal asserts its REASON (code), and has a positive control that the same actor CAN do
 * the neighbouring thing — a refusal that could come from anywhere proves nothing (BP.S1c).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, {
    get: (_t, property) => (database.client as unknown as Record<string, unknown>)[property as string],
  }),
}))

const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const A = 'ws_a_ae2_share' // offers the assortment
const B = 'ws_b_ae2_share' // the follower
const C = 'ws_c_ae2_share' // a third business

describe('AE.2 — assortments and shares between business profiles', () => {
  let assortments: typeof import('./assortment.service.js')
  let shares: typeof import('./assortment-share.service.js')
  let rules: typeof import('./share-rules.js')

  const user = { ownerA: '', ownerB: '', staffA: '', ownerC: '', viewerB: '' }
  const product = { parent: '', child: '', deleted: '', standalone: '', other: '', inB: '' }

  const as = <T>(workspaceId: string, actorUserId: string | null, work: () => Promise<T>) =>
    withWorkspace({ workspaceId, actorUserId, membershipId: null, roleKeys: [] }, work)
  const sql = async (text: string, params: unknown[] = []) => (await database.db.query(text, params)).rows as Array<Record<string, unknown>>
  /** Resolves to the refusal's code, or fails the test if the call succeeded. */
  const refusal = async (work: Promise<unknown>) => {
    try { await work } catch (error) { return (error as { code?: string }).code ?? String((error as Error).message) }
    throw new Error('expected a refusal, but the call succeeded')
  }
  /** The database's own error text, for arms that bypass the service. */
  const dbError = async (work: Promise<unknown>) => {
    try { await work } catch (error) { return String((error as Error).message) }
    return 'NO ERROR'
  }

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    assortments = await import('./assortment.service.js')
    shares = await import('./assortment-share.service.js')
    rules = await import('./share-rules.js')

    const ownerRole = randomUUID()
    const viewerRole = randomUUID()
    await sql(`INSERT INTO "Role" (id, key, name, "isSystem", "updatedAt") VALUES ($1,'OWNER','Owner',true,CURRENT_TIMESTAMP)`, [ownerRole])
    await sql(`INSERT INTO "Role" (id, key, name, "isSystem", permissions, "updatedAt") VALUES ($1,'VIEWER','Viewer',true,ARRAY['products.view'],CURRENT_TIMESTAMP)`, [viewerRole])
    for (const key of Object.keys(user) as Array<keyof typeof user>) {
      user[key] = randomUUID()
      await sql(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,$2,'active',CURRENT_TIMESTAMP)`, [user[key], `${key}-${user[key]}@example.test`])
    }
    for (const [id, name] of [[A, 'Business A'], [B, 'Business B'], [C, 'Business C']]) {
      await sql(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,$2,'active','ae2',$1,CURRENT_TIMESTAMP)`, [id, name])
    }
    const member = async (workspaceId: string, userId: string, roleId: string) => {
      const id = randomUUID()
      await sql(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1,$2,$3,'active',CURRENT_TIMESTAMP)`, [id, workspaceId, userId])
      await sql(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [id, roleId])
    }
    await member(A, user.ownerA, ownerRole)
    await member(B, user.ownerA, viewerRole) // ownerA belongs to B, but is NOT its owner
    await member(B, user.ownerB, ownerRole)
    await member(B, user.viewerB, viewerRole)
    await member(A, user.staffA, viewerRole)
    await member(C, user.ownerC, ownerRole)

    const seed = async (workspaceId: string, extra: { parentId?: string; deleted?: boolean } = {}) => {
      const id = randomUUID()
      await sql(
        `INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "parentId", "deletedAt", "updatedAt") VALUES ($1,$2,$3,$3,10,$4,$5,CURRENT_TIMESTAMP)`,
        [id, workspaceId, `AE2-${id.slice(0, 8)}`, extra.parentId ?? null, extra.deleted ? new Date() : null],
      )
      return id
    }
    product.parent = await seed(A)
    product.child = await seed(A, { parentId: product.parent })
    product.deleted = await seed(A, { deleted: true })
    product.standalone = await seed(A)
    product.other = await seed(A)
    product.inB = await seed(B)
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 30_000)

  // ── Assortments ───────────────────────────────────────────────────────────────
  describe('assortments', () => {
    it('CONTROL — create, add top-level products, list; the version advances with each change', async () => {
      const created = await as(A, user.staffA, () => assortments.createAssortment({ name: 'Summer jackets', selection: 'list' }))
      expect(created).toMatchObject({ name: 'Summer jackets', selection: 'list', version: 1, memberCount: 0 })
      const added = await as(A, user.staffA, () => assortments.addMembers(created.id, { productIds: [product.parent, product.standalone], expectedVersion: 1 }))
      expect(added).toEqual({ added: 2, alreadyMembers: 0, version: 2 })
      const again = await as(A, user.staffA, () => assortments.addMembers(created.id, { productIds: [product.parent], expectedVersion: 2 }))
      expect(again).toEqual({ added: 0, alreadyMembers: 1, version: 3 })
      const members = await as(A, user.staffA, () => assortments.listMembers(created.id))
      expect(members.members.map((m) => m.productId).sort()).toEqual([product.parent, product.standalone].sort())
      expect(members.members.every((m) => m.mode === 'include')).toBe(true)
      const listed = await as(A, user.staffA, () => assortments.listAssortments())
      expect(listed.find((row) => row.id === created.id)).toMatchObject({ memberCount: 2, version: 3 })
    })

    it('an "all" assortment stores its members as exclusions', async () => {
      const created = await as(A, user.staffA, () => assortments.createAssortment({ name: 'Everything but', selection: 'all' }))
      await as(A, user.staffA, () => assortments.addMembers(created.id, { productIds: [product.other], expectedVersion: 1 }))
      const members = await as(A, user.staffA, () => assortments.listMembers(created.id))
      expect(members.members).toEqual([expect.objectContaining({ productId: product.other, mode: 'exclude' })])
    })

    it('refuses variations, deleted products and another business\'s products — all or nothing, each named', async () => {
      const created = await as(A, user.staffA, () => assortments.createAssortment({ name: 'Refusals' }))
      let caught: { code?: string; refused?: Array<{ productId: string; reason: string }> } = {}
      try {
        await as(A, user.staffA, () => assortments.addMembers(created.id, { productIds: [product.standalone, product.child, product.deleted, product.inB], expectedVersion: 1 }))
      } catch (error) { caught = error as typeof caught }
      expect(caught.code).toBe('products_refused')
      expect(caught.refused?.map((r) => r.productId).sort()).toEqual([product.child, product.deleted, product.inB].sort())
      expect(caught.refused?.find((r) => r.productId === product.child)?.reason).toMatch(/variation/)
      // Nothing was added — not even the valid product — and the version did not move.
      expect((await as(A, user.staffA, () => assortments.listMembers(created.id))).members).toEqual([])
      expect((await as(A, user.staffA, () => assortments.listAssortments())).find((r) => r.id === created.id)?.version).toBe(1)
    })

    it('a stale version is refused; a duplicate name is refused; archive keeps the row', async () => {
      const created = await as(A, user.staffA, () => assortments.createAssortment({ name: 'Versioned' }))
      expect(await refusal(as(A, user.staffA, () => assortments.updateAssortment(created.id, { name: 'Versioned 2', expectedVersion: 7 })))).toBe('assortment_changed')
      expect(await refusal(as(A, user.staffA, () => assortments.createAssortment({ name: 'Versioned' })))).toBe('assortment_name_taken')
      const renamed = await as(A, user.staffA, () => assortments.updateAssortment(created.id, { name: 'Versioned 2', expectedVersion: 1 }))
      expect(renamed).toMatchObject({ name: 'Versioned 2', version: 2 })
      const archived = await as(A, user.staffA, () => assortments.archiveAssortment(created.id, { expectedVersion: 2 }))
      expect(archived.archivedAt).not.toBeNull()
      expect(await refusal(as(A, user.staffA, () => assortments.addMembers(created.id, { productIds: [product.parent], expectedVersion: 3 })))).toBe('assortment_archived')
      expect((await as(A, user.staffA, () => assortments.listAssortments())).some((r) => r.id === created.id)).toBe(false)
      expect((await as(A, user.staffA, () => assortments.listAssortments({ includeArchived: true }))).some((r) => r.id === created.id)).toBe(true)
    })

    it('another business cannot see or change the assortment (no share yet)', async () => {
      const created = await as(A, user.staffA, () => assortments.createAssortment({ name: 'Private to A' }))
      expect(await refusal(as(B, user.ownerB, () => assortments.addMembers(created.id, { productIds: [product.inB], expectedVersion: 1 })))).toBe('assortment_not_found')
      expect((await as(B, user.ownerB, () => assortments.listAssortments())).some((r) => r.id === created.id)).toBe(false)
    })
  })

  // ── Shares through the services ───────────────────────────────────────────────
  describe('offer and answer', () => {
    let assortmentId = ''
    let shareId = ''

    beforeAll(async () => {
      const created = await as(A, user.ownerA, () => assortments.createAssortment({ name: 'Offered to B' }))
      assortmentId = created.id
      await as(A, user.ownerA, () => assortments.addMembers(assortmentId, { productIds: [product.parent], expectedVersion: 1 }))
    })

    it('refusals before an offer exists, each for its own reason', async () => {
      // Not an owner of A (staffA is a viewer).
      expect(await refusal(as(A, user.staffA, () => shares.offerShare({ assortmentId, destinationWorkspaceId: B })))).toBe('workspace_owner_required')
      // No person (an API key).
      expect(await refusal(as(A, null, () => shares.offerShare({ assortmentId, destinationWorkspaceId: B })))).toBe('session_required')
      // A business ownerA does not belong to.
      expect(await refusal(as(A, user.ownerA, () => shares.offerShare({ assortmentId, destinationWorkspaceId: C })))).toBe('destination_unavailable')
      // Its own business.
      expect(await refusal(as(A, user.ownerA, () => shares.offerShare({ assortmentId, destinationWorkspaceId: A })))).toBe('invalid_destination')
      // A malformed field-group list.
      expect(await refusal(as(A, user.ownerA, () => shares.offerShare({ assortmentId, destinationWorkspaceId: B, fieldGroups: ['listings'] })))).toBe('invalid_field_groups')
    })

    it('CONTROL — the owner of A offers to B: pending, default field groups, audited in BOTH businesses', async () => {
      const share = await as(A, user.ownerA, () => shares.offerShare({ assortmentId, destinationWorkspaceId: B }))
      shareId = share.id
      expect(share).toMatchObject({
        status: 'pending', version: 1, assortmentName: 'Offered to B', ownerWorkspaceId: A, workspaceId: B,
        ownerWorkspaceName: 'Business A', workspaceName: 'Business B', followSettings: false,
        fieldGroups: [...rules.DEFAULT_FIELD_GROUPS],
      })
      const audits = await sql(`SELECT "workspaceId", action FROM "WorkspaceAudit" WHERE "targetId" = $1 ORDER BY "workspaceId"`, [shareId])
      expect(audits).toEqual([{ workspaceId: A, action: 'assortment.share_offered' }, { workspaceId: B, action: 'assortment.share_offered' }])
    })

    it('a second open offer of the same assortment to the same business is refused', async () => {
      expect(await refusal(as(A, user.ownerA, () => shares.offerShare({ assortmentId, destinationWorkspaceId: B })))).toBe('share_already_open')
    })

    it('B sees the incoming offer and the assortment name; C sees nothing (positive control: the row exists)', async () => {
      const inB = await as(B, user.viewerB, () => shares.listShares())
      expect(inB.incoming.map((s) => s.id)).toContain(shareId)
      expect(inB.incoming.find((s) => s.id === shareId)?.assortmentName).toBe('Offered to B')
      expect(inB.outgoing).toEqual([])
      const inC = await as(C, user.ownerC, () => shares.listShares())
      expect([...inC.incoming, ...inC.outgoing].some((s) => s.id === shareId)).toBe(false)
      expect((await sql(`SELECT count(*)::int AS n FROM "AssortmentShare" WHERE id = $1`, [shareId]))[0].n).toBe(1)
    })

    it('🔴 the owner cannot answer for the follower, and the follower cannot pause for the owner', async () => {
      expect(await refusal(as(A, user.ownerA, () => shares.followerDecision(shareId, 'accept', { expectedVersion: 1 })))).toBe('share_follower_only')
      expect(await refusal(as(B, user.ownerB, () => shares.ownerAction(shareId, 'pause', { expectedVersion: 1 })))).toBe('share_owner_only')
    })

    it('only an OWNER of B may accept: a member who is not an owner is refused — by the service AND by the database function', async () => {
      // ownerA is a member of B but not its owner.
      expect(await refusal(as(B, user.ownerA, () => shares.followerDecision(shareId, 'accept', { expectedVersion: 1 })))).toBe('workspace_owner_required')
      // Straight at the database function, skipping the service's check.
      const [{ result }] = await as(B, user.ownerA, () => database.client.$queryRaw<Array<{ result: { code: string } }>>`SELECT nexus_assortment_share_respond(${shareId}, 'accept', 1) AS result`)
      expect(result.code).toBe('workspace_owner_required')
      expect((await sql(`SELECT status FROM "AssortmentShare" WHERE id = $1`, [shareId]))[0].status).toBe('pending')
    })

    it('a stale version is refused with the current state', async () => {
      expect(await refusal(as(B, user.ownerB, () => shares.followerDecision(shareId, 'accept', { expectedVersion: 9 })))).toBe('share_changed')
    })

    it('CONTROL — the owner of B accepts: active, answered by that person, audited in both', async () => {
      const accepted = await as(B, user.ownerB, () => shares.followerDecision(shareId, 'accept', { expectedVersion: 1 }))
      expect(accepted).toMatchObject({ status: 'active', version: 2 })
      const row = (await sql(`SELECT "respondedByUserId", "respondedAt" FROM "AssortmentShare" WHERE id = $1`, [shareId]))[0]
      expect(row.respondedByUserId).toBe(user.ownerB)
      expect(row.respondedAt).not.toBeNull()
      const audits = await sql(`SELECT "workspaceId" FROM "WorkspaceAudit" WHERE "targetId" = $1 AND action = 'assortment.share_accepted'`, [shareId])
      expect(audits.map((a) => a.workspaceId).sort()).toEqual([A, B])
    })

    it('an assortment with an open share cannot be archived', async () => {
      const version = (await as(A, user.ownerA, () => assortments.listAssortments())).find((r) => r.id === assortmentId)!.version
      expect(await refusal(as(A, user.ownerA, () => assortments.archiveAssortment(assortmentId, { expectedVersion: version })))).toBe('assortment_shared')
    })

    it('B can read the offered assortment but not change it or add to it', async () => {
      expect(await refusal(as(B, user.ownerB, () => assortments.addMembers(assortmentId, { productIds: [product.inB], expectedVersion: 99 })))).toBe('assortment_not_owned')
      expect(await refusal(as(B, user.ownerB, () => assortments.updateAssortment(assortmentId, { name: 'Taken over', expectedVersion: 99 })))).toBe('assortment_not_owned')
      // And B's own list does not show A's assortment.
      expect((await as(B, user.ownerB, () => assortments.listAssortments())).some((r) => r.id === assortmentId)).toBe(false)
    })

    it('pause → resume → B leaves; an ended share accepts nothing more; B loses sight of the assortment', async () => {
      const paused = await as(A, user.ownerA, () => shares.ownerAction(shareId, 'pause', { expectedVersion: 2 }))
      expect(paused).toMatchObject({ status: 'paused', version: 3 })
      expect(await refusal(as(A, user.ownerA, () => shares.ownerAction(shareId, 'pause', { expectedVersion: 3 })))).toBe('share_state')
      const resumed = await as(A, user.ownerA, () => shares.ownerAction(shareId, 'resume', { expectedVersion: 3 }))
      expect(resumed).toMatchObject({ status: 'active', version: 4 })
      const left = await as(B, user.ownerB, () => shares.followerDecision(shareId, 'leave', { expectedVersion: 4 }))
      expect(left).toMatchObject({ status: 'revoked', endedBySide: 'follower', version: 5 })
      expect(await refusal(as(A, user.ownerA, () => shares.ownerAction(shareId, 'resume', { expectedVersion: 5 })))).toBe('share_state')
      expect((await as(B, user.ownerB, () => shares.listShares())).incoming.find((s) => s.id === shareId)?.assortmentName).toBeNull()
      // The ended share no longer blocks a new offer.
      const again = await as(A, user.ownerA, () => shares.offerShare({ assortmentId, destinationWorkspaceId: B, fieldGroups: ['identity', 'media'] }))
      expect(again).toMatchObject({ status: 'pending', fieldGroups: ['identity', 'media'] })
      // Withdraw it (owner revokes a pending offer), then decline is impossible.
      const withdrawn = await as(A, user.ownerA, () => shares.ownerAction(again.id, 'revoke', { expectedVersion: 1 }))
      expect(withdrawn).toMatchObject({ status: 'revoked', endedBySide: 'owner' })
      expect((await sql(`SELECT action FROM "WorkspaceAudit" WHERE "targetId" = $1 AND "workspaceId" = $2 ORDER BY "createdAt"`, [again.id, B])).map((r) => r.action))
        .toEqual(['assortment.share_offered', 'assortment.share_withdrawn'])
      expect(await refusal(as(B, user.ownerB, () => shares.followerDecision(again.id, 'decline', { expectedVersion: 2 })))).toBe('share_state')
    })

    it('decline ends a pending offer', async () => {
      const created = await as(A, user.ownerA, () => assortments.createAssortment({ name: 'To be declined' }))
      const offer = await as(A, user.ownerA, () => shares.offerShare({ assortmentId: created.id, destinationWorkspaceId: B }))
      const declined = await as(B, user.ownerB, () => shares.followerDecision(offer.id, 'decline', { expectedVersion: 1 }))
      expect(declined).toMatchObject({ status: 'declined', endedBySide: 'follower', version: 2 })
    })
  })

  // ── The database rules, with the service out of the way ───────────────────────
  describe('database rules (no service in the path)', () => {
    let assortmentId = ''
    let pendingId = ''

    beforeAll(async () => {
      const created = await as(A, user.ownerA, () => assortments.createAssortment({ name: 'Database arms' }))
      assortmentId = created.id
      pendingId = (await as(A, user.ownerA, () => shares.offerShare({ assortmentId, destinationWorkspaceId: B }))).id
    })

    it('🔴 the owner cannot activate a pending share with a direct UPDATE — the trigger refuses', async () => {
      const error = await dbError(as(A, user.ownerA, () => database.client.$executeRaw`UPDATE "AssortmentShare" SET status = 'active', version = version + 1 WHERE id = ${pendingId}`))
      expect(error).toMatch(/owner cannot change a pending share to active/)
      expect((await sql(`SELECT status FROM "AssortmentShare" WHERE id = $1`, [pendingId]))[0].status).toBe('pending')
    })

    it('🔴 the follower cannot UPDATE or DELETE the row directly (0 rows); the owner cannot DELETE it (trigger)', async () => {
      const followerUpdate = await as(B, user.ownerB, () => database.client.$executeRaw`UPDATE "AssortmentShare" SET status = 'active', version = version + 1 WHERE id = ${pendingId}`)
      expect(followerUpdate).toBe(0)
      const followerDelete = await as(B, user.ownerB, () => database.client.$executeRaw`DELETE FROM "AssortmentShare" WHERE id = ${pendingId}`)
      expect(followerDelete).toBe(0)
      expect(await dbError(as(A, user.ownerA, () => database.client.$executeRaw`DELETE FROM "AssortmentShare" WHERE id = ${pendingId}`))).toMatch(/never deleted/)
      // Positive control: the row is still there and still pending — each 0 was a refusal, not an empty table.
      expect((await sql(`SELECT status FROM "AssortmentShare" WHERE id = $1`, [pendingId]))[0].status).toBe('pending')
      expect((await as(B, user.ownerB, () => database.client.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "AssortmentShare" WHERE id = ${pendingId}`))[0].n).toBe(1)
    })

    it('a third business can neither read nor write the row', async () => {
      expect((await as(C, user.ownerC, () => database.client.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "AssortmentShare" WHERE id = ${pendingId}`))[0].n).toBe(0)
      expect(await as(C, user.ownerC, () => database.client.$executeRaw`UPDATE "AssortmentShare" SET version = version + 1 WHERE id = ${pendingId}`)).toBe(0)
    })

    it('what was offered cannot change: field groups, follower and assortment are immutable', async () => {
      expect(await dbError(as(A, user.ownerA, () => database.client.$executeRaw`UPDATE "AssortmentShare" SET "fieldGroups" = ARRAY['identity','price'], version = version + 1 WHERE id = ${pendingId}`))).toMatch(/cannot change after it is offered/)
      expect(await dbError(as(A, user.ownerA, () => database.client.$executeRaw`UPDATE "AssortmentShare" SET "workspaceId" = ${C}, version = version + 1 WHERE id = ${pendingId}`))).toMatch(/cannot change after it is offered/)
    })

    it('a share cannot be offered by a business that does not own the assortment (composite key)', async () => {
      const error = await dbError(as(B, user.ownerB, () => database.client.$executeRaw`
        INSERT INTO "AssortmentShare" (id, "assortmentId", "ownerWorkspaceId", "workspaceId", "fieldGroups", "createdByUserId", "updatedAt")
        VALUES (${randomUUID()}, ${assortmentId}, ${B}, ${C}, ARRAY['identity'], ${user.ownerB}, CURRENT_TIMESTAMP)`))
      expect(error).toMatch(/foreign key|violates/i)
    })

    it('a share cannot start in any state but pending, nor with an empty or unknown field group', async () => {
      const insert = (status: string, groups: string[]) => as(A, user.ownerA, () => database.client.$executeRawUnsafe(
        `INSERT INTO "AssortmentShare" (id, "assortmentId", "ownerWorkspaceId", "workspaceId", status, "fieldGroups", "createdByUserId", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7, CURRENT_TIMESTAMP)`, randomUUID(), assortmentId, A, C, status, groups, user.ownerA))
      expect(await dbError(insert('active', ['identity']))).toMatch(/starts pending/)
      expect(await dbError(insert('pending', []))).toMatch(/AssortmentShare_field_groups_check/)
      expect(await dbError(insert('pending', ['listings']))).toMatch(/AssortmentShare_field_groups_check/)
    })

    it('the trigger allows EXACTLY the transitions share-rules.ts allows — all 50 (side, from, to)', async () => {
      const mismatches: string[] = []
      let checked = 0
      for (const side of ['owner', 'follower'] as const) {
        for (const from of rules.SHARE_STATUSES) {
          for (const to of rules.SHARE_STATUSES) {
            // Put a row in `from` with the guard off, as the superuser, then switch the guard back on.
            // Each arm gets its own assortment, so the one-open-share index never decides an arm.
            const id = randomUUID()
            const armAssortment = randomUUID()
            const ended = from === 'declined' || from === 'revoked'
            await sql(`INSERT INTO "Assortment" (id, "workspaceId", name, "updatedAt") VALUES ($1,$2,$3,CURRENT_TIMESTAMP)`, [armAssortment, A, `arm ${armAssortment}`])
            await database.db.exec('ALTER TABLE "AssortmentShare" DISABLE TRIGGER nexus_assortment_share_guard')
            await sql(
              `INSERT INTO "AssortmentShare" (id, "assortmentId", "ownerWorkspaceId", "workspaceId", status, "fieldGroups", "createdByUserId", "endedBySide", "endedAt", "updatedAt")
               VALUES ($1,$2,$3,$4,$5,ARRAY['identity'],$6,$7,$8,CURRENT_TIMESTAMP)`,
              [id, armAssortment, A, C, from, user.ownerA, ended ? 'owner' : null, ended ? new Date() : null],
            )
            await database.db.exec('ALTER TABLE "AssortmentShare" ENABLE TRIGGER nexus_assortment_share_guard')
            // The acting side is the business in the context — exactly what the guard reads.
            const context = side === 'owner' ? A : C
            const endsIt = to === 'declined' || to === 'revoked'
            let allowed = true
            try {
              await database.db.transaction(async (tx) => {
                await tx.query(`SELECT set_config('nexus.workspace_id', $1, true)`, [context])
                await tx.query(
                  `UPDATE "AssortmentShare" SET status = $1, version = version + 1, "endedBySide" = $2, "endedAt" = $3 WHERE id = $4`,
                  [to, endsIt ? side : null, endsIt ? new Date() : null, id],
                )
              })
            } catch { allowed = false }
            if (allowed !== rules.canTransition(side, from, to)) mismatches.push(`${side} ${from}→${to}: database ${allowed}, rules ${!allowed}`)
            checked++
          }
        }
      }
      expect(checked).toBe(50)
      expect(mismatches).toEqual([])
      // Positive control that the guard was ON during those arms: a known-forbidden change is refused now.
      const probe = await sql(`SELECT id FROM "AssortmentShare" WHERE "workspaceId" = $1 AND status = 'pending' LIMIT 1`, [C])
      await expect(database.db.transaction(async (tx) => {
        await tx.query(`SELECT set_config('nexus.workspace_id', $1, true)`, [A])
        await tx.query(`UPDATE "AssortmentShare" SET status = 'active', version = version + 1 WHERE id = $1`, [probe[0].id])
      })).rejects.toThrow(/owner cannot change a pending share to active/)
    }, 120_000)
  })
})
