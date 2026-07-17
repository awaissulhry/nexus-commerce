/**
 * FS1 — DB-level parity gate: the SQL-aggregate rewrites must produce
 * IDENTICAL numbers to the legacy row-hydrating implementations on the SAME
 * database. Legacy code is copied here verbatim-in-spirit (paged where the old
 * shape would P2029/OOM — the MATH is unchanged). Read-only throughout.
 * Run against the harness AND the live DB before shipping:
 *   npx tsx scripts/scale/parity.ts                     # live (read-only)
 *   FACTORY_DATABASE_URL="file:$(pwd)/data/scale.db" npx tsx scripts/scale/parity.ts
 */
import { prisma } from "../../src/lib/db";
import { materialStock, expectedForMaterial } from "../../src/lib/materials/stock";
import { loadOrderFinancials, loadMonthMoney } from "../../src/lib/financials/load";
import { orderFinancials, depositsOutstanding, monthMoneyFromFins, romeMonthKey, type FinOrder, type OrderFinancials } from "../../src/lib/financials/rollup";
import { marginByProduct, marginByProductFromAggregates } from "../../src/lib/analytics/margin-by-product";
import { quoteWinLoss, quoteWinLossFromGroups } from "../../src/lib/analytics/win-loss";
import { throughputByWeek } from "../../src/lib/analytics/throughput";
import { Prisma } from "../../src/generated/prisma/client";

let failures = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function firstDiff<T>(a: T[], b: T[], key: (x: T) => string): string | null {
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  const bm = new Map(b.map((x) => [key(x), JSON.stringify(x)]));
  for (const x of a) {
    const other = bm.get(key(x));
    if (other !== JSON.stringify(x)) return `at ${key(x)}: ${JSON.stringify(x).slice(0, 160)} vs ${(other ?? "missing").slice(0, 160)}`;
  }
  return null;
}

