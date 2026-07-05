/**
 * F1 — Gmail ingestion (label-scoped, FD3): bounded backfill on label pick,
 * then history.list incremental polling from the worker (10s cadence ≈ 0.02%
 * of daily quota — the F0 math). historyId expiry (HTTP 404) triggers a full
 * resync automatically. F1 stores headers + snippet (bodies lazy-load in
 * FP1's Inbox). Sender → PartyEmail matching links conversations to parties.
 */
import { google, type gmail_v1 } from "googleapis";
import { prisma } from "@/lib/db";
import { publishEvent } from "@/lib/events";
import { getAuthedClient } from "./oauth";

const BACKFILL_THREADS = 50;

function header(msg: gmail_v1.Schema$Message, name: string): string {
  return msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

const parseAddress = (raw: string): string => {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
};

async function upsertMessage(
  ownEmail: string,
  msg: gmail_v1.Schema$Message,
): Promise<void> {
  const threadId = msg.threadId!;
  const gmailMessageId = msg.id!;
  const from = parseAddress(header(msg, "From"));
  const subject = header(msg, "Subject");
  const sentAt = msg.internalDate ? new Date(Number(msg.internalDate)) : new Date();
  const direction = from === ownEmail.toLowerCase() ? "OUTBOUND" : "INBOUND";

  // sender → party match (the golden flow's first hop)
  const partyEmail =
    direction === "INBOUND" ? await prisma.partyEmail.findUnique({ where: { email: from } }) : null;

  const conversation = await prisma.conversation.upsert({
    where: { gmailThreadId: threadId },
    create: {
      channel: "GMAIL",
      gmailThreadId: threadId,
      subject: subject || null,
      partyId: partyEmail?.partyId ?? null,
      lastMessageAt: sentAt,
    },
    update: {
      subject: subject || undefined,
      lastMessageAt: sentAt,
      ...(partyEmail ? { partyId: partyEmail.partyId } : {}),
    },
  });

  await prisma.message.upsert({
    where: { gmailMessageId },
    create: {
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
    update: { labels: msg.labelIds ?? [] },
  });
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
  publishEvent("conversation.synced", { backfill: true });
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
    if (synced > 0) publishEvent("conversation.synced", { synced });
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
