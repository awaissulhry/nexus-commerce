/**
 * F1 — the sidecar worker (FD11): its own process so the Gmail poller never
 * misses an order email because the UI restarted (and dev double-scheduling
 * inside Next, vercel/next.js#51450, can't happen). Jobs:
 *   · heartbeat        every 30s → AppSetting worker.heartbeat (Health panel)
 *   · Gmail poll       every 10s → history.list incremental (≈0.02%/day quota)
 *   · tracking tick    every 15m → poll in-flight shipments, drive → delivered
 *   · nightly snapshot 03:xx     → VACUUM INTO .snapshots/ (rotate 14)
 * Shares the SQLite file with the web process under WAL.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma, factoryDbUrl } from "../src/lib/db";
import { audit } from "../src/lib/audit";
import { publishEventDurable } from "../src/lib/events";
import { incrementalSync } from "../src/lib/google/gmail-sync";
import { notify } from "../src/lib/notifications";
import { pollInflightShipments } from "../src/lib/shipping/poll-tracking";
import { quoteTick } from "./quote-tick";

const HEARTBEAT_MS = 30_000;
const GMAIL_POLL_MS = 10_000;
const INBOX_TICK_MS = 60_000;
const TRACKING_TICK_MS = 15 * 60 * 1000; // FP8 — poll in-flight shipments (read-only)
const OUTBOX_TTL_MS = 60 * 60 * 1000; // FS2 — outbox doubles as the gap-free resume window (was 10 min)
const SNAPSHOT_HOUR = 3;
const SNAPSHOT_KEEP = 14;

let stopping = false;
let gmailBusy = false;
let trackingBusy = false;
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
    const woken = await prisma.conversation.findMany({ // bounded: due-scan: snoozeUntil<=now, FS1-indexed, result is only what's due
      where: { state: "SNOOZED", snoozeUntil: { lte: now } },
      select: { id: true, subject: true, assigneeId: true },
    });
    for (const c of woken) {
      await prisma.conversation.update({
        where: { id: c.id },
        data: { state: "OPEN", snoozeUntil: null },
      });
      // EPI1.1 (G1) — the wake used to be invisible: no audit row for the
      // ONE-timeline, no event for open tabs. System actor = null.
      await audit({
        actorId: null,
        entityType: "conversation",
        entityId: c.id,
        action: "unsnoozed",
        after: { state: "OPEN", by: "worker" },
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

    const due = await prisma.conversation.findMany({ // bounded: due-scan: followUpAt<=now, FS1-indexed, result is only what's due
      where: { followUpAt: { lte: now } },
      select: { id: true, subject: true, assigneeId: true },
    });
    let fallbackOwnerId: string | null | undefined;
    for (const c of due) {
      await prisma.conversation.update({ where: { id: c.id }, data: { followUpAt: null } });
      // EPI1.1 (G1) — follow-up firing lands in the timeline too.
      await audit({
        actorId: null,
        entityType: "conversation",
        entityId: c.id,
        action: "followup.fired",
        after: { by: "worker" },
      });
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

    // EPI1.1 (G1) — one durable event per tick that changed anything, so open
    // tabs live-refresh on wakes/fired follow-ups (mirrors the bulk idiom).
    if (woken.length > 0 || due.length > 0) {
      await publishEventDurable("conversation.updated", {
        worker: true,
        woken: woken.length,
        followUpsFired: due.length,
      });
    }

    await prisma.factoryEventOutbox.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - OUTBOX_TTL_MS) } },
    });
  } catch (err) {
    console.error("[worker] inbox tick error:", (err as Error).message);
  }
}

/**
 * FP8 — tracking tick: ask the carrier where each in-flight parcel is, append
 * new events, and let a delivery flip its order. Read-only against the carrier;
 * no-ops cleanly when no carrier is connected (the FakeCarrier stands in).
 */
async function trackingTick() {
  if (trackingBusy || stopping) return;
  trackingBusy = true;
  try {
    const r = await pollInflightShipments();
    if (r.advanced > 0) console.log(`[worker] tracking: ${r.advanced} advanced, ${r.delivered} delivered (${r.polled} in flight)`);
  } catch (err) {
    console.error("[worker] tracking tick error:", (err as Error).message);
  } finally {
    trackingBusy = false;
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
    setInterval(() => void quoteTick(), 60_000), // EPQ.1 — expiry sweep
    setInterval(() => void trackingTick(), TRACKING_TICK_MS),
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
