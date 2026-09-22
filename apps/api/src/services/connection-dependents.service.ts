/**
 * What would a `ChannelConnection` delete take with it?
 *
 * ## Why this exists
 *
 * The Owner asked for 11 dead eBay rows to be deleted. Measured first, on the live screen:
 * one connection is real (`xaviaracing`, token, synced today) and eleven have **no refresh token
 * at all** — failed sign-in attempts that left a row behind, spread over months.
 *
 * Two facts made a blind delete wrong:
 *
 *   1. **Nothing in the API has ever deleted a `ChannelConnection`.** `grep channelConnection
 *      .delete` returns nothing; every path revokes or deactivates instead.
 *   2. **A delete cascades.** `VariantChannelListing` and `EbayCampaign` are `onDelete: Cascade`,
 *      so real listing rows and real ad campaigns go with the connection. One of the eleven
 *      carries the SAME eBay user id as the live account and synced on 2026-08-19, so "it is
 *      disconnected" says nothing about what is attached to it.
 *
 * This module answers the only question that makes the delete safe: **for this row, how many
 * rows in each dependent table point at it, and which of those would be destroyed rather than
 * merely unlinked.** It writes nothing.
 *
 * ## 🔴 The relation list is DERIVED, never written down
 *
 * A hardcoded list of dependent tables is a set claim, and it goes stale the moment someone adds
 * a relation — at which point this report would under-count and a "safe" delete would destroy
 * something nobody counted. So the list comes from Prisma's own DMMF at runtime, which is the
 * same schema the cascade is enforced from. Adding a relation tomorrow adds it here for free.
 *
 * The derivation carries its own positive control: if it finds no relations at all, that is a
 * broken reader, not a connection with no dependents, and it throws rather than reporting zeros.
 */
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { workspaceIdForQuery } from '../lib/workspace-context.js'

/** How the database treats a dependent row when its connection is deleted. */
export type DependentAction = 'Cascade' | 'SetNull' | 'Restrict' | 'NoAction' | 'Unknown'

export interface DependentRelation {
  /** Prisma model name, e.g. `VariantChannelListing`. */
  model: string
  /** The foreign-key field on that model, e.g. `channelConnectionId`. */
  field: string
  action: DependentAction
  /** True when deleting the connection DESTROYS these rows rather than unlinking them. */
  destroys: boolean
}

/**
 * Every model that points at `ChannelConnection`, read from the live schema.
 *
 * Exported so a test can assert the derivation against the relations we know exist — a set
 * claim has to be checked against something, and the check is "did it find the ones we can see".
 */
export function dependentRelations(): DependentRelation[] {
  return deriveDependentRelations(Prisma.dmmf.datamodel.models)
}

/**
 * The derivation itself, over any model list.
 *
 * Split out because the guard below could not otherwise be tested: against the real schema the
 * list is never empty, so removing the guard changed nothing a test could see. A mutation that
 * deleted it **survived**, which is the only reason this refactor exists — the hole was real,
 * not theoretical.
 */
export function deriveDependentRelations(
  models: ReadonlyArray<{ name: string; fields: ReadonlyArray<Record<string, unknown>> }>,
): DependentRelation[] {
  const found: DependentRelation[] = []
  for (const model of models) {
    for (const field of model.fields as ReadonlyArray<{
      kind?: unknown; type?: unknown; relationFromFields?: readonly string[]; relationOnDelete?: unknown
    }>) {
      if (field.kind !== 'object' || field.type !== 'ChannelConnection') continue
      const from = field.relationFromFields ?? []
      if (from.length !== 1) continue
      const action = (field.relationOnDelete ?? 'Unknown') as DependentAction
      found.push({ model: model.name, field: from[0]!, action, destroys: action === 'Cascade' })
    }
  }
  // 🟢 The derivation's own positive control. Zero relations means the reader is broken — and a
  // broken reader reporting "no dependents" is exactly how a delete destroys something.
  if (found.length === 0) {
    throw new Error('connection-dependents: no ChannelConnection relations found in the schema — the reader is broken, not the data.')
  }
  return found
}

/** The Prisma client accessor for a model name (`VariantChannelListing` → `variantChannelListing`). */
function accessorFor(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1)
}

export interface DependentCount extends DependentRelation {
  count: number
  /** Set when the count could not be taken — reported, never silently folded into 0. */
  error?: string
}

export interface ConnectionDependents {
  connectionId: string
  /** Rows that would be DESTROYED. Zero here is what makes a delete safe. */
  destroyedTotal: number
  /** Rows that would survive with their link cleared. */
  unlinkedTotal: number
  /** Every relation, including the zeros — an absent line and a zero must not look alike. */
  counts: DependentCount[]
  /** True when any count failed, so `destroyedTotal` is a floor rather than a total. */
  incomplete: boolean
}

/**
 * Count every dependent row for one connection. **Reads only.**
 *
 * A failed count is reported on its own line and sets `incomplete`, because a table that could
 * not be read is not a table with nothing in it — the distinction this whole programme keeps
 * paying for.
 */