// ── 1. materials stock: legacy whole-ledger fold vs shipped groupBy route math ──
async function checkStock() {
  const materials = await prisma.material.findMany({ orderBy: { name: "asc" } }); // bounded: catalog
  const openPos = await prisma.purchaseOrder.findMany({ where: { state: { in: ["SENT", "PARTIAL"] } }, select: { id: true, lines: true } }); // bounded: open POs

  // legacy: every movement row, folded in JS (paged to keep memory sane)
  const movesByMat = new Map<string, { type: string; qty: number }[]>();
  const receivedByPoMat: Record<string, Record<string, number>> = {};
  let cursor: string | null = null;
  for (;;) {
    const page: { id: string; materialId: string; type: string; qty: number; refType: string | null; refId: string | null }[] =
      await prisma.movementLedger.findMany({
        select: { id: true, materialId: true, type: true, qty: true, refType: true, refId: true },
        orderBy: { id: "asc" },
        take: 100_000,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
    if (!page.length) break;
    for (const m of page) {
      let arr = movesByMat.get(m.materialId);
      if (!arr) movesByMat.set(m.materialId, (arr = []));
      arr.push({ type: m.type, qty: m.qty });
      if (m.type === "IN" && m.refType === "PO" && m.refId) ((receivedByPoMat[m.refId] ??= {})[m.materialId] = (receivedByPoMat[m.refId][m.materialId] ?? 0) + m.qty);
    }
    cursor = page[page.length - 1].id;
    if (page.length < 100_000) break;
  }
  const expectedByMat: Record<string, number> = {};
  for (const po of openPos) for (const l of ((po.lines as { materialId: string; qty: number }[]) ?? [])) {
    const rec = receivedByPoMat[po.id]?.[l.materialId] ?? 0;
    expectedByMat[l.materialId] = (expectedByMat[l.materialId] ?? 0) + Math.max(0, l.qty - rec);
  }
  const legacy = materials.map((m) => ({ id: m.id, ...materialStock(movesByMat.get(m.id) ?? [], expectedByMat[m.id] ?? 0) }));

  // shipped: groupBy pseudo-movements (exactly the route's code shape)
  const typeSums = await prisma.movementLedger.groupBy({ by: ["materialId", "type"], _sum: { qty: true } });
  const pseudoByMat: Record<string, { type: string; qty: number }[]> = {};
  for (const s of typeSums) (pseudoByMat[s.materialId] ??= []).push({ type: s.type, qty: s._sum.qty ?? 0 });
  const poIds = openPos.map((po) => po.id);
  const poReceipts = poIds.length
    ? await prisma.movementLedger.groupBy({ by: ["refId", "materialId"], where: { type: "IN", refType: "PO", refId: { in: poIds } }, _sum: { qty: true } })
    : [];
  const recByPoMat: Record<string, Record<string, number>> = {};
  for (const r of poReceipts) if (r.refId) (recByPoMat[r.refId] ??= {})[r.materialId] = r._sum.qty ?? 0;
  const expByMat: Record<string, number> = {};
  for (const po of openPos) for (const l of ((po.lines as { materialId: string; qty: number }[]) ?? [])) {
    const rec = recByPoMat[po.id]?.[l.materialId] ?? 0;
    expByMat[l.materialId] = (expByMat[l.materialId] ?? 0) + Math.max(0, l.qty - rec);
  }
  const fresh = materials.map((m) => ({ id: m.id, ...materialStock(pseudoByMat[m.id] ?? [], expByMat[m.id] ?? 0) }));

  // float Σ-order differs → compare at 1e-6
  let diff: string | null = null;
  for (let i = 0; i < legacy.length; i++) {
    for (const k of ["inStock", "committed", "expected", "available"] as const) {
      if (Math.abs((legacy[i][k] as number) - (fresh[i][k] as number)) > 1e-6) { diff = `${legacy[i].id}.${k}: ${legacy[i][k]} vs ${fresh[i][k]}`; break; }
    }
    if (diff) break;
  }
  report("materials stock four-column fold", !diff, diff ?? `${materials.length} materials`);
}

// ── 2. financials: legacy hydrate vs shipped SQL loader ──
// EPF1 re-baseline: the legacy reproduction now carries the SAME inputs the
// EPF1 fold semantics need (payment/invoice dates for Rome-month buckets,
// invoice numbers, WO states for actualComplete) — the parity claim stays
// "row-hydrating fold ≡ SQL-aggregate loader" on the NEW semantics.
async function legacyFins(excludeStates: string[]): Promise<OrderFinancials[]> {
  // paged like the ORIGINAL legacy reproduction — the one-shot relation-include
  // shape trips P2029 at 50k (each relation select becomes an IN(ids) query)
  type LegacyOrder = {
    id: string; number: string; state: string; createdAt: Date;
    party: { id: string; name: string };
    lines: { netPriceCents: number; costCents: number; qty: number }[];
    payments: { kind: string; amountCents: number; receivedAt: Date }[];
    invoices: { number: string; amountCents: number; paidAt: Date | null; createdAt: Date }[];
    bornFromQuote: { depositPct: number | null } | null;
    workOrders: { id: string; state: string }[];
  };
  const orders: LegacyOrder[] = [];
  for (let cursor: string | undefined; ; ) {
    const page = await prisma.order.findMany({
      where: { state: { notIn: excludeStates as never[] } },
      orderBy: { id: "asc" },
      take: 400, // prisma's SQLite param ceiling is 999 — 400 ids per relation IN() stays under it
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, number: true, state: true, createdAt: true,
        party: { select: { id: true, name: true } },
        lines: { select: { netPriceCents: true, costCents: true, qty: true } },
        payments: { select: { kind: true, amountCents: true, receivedAt: true } },
        invoices: { select: { number: true, amountCents: true, paidAt: true, createdAt: true }, orderBy: { createdAt: "asc" as const } },
        bornFromQuote: { select: { depositPct: true } },
        workOrders: { select: { id: true, state: true } },
      },
    }); // bounded: paged at 400/loop — parity-script legacy reproduction
    orders.push(...(page as LegacyOrder[]));
    if (page.length < 400) break;
    cursor = page[page.length - 1].id;
  }
  orders.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : 1));
  const woToOrder = new Map<string, string>();
  for (const o of orders) for (const w of o.workOrders) woToOrder.set(w.id, o.id);
  const actual = new Map<string, number>();
  const moves = await prisma.movementLedger.findMany({ where: { refType: "WorkOrder", type: "OUT" }, select: { refId: true, materialId: true, qty: true } }); // bounded: OUT-consumption rows only
  const costs = Object.fromEntries((await prisma.material.findMany({ select: { id: true, costCents: true } })).map((m) => [m.id, m.costCents])); // bounded: catalog
  for (const m of moves) {
    const orderId = m.refId ? woToOrder.get(m.refId) : undefined;
    if (!orderId) continue;
    actual.set(orderId, (actual.get(orderId) ?? 0) + m.qty * (costs[m.materialId] ?? 0));
  }
  for (const [k, v] of actual) actual.set(k, Math.round(v));
  return orders.map((o) =>
    orderFinancials({
      id: o.id, number: o.number, partyId: o.party.id, partyName: o.party.name, state: o.state, createdAtISO: o.createdAt.toISOString(),
      lines: o.lines,
      payments: o.payments.map((p) => ({ kind: p.kind, amountCents: p.amountCents, receivedAtISO: p.receivedAt.toISOString() })),
      invoices: o.invoices.map((i) => ({ amountCents: i.amountCents, paidAt: i.paidAt ? i.paidAt.toISOString() : null, issuedAtISO: i.createdAt.toISOString(), number: i.number })),
      depositPct: o.bornFromQuote?.depositPct, actualCostCents: actual.get(o.id) ?? null,
      actualComplete: o.workOrders.length > 0 && o.workOrders.every((w) => w.state === "DONE"),
    } satisfies FinOrder),
  );
}

