import type { Prisma } from '@nexus/factory-db'

/**
 * A DEAD event back to PENDING for its relay (B-W2b-415; PLT-201: the error queue's Retry), inside the caller's command. The
 * outbox guard allows exactly this move ("a person re-queues it after fixing the cause"); the event itself never changes.
 * Its attempts stay as they were, so a new failure makes it DEAD again at once: one retry. False when it is not DEAD any more.
 * Here, in platform/outbox, because nothing else writes the outbox (scripts/factory/check-event-contract.mjs).
 */
export async function requeueDeadEvent(tx: Prisma.TransactionClient, eventId: string, now: Date): Promise<boolean> {
  const moved = await tx.outboxEvent.updateMany({ where: { id: eventId, status: 'DEAD' }, data: { status: 'PENDING', nextAttemptAt: now } })
  return moved.count === 1
}
