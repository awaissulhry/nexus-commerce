/**
 * Shared stock — the profile switch: offering stock to another business profile, answering the offer,
 * pausing, resuming and ending it. Plan: docs/2026-09-19-shared-stock-plan.md §4; contract
 * docs/2026-09-19-shared-stock-build.md §2.
 *
 * Three layers, each covering what the others cannot (the AE.2 shape):
 *   • The database (stock-pool.sql): row security, the grant guard (only the borrower can make a
 *     pending grant active; owners only; fixed terms), the answer function, one open grant per pair.
 *   • This service: a refusal in words the owner can act on, before the database has to refuse, the
 *     audit on BOTH sides, and a notice to the other business's owners.
 *   • grant-rules.ts: the same transition table, parity-tested against the guard.
 *
 * Every change that moves listings (accept, pause, resume, end, leave) is followed by a kick of the
 * pool work (pool-tasks.ts): the database queued the listing work in the same transaction.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { WorkspaceError, requireWorkspace, withWorkspace } from '../../lib/workspace-context.js'
import { createWorkspaceService } from '../workspace.service.js'
import { logger } from '../../utils/logger.js'
import {
  borrowerTarget, canTransition, expectVersion, idList, lenderTarget, transitionRefusal,
  type BorrowerDecision, type GrantStatus, type LenderAction,
} from './grant-rules.js'
import { notifyOwners } from './pool-notify.js'
import { afterPoolChange } from './pool-tasks.js'
import { syncSharedWarehouses } from './shared-warehouses.js'

const workspaces = createWorkspaceService(prisma)

export interface GrantLocation {
  id: string
  code: string | null
  name: string | null
  /** False when the lender no longer has it as an active warehouse: it then lends nothing. */
  usable: boolean
}

export interface GrantRow {
  id: string
  /** Which side this business is on. */
  side: 'lender' | 'borrower'
  ownerWorkspaceId: string
  ownerWorkspaceName: string
  workspaceId: string
  workspaceName: string
  status: GrantStatus
  version: number
  locations: GrantLocation[]
  /** The borrower's products that sell from this pool now. */
  linkedProducts: number
  createdAt: Date
  respondedAt: Date | null
  pausedAt: Date | null
  endedAt: Date | null
  endedBySide: 'owner' | 'borrower' | null
}

export interface GrantImpact {
  grantId: string
  linkedProducts: number
  listings: { toZero: number; toOwn: number; pinned: number; paused: number; closed: number; fba: number }
  sharedVariants: { toZero: number; toOwn: number; excluded: number }
}

const grantSelect = {
  id: true, ownerWorkspaceId: true, workspaceId: true, status: true, version: true, createdAt: true,
  respondedAt: true, pausedAt: true, endedAt: true, endedBySide: true,
  ownerWorkspace: { select: { name: true } },
  workspace: { select: { name: true } },
} satisfies Prisma.StockPoolGrantSelect

type GrantRecord = Prisma.StockPoolGrantGetPayload<{ select: typeof grantSelect }>

/** Consent is a human act: an API key carries no person and can never offer or answer. */
function actingPerson(verb: string) {
  const context = requireWorkspace()
  if (!context.actorUserId) throw new WorkspaceError('session_required', `Sign in as an owner of this business profile to ${verb} shared stock.`, 403)
  return { workspaceId: context.workspaceId, actorUserId: context.actorUserId }
}

async function withDetails(rows: GrantRecord[], workspaceId: string): Promise<GrantRow[]> {
  if (rows.length === 0) return []
  const details = await prisma.$queryRaw<Array<{ grant_id: string; linked_products: number; locations: GrantLocation[] }>>`
    SELECT * FROM nexus_pool_grant_details(${rows.map((r) => r.id)}::text[])`
  const byId = new Map(details.map((d) => [d.grant_id, d]))
  return rows.map(({ ownerWorkspace, workspace, ...row }) => ({
    ...row,
    side: row.ownerWorkspaceId === workspaceId ? 'lender' : 'borrower',
    status: row.status as GrantStatus,
    endedBySide: row.endedBySide as GrantRow['endedBySide'],
    ownerWorkspaceName: ownerWorkspace.name,
    workspaceName: workspace.name,
    locations: byId.get(row.id)?.locations ?? [],
    linkedProducts: Number(byId.get(row.id)?.linked_products ?? 0),
  }))
}

