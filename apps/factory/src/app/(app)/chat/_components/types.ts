/**
 * FC2 — response shapes the /chat shell consumes (the FC1 API surface;
 * moneyCents/moneyLabel are OPTIONAL because jsonStripped deletes them for
 * cost-blind callers — absence renders as nothing, by design).
 * FC3 — thread summaries on roots, the bounded members payload the mention
 * chips resolve against, followed threads on the spaces payload, and the
 * thread panel's own response shape.
 */
import type { FollowedThread, MentionMember, ThreadSummary } from "@/lib/chat/ui";

export type SpaceItem = {
  id: string;
  kind: "ORDER" | "CUSTOM" | "DM";
  name: string;
  entityType: string | null;
  entityId: string | null;
  updatedAt: string;
  role: "MEMBER" | "MANAGER";
  notifyLevel: "ALL" | "MENTIONS" | "OFF";
  lastReadMessageId: string | null;
  unread: number;
  memberCount: number;
  lastMessage: {
    id: string;
    kind: "MESSAGE" | "SYSTEM";
    body: string;
    authorName: string | null;
    deletedAt: string | null;
    createdAt: string;
  } | null;
};

export type SpacesResponse = { items: SpaceItem[]; threads: FollowedThread[] };

export type ApiMessage = {
  id: string;
  authorId: string | null;
  author: { id: string; displayName: string } | null;
  kind: "MESSAGE" | "SYSTEM";
  body: string;
  threadRootId: string | null;
  moneyCents?: number | null;
  moneyLabel?: string | null;
  meta: unknown;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  reactions: { userId: string; emoji: string }[];
  /** FC3 — present on main-stream roots that have replies */
  thread?: ThreadSummary | null;
};

export type MessagesResponse = {
  items: ApiMessage[];
  window: { before: string | null; take: number };
  /** FC3 — bounded space membership for mention-chip resolution */
  members: MentionMember[];
};

/** FC3 — GET /api/chat/spaces/[id]/threads/[rootId] */
export type ThreadResponse = {
  root: ApiMessage;
  items: ApiMessage[];
  window: { before: string | null; take: number };
  replyCount: number;
  following: boolean;
};
