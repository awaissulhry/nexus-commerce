/**
 * FC1 — the pure cores of the chat service, extracted so the contract is
 * testable without a DB (house pattern: orders/money.ts). chat-service.ts is
 * the only consumer besides the tests and the /api/chat routes.
 */

/**
 * The cost-blind law (FC1-SPEC §Schema, substrate trap #1): money rides ONLY
 * in the structured `moneyCents` field — the grain strip deletes `*Cents`
 * keys, but money interpolated into free text would be unstrippable. When a
 * message carries moneyCents, its body must not smell of money.
 */
export const MONEY_IN_BODY_RE = /€|\bEUR\b|\d+[.,]\d{2}\s*€/;

export const bodyCarriesMoney = (body: string): boolean => MONEY_IN_BODY_RE.test(body);

/** ORDER spaces are system-named: "ORD-214 · Rossi Leather". */
export function orderSpaceName(orderNumber: string, partyName: string): string {
  return `${orderNumber} · ${partyName}`;
}

export type OrderSpaceMember = { userId: string; role: "MANAGER" };

/**
 * ensureOrderSpace's membership contract: every active OWNER user joins as
 * MANAGER (dedupe-stable — same input, same output, so the create is
 * idempotent in shape as well as in the DB unique).
 */
export function buildOrderSpaceMembers(ownerUserIds: string[]): OrderSpaceMember[] {
  return [...new Set(ownerUserIds)].map((userId) => ({ userId, role: "MANAGER" as const }));
}

/**
 * Read-cursor unread math: a message is unread when it landed AFTER the
 * cursor message, is not soft-deleted, and is not the viewer's own (system
 * messages — authorId null — always count). No cursor = everything unread.
 * Returns the Prisma where clause the bounded count aggregate runs on.
 */
export function unreadMessageWhere(spaceId: string, viewerUserId: string, lastReadAt: Date | null) {
  return {
    spaceId,
    deletedAt: null,
    OR: [{ authorId: null }, { authorId: { not: viewerUserId } }],
    ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
  };
}

export const WINDOW_TAKE_DEFAULT = 100;
export const WINDOW_TAKE_MAX = 100;

/**
 * The windowed-query param grammar (?before=<messageId>&take=<n>), shared by
 * GET …/messages: take clamps to [1, 100] and defaults to 100 on anything
 * non-numeric; before is a message-id anchor or null (= newest window).
 */
export function parseWindow(input: { before?: string | null; take?: string | null }): {
  before: string | null;
  take: number;
} {
  const rawTake = Number(input.take);
  const take =
    input.take != null && input.take !== "" && Number.isFinite(rawTake)
      ? Math.min(WINDOW_TAKE_MAX, Math.max(1, Math.floor(rawTake)))
      : WINDOW_TAKE_DEFAULT;
  const before = input.before && input.before.trim() ? input.before.trim() : null;
  return { before, take };
}