/**
 * Money comparison: every INTEGER-derived field must match EXACTLY. The
 * actual-cost family alone tolerates ±1 cent: it is Σ(qty REAL × costCents),
 * and float summation associativity (JS legacy vs SQLite SUM) can flip a
 * value sitting on a half-cent boundary — the legacy number was itself
 * summation-order-dependent at that precision (seen once in 47k orders).
 */
function finsDiff(a: OrderFinancials[], b: OrderFinancials[], opts?: { hotProjection?: boolean }): string | null {
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  // EPF1 split-path: the HOT loader's pseudo docs carry no dates, so its
  // per-order month buckets degrade to the documented creation-month
  // fallback — they are NOT a shared figure. Every other figure must match.
  const skip = opts?.hotProjection ? new Set<keyof OrderFinancials>(["invoicedByMonthCents", "paidByMonthCents"]) : new Set<keyof OrderFinancials>();
  const bm = new Map(b.map((x) => [x.orderId, x]));
  for (const x of a) {
    const y = bm.get(x.orderId);
    if (!y) return `missing ${x.orderId}`;
    for (const k of Object.keys(x) as (keyof OrderFinancials)[]) {
      if (skip.has(k)) continue;
      if (k === "actualCostCents" || k === "actualMarginCents") {
        if (Math.abs((x[k] as number) - (y[k] as number)) > 1) return `${x.orderId}.${k}: ${x[k]} vs ${y[k]}`;
      } else if (k === "actualMarginPct") {
        // derived from actualMarginCents (±1c) over quotedNet: bound = 1c as a pct of net
        const bound = (1 / Math.max(x.quotedNetCents, 1)) * 100 + 1e-9;
        if (Math.abs((x[k] as number) - (y[k] as number)) > bound) return `${x.orderId}.${k}: ${x[k]} vs ${y[k]}`;
      } else if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) {
        return `${x.orderId}.${k}: ${JSON.stringify(x[k])} vs ${JSON.stringify(y[k])}`;
      }
    }
    if (opts?.hotProjection) {
      // the hot degradation itself must stay lawful: Σ of each map = the total
      const sum = (r: Record<string, number>) => Object.values(r).reduce((s, v) => s + v, 0);
      if (sum(x.invoicedByMonthCents) !== x.invoicedCents) return `${x.orderId}: hot invoicedByMonthCents Σ ≠ invoicedCents`;
      if (sum(x.paidByMonthCents) !== x.paidCents) return `${x.orderId}: hot paidByMonthCents Σ ≠ paidCents`;
    }
  }
  return null;
}

