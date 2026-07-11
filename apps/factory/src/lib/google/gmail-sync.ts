/**
 * F1 — Gmail ingestion (label-scoped, FD3): bounded backfill on label pick,
 * then history.list incremental polling from the worker (10s cadence ≈ 0.02%
 * of daily quota — the F0 math). historyId expiry (HTTP 404) triggers a full
 * resync automatically. Sender → party matching links conversations.
 * FP1.1 additions: domain matching (PartyEmail.matchDomain), work semantics
 * on inbound (CLOSED → reopen to assignee, un-snooze, cancel follow-up —
 * the Missive ADOPT verdicts), assignee notifications, and DURABLE event
 * publishing (this file runs in the WORKER process; the in-memory bus never
 * reaches web SSE clients — FactoryEventOutbox does).
 */
import { google, type gmail_v1 } from "googleapis";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { notify } from "@/lib/notifications";
import { TtlCache } from "@/lib/ttl-cache";
import { matchPartyId, type EmailRow } from "./match";
import { getAuthedClient } from "./oauth";

const BACKFILL_THREADS = 50;

function header(msg: gmail_v1.Schema$Message, name: string): string {
  return msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

const parseAddress = (raw: string): string => {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
};

const emailRowCache = new TtlCache<EmailRow[]>(30_000, 4);

async function partyEmailRows(): Promise<EmailRow[]> {
  const hit = emailRowCache.get("rows");
  if (hit) return hit;
  const rows = await prisma.partyEmail.findMany({
    select: { email: true, partyId: true, matchDomain: true },
  });
  emailRowCache.set("rows", rows);
  return rows;
}

/** Exported for the link-party route: re-match a party's other conversations. */
export const clearPartyEmailCache = () => emailRowCache.clear();

async function upsertMessage(ownEmail: string, msg: gmail_v1.Schema$Message): Promise<void> {
  const threadId = msg.threadId!;
  const gmailMessageId = msg.id!;
  const from = parseAddress(header(msg, "From"));
  const subject = header(msg, "Subject");
  const sentAt = msg.internalDate ? new Date(Number(msg.internalDate)) : new Date();
  const direction = from === ownEmail.toLowerCase() ? "OUTBOUND" : "INBOUND";

  // already ingested → refresh labels only, no work semantics
  const existingMessage = await prisma.message.findUnique({
    where: { gmailMessageId },
    select: { id: true },
  });
  if (existingMessage) {
    await prisma.message.update({
      where: { id: existingMessage.id },
      data: { labels: msg.labelIds ?? [] },
    });
    return;
  }

  const partyId =
    direction === "INBOUND" ? matchPartyId(from, await partyEmailRows()) : null;

  const existingConversation = await prisma.conversation.findUnique({
    where: { gmailThreadId: threadId },
    select: { id: true, state: true, assigneeId: true, snoozeUntil: true, followUpAt: true, partyId: true },
  });

  const conversation = await prisma.conversation.upsert({
    where: { gmailThreadId: threadId },
    create: {
      channel: "GMAIL",
      gmailThreadId: threadId,
      subject: subject || null,
      partyId,
      lastMessageAt: sentAt,
      lastMessageDirection: direction, // FS1 — mirrors lastMessageAt semantics
    },
    update: {
      subject: subject || undefined,
      lastMessageAt: sentAt,
      lastMessageDirection: direction, // FS1 — mirrors lastMessageAt semantics
      ...(partyId && !existingConversation?.partyId ? { partyId } : {}),
    },
  });

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      gmailMessageId,
      direction,
      fromAddress: from,
      toAddresses: header(msg, "To")
        .split(",")
        .map((a) => parseAddress(a))
        .filter(Boolean),
      snippet: msg.snippet ?? null,
      labels: msg.labelIds ?? [],
      sentAt,
    },
  });

  // Work semantics on a NEW inbound message (FP1: Missive-verdict state machine)
  if (direction === "INBOUND" && existingConversation) {
    const patch: Record<string, unknown> = {};
    const auditActions: string[] = [];
    if (existingConversation.state === "CLOSED") {
      patch.state = "OPEN";
      auditActions.push("reopened");
    }
    if (existingConversation.state === "SNOOZED" || existingConversation.snoozeUntil) {
      patch.state = "OPEN";
      patch.snoozeUntil = null;
      auditActions.push("unsnoozed");
    }
    if (existingConversation.followUpAt) {
      patch.followUpAt = null;
      auditActions.push("followup.autocancelled");
    }
    if (Object.keys(patch).length) {
      await prisma.conversation.update({ where: { id: conversation.id }, data: patch });
      for (const action of auditActions) {
        void audit({ entityType: "conversation", entityId: conversation.id, action, after: { via: "inbound reply" } });
      }
    }
    if (existingConversation.assigneeId) {
      await notify({
        userId: existingConversation.assigneeId,
        kind: "STATE_CHANGE",
        title:
          existingConversation.state === "CLOSED"
            ? `Reopened by a reply: ${subject || "(no subject)"}`
            : `New reply: ${subject || "(no subject)"}`,
        body: msg.snippet ?? undefined,
        entityType: "conversation",
        entityId: conversation.id,
        href: `/inbox?focus=${conversation.id}`,
      });
    }
  }
}