export async function connectionDependents(connectionId: string, client: Prisma.TransactionClient = prisma): Promise<ConnectionDependents> {
  const relations = dependentRelations()
  const counts: DependentCount[] = []
  for (const relation of relations) {
    const delegate = (client as unknown as Record<string, { count?: (args: unknown) => Promise<number> }>)[
      accessorFor(relation.model)
    ]
    if (!delegate?.count) {
      counts.push({ ...relation, count: 0, error: `no Prisma delegate for ${relation.model}` })
      continue
    }
    try {
      counts.push({ ...relation, count: await delegate.count({ where: { [relation.field]: connectionId } }) })
    } catch (err) {
      counts.push({ ...relation, count: 0, error: err instanceof Error ? err.message.slice(0, 200) : String(err) })
    }
  }
  const incomplete = counts.some((c) => c.error)
  return {
    connectionId,
    destroyedTotal: counts.filter((c) => c.destroys && !c.error).reduce((sum, c) => sum + c.count, 0),
    unlinkedTotal: counts.filter((c) => !c.destroys && !c.error).reduce((sum, c) => sum + c.count, 0),
    counts,
    incomplete,
  }
}

/**
 * 🔴 The one rule a delete must obey.
 *
 * Safe means: nothing would be destroyed, AND every count was actually taken. `incomplete` makes
 * this false even when `destroyedTotal` is 0, because an unread table is an unknown, not a zero.
 */
export function isSafeToDelete(report: ConnectionDependents): boolean {
  return report.destroyedTotal === 0 && !report.incomplete
}

/** Only a locked, freshly measured dead row can be removed. No channel call is made. */
export async function deleteDeadConnection(connectionId: string) {
  const workspaceId = workspaceIdForQuery()
  return prisma.$transaction(async tx => {
    // FOR UPDATE blocks both reconnects and the KEY SHARE lock a new FK reference needs.
    // ReadCommitted ensures the following counts see writers that committed while we waited.
    // Explicit profile predicate supplements RLS: raw SQL has no ORM selector scoping.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "ChannelConnection"
      WHERE id = ${connectionId} AND "workspaceId" = ${workspaceId} FOR UPDATE`
    if (!locked.length) throw Object.assign(new Error('Connection not found in this business profile.'), {
      code: 'connection_not_found', statusCode: 404,
    })
    const connection = await tx.channelConnection.findUnique({
      where: { id: connectionId },
      select: { isActive: true, isPrimary: true, authStatus: true, credentialsEnc: true, accessToken: true, refreshToken: true, ebayAccessToken: true, ebayRefreshToken: true },
    })
    if (!connection || connection.isActive || connection.isPrimary ||
        ['connected', 'degraded'].includes(connection.authStatus.toLowerCase()) ||
        connection.credentialsEnc || connection.accessToken || connection.refreshToken || connection.ebayAccessToken || connection.ebayRefreshToken) {
      throw Object.assign(new Error('This connection is active, primary, or still holds credentials. Disconnect it before considering deletion.'), {
        code: 'connection_in_use', statusCode: 409,
      })
    }
    const dependents = await connectionDependents(connectionId, tx)
    if (!isSafeToDelete(dependents)) throw Object.assign(new Error('Deletion refused: dependent rows would be destroyed, or a count could not be completed.'), {
      code: 'connection_not_safe', statusCode: 409, dependents,
    })
    await tx.channelConnection.delete({ where: { id: connectionId } })
    return { deleted: true, connectionId, dependents }
  }, { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 30_000 })
}

export interface ConnectionDependentsReportRow {
  id: string
  channel: string
  label: string | null
  isActive: boolean
  isPrimary: boolean
  authStatus: string
  externalAccountId: string | null
  /** Presence only — the token itself never leaves this service. */
  hasRefreshToken: boolean
  lastSyncAt: Date | null
  destroyedTotal: number
  unlinkedTotal: number
  incomplete: boolean
  safeToDelete: boolean
  /** Only the non-zero lines, plus any that failed to count. */
  detail: DependentCount[]
}

/**
 * The whole report, for a channel or a single connection. **Reads only.**
 *
 * The query lives here rather than in the route: the PH.4a ratchet refuses new direct database
 * access in an HTTP handler, and it is right — a handler that owns a query cannot be reused by
 * the delete path that will read this same verdict before it acts.
 */
export async function connectionDependentsReport(
  filter: { channel?: string; connectionId?: string } = {},
): Promise<ConnectionDependentsReportRow[]> {
  const where: Record<string, unknown> = {}
  if (filter.connectionId) where.id = filter.connectionId
  if (filter.channel) where.channelType = filter.channel.toUpperCase()

  const connections = await prisma.channelConnection.findMany({
    where,
    select: {
      id: true, channelType: true, accountLabel: true, isActive: true, isPrimary: true,
      authStatus: true, externalAccountId: true, refreshToken: true, lastSyncAt: true,
    },
    orderBy: [{ channelType: 'asc' }, { isPrimary: 'desc' }, { createdAt: 'asc' }],
  })

  const rows: ConnectionDependentsReportRow[] = []
  for (const connection of connections) {
    const dependents = await connectionDependents(connection.id)
    rows.push({
      id: connection.id,
      channel: connection.channelType,
      label: connection.accountLabel,
      isActive: connection.isActive,
      isPrimary: connection.isPrimary,
      authStatus: connection.authStatus,
      externalAccountId: connection.externalAccountId,
      hasRefreshToken: !!connection.refreshToken,
      lastSyncAt: connection.lastSyncAt,
      destroyedTotal: dependents.destroyedTotal,
      unlinkedTotal: dependents.unlinkedTotal,
      incomplete: dependents.incomplete,
      safeToDelete: isSafeToDelete(dependents),
      detail: dependents.counts.filter((c) => c.count > 0 || c.error),
    })
  }
  return rows
}
