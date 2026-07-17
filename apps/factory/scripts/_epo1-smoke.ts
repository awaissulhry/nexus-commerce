/**
 * EPO1 — verification smoke (ad-hoc, untracked). Exercises the transition
 * service end-to-end against the live db (WAL-safe): legality, action-owned
 * edges, stale-stamp guard, audit+event completeness, payment idempotency.
 * Creates throwaway rows and deletes them after (AuditLog stays, append-only).
 */
import { prisma } from "@/lib/db";
import { transitionOrder } from "@/lib/orders/transition-service";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, detail ?? ""); }
}

async function main() {
  const party = await prisma.party.create({ data: { name: "_EPO1 SMOKE PARTY", kind: "CUSTOMER" } });
  const order = await prisma.order.create({ data: { number: `_EPO1-${Date.now()}`, partyId: party.id, state: "CONFIRMED" } });
  console.log(`smoke order ${order.number}`);

  try {
    // 1. illegal edge → 422
    let r = await transitionOrder({ orderId: order.id, to: "SHIPPED", via: "manual", actorId: null });
    check("CONFIRMED→SHIPPED manual refused 422", !r.ok && r.status === 422);

    // 2. action-owned edge refused as manual, with the pointer
    r = await transitionOrder({ orderId: order.id, to: "IN_PRODUCTION", via: "manual", actorId: null });
    check("CONFIRMED→IN_PRODUCTION manual refused + useStartProduction", !r.ok && r.status === 422 && r.useStartProduction === true);

    // 3. reason required for cancel
    r = await transitionOrder({ orderId: order.id, to: "CANCELLED", via: "cancel", actorId: null });
    check("CANCELLED without reason refused 422", !r.ok && r.status === 422);

    // 4. stale stamp → 409
    r = await transitionOrder({ orderId: order.id, to: "IN_PRODUCTION", via: "start-production", actorId: null, expectedUpdatedAt: new Date(Date.now() - 3_600_000) });
    check("stale expectedUpdatedAt refused 409", !r.ok && r.status === 409);

    // 5. the legal ladder, each via its driver; audit + event after each
    const outboxBefore = await prisma.factoryEventOutbox.count({ where: { type: "order.updated" } });
    const ladder: [Parameters<typeof transitionOrder>[0]["to"], Parameters<typeof transitionOrder>[0]["via"]][] = [
      ["IN_PRODUCTION", "start-production"],
      ["READY", "all-wos-done"],
      ["SHIPPED", "label-purchased"],
      ["READY", "label-voided"], // the system edge the graph now knows
      ["SHIPPED", "label-purchased"],
      ["DELIVERED", "tracking"],
      ["CLOSED", "manual"],
    ];
    let ladderOk = true;
    for (const [to, via] of ladder) {
      const step = await transitionOrder({ orderId: order.id, to, via, actorId: null });
      if (!step.ok) { ladderOk = false; console.error("   ladder failed at", to, via, step); break; }
    }
    check("full lifecycle ladder incl. SHIPPED→READY via label-voided", ladderOk);

    // SHIPPED→READY via manual must stay refused (probe on a fresh order)
    const o2 = await prisma.order.create({ data: { number: `_EPO1B-${Date.now()}`, partyId: party.id, state: "SHIPPED" } });
    r = await transitionOrder({ orderId: o2.id, to: "READY", via: "manual", actorId: null });
    check("SHIPPED→READY manual refused (system-only edge)", !r.ok && r.status === 422);
    await prisma.order.delete({ where: { id: o2.id } });

    // 6. completeness: one audit row + one durable event per ladder step
    await new Promise((res) => setTimeout(res, 300)); // audit() is fire-and-forget
    const audits = await prisma.auditLog.count({ where: { entityType: "order", entityId: order.id, action: "state-changed" } });
    check(`audit rows = ladder steps (${audits}/${ladder.length})`, audits === ladder.length);
    const outboxAfter = await prisma.factoryEventOutbox.count({ where: { type: "order.updated" } });
    check(`durable order.updated events = ladder steps (${outboxAfter - outboxBefore}/${ladder.length})`, outboxAfter - outboxBefore === ladder.length);
    const viaRow = await prisma.auditLog.findFirst({ where: { entityType: "order", entityId: order.id, action: "state-changed" }, orderBy: { createdAt: "desc" } });
    check("audit `after` carries via", typeof (viaRow?.after as { via?: string } | null)?.via === "string");

    // 7. payment idempotency: same key can only land once
    const key = `_epo1-${Date.now()}`;
    await prisma.payment.create({ data: { orderId: order.id, kind: "OTHER", amountCents: 100, idempotencyKey: key } });
    let dup = false;
    try {
      await prisma.payment.create({ data: { orderId: order.id, kind: "OTHER", amountCents: 100, idempotencyKey: key } });
    } catch (err) {
      dup = (err as { code?: string }).code === "P2002";
    }
    check("duplicate idempotencyKey blocked by unique (P2002)", dup);
  } finally {
    await prisma.payment.deleteMany({ where: { orderId: order.id } });
    await prisma.order.delete({ where: { id: order.id } }).catch(() => {});
    await prisma.party.delete({ where: { id: party.id } }).catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
