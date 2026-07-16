/**
 * EPO1.1 — THE single writer of Order.state. Every transition — operator route
 * or system driver (production done, label bought, tracking delivered, label
 * voided) — flows through here: legality via `canTransitionVia`, an optimistic
 * write guard (the row must still be in `from`, and optionally untouched since
 * `expectedUpdatedAt` — D-6), the state write plus any same-transaction
 * companion writes (`also`), then exactly one audit row and one durable
 * `order.updated` event carrying `via`. Kills C1/C2/C9: no code path writes
 * Order.state anywhere else, so "no silent state change" is enforced by shape,
 * not convention. Audit/event follow the F1 never-throw philosophy: they are
 * emitted after commit on the one code path (ordering-guaranteed), never
 * inside the transaction.
 */
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { canTransitionVia, requiresReason, type OrderState, type TransitionVia } from "./transitions";

class StaleWriteError extends Error {}

export type TransitionInput = {
  orderId: string;
  to: OrderState;
  via: TransitionVia;
  /** null = system actor (worker/carrier) — shows as system on the timeline */
  actorId: string | null;
  /** required when the target state requires one (CANCELLED) */
  reason?: string;
  /** free-form operator note, recorded on the audit row */
  note?: string;
  /** D-6 optimistic concurrency: reject if the order changed since this stamp */
  expectedUpdatedAt?: string | Date;
  /**
   * Companion writes that must commit atomically with the state change
   * (WO cascade on cancel, WO creation on start-production, shipment/party
   * writes on buy/void). Whatever map it returns is merged into the audit
   * row's `after` so the cascade is visible in the trail.
   */
  also?: (tx: Prisma.TransactionClient, order: { id: string; number: string; from: OrderState }) => Promise<Record<string, unknown> | void>;
};

export type TransitionOutcome =
  | { ok: true; from: OrderState; to: OrderState }
  | { ok: false; status: 404 | 409 | 422; error: string; useStartProduction?: boolean };

export async function transitionOrder(input: TransitionInput): Promise<TransitionOutcome> {
  const { orderId, to, via } = input;
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, number: true, state: true } });
  if (!order) return { ok: false, status: 404, error: "Not found" };
  const from = order.state as OrderState;

  const chk = canTransitionVia(from, to, via);
  if (!chk.ok) return { ok: false, status: 422, error: chk.reason ?? "Illegal transition", useStartProduction: chk.useStartProduction };
  const reason = input.reason?.trim();
  if (requiresReason(to) && !reason) return { ok: false, status: 422, error: "A reason is required" };

  const data: Prisma.OrderUpdateManyMutationInput = { state: to };
  if (to === "CANCELLED") data.cancelReason = reason;
  if (from === "CANCELLED" && to === "CONFIRMED") data.cancelReason = null; // reopen clears the reason

  let extra: Record<string, unknown> | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      // the guard: the row must still be in `from` (two racing transitions can't
      // both win) and, when the caller sent its read stamp, untouched since it.
      const res = await tx.order.updateMany({
        where: {
          id: orderId,
          state: from,
          ...(input.expectedUpdatedAt ? { updatedAt: new Date(input.expectedUpdatedAt) } : {}),
        },
        data,
      });
      if (res.count === 0) throw new StaleWriteError();
      if (input.also) extra = (await input.also(tx, { id: order.id, number: order.number, from })) ?? undefined;
    });
  } catch (err) {
    if (err instanceof StaleWriteError) {
      return { ok: false, status: 409, error: "The order changed elsewhere — refresh and retry" };
    }
    throw err;
  }

  void audit({
    actorId: input.actorId,
    entityType: "order",
    entityId: orderId,
    action: "state-changed",
    before: { from },
    after: { to, via, ...(reason ? { reason } : {}), ...(input.note ? { note: input.note } : {}), ...(extra ?? {}) },
  });
  await publishEventDurable("order.updated", { orderId, from, to, via });

  return { ok: true, from, to };
}