async function checkFinancials() {
  const legacy = await legacyFins(["CANCELLED"]);

  // DOC-DATES path ≡ legacy: full per-order compare including Rome-month buckets
  const doc = await loadOrderFinancials(undefined, { docDates: true });
  const docDiff = finsDiff(legacy, doc);
  report("financials doc-dates path ≡ legacy (full, incl. month buckets)", docDiff === null, docDiff ?? `${doc.length} orders`);

  // HOT path ≡ legacy: every per-order figure (month buckets excluded by design)
  const fresh = await loadOrderFinancials();
  const fd = finsDiff(legacy, fresh, { hotProjection: true });
  report("financials hot path ≡ legacy (per-order figures; int money exact; actual-cost ±1c float assoc)", fd === null, fd ?? `${fresh.length} orders`);

  // tiles' month figures: TZ-exact SQL range sums ≡ Σ of the doc-dated buckets
  const monthKey = romeMonthKey(new Date().toISOString());
  const [sqlMonth, foldMonth] = [await loadMonthMoney(monthKey), monthMoneyFromFins(doc, monthKey)];
  report(
    "tiles month money: SQL range sums ≡ doc-dates fold",
    sqlMonth.invoicedCents === foldMonth.invoicedCents && sqlMonth.paidCents === foldMonth.paidCents,
    `${monthKey} invoiced ${sqlMonth.invoicedCents}/${foldMonth.invoicedCents} paid ${sqlMonth.paidCents}/${foldMonth.paidCents}`,
  );

  const [legacyDep, freshDep] = [
    depositsOutstanding(await legacyFins(["CANCELLED", "CLOSED"])),
    depositsOutstanding(await loadOrderFinancials(undefined, { excludeStates: ["CANCELLED", "CLOSED"] })),
  ];
  const dd = firstDiff(legacyDep, freshDep, (d) => d.orderId);
  report("deposits outstanding", dd === null, dd ?? `${freshDep.length} outstanding`);
}

// ── 3. lastMessageDirection column integrity vs actual newest message ──
async function checkLastDirection() {
  // stale = the column's direction is not among the newest messages' directions
  // (multiple messages can share the max sentAt; any of their directions is a
  // valid "latest" — the write path stamps whichever arrived last)
  const rows = await prisma.$queryRaw<{ bad: number | bigint }[]>(Prisma.sql`
    SELECT COUNT(*) AS bad FROM "Conversation" c
    WHERE EXISTS (SELECT 1 FROM "Message" m WHERE m."conversationId" = c."id")
      AND COALESCE(c."lastMessageDirection", '') NOT IN
          (SELECT m2."direction" FROM "Message" m2 WHERE m2."conversationId" = c."id"
           AND m2."sentAt" = (SELECT MAX(m3."sentAt") FROM "Message" m3 WHERE m3."conversationId" = c."id"))`);
  const bad = Number(rows[0]?.bad ?? 0);
  report("Conversation.lastMessageDirection integrity", bad === 0, bad === 0 ? undefined : `${bad} stale`);
}

