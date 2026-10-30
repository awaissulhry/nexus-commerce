import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { StoredAction } from '@nexus/factory-domain/insights/actions'
import type { CommandTx } from '../../core/command'

/**
 * The storage of Today's actions (B-W1-52 actions; factory-db insights.prisma): AttentionAction (one row per Today row
 * key), its append-only history AttentionActionLog, and TodayLayout (one per person). Every read and write of those
 * tables is here; the rules are factory-domain insights/actions, the commands actions.ts and layout.ts.
 */

export const ACTION_COLUMNS = {
  id: true,
  rowKey: true,
  version: true,
  assignedToId: true,
  assignedById: true,
  assignedAt: true,
  resolvedCondition: true,
  resolveNote: true,
  resolvedById: true,
  resolvedAt: true,
  acknowledgedCondition: true,
  acknowledgedById: true,
  acknowledgedAt: true,
  // W2a (B-W2a-20): Today's snooze.
  snoozedCondition: true,
  snoozedById: true,
  snoozedAt: true,
  snoozedUntil: true,
} as const satisfies Prisma.AttentionActionSelect

export type ActionRow = Prisma.AttentionActionGetPayload<{ select: typeof ACTION_COLUMNS }>

export const storedOf = (row: ActionRow): StoredAction => row

/** The stored actions of these row keys, by key (the keys of one Today: a few hundred at most). */
export async function readActions(db: FactoryClient | CommandTx, keys: readonly string[]): Promise<Map<string, ActionRow>> {
  if (keys.length === 0) return new Map()
  const rows = await db.attentionAction.findMany({ where: { rowKey: { in: [...new Set(keys)] } }, select: ACTION_COLUMNS })
  return new Map(rows.map((row) => [row.rowKey, row]))
}

export async function readAction(db: FactoryClient | CommandTx, key: string): Promise<ActionRow | null> {
  return db.attentionAction.findFirst({ where: { rowKey: key }, select: ACTION_COLUMNS })
}

/** Inside a command: the row's action locked (FOR UPDATE) and read, or null when none is stored yet. */
export async function lockAction(tx: CommandTx, key: string): Promise<ActionRow | null> {
  await tx.$queryRaw`SELECT id FROM "AttentionAction" WHERE "rowKey" = ${key} FOR UPDATE`
  return readAction(tx, key)
}

/** The row of an action as it is first stored: its key, kind, record and scope. */
export interface ActionIdentity {
  readonly rowKey: string
  readonly kind: string
  readonly recordType: string
  readonly recordId: string
  readonly subKey: string | null
  readonly companyId: string | null
  readonly siteId: string | null
  readonly partyId: string | null
}

/** What an action changes on the row's action (the columns of one verb). */
export interface ActionChange {
  readonly assignedToId?: string | null
  readonly assignedById?: string | null
  readonly assignedAt?: Date | null
  readonly resolvedCondition?: string | null
  readonly resolveNote?: string | null
  readonly resolvedById?: string | null
  readonly resolvedAt?: Date | null
  readonly acknowledgedCondition?: string | null
  readonly acknowledgedById?: string | null
  readonly acknowledgedAt?: Date | null
  readonly snoozedCondition?: string | null
  readonly snoozedById?: string | null
  readonly snoozedAt?: Date | null
  readonly snoozedUntil?: Date | null
}

/** Stores the change on the row's action: a new action (version 1), or the locked existing one (its version + 1). */
export async function writeAction(tx: CommandTx, existing: { readonly id: string; readonly version: number } | null, identity: ActionIdentity, change: ActionChange, by: { readonly id: string; readonly actorId: string; readonly now: Date }): Promise<ActionRow> {
  const scope = { companyId: identity.companyId, siteId: identity.siteId, partyId: identity.partyId }
  if (existing === null) {
    return tx.attentionAction.create({
      data: { id: by.id, rowKey: identity.rowKey, kind: identity.kind, recordType: identity.recordType, recordId: identity.recordId, subKey: identity.subKey, ...scope, ...change, createdAt: by.now, updatedAt: by.now, createdById: by.actorId },
      select: ACTION_COLUMNS,
    })
  }
  return tx.attentionAction.update({ where: { id: existing.id }, data: { ...scope, ...change, version: existing.version + 1, updatedAt: by.now }, select: ACTION_COLUMNS })
}