export async function listGmailLabels() {
  const authed = await getAuthedClient();
  if (!authed) return null;
  const gmail = google.gmail({ version: "v1", auth: authed.client });
  const res = await gmail.users.labels.list({ userId: "me" });
  return (res.data.labels ?? [])
    .filter((l) => l.type === "user" || l.id === "INBOX")
    .map((l) => ({ id: l.id!, name: l.name! }));
}

/**
 * Paginated backfill of the chosen label. FS1 (C-2): the old version fetched
 * ONE page of 50 threads and stamped historyId — on a busy mailbox everything
 * past page one silently never synced. Now: the run walks pages under a
 * thread budget, persisting Gmail's pageToken (plus the historyId captured at
 * the START of the whole backfill) in AppSetting; while pages remain,
 * `historyId` stays null so the worker's next tick re-enters here and resumes.
 * Only when fully drained does the START historyId get stamped — anything that
 * arrived mid-backfill replays through incremental sync, so there is no gap.
 */
const BACKFILL_STATE_KEY = "gmail.backfill.state";
type BackfillState = { labelId: string; pageToken: string; startHistoryId: string | null };

export async function backfillLabel(
  labelId: string,
  opts?: { budgetThreads?: number },
): Promise<{ threads: number; messages: number; more: boolean }> {
  const authed = await getAuthedClient();
  if (!authed) throw new Error("Google not connected");
  const gmail = google.gmail({ version: "v1", auth: authed.client });
  const budget = opts?.budgetThreads ?? BACKFILL_THREADS;

  const savedRow = await prisma.appSetting.findUnique({ where: { key: BACKFILL_STATE_KEY } });
  const savedRaw = (savedRow?.value ?? null) as BackfillState | null;
  const saved = savedRaw?.labelId === labelId ? savedRaw : null; // label changed → stale token, start fresh
  let startHistoryId = saved?.startHistoryId ?? null;
  if (!saved) {
    // fresh backfill — capture the mailbox position BEFORE we start walking
    const profile = await gmail.users.getProfile({ userId: "me" });
    startHistoryId = profile.data.historyId ? String(profile.data.historyId) : null;
  }

  let pageToken: string | undefined = saved?.pageToken;
  let threads = 0;
  let messages = 0;
  while (threads < budget) {
    const page = await gmail.users.threads.list({
      userId: "me",
      labelIds: [labelId],
      maxResults: Math.min(50, budget - threads),
      pageToken,
    });
    for (const t of page.data.threads ?? []) {
      const thread = await gmail.users.threads.get({
        userId: "me",
        id: t.id!,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "To", "Date", "Message-ID"],
      });
      for (const msg of thread.data.messages ?? []) {
        await upsertMessage(authed.email, msg);
        messages++;
      }
      threads++;
    }
    pageToken = page.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }

  const more = !!pageToken;
  if (more) {
    await prisma.appSetting.upsert({
      where: { key: BACKFILL_STATE_KEY },
      create: { key: BACKFILL_STATE_KEY, value: { labelId, pageToken, startHistoryId } as never },
      update: { value: { labelId, pageToken, startHistoryId } as never },
    });
    // historyId stays null → the worker's next tick resumes the backfill
    await prisma.googleConnection.updateMany({
      where: { email: authed.email },
      data: { historyId: null, lastSyncAt: new Date(), lastError: null },
    });
  } else {
    await prisma.appSetting.deleteMany({ where: { key: BACKFILL_STATE_KEY } });
    await prisma.googleConnection.updateMany({
      where: { email: authed.email },
      data: { historyId: startHistoryId ?? undefined, lastSyncAt: new Date(), lastError: null },
    });
  }
  await publishEventDurable("conversation.synced", { backfill: true, more });
  return { threads, messages, more };
}

