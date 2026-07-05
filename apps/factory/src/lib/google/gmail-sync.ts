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
    },
    update: {
      subject: subject || undefined,
      lastMessageAt: sentAt,
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

/** Bounded initial backfill of the chosen label; worker increments after. */
export async function backfillLabel(labelId: string): Promise<{ threads: number; messages: number }> {
  const authed = await getAuthedClient();
  if (!authed) throw new Error("Google not connected");
  const gmail = google.gmail({ version: "v1", auth: authed.client });

  const threadList = await gmail.users.threads.list({
    userId: "me",
    labelIds: [labelId],
    maxResults: BACKFILL_THREADS,
  });
  let messages = 0;
  for (const t of threadList.data.threads ?? []) {
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
  }

  const profile = await gmail.users.getProfile({ userId: "me" });
  await prisma.googleConnection.updateMany({
    where: { email: authed.email },
    data: {
      historyId: profile.data.historyId ? String(profile.data.historyId) : undefined,
      lastSyncAt: new Date(),
      lastError: null,
    },
  });
  await publishEventDurable("conversation.synced", { backfill: true });
  return { threads: threadList.data.threads?.length ?? 0, messages };
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
      // historyId expired — mandatory full resync (F0-ARCHITECTURE §Gmail)
      await prisma.googleConnection.update({ where: { id: connection.id }, data: { historyId: null } });
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