async function audit(tx: Prisma.TransactionClient, grant: { id: string; ownerWorkspaceId: string; workspaceId: string }, actorUserId: string, action: string, metadata: Record<string, unknown> = {}) {
  // Both businesses get the record: each must be able to see how the other reached it.
  for (const workspaceId of [grant.ownerWorkspaceId, grant.workspaceId]) {
    await tx.workspaceAudit.create({
      data: {
        workspaceId, actorUserId, action, targetId: grant.id,
        metadata: { lenderWorkspaceId: grant.ownerWorkspaceId, borrowerWorkspaceId: grant.workspaceId, ...metadata } as Prisma.InputJsonValue,
      },
    })
  }
}

/** Tell the OTHER business's owners, in that business's own context (its notifications are its rows). */
async function tellOtherSide(otherWorkspaceId: string, notice: Parameters<typeof notifyOwners>[0]) {
  try {
    await withWorkspace({ workspaceId: otherWorkspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, () => notifyOwners(notice))
  } catch (error) {
    logger.warn('[stock-pool] could not notify the other business', { otherWorkspaceId, error: String(error).slice(0, 160) })
  }
}

/** Outgoing (this business lends) and incoming (this business borrows). */
export async function listGrants(): Promise<{ lending: GrantRow[]; borrowing: GrantRow[] }> {
  const { workspaceId } = requireWorkspace()
  const [lending, borrowing] = await Promise.all([
    prisma.stockPoolGrant.findMany({ where: { ownerWorkspaceId: workspaceId }, select: grantSelect, orderBy: { createdAt: 'desc' } }),
    prisma.stockPoolGrant.findMany({ where: { workspaceId }, select: grantSelect, orderBy: { createdAt: 'desc' } }),
  ])
  return { lending: await withDetails(lending, workspaceId), borrowing: await withDetails(borrowing, workspaceId) }
}

/** The warehouses this business can lend: its active WAREHOUSE locations. Never Amazon FBA stock. */
export async function lendableLocations(): Promise<Array<{ id: string; code: string; name: string }>> {
  requireWorkspace()
  return prisma.stockLocation.findMany({ where: { type: 'WAREHOUSE', isActive: true }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } })
}

export async function offerGrant(input: { borrowerWorkspaceId?: unknown; locationIds?: unknown }): Promise<GrantRow> {
  const { workspaceId, actorUserId } = actingPerson('offer')
  const borrowerWorkspaceId = typeof input.borrowerWorkspaceId === 'string' ? input.borrowerWorkspaceId : ''
  if (!borrowerWorkspaceId || borrowerWorkspaceId === workspaceId) throw new WorkspaceError('invalid_borrower', 'Choose a different business profile to lend stock to.', 400)
  const locationIds = idList(input.locationIds, 'warehouses', 50)

  // "May you lend at all" before "may you name that business" — so a refusal states the true reason.
  await workspaces.requireOwner(actorUserId, workspaceId)
  try {
    await workspaces.membership(actorUserId, borrowerWorkspaceId)
  } catch {
    throw new WorkspaceError('borrower_unavailable', 'You can only lend stock to a business profile you are a member of.', 403)
  }
  const lendable = new Set((await lendableLocations()).map((l) => l.id))
  const wrong = locationIds.filter((id) => !lendable.has(id))
  if (wrong.length > 0) throw new WorkspaceError('invalid_warehouses', 'Only active warehouses of this business can be lent. Amazon FBA stock never can.', 400)

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.stockPoolGrant.create({
      data: { ownerWorkspaceId: workspaceId, workspaceId: borrowerWorkspaceId, locationIds, createdByUserId: actorUserId },
      select: grantSelect,
    })
    await audit(tx, row, actorUserId, 'stock_pool.offered', { locationIds })
    return row
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new WorkspaceError('grant_already_open', 'This business already has open shared stock with that business profile. End it before offering a new one.', 409)
    }
    throw error
  })
  const [row] = await withDetails([created], workspaceId)
  await tellOtherSide(borrowerWorkspaceId, {
    type: 'stock-pool-offered', severity: 'info',
    title: `${row.ownerWorkspaceName} offers to share its stock`,
    body: `${row.ownerWorkspaceName} offers ${row.locations.length === 1 ? 'one warehouse' : `${row.locations.length} warehouses`} as shared stock. Nothing changes until an owner accepts.`,
    entityType: 'StockPoolGrant', entityId: row.id, href: '/settings/sharing',
  })
  return row
}

