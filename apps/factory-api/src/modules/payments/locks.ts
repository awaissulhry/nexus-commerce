import type { CommandTx } from '../../core/command'
import type { RequestContext } from '../../core/context'
import { ApiError } from '../../core/errors'

/**
 * The money locks (the …_money_guards triggers' `factory_money_lock`: a transaction advisory lock per payment, deposit
 * request and invoice, held to the end of the transaction). The API takes them FIRST, in the triggers' order, and reads
 * the sums under them, so it answers a clear 409 before the database would refuse, and two writers queue instead of
 * deadlocking:
 *
 *   payment ('factory.money.payment')  →  its targets, in id order: deposit requests ('factory.money.deposit'),
 *   invoices ('factory.money.invoice')  →  then, when a command issues an invoice, the number series row (allocateNumber)
 *
 * Issuing a TD02 takes its request's lock, a TD04 its credited invoice's, an invoice that deducts TD02s theirs (id order),
 * before its number; the invoice's own row (command()'s version bump) comes first, and no command that holds a money lock
 * then waits for an existing invoice's row.
 */

export type MoneyLock = 'payment' | 'deposit' | 'invoice'

export function tenantOf(context: RequestContext): string {
  if (context.audience === 'platform') throw new ApiError('internal_error', 'A money command runs in a tenant.')
  return context.tenantId
}

/** Takes one money lock (the same key as factory_money_lock in the …_money_guards migration). */
export async function lockMoney(tx: CommandTx, context: RequestContext, what: MoneyLock, id: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', ${`factory.money.${what}`}::text, ${tenantOf(context)}::uuid, ${id}::uuid), 0))`
}

/** Takes the locks of several targets of one kind, in id order. */
export async function lockAll(tx: CommandTx, context: RequestContext, what: MoneyLock, ids: Iterable<string>): Promise<void> {
  for (const id of [...new Set(ids)].sort()) await lockMoney(tx, context, what, id)
}