// ── 4. analytics folds ──
async function checkAnalytics() {
  // throughput: legacy per-WO all-finished fold vs SQL HAVING
  const wos = await prisma.workOrder.findMany({ select: { stages: { select: { finishedAt: true } } } }); // bounded: parity one-shot legacy reproduction
  const legacyFinishes: string[] = [];
  for (const wo of wos) {
    if (wo.stages.length > 0 && wo.stages.every((s) => s.finishedAt)) {
      legacyFinishes.push(new Date(wo.stages.reduce((mx, s) => Math.max(mx, s.finishedAt!.getTime()), 0)).toISOString());
    }
  }
  const finRows = await prisma.$queryRaw<{ mf: string | Date }[]>`
    SELECT MAX(s."finishedAt") AS mf FROM "WorkOrderStage" s
    GROUP BY s."workOrderId" HAVING COUNT(*) = COUNT(s."finishedAt")`;
  const freshFinishes = finRows.map((r) => (r.mf instanceof Date ? r.mf : new Date(r.mf)).toISOString());
  const tDiff = firstDiff(throughputByWeek(legacyFinishes), throughputByWeek(freshFinishes), (p) => p.weekKey);
  report("analytics throughput weeks", tDiff === null, tDiff ?? `${freshFinishes.length} finished WOs`);

  // margin by product: legacy line rows vs SQL aggregate rows
  const lines = await prisma.orderLine.findMany({ where: { order: { state: { not: "CANCELLED" } } }, select: { description: true, netPriceCents: true, costCents: true, qty: true } }); // bounded: parity one-shot legacy reproduction
  const legacyMbp = marginByProduct(lines.map((l) => ({ product: l.description, netPriceCents: l.netPriceCents, costCents: l.costCents, qty: l.qty })));
  const aggs = await prisma.$queryRaw<{ product: string | null; n: number | bigint; net: number | bigint; cost: number | bigint }[]>`
    SELECT l."description" AS product, COUNT(*) AS n, SUM(l."netPriceCents" * l."qty") AS net, SUM(l."costCents" * l."qty") AS cost
    FROM "OrderLine" l JOIN "Order" o ON o."id" = l."orderId" WHERE o."state" <> 'CANCELLED' GROUP BY l."description"`;
  const freshMbp = marginByProductFromAggregates(aggs.map((r) => ({ product: r.product, lines: Number(r.n), netCents: Number(r.net ?? 0), costCents: Number(r.cost ?? 0) })));
  const mDiff = firstDiff(legacyMbp, freshMbp, (p) => p.product);
  report("analytics margin by product", mDiff === null, mDiff ?? `${freshMbp.length} products`);

  // win/loss: legacy quote rows vs groupBy
  const quotes = await prisma.quote.findMany({ select: { state: true, lostReason: true } }); // bounded: parity one-shot legacy reproduction
  const groups = await prisma.quote.groupBy({ by: ["state", "lostReason"], _count: { _all: true } });
  const legacyWl = quoteWinLoss(quotes);
  const freshWl = quoteWinLossFromGroups(groups.map((g) => ({ state: g.state, lostReason: g.lostReason, count: g._count._all })));
  report("analytics win/loss", JSON.stringify(legacyWl) === JSON.stringify(freshWl), JSON.stringify(legacyWl) === JSON.stringify(freshWl) ? `${quotes.length} quotes` : `${JSON.stringify(legacyWl).slice(0, 120)} vs ${JSON.stringify(freshWl).slice(0, 120)}`);

  // counters "unanswered": column-count vs recomputed truth
  const viaColumn = await prisma.conversation.count({ where: { state: "OPEN", lastMessageDirection: "INBOUND" } });
  const truthRows = await prisma.$queryRaw<{ c: number | bigint }[]>(Prisma.sql`
    SELECT COUNT(*) AS c FROM "Conversation" c
    WHERE c."state" = 'OPEN' AND (SELECT m."direction" FROM "Message" m WHERE m."conversationId" = c."id" ORDER BY m."sentAt" DESC, m."id" DESC LIMIT 1) = 'INBOUND'`);
  const truth = Number(truthRows[0]?.c ?? 0);
  report("counters unanswered", viaColumn === truth, viaColumn === truth ? `${truth} unanswered` : `${viaColumn} vs ${truth}`);
}

async function main() {
  console.log(`FS1 parity vs ${process.env.FACTORY_DATABASE_URL || "live factory.db"} (read-only)`);
  await checkStock();
  await checkFinancials();
  await checkLastDirection();
  await checkAnalytics();
  if (failures) { console.error(`\n${failures} PARITY FAILURE(S) — do not ship.`); process.exit(1); }
  console.log("\nAll parity checks passed.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
