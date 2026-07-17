/**
 * FC2 — chat-volume seeder for the load harness (the FC1 test-plan item:
 * "harness gains chat seeding for FC2's windowing proof"). Same refusals as
 * seed-scale.ts, plus one of its own:
 *   · FACTORY_ALLOW_DEV_SEED=1
 *   · FACTORY_DATABASE_URL contains "scale" (never the live factory.db)
 *   · seed-scale.ts must have run first (orders + users exist)
 *   · the target DB contains zero chat spaces (re-seed = delete scale.db and re-run both)
 * Run:
 *   FACTORY_ALLOW_DEV_SEED=1 FACTORY_DATABASE_URL="file:$(pwd)/data/scale.db" \
 *     npx tsx scripts/scale/seed-chat.ts
 * Volumes (bounded by construction): 200 ORDER spaces over existing scale
 * orders · ~50k messages total with ONE monster space of 5,000 (the FC2
 * windowed-stream proof) · members = the scale Owner (su0, MANAGER) + 3–6
 * workers per space · ~6% SYSTEM messages (some carrying moneyCents ONLY —
 * bodies stay money-free per the FC1 law) · sprinkled edits + tombstones ·
 * su0 read cursors at ~70% on every even space (real unread badges).
 * Output: data/chat-manifest.json (ids + volumes for verification).
 */
import fs from "node:fs";
import path from "node:path";
import { prisma, factoryDbUrl } from "../../src/lib/db";
import { orderSpaceName } from "../../src/lib/chat/pure";

const V = {
  spaces: 200,
  monsterMessages: 5_000,
  minPerSpace: 80,
  maxPerSpace: 380, // 199 × ~230 avg + 5,000 ≈ 50k total
  workersPerSpaceMin: 3,
  workersPerSpaceMax: 6,
};

const BATCH = 2_000;
const now = Date.now();
const DAY = 86_400_000;
const MIN = 60_000;

// deterministic pseudo-random (reproducible across re-seeds, seed-scale pattern)
let rngState = 0xc2a7c2a7;
function rnd(): number {
  rngState = (rngState * 1664525 + 1013904223) >>> 0;
  return rngState / 0xffffffff;
}
const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));

const LINES = [
  "Sleeves measured again, the left one needs 2cm more.",
  "Hides from lot L-88 look consistent, proceeding with cutting.",
  "Customer confirmed the perforation layout on the chest panel.",
  "QC flagged stitching on the right shoulder, redoing that seam.",
  "Waiting on the armor inserts before assembly can continue.",
  "Zip supplier says Thursday. Planning packing for Friday.",
  "Photos of the back protector pocket uploaded to the thread.",
  "Size run checked twice, the 54 goes first.",
  "Lining swap approved, same colour family.",
  "Label printer jammed again, cleared it, labels fine.",
  "Fit notes from the last order applied to this pattern.",
  "The kangaroo panels are cut, moving to stitching tomorrow.",
];
const SYSTEM_EVENTS = [
  { event: "order.confirmed", body: "Order confirmed" },
  { event: "stage.advanced", body: "CUTTING finished, STITCHING started" },
  { event: "stage.advanced", body: "QC passed, moving to PACKING" },
  { event: "payment.recorded", body: "Deposit recorded", money: true },
  { event: "label.bought", body: "Shipping label bought", money: true },
  { event: "tracking.updated", body: "Tracking update, parcel in transit" },
];