const LENDER_AUDIT: Record<LenderAction, string> = { pause: 'paused', resume: 'resumed', end: 'ended' }

/** Pause, resume or end (a pending offer is withdrawn by ending it). An OWNER of the lending business. */
export async function lenderAction(grantId: string, action: LenderAction, input: { expectedVersion?: unknown }): Promise<GrantRow> {
  const { workspaceId, actorUserId } = actingPerson(action)
  const expectedVersion = expectVersion(input.expectedVersion)
  await workspaces.requireOwner(actorUserId, workspaceId)

  const grant = await prisma.stockPoolGrant.findUnique({ where: { id: grantId }, select: grantSelect })
  if (!grant) throw new WorkspaceError('grant_not_found', 'This shared stock is unavailable in this business profile.', 404)
  if (grant.ownerWorkspaceId !== workspaceId) {
    throw new WorkspaceError('grant_lender_only', 'Only the business that lends this stock can pause, resume or end it. You can leave it.', 403)
  }
  const from = grant.status as GrantStatus
  const to = lenderTarget(action)
  if (!canTransition('owner', from, to)) throw new WorkspaceError('grant_state', transitionRefusal('owner', action, from), 409)

  const now = new Date()
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.stockPoolGrant.updateMany({
      where: { id: grantId, ownerWorkspaceId: workspaceId, version: expectedVersion, status: from },
      data: {
        status: to,
        version: { increment: 1 },
        ...(action === 'pause' ? { pausedAt: now, pausedByUserId: actorUserId } : {}),
        ...(action === 'resume' ? { pausedAt: null, pausedByUserId: null } : {}),
        ...(action === 'end' ? { endedAt: now, endedByUserId: actorUserId, endedBySide: 'owner' } : {}),
      },
    })
    if (result.count === 0) throw new WorkspaceError('grant_changed', 'This shared stock changed since you loaded it. Review it again.', 409)
    const verb = action === 'end' && from === 'pending' ? 'withdrawn' : LENDER_AUDIT[action]
    await audit(tx, grant, actorUserId, `stock_pool.${verb}`, { from, to })
    return tx.stockPoolGrant.findUniqueOrThrow({ where: { id: grantId }, select: grantSelect })
  })
  afterPoolChange()
  const [row] = await withDetails([updated], workspaceId)
  const pending = from === 'pending'
  await tellOtherSide(grant.workspaceId, {
    type: 'stock-pool-changed', severity: action === 'resume' ? 'info' : 'warn',
    title: pending ? `${row.ownerWorkspaceName} withdrew its shared stock offer`
      : action === 'pause' ? `${row.ownerWorkspaceName} paused its shared stock`
        : action === 'resume' ? `${row.ownerWorkspaceName} turned its shared stock back on`
          : `${row.ownerWorkspaceName} ended its shared stock`,
    body: pending ? null
      : action === 'resume' ? 'Your products that use it show the shared number again.'
        : 'Your products that used it now show their own stock, or 0. Orders already made still ship from the shared stock.',
    entityType: 'StockPoolGrant', entityId: row.id, href: '/settings/sharing',
  })
  return row
}

const BORROWER_AUDIT: Record<BorrowerDecision, string> = { accept: 'accepted', decline: 'declined', leave: 'left' }