/** Worker cadence: history.list since the stored id; 404 → full resync. */
export async function incrementalSync(): Promise<{ synced: number } | { resynced: true } | null> {
  const authed = await getAuthedClient();
  if (!authed) return null;
  const connection = await prisma.googleConnection.findFirst({ where: { email: authed.email } });
  if (!connection?.labelId) return null;
  const gmail = google.gmail({ version: "v1", auth: authed.client });

  if (!connection.historyId) {
    await backfillLabel(connection.labelId);
    return { resynced: true };
  }

  try {
    let pageToken: string | undefined;
    let newest = connection.historyId;
    let synced = 0;
    do {
      const res = await gmail.users.history.list({
        userId: "me",
        startHistoryId: connection.historyId,
        labelId: connection.labelId,
        historyTypes: ["messageAdded"],
        pageToken,
      });
      if (res.data.historyId) newest = String(res.data.historyId);
      for (const h of res.data.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          const id = added.message?.id;
          if (!id) continue;
          const full = await gmail.users.messages.get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "To", "Date", "Message-ID"],
          });
          await upsertMessage(authed.email, full.data);
          synced++;
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    await prisma.googleConnection.update({
      where: { id: connection.id },
      data: { historyId: newest, lastSyncAt: new Date(), lastError: null },
    });
    if (synced > 0) await publishEventDurable("conversation.synced", { synced });
    return { synced };
  } catch (err) {
    const status = (err as { status?: number; code?: number }).status ?? (err as { code?: number }).code;
    if (status === 404) {
      // historyId expired — mandatory full resync (F0-ARCHITECTURE §Gmail).
      // FS1 (C-2) — this is no longer silent: the Owner is told a recovery is
      // running, and the paginated backfill resumes across ticks until drained.
      await prisma.googleConnection.update({ where: { id: connection.id }, data: { historyId: null } });
      void audit({ entityType: "integration", entityId: connection.id, action: "gmail.resync.triggered", after: { reason: "historyId expired (404)" } });
      const owners = await prisma.user.findMany({
        where: { status: "active", roleAssignments: { some: { role: { key: "OWNER" } } } },
        select: { id: true },
      }); // bounded: owner set is tiny by construction
      for (const o of owners) {
        await notify({
          userId: o.id,
          kind: "SYSTEM",
          title: "Gmail sync token expired — full recovery started",
          body: "Mail is being re-synced page by page in the background; nothing is lost. This banner clears itself when the backfill drains.",
          href: "/settings/integrations",
        });
      }
      await backfillLabel(connection.labelId);
      return { resynced: true };
    }
    await prisma.googleConnection.update({
      where: { id: connection.id },
      data: { lastError: String((err as Error).message).slice(0, 300) },
    });
    throw err;
  }
}
