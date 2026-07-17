/**
 * FC2 — response shapes the /chat shell consumes (the FC1 API surface;
 * moneyCents/moneyLabel are OPTIONAL because jsonStripped deletes them for
 * cost-blind callers — absence renders as nothing, by design).
 */

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

export type SpacesResponse = { items: SpaceItem[] };

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
};

export type MessagesResponse = {
  items: ApiMessage[];
  window: { before: string | null; take: number };
};
