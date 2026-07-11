/**
 * FS0 — synthetic-scale seeder for the load harness (docs/factory/FS0-SPEC.md).
 * This is the dev-only faker the F1 seed header reserved behind
 * FACTORY_ALLOW_DEV_SEED. It REFUSES to run unless:
 *   · FACTORY_ALLOW_DEV_SEED=1
 *   · FACTORY_DATABASE_URL contains "scale" (never the live factory.db)
 *   · the target DB contains zero orders (fresh file only)
 * Run:  FACTORY_ALLOW_DEV_SEED=1 FACTORY_DATABASE_URL="file:$(pwd)/data/scale.db" \
 *         npx prisma migrate deploy && npx tsx scripts/scale/seed-scale.ts
 * Output: data/scale-manifest.json (ids + volumes for measure.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { prisma, factoryDbUrl } from "../../src/lib/db";
import { seedSystemRoles } from "../../src/lib/auth/seed-roles";

// ── volumes (FS0-SPEC table) ─────────────────────────────────────
const V = {
  users: 500,
  parties: 800,
  suppliers: 30,
  conversations: 60_000,
  monsterThreadMessages: 5_000,
  attachments: 30_000,
  templates: 20,
  quotes: 60_000,
  orders: 50_000,
  activeWorkOrders: 1_200,
  materials: 200,
  lots: 1_000,
  ledger: 1_200_000,
  audit: 800_000,
  invoices: 30_000,
  payments: 60_000,
  shipments: 40_000,
  trackingEvents: 160_000,
  notifications: 40_000,
};

const BATCH = 2_000;
const now = Date.now();
const DAY = 86_400_000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Deterministic pseudo-random (reproducible baselines across re-seeds).
let rngState = 0xf5c0f5c0;
function rnd(): number {
  rngState = (rngState * 1664525 + 1013904223) >>> 0;
  return rngState / 0xffffffff;
}
const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
const past = (maxDaysAgo: number) => new Date(now - rnd() * maxDaysAgo * DAY);

const GARMENTS = ["Kangaroo Suit", "Airbag Suit", "Gp Jacket", "Rain Jacket", "Kid Suit", "Custom Gloves", "Leather Pants", "Race Boots Liner"];
const FIRST = ["Marco", "Sara", "Luca", "Anna", "Paolo", "Elena", "Dario", "Giulia", "Romain", "Margaux", "Jarno", "Mario"];
const LAST = ["Rossi", "Bianchi", "Bertet", "Pierino", "Salatarelli", "Balzano", "Guggi", "Anniballi", "Pobre", "Dario", "Torino", "Vergne"];

async function createManyBatched(label: string, rows: unknown[], create: (chunk: unknown[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await create(rows.slice(i, i + BATCH));
    if ((i / BATCH) % 50 === 0) process.stdout.write(`\r${label}: ${Math.min(i + BATCH, rows.length)}/${rows.length}      `);
  }
  process.stdout.write(`\r${label}: ${rows.length}/${rows.length} ✓\n`);
}

async function main() {
  // ── the three refusals ─────────────────────────────────────────
  if (process.env.FACTORY_ALLOW_DEV_SEED !== "1") throw new Error("refusing: FACTORY_ALLOW_DEV_SEED must be 1");
  const url = factoryDbUrl();
  if (!/scale/.test(url)) throw new Error(`refusing: FACTORY_DATABASE_URL must point at a scale DB, got ${url}`);
  if ((await prisma.order.count()) > 0) throw new Error("refusing: target DB already has orders — delete the scale.db file to re-seed");

  console.log(`FS0 seed → ${url}`);
  await seedSystemRoles({ bumpVersions: false });
  const roles = await prisma.role.findMany({ select: { id: true, key: true } });
  const ownerRole = roles.find((r) => r.key === "OWNER")!;
  const workerRole = roles.find((r) => r.key === "WORKER")!;

  const defaultList = await prisma.priceList.upsert({
    where: { id: "spl-default" },
    create: { id: "spl-default", kind: "DEFAULT", name: "Listino base" },
    update: {},
  });
  await prisma.appSetting.upsert({ where: { key: "production.stages" }, create: { key: "production.stages", value: ["CUTTING", "STITCHING", "ASSEMBLY", "QC", "PACKING"] }, update: {} });
  await prisma.appSetting.upsert({ where: { key: "pricing.defaults" }, create: { key: "pricing.defaults", value: { marginFloorPct: 20, depositDefaultPct: 30 } }, update: {} });

  // ── users + one OWNER session for measure.ts ───────────────────
  const users = Array.from({ length: V.users }, (_, i) => ({
    id: `su${i}`,
    email: i === 0 ? "scale-owner@factory.test" : `scale-worker-${i}@factory.test`,
    displayName: i === 0 ? "Scale Owner" : `${pick(FIRST)} ${pick(LAST)} #${i}`,
    passwordHash: "x-not-a-real-hash-login-unused",
    status: "active",
  }));
  await createManyBatched("users", users, (c) => prisma.user.createMany({ data: c as never }));
  await prisma.userRole.createMany({
    data: users.map((u, i) => ({ id: `sur${i}`, userId: u.id, roleId: i === 0 ? ownerRole.id : workerRole.id })),
  });
  const sessionToken = randomBytes(24).toString("hex");
  await prisma.session.create({
    data: { userId: "su0", tokenHash: sha256(sessionToken), idleExpiry: new Date(now + 7 * DAY), absoluteExpiry: new Date(now + 30 * DAY) },
  });

  // ── parties ────────────────────────────────────────────────────
  const parties = Array.from({ length: V.parties + V.suppliers }, (_, i) => ({
    id: `sp${i}`,
    kind: i < V.suppliers ? "SUPPLIER" : rnd() < 0.3 ? "BRAND" : "CUSTOMER",
    name: i < V.suppliers ? `Scale Supplier ${i}` : `${pick(FIRST)} ${pick(LAST)} ${i}`,
    priceListId: defaultList.id,
    createdAt: past(700),
    updatedAt: past(100),
  }));
  await createManyBatched("parties", parties, (c) => prisma.party.createMany({ data: c as never }));
  await createManyBatched(
    "party emails",
    parties.map((p, i) => ({ id: `spe${i}`, partyId: p.id, email: `contact-${i}@scale-${i % 900}.test`, matchDomain: rnd() < 0.2 })),
    (c) => prisma.partyEmail.createMany({ data: c as never }),
  );
  const customerIds = parties.slice(V.suppliers).map((p) => p.id);
  const supplierIds = parties.slice(0, V.suppliers).map((p) => p.id);

  // ── product templates ──────────────────────────────────────────
  const templates = Array.from({ length: V.templates }, (_, i) => ({
    id: `st${i}`,
    name: `${GARMENTS[i % GARMENTS.length]} T${i}`,
    baseCostCents: int(20_000, 60_000),
    basePriceCents: int(60_000, 180_000),
  }));
  await prisma.productTemplate.createMany({ data: templates as never });

  // ── conversations + messages (incl. the monster thread) ───────
  const convs: unknown[] = [];
  const msgs: unknown[] = [];
  let msgCount = 0;
  const monsterId = "sc-monster";
  for (let i = 0; i < V.conversations; i++) {
    const isMonster = i === 0;
    const id = isMonster ? monsterId : `sc${i}`;
    const state = isMonster ? "OPEN" : i < 2_000 ? "OPEN" : i < 2_500 ? "SNOOZED" : "CLOSED";
    const n = isMonster ? V.monsterThreadMessages : rnd() < 0.02 ? int(500, 1_000) : int(3, 15);
    const partyId = rnd() < 0.85 ? pick(customerIds) : null;
    const t0 = now - int(1, 700) * DAY;
    let last = t0;
    for (let m = 0; m < n; m++) {
      last = t0 + m * int(60_000, 3 * DAY);
      msgs.push({
        id: `sm${msgCount++}`,
        conversationId: id,
        direction: m % 3 === 2 ? "OUTBOUND" : "INBOUND",
        fromAddress: m % 3 === 2 ? "info@xaviaracing.it" : `contact-${i % 900}@scale-${i % 900}.test`,
        snippet: `${pick(GARMENTS)} — synthetic message ${m} for load baseline`,
        bodyText: `Synthetic body ${m}. ${pick(GARMENTS)} order discussion, size ${int(44, 60)}.`,
        sentAt: new Date(Math.min(last, now)),
      });
    }
    convs.push({
      id,
      subject: isMonster ? "MONSTER THREAD — 5k messages (FS0 probe)" : `Fwd: SCALE ORDER ${i} ${pick(LAST).toUpperCase()}`,
      partyId,
      state,
      snoozeUntil: state === "SNOOZED" ? new Date(now + int(1, 10) * DAY) : null,
      followUpAt: rnd() < 0.05 ? new Date(now + int(1, 14) * DAY) : null,
      assigneeId: rnd() < 0.3 ? `su${int(0, V.users - 1)}` : null,
      lastMessageAt: new Date(Math.min(last, now)),
      createdAt: new Date(t0),
      updatedAt: new Date(Math.min(last, now)),
    });
  }
  await createManyBatched("conversations", convs, (c) => prisma.conversation.createMany({ data: c as never }));
  await createManyBatched("messages", msgs, (c) => prisma.message.createMany({ data: c as never }));
  await createManyBatched(
    "attachments",
    Array.from({ length: V.attachments }, (_, i) => ({
      id: `sa${i}`,
      messageId: `sm${int(0, msgCount - 1)}`,
      filename: `Tuta_Synthetic_${i}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: int(100_000, 6_000_000),
    })),
    (c) => prisma.attachment.createMany({ data: c as never }),
  );

  // ── quotes ─────────────────────────────────────────────────────
  const quoteStates = ["DRAFT", "SENT", "SENT", "ACCEPTED", "ACCEPTED", "ACCEPTED", "REJECTED", "EXPIRED"];
  const quotes = Array.from({ length: V.quotes }, (_, i) => ({
    id: `sq${i}`,
    number: `Q-${i + 1}`,
    partyId: pick(customerIds),
    conversationId: rnd() < 0.6 ? `sc${int(1, V.conversations - 1)}` : null,
    state: pick(quoteStates),
    createdAt: past(700),
    updatedAt: past(200),
  }));
  await createManyBatched("quotes", quotes, (c) => prisma.quote.createMany({ data: c as never }));
  const qlines: unknown[] = [];
  let qli = 0;
  for (let i = 0; i < V.quotes; i++) {
    const n = int(1, 4);
    for (let l = 0; l < n; l++) {
      const list = int(60_000, 200_000);
      const cost = Math.floor(list * (0.35 + rnd() * 0.3));
      qlines.push({
        id: `sql${qli++}`, quoteId: `sq${i}`, templateId: `st${int(0, V.templates - 1)}`,
        description: `${pick(GARMENTS)} size ${int(44, 60)}`, qty: int(1, 5),
        listPriceCents: list, netPriceCents: list, costCents: cost, marginCents: list - cost,
        marginPct: Math.round(((list - cost) / list) * 100),
      });
    }
  }
  await createManyBatched("quote lines", qlines, (c) => prisma.quoteLine.createMany({ data: c as never }));

  // ── orders + lines + work orders + stages ─────────────────────
  // state mix: history-heavy; ~1500 CONFIRMED, ~800 IN_PRODUCTION, ~300 READY
  const orders: unknown[] = [];
  const olines: unknown[] = [];
  const wos: unknown[] = [];
  const stages: unknown[] = [];
  const STAGE_KEYS = ["CUTTING", "STITCHING", "ASSEMBLY", "QC", "PACKING"];
  let oli = 0, sti = 0;
  for (let i = 0; i < V.orders; i++) {
    const st = i < 1_500 ? "CONFIRMED" : i < 2_300 ? "IN_PRODUCTION" : i < 2_600 ? "READY" : i < 6_000 ? "SHIPPED" : i < 12_000 ? "DELIVERED" : rnd() < 0.03 ? "CANCELLED" : "CLOSED";
    const created = past(700);
    orders.push({
      id: `so${i}`, number: `ORD-${i + 1}`, partyId: pick(customerIds),
      bornFromQuoteId: rnd() < 0.7 ? `sq${int(0, V.quotes - 1)}` : null,
      conversationId: rnd() < 0.6 ? `sc${int(1, V.conversations - 1)}` : null,
      state: st, promiseDateAt: new Date(created.getTime() + int(20, 60) * DAY),
      createdAt: created, updatedAt: past(60),
    });
    const nl = int(1, 4);
    for (let l = 0; l < nl; l++) {
      const list = int(60_000, 200_000);
      olines.push({
        id: `sol${oli}`, orderId: `so${i}`, description: `${pick(GARMENTS)} size ${int(44, 60)}`,
        qty: int(1, 3), netPriceCents: list, costCents: Math.floor(list * (0.35 + rnd() * 0.3)),
      });
      oli++;
    }
    // one WO per order; the first V.activeWorkOrders IN_PRODUCTION-ish orders get active WOs
    const woState = st === "IN_PRODUCTION" && wos.filter(Boolean).length < 999_999 && i < 2_300 && i >= 1_500 ? (rnd() < 0.2 ? "BLOCKED" : rnd() < 0.5 ? "IN_PROGRESS" : "READY") : st === "CONFIRMED" && i < 900 ? "READY" : "DONE";
    wos.push({
      id: `swo${i}`, number: `ORD-${i + 1}/1`, orderId: `so${i}`, orderLineId: `sol${oli - 1}`,
      priority: int(0, 5), state: woState, label: `Size ${int(44, 60)} · ×${int(1, 3)}`,
      estCostCents: int(20_000, 90_000), actualCostCents: woState === "DONE" ? int(20_000, 95_000) : 0,
      createdAt: created, updatedAt: past(30),
    });
    for (let s = 0; s < STAGE_KEYS.length; s++) {
      const done = woState === "DONE" || (woState === "IN_PROGRESS" && s < 2);
      stages.push({
        id: `sst${sti++}`, workOrderId: `swo${i}`, stage: STAGE_KEYS[s], sort: s,
        assigneeId: rnd() < 0.5 ? `su${int(1, V.users - 1)}` : null,
        startedAt: done || (woState === "IN_PROGRESS" && s === 2) ? new Date(created.getTime() + s * DAY) : null,
        finishedAt: done ? new Date(created.getTime() + (s + 1) * DAY) : null,
        certCheckPassed: STAGE_KEYS[s] === "QC" && done ? true : null,
      });
    }
  }
  await createManyBatched("orders", orders, (c) => prisma.order.createMany({ data: c as never }));
  await createManyBatched("order lines", olines, (c) => prisma.orderLine.createMany({ data: c as never }));
  await createManyBatched("work orders", wos, (c) => prisma.workOrder.createMany({ data: c as never }));
  await createManyBatched("wo stages", stages, (c) => prisma.workOrderStage.createMany({ data: c as never }));

  // ── materials + lots + the 1.2M-row ledger ─────────────────────
  const materials = Array.from({ length: V.materials }, (_, i) => ({
    id: `smat${i}`, name: `Scale Leather ${i}`, unit: pick(["HIDE", "SQM", "PIECE", "M"]),
    costCents: int(500, 20_000), reorderLevel: rnd() < 0.7 ? int(5, 50) : null,
  }));
  await prisma.material.createMany({ data: materials as never });
  await prisma.materialLot.createMany({
    data: Array.from({ length: V.lots }, (_, i) => ({
      id: `slot${i}`, materialId: `smat${i % V.materials}`, lotCode: `LOT-${i}`,
      supplierId: pick(supplierIds), receivedAt: past(600),
    })) as never,
  });
  const MOVE_TYPES = ["IN", "OUT", "OUT", "RESERVE", "RELEASE", "ADJUST"];
  const ledger = Array.from({ length: V.ledger }, (_, i) => ({
    id: `sml${i}`, materialId: `smat${i % V.materials}`, lotId: rnd() < 0.4 ? `slot${i % V.lots}` : null,
    type: MOVE_TYPES[int(0, MOVE_TYPES.length - 1)], qty: Math.round(rnd() * 200) / 10 + 0.1,
    refType: rnd() < 0.6 ? "WorkOrder" : "PO", refId: `swo${int(0, V.orders - 1)}`,
    actorId: rnd() < 0.5 ? `su${int(0, V.users - 1)}` : null, createdAt: past(700),
  }));
  await createManyBatched("movement ledger", ledger, (c) => prisma.movementLedger.createMany({ data: c as never }));

  // ── audit log ──────────────────────────────────────────────────
  const ENTS = ["order", "quote", "conversation", "workorder", "material", "party"];
  const audit = Array.from({ length: V.audit }, (_, i) => ({
    id: `sal${i}`, actorId: rnd() < 0.7 ? `su${int(0, V.users - 1)}` : null,
    entityType: ENTS[i % ENTS.length], entityId: `so${int(0, V.orders - 1)}`,
    action: pick(["created", "updated", "state_changed"]), createdAt: past(700),
  }));
  await createManyBatched("audit log", audit, (c) => prisma.auditLog.createMany({ data: c as never }));

  // ── invoices / payments / shipments / tracking / notifications ─
  await createManyBatched(
    "invoices",
    Array.from({ length: V.invoices }, (_, i) => ({
      id: `sinv${i}`, orderId: `so${int(0, V.orders - 1)}`, number: `INV-${i + 1}`,
      amountCents: int(60_000, 400_000), sentAt: past(300), paidAt: rnd() < 0.8 ? past(200) : null,
    })),
    (c) => prisma.invoice.createMany({ data: c as never }),
  );
  await createManyBatched(
    "payments",
    Array.from({ length: V.payments }, (_, i) => ({
      id: `spay${i}`, orderId: `so${int(0, V.orders - 1)}`, kind: pick(["DEPOSIT", "BALANCE", "OTHER"]),
      amountCents: int(20_000, 200_000), method: pick(["bank", "card", "cash"]), receivedAt: past(300),
    })),
    (c) => prisma.payment.createMany({ data: c as never }),
  );
  await createManyBatched(
    "shipments",
    Array.from({ length: V.shipments }, (_, i) => ({
      id: `sship${i}`, orderId: `so${int(2_600, V.orders - 1)}`, service: "synthetic-standard",
      trackingNumber: `SYNTH${100000 + i}`, state: pick(["DELIVERED", "DELIVERED", "IN_TRANSIT", "LABEL_PURCHASED"]),
      costCents: int(700, 4_000), createdAt: past(400), updatedAt: past(100),
    })),
    (c) => prisma.shipment.createMany({ data: c as never }),
  );
  await createManyBatched(
    "tracking events",
    Array.from({ length: V.trackingEvents }, (_, i) => ({
      id: `strk${i}`, shipmentId: `sship${i % V.shipments}`, status: pick(["in_transit", "out_for_delivery", "delivered"]),
      occurredAt: past(400),
    })),
    (c) => prisma.trackingEvent.createMany({ data: c as never }),
  );
  await createManyBatched(
    "notifications",
    Array.from({ length: V.notifications }, (_, i) => ({
      id: `sn${i}`, userId: `su${i % V.users}`, kind: pick(["MENTION", "ASSIGNMENT", "STATE_CHANGE", "REMINDER"]),
      title: `Synthetic notification ${i}`, href: `/orders?focus=so${int(0, V.orders - 1)}`,
      readAt: rnd() < 0.7 ? past(50) : null, createdAt: past(90),
    })),
    (c) => prisma.notification.createMany({ data: c as never }),
  );

  // ── manifest for measure.ts ────────────────────────────────────
  const dbFile = url.replace(/^file:/, "");
  const manifest = {
    seededAt: new Date(now).toISOString(),
    sessionToken,
    monsterConversationId: monsterId,
    typicalConversationId: "sc42",
    volumes: V,
    dbSizeBytes: fs.statSync(dbFile).size,
  };
  fs.writeFileSync(path.join(path.dirname(dbFile), "scale-manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nFS0 seed complete. DB ${(manifest.dbSizeBytes / 1e9).toFixed(2)} GB → manifest written.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
