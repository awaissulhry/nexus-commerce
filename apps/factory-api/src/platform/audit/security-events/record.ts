import type { FactoryClient, Prisma, SecurityEventKind, SecuritySurface } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { detailsOf } from './details'

/**
 * One security event written outside a command (B-W2b-399; PLT-075): a refused request (hooks.ts) and a sign-in refused before
 * anybody is proved (an address nobody has, a locked or suspended account, an unknown badge: sign-in.ts). The caller picks the
 * scope it runs in (the request's own, the tenant's office scope before a session, a floor device's site); createMany, because
 * the floor and partner roles may insert these rows but not read them back. The time is the database's own (`databaseNow`). The events that are audit rows are written by
 * command() itself (ledgers.ts).
 */

export interface EventInput {
  readonly kind: SecurityEventKind
  readonly surface: SecuritySurface
  /** null only when nobody is known (a failed sign-in, an API key's use). */
  readonly actorId: string | null
  /** Exactly on a FLOOR event: the device's site. */
  readonly siteId?: string | null
  /** A PORTAL or LINK event's party, when known. */
  readonly partyId?: string | null
  readonly ipHash: string | null
  readonly record?: { readonly type: string; readonly id: string } | null
  readonly details: Readonly<Record<string, unknown>>
}

/**
 * The time a ledger row keeps: the database's own (its transaction's start, `now()`), read in the same scope. The database
 * refuses a security event or a read in the future (`factory_recall_not_future`), and neither the API's clock nor this process's
 * (a test moves both) may fail the command or the answer the row belongs to.
 */
export async function databaseNow(client: Pick<FactoryClient, '$queryRaw'> | Pick<Prisma.TransactionClient, '$queryRaw'>): Promise<Date> {
  const [row] = await (client as Pick<FactoryClient, '$queryRaw'>).$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`
  return row!.now
}

/** The row of an event, without its time (the writer adds the database's). */
export function securityEventRow(input: EventInput): Omit<Prisma.SecurityEventCreateManyInput, 'at'> {
  return {
    id: newId(),
    siteId: input.surface === 'FLOOR' ? (input.siteId ?? null) : null,
    partyId: input.surface === 'PORTAL' || input.surface === 'LINK' ? (input.partyId ?? null) : null,
    kind: input.kind,
    surface: input.surface,
    actorId: input.actorId,
    ipHash: input.ipHash,
    ipCountry: null,
    recordType: input.record?.type ?? null,
    recordId: input.record?.id ?? null,
    details: detailsOf(input.details) as Prisma.InputJsonValue,
  }
}

export async function insertSecurityEvent(client: Pick<FactoryClient, 'securityEvent' | '$queryRaw'>, input: EventInput): Promise<void> {
  await client.securityEvent.createMany({ data: [{ ...securityEventRow(input), at: await databaseNow(client) }] })
}
