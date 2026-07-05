/**
 * F1 — the sidecar worker (FD11): its own process so the Gmail poller never
 * misses an order email because the UI restarted (and dev double-scheduling
 * inside Next, vercel/next.js#51450, can't happen). Jobs:
 *   · heartbeat        every 30s → AppSetting worker.heartbeat (Health panel)
 *   · Gmail poll       every 10s → history.list incremental (≈0.02%/day quota)
 *   · nightly snapshot 03:xx     → VACUUM INTO .snapshots/ (rotate 14)
 * Shares the SQLite file with the web process under WAL.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma, factoryDbUrl } from "../src/lib/db";
import { incrementalSync } from "../src/lib/google/gmail-sync";
import { notify } from "../src/lib/notifications";

const HEARTBEAT_MS = 30_000;
const GMAIL_POLL_MS = 10_000;
const INBOX_TICK_MS = 60_000;
const OUTBOX_TTL_MS = 10 * 60 * 1000;
const SNAPSHOT_HOUR = 3;
const SNAPSHOT_KEEP = 14;

let stopping = false;
let gmailBusy = false;
let lastSnapshotDay = "";

async function heartbeat() {
  try {
    await prisma.appSetting.upsert({
      where: { key: "worker.heartbeat" },
      create: { key: "worker.heartbeat", value: { ts: new Date().toISOString(), pid: process.pid } },
      update: { value: { ts: new Date().toISOString(), pid: process.pid } },
    });
  } catch (err) {
    console.error("[worker] heartbeat failed:", (err as Error).message);
  }
}

async function gmailPoll() {
  if (gmailBusy || stopping) return;
  gmailBusy = true;
  try {
    const result = await incrementalSync();
    if (result && "synced" in result && result.synced > 0) {
      console.log(`[worker] gmail: +${result.synced} message(s)`);
    }
    if (result && "resynced" in result) console.log("[worker] gmail: full resync completed");
  } catch (err) {
    console.error("[worker] gmail poll error:", (err as Error).message);
  } finally {
    gmailBusy = false;
  }
}

/**
 * FP1.1 — inbox minute tick: wake snoozed threads, fire follow-up reminders
 * (auto-cancel on reply lives in the sync path), prune the event outbox.
 * All notifications go durable (notify() writes the outbox) so web SSE
 * clients hear them from this separate process.
 */
async function inboxTick() {
  const now = new Date();
  try {
    const woken = await prisma.conversation.findMany({
      where: { state: "SNOOZED", snoozeUntil: { lte: now } },
      select: { id: true, subject: true, assigneeId: true },
    });
    for (const c of woken) {
      await prisma.conversation.update({
        where: { id: c.id },
        data: { state: "OPEN", snoozeUntil: null },
      });
      if (c.assigneeId) {
        await notify({
          userId: c.assigneeId,
          kind: "REMINDER",
          title: `Back from snooze: ${c.subject ?? "(no subject)"}`,
          entityType: "conversation",
          entityId: c.id,
          href: `/inbox?focus=${c.id}`,
        });
      }
    }

    const due = await prisma.conversation.findMany({
      where: { followUpAt: { lte: now } },
      select: { id: true, subject: true, assigneeId: true },
    });
    let fallbackOwnerId: string | null | undefined;
    for (const c of due) {
      await prisma.conversation.update({ where: { id: c.id }, data: { followUpAt: null } });
      let target = c.assigneeId;
      if (!target) {
        if (fallbackOwnerId === undefined) {
          fallbackOwnerId =
            (
              await prisma.user.findFirst({
                where: { status: "active", roleAssignments: { some: { role: { key: "OWNER" } } } },
                select: { id: true },
              })
            )?.id ?? null;
        }
        target = fallbackOwnerId ?? null;
      }
      if (target) {
        await notify({
          userId: target,
          kind: "REMINDER",
          title: `Follow up: ${c.subject ?? "(no subject)"}`,
          body: "No reply arrived — the reminder you set is due.",
          entityType: "conversation",
          entityId: c.id,
          href: `/inbox?focus=${c.id}`,
        });
      }
    }

    await prisma.factoryEventOutbox.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - OUTBOX_TTL_MS) } },
    });
  } catch (err) {
    console.error("[worker] inbox tick error:", (err as Error).message);
  }
}

async function nightlySnapshot() {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (now.getHours() !== SNAPSHOT_HOUR || lastSnapshotDay === day) return;
  lastSnapshotDay = day;
  try {
    const dbFile = factoryDbUrl().replace(/^file:/, "");
    const dir = path.join(path.dirname(dbFile), "..", ".snapshots");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `factory-${day}.db`);
    if (!fs.existsSync(target)) {
      await prisma.$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
      console.log(`[worker] snapshot written: ${path.basename(target)}`);
    }
    const snapshots = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("factory-") && f.endsWith(".db"))
      .sort();
    while (snapshots.length > SNAPSHOT_KEEP) {
      const oldest = snapshots.shift()!;
      fs.rmSync(path.join(dir, oldest));
      console.log(`[worker] snapshot rotated out: ${oldest}`);
    }
  } catch (err) {
    console.error("[worker] snapshot failed:", (err as Error).message);
  }
}

async function main() {
  console.log("[worker] Nexus Factory worker starting (heartbeat 30s · gmail 10s · snapshot 03:00)");
  await heartbeat();
  const timers = [
    setInterval(() => void heartbeat(), HEARTBEAT_MS),
    setInterval(() => void gmailPoll(), GMAIL_POLL_MS),
    setInterval(() => void inboxTick(), INBOX_TICK_MS),
    setInterval(() => void nightlySnapshot(), 60_000),
  ];
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${signal} — stopping`);
    for (const t of timers) clearInterval(t);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

void main();