export interface LogEntry {
  readonly verb: 'ASSIGNED' | 'UNASSIGNED' | 'RESOLVED' | 'ACKNOWLEDGED' | 'SNOOZED'
  readonly condition: string
  readonly recordLabel: string
  readonly actorId: string
  readonly assigneeId: string | null
  readonly note: string | null
  /** SNOOZED: until when (null: until the row's condition changes). */
  readonly snoozedUntil?: Date | null
  readonly at: Date
  readonly requestId: string
}

/** One history row of the action (append-only). */
export async function writeLog(tx: CommandTx, actionId: string, identity: ActionIdentity, entry: LogEntry, id: string): Promise<void> {
  await tx.attentionActionLog.create({
    data: {
      id,
      actionId,
      rowKey: identity.rowKey,
      kind: identity.kind,
      recordType: identity.recordType,
      recordId: identity.recordId,
      companyId: identity.companyId,
      siteId: identity.siteId,
      partyId: identity.partyId,
      ...entry,
    },
    select: { id: true },
  })
}

/**
 * What a person did through Today's verbs in a span of time, newest first. A snooze (W2a) is not a decision: "Handled
 * today" leaves it out (B-W2a-01's question, decided by B-W2a-20).
 */
const DECIDED = { not: 'SNOOZED' as const }
export async function readHandled(db: FactoryClient, actorId: string, from: Date, to: Date, limit: number) {
  return db.attentionActionLog.findMany({
    where: { actorId, at: { gte: from, lt: to }, verb: DECIDED },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take: limit,
    select: { id: true, rowKey: true, kind: true, recordType: true, recordId: true, recordLabel: true, companyId: true, verb: true, assigneeId: true, note: true, at: true },
  })
}

export async function countHandled(db: FactoryClient, actorId: string, from: Date, to: Date): Promise<number> {
  return db.attentionActionLog.count({ where: { actorId, at: { gte: from, lt: to }, verb: DECIDED } })
}

export const LAYOUT_COLUMNS = { id: true, userId: true, sections: true, panels: true, mainLens: true, version: true, updatedAt: true } as const satisfies Prisma.TodayLayoutSelect
export type LayoutRow = Prisma.TodayLayoutGetPayload<{ select: typeof LAYOUT_COLUMNS }>

/** A person's layout: its id is the person's user id (one per person). */
export async function readLayout(db: FactoryClient | CommandTx, userId: string): Promise<LayoutRow | null> {
  return db.todayLayout.findUnique({ where: { id: userId }, select: LAYOUT_COLUMNS })
}

/** Inside a command: the person's layout locked (FOR UPDATE) and read, or null when none is saved yet. */
export async function lockLayout(tx: CommandTx, userId: string): Promise<LayoutRow | null> {
  await tx.$queryRaw`SELECT id FROM "TodayLayout" WHERE id = ${userId}::uuid FOR UPDATE`
  return readLayout(tx, userId)
}

export async function writeLayout(
  tx: CommandTx,
  existing: { readonly id: string; readonly version: number } | null,
  layout: { readonly sections: Prisma.InputJsonValue; readonly panels: Prisma.InputJsonValue; readonly mainLens: string | null },
  by: { readonly userId: string; readonly now: Date },
): Promise<LayoutRow> {
  if (existing === null) {
    return tx.todayLayout.create({ data: { id: by.userId, userId: by.userId, ...layout, createdAt: by.now, updatedAt: by.now, createdById: by.userId }, select: LAYOUT_COLUMNS })
  }
  return tx.todayLayout.update({ where: { id: existing.id }, data: { ...layout, version: existing.version + 1, updatedAt: by.now }, select: LAYOUT_COLUMNS })
}

/** Display names of office people, by id. */
export async function peopleNames(db: FactoryClient | CommandTx, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string'))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
}
