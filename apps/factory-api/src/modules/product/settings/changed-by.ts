import type { FactoryClient } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { CommandTools, CommandTx } from '../../../core/command'

/**
 * Who changed the product settings and a product type last (B-W2b-283, follow-up FU1:04 of B-W2b-221 and -239; factory-db
 * ProductSettings.updatedById and ProductTypeProfile.updatedById, schema wave 34/44 of B-W2b-275). Every write of either row
 * writes `updatedById` (an office person; a system write: null), and both views say "Changed by" from it, so the Product
 * settings screen names the person without audit.read (the audit trail stays the place for what changed, card by card).
 * A row changed before this step names nobody (null) until its next write. An office person's display name only: never a
 * floor worker, never a figure.
 */

type Reader = Pick<FactoryClient | CommandTx, 'user'>

/** The person a write records as the row's last changer: the office caller, else nobody. */
export const updatedByOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

export interface ChangedByView {
  readonly id: string
  readonly name: string
}

/** The office people's display names, by id (an unknown or removed person: left out). */
export async function changedByNames(db: Reader, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((value): value is string => typeof value === 'string' && isUuid(value)))]
  if (wanted.length === 0) return new Map()
  const rows = await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })
  return new Map(rows.map((row) => [row.id, row.displayName]))
}

/** "Changed by" of one row: the person and their name, or null (nobody recorded, or not a person this tenant knows). */
export async function changedByOf(db: Reader, updatedById: string | null): Promise<ChangedByView | null> {
  if (updatedById === null) return null
  const name = (await changedByNames(db, [updatedById])).get(updatedById)
  return name === undefined ? null : { id: updatedById, name }
}