/**
 * Accept, decline or leave. An OWNER of the borrowing business. Goes through the database function
 * `nexus_stock_pool_grant_respond`: the borrower has no UPDATE policy on the lender's row; the
 * function re-checks the OWNER role and the version itself.
 */
export async function borrowerDecision(grantId: string, decision: BorrowerDecision, input: { expectedVersion?: unknown }): Promise<GrantRow> {
  const { workspaceId, actorUserId } = actingPerson(decision)
  const expectedVersion = expectVersion(input.expectedVersion)
  await workspaces.requireOwner(actorUserId, workspaceId)

  const grant = await prisma.stockPoolGrant.findUnique({ where: { id: grantId }, select: grantSelect })
  if (!grant) throw new WorkspaceError('grant_not_found', 'This shared stock is unavailable in this business profile.', 404)
  if (grant.workspaceId !== workspaceId) {
    throw new WorkspaceError('grant_borrower_only', 'Only the business this stock was offered to can accept, decline or leave it. You can pause or end it.', 403)
  }
  const from = grant.status as GrantStatus
  if (!canTransition('borrower', from, borrowerTarget(decision))) {
    throw new WorkspaceError('grant_state', transitionRefusal('borrower', decision, from), 409)
  }

  const updated = await prisma.$transaction(async (tx) => {
    const [{ result }] = await tx.$queryRaw<Array<{ result: { error?: string; code?: string; status?: number } }>>`
      SELECT nexus_stock_pool_grant_respond(${grantId}, ${decision}, ${expectedVersion}::integer) AS result`
    if (result.error) throw new WorkspaceError(result.code ?? 'grant_refused', result.error, result.status ?? 409)
    await audit(tx, grant, actorUserId, `stock_pool.${BORROWER_AUDIT[decision]}`, { from, to: borrowerTarget(decision) })
    return tx.stockPoolGrant.findUniqueOrThrow({ where: { id: grantId }, select: grantSelect })
  })
  afterPoolChange()
  // Shared stock step 4 — the borrower's copies of the lent warehouses' addresses (the ship-from of pool
  // orders): made on accept, turned off on leave. Best effort: shipping re-syncs them before use.
  await syncSharedWarehouses().catch((error) => logger.warn('[stock-pool] shared warehouse copies not synced', { grantId, error: String(error).slice(0, 160) }))
  const [row] = await withDetails([updated], workspaceId)
  await tellOtherSide(grant.ownerWorkspaceId, {
    type: 'stock-pool-changed', severity: decision === 'accept' ? 'success' : 'warn',
    title: decision === 'accept' ? `${row.workspaceName} accepted your shared stock`
      : decision === 'decline' ? `${row.workspaceName} declined your shared stock`
        : `${row.workspaceName} stopped using your shared stock`,
    body: decision === 'accept' ? 'Its owners can now switch products to your shared stock, one by one.' : null,
    entityType: 'StockPoolGrant', entityId: row.id, href: '/settings/sharing',
  })
  return row
}

/**
 * What pausing or ending (or leaving) would do to the borrower's listings, as counts. Either side may
 * ask; neither sees the other's rows. Read-only.
 */
export async function grantImpact(grantId: string): Promise<GrantImpact> {
  requireWorkspace()
  const [{ result }] = await prisma.$queryRaw<Array<{ result: GrantImpact & { error?: string; code?: string; status?: number } }>>`
    SELECT nexus_pool_grant_impact(${grantId}) AS result`
  if (result.error) throw new WorkspaceError(result.code ?? 'grant_not_found', result.error, result.status ?? 404)
  const n = (v: unknown) => Number(v ?? 0)
  return {
    grantId: result.grantId,
    linkedProducts: n(result.linkedProducts),
    listings: { toZero: n(result.listings?.toZero), toOwn: n(result.listings?.toOwn), pinned: n(result.listings?.pinned), paused: n(result.listings?.paused), closed: n(result.listings?.closed), fba: n(result.listings?.fba) },
    sharedVariants: { toZero: n(result.sharedVariants?.toZero), toOwn: n(result.sharedVariants?.toOwn), excluded: n(result.sharedVariants?.excluded) },
  }
}