async function createManyBatched(label: string, rows: unknown[], create: (chunk: unknown[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await create(rows.slice(i, i + BATCH));
    process.stdout.write(`\r${label}: ${Math.min(i + BATCH, rows.length)}/${rows.length}      `);
  }
  process.stdout.write(`\r${label}: ${rows.length}/${rows.length} ✓\n`);
}

async function main() {
  // ── the refusals ───────────────────────────────────────────────
  if (process.env.FACTORY_ALLOW_DEV_SEED !== "1") throw new Error("refusing: FACTORY_ALLOW_DEV_SEED must be 1");
  const url = factoryDbUrl();
  if (!/scale/.test(url)) throw new Error(`refusing: FACTORY_DATABASE_URL must point at a scale DB, got ${url}`);
  if ((await prisma.order.count()) === 0) throw new Error("refusing: no orders — run seed-scale.ts first");
  if ((await prisma.chatSpace.count()) > 0) throw new Error("refusing: chat already seeded — delete scale.db and re-run both seeders");
  const owner = await prisma.user.findUnique({ where: { id: "su0" }, select: { id: true } });
  if (!owner) throw new Error("refusing: scale owner su0 missing — run seed-scale.ts first");

  console.log(`FC2 chat seed → ${url}`);

  const orders = await prisma.order.findMany({
    take: V.spaces, // bounded: exactly the spaces we seed
    orderBy: { createdAt: "asc" },
    select: { id: true, number: true, party: { select: { name: true } } },
  });
  if (orders.length < V.spaces) throw new Error(`refusing: need ${V.spaces} orders, found ${orders.length}`);

  const workerIds = (
    await prisma.user.findMany({
      where: { id: { not: "su0" }, status: "active" },
      take: 200, // bounded: enough authors for variety
      orderBy: { id: "asc" },
      select: { id: true },
    })
  ).map((u) => u.id);

  // ── spaces + members + messages (generated in one pass) ────────
  const spaces: unknown[] = [];
  const members: unknown[] = [];
  const messages: unknown[] = [];
  const cursorPlan: { spaceId: string; messageId: string }[] = [];
  const spaceTouch: { id: string; at: Date }[] = [];
  let msgN = 0;
  let memberN = 0;
  let totalMessages = 0;
  const monsterSpaceId = "scs0";

  for (let i = 0; i < V.spaces; i++) {
    const order = orders[i];
    const spaceId = `scs${i}`;
    const count = i === 0 ? V.monsterMessages : int(V.minPerSpace, V.maxPerSpace);
    totalMessages += count;

    const crew = new Set<string>();
    while (crew.size < int(V.workersPerSpaceMin, V.workersPerSpaceMax)) crew.add(pick(workerIds));
    const authors = [...crew];
    members.push({ id: `scmb${memberN++}`, spaceId, userId: "su0", role: "MANAGER" });
    for (const userId of authors) members.push({ id: `scmb${memberN++}`, spaceId, userId, role: "MEMBER" });

    // ascending distinct timestamps ending 0–30 days ago (walked backwards
    // from the end so the last message lands exactly at `end`); monster ends
    // recently. Ids are zero-padded so the same-ms id tiebreak stays sane.
    const end = now - (i === 0 ? int(0, 2) : int(0, 30)) * DAY - int(0, 600) * MIN;
    const stamps: number[] = new Array(count);
    let back = end;
    for (let j = count - 1; j >= 0; j--) {
      stamps[j] = back;
      back -= int(1, 30) * MIN + int(0, 50_000);
    }
    const spaceMessageIds: string[] = [];
    for (let j = 0; j < count; j++) {
      const at = new Date(stamps[j]);
      const id = `scm${String(msgN++).padStart(7, "0")}`;
      spaceMessageIds.push(id);
      if (rnd() < 0.06) {
        const sys = pick(SYSTEM_EVENTS);
        messages.push({
          id,
          spaceId,
          authorId: null,
          kind: "SYSTEM",
          body: `${sys.body} for ${order.number}`, // money-free by construction (FC1 law)
          meta: { entityType: "order", entityId: order.id, event: sys.event },
          moneyCents: sys.money ? int(5_000, 250_000) : null,
          moneyLabel: sys.money ? sys.body : null,
          createdAt: at,
        });
      } else {
        const deleted = rnd() < 0.015;
        const edited = !deleted && rnd() < 0.02;
        messages.push({
          id,
          spaceId,
          authorId: rnd() < 0.25 ? "su0" : pick(authors),
          kind: "MESSAGE",
          body: `${pick(LINES)} (${order.number}/${j})`,
          editedAt: edited ? new Date(at.getTime() + int(1, 20) * MIN) : null,
          deletedAt: deleted ? new Date(at.getTime() + int(1, 60) * MIN) : null,
          createdAt: at,
        });
      }
    }

    const lastAt = new Date(end);
    spaces.push({
      id: spaceId,
      kind: "ORDER",
      name: orderSpaceName(order.number, order.party.name),
      entityType: "order",
      entityId: order.id,
      createdAt: new Date(end - count * 20 * MIN),
      updatedAt: lastAt, // FC2 — the rail's activity order (posting bumps this in prod)
    });
    spaceTouch.push({ id: spaceId, at: lastAt });

    // read cursors: even spaces = su0 read up to ~70% (real unread badges)
    if (i % 2 === 0) cursorPlan.push({ spaceId, messageId: spaceMessageIds[Math.floor(spaceMessageIds.length * 0.7)] });
    else cursorPlan.push({ spaceId, messageId: spaceMessageIds[spaceMessageIds.length - 1] });
  }

  await createManyBatched("chat spaces", spaces, (c) => prisma.chatSpace.createMany({ data: c as never }));
  await createManyBatched("chat members", members, (c) => prisma.chatMember.createMany({ data: c as never }));
  await createManyBatched("chat messages", messages, (c) => prisma.chatMessage.createMany({ data: c as never }));

  // createMany's @updatedAt stamped "now" — restore each space's true last-activity time
  for (const s of spaceTouch) {
    await prisma.chatSpace.update({ where: { id: s.id }, data: { updatedAt: s.at } });
  }
  console.log("space activity times restored ✓");

  for (const c of cursorPlan) {
    await prisma.chatMember.updateMany({
      where: { spaceId: c.spaceId, userId: "su0" },
      data: { lastReadMessageId: c.messageId },
    });
  }
  console.log("read cursors set ✓ (even spaces carry unread)");

  const dbFile = url.replace(/^file:/, "");
  const manifest = {
    seededAt: new Date().toISOString(),
    spaces: V.spaces,
    messages: totalMessages,
    monsterSpaceId,
    monsterMessages: V.monsterMessages,
    ownerUserId: "su0",
    note: "FC2 windowing proof: open /chat?space=" + monsterSpaceId + " on :3199",
  };
  fs.writeFileSync(path.join(path.dirname(dbFile), "chat-manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`FC2 chat seed complete: ${V.spaces} spaces · ${totalMessages} messages (monster ${monsterSpaceId} = ${V.monsterMessages}) → manifest written.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
