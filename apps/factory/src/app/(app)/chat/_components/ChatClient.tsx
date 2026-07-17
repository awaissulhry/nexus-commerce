/**
 * FC2 — the /chat workspace container (Google-Chat anatomy on the FS3
 * substrate): resizable rail + space view (useResizablePanes, key
 * factory.chat.paneWidths), ?space= deep links via the house URL law
 * (replaceState + PopStateEvent), live refetch on chat.* SSE events
 * (debounce 1000), read cursor POSTed on space open and on new-message
 * visibility, windowed message paging accumulated here, CUSTOM space
 * creation behind chat.spaces.create. Keyboard: j/k or ↑/↓ move the rail
 * selection while the rail is focused; Esc anywhere returns focus to it.
 * FC3 — ?thread=<rootId> opens the right-side thread panel (its own
 * resizable pane, key factory.chat.threadPaneWidth): windowed replies,
 * optimistic reply send, follow/unfollow toggle, and the read cursor now
 * advances over thread replies too while the panel is open. Esc closes the
 * panel first, then returns focus to the rail.
 * FC4 — the affordance wiring: optimistic reaction toggles (FC1 routes),
 * presence (GET seed + ephemeral chat.presence payloads), the per-space
 * typing set (ephemeral chat.typing + 4s prune tick + ≤1/2s publish
 * throttle), and the bell menu's notifyLevel POST.
 */
"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Input, Button } from "@/design-system/primitives";
import { Modal, useToast } from "@/design-system/components";
import { PaneHandle } from "@/components/PaneHandle";
import { useResizablePanes, type PaneDef } from "@/components/useResizablePanes";
import { apiJson } from "@/lib/api-client";
import { useAuth, usePermission } from "@/lib/auth/client";
import { useFactoryEvents, useFactoryEventData } from "@/lib/use-factory-events";
import {
  chatUrl,
  foldPresence,
  mergeNewestWindow,
  shouldPublishTyping,
  sortSpacesByActivity,
  toggleReaction,
  typingPrune,
  typingUpsert,
  type FollowedThread,
  type SpaceMember,
  type StreamMessage,
  type Typist,
} from "@/lib/chat/ui";
import { SpaceRail } from "./SpaceRail";
import { SpaceView } from "./SpaceView";
import { ThreadPanel } from "./ThreadPanel";
import type { ApiMessage, MessagesResponse, SpaceItem, SpacesResponse, ThreadResponse } from "./types";

const PANES_KEY = "factory.chat.paneWidths";
const PANE_DEFS: PaneDef[] = [{ min: 240, max: 520, defaultSize: 300 }]; // the left rail
// FC3 — the thread panel: its own instance + key so FC2's saved rail width
// survives untouched (the inbox lesson: resizable, persisted). invert: the
// handle sits on the panel's LEADING edge — dragging left grows it.
const THREAD_PANES_KEY = "factory.chat.threadPaneWidth";
const THREAD_PANE_DEFS: PaneDef[] = [{ min: 280, max: 560, defaultSize: 340, invert: true }];
const WINDOW_TAKE = 100;

const toStream = (m: ApiMessage): StreamMessage => ({
  id: m.id,
  authorId: m.authorId,
  authorName: m.author?.displayName ?? null,
  kind: m.kind,
  body: m.body,
  moneyCents: m.moneyCents,
  moneyLabel: m.moneyLabel,
  meta: m.meta,
  editedAt: m.editedAt,
  deletedAt: m.deletedAt,
  createdAt: m.createdAt,
  thread: m.thread ?? null,
  reactions: m.reactions ?? [], // FC4 — pills render these
});

type ThreadState = {
  rootId: string;
  root: StreamMessage | null;
  replies: StreamMessage[];
  replyCount: number;
  following: boolean;
  hasEarlier: boolean;
};

function ChatInner() {
  const params = useSearchParams();
  const { toast } = useToast();
  const { user } = useAuth();
  const canCreate = usePermission("chat.spaces.create");
  const canPost = usePermission("chat.post");

  const spaceId = params.get("space");
  const spaceIdRef = useRef(spaceId);
  spaceIdRef.current = spaceId;
  const threadId = spaceId ? params.get("thread") : null; // a thread is meaningless without its space
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  const [spaces, setSpaces] = useState<SpaceItem[] | null>(null);
  const [followedThreads, setFollowedThreads] = useState<FollowedThread[]>([]);
  const [spacesError, setSpacesError] = useState<string | null>(null);
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [notMember, setNotMember] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);

  // FC3 — the open thread panel
  const [thread, setThread] = useState<ThreadState | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [loadingEarlierReplies, setLoadingEarlierReplies] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);

  const railRef = useRef<HTMLDivElement>(null);
  const panes = useResizablePanes(PANES_KEY, PANE_DEFS);
  const threadPanes = useResizablePanes(THREAD_PANES_KEY, THREAD_PANE_DEFS);

  // ── URL law (quotes/orders pattern) ────────────────────────────
  const open = useCallback((id: string | null, rootId?: string | null) => {
    window.history.replaceState(null, "", chatUrl(id, rootId ?? null));
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  // ── rail ───────────────────────────────────────────────────────
  const loadSpaces = useCallback(async () => {
    try {
      const d = await apiJson<SpacesResponse>("/api/chat/spaces");
      setSpaces(sortSpacesByActivity(d.items));
      setFollowedThreads(d.threads ?? []);
      setSpacesError(null);
    } catch (e) {
      setSpacesError((e as Error).message || "Couldn't load spaces");
    }
  }, []);
  useEffect(() => {
    void loadSpaces();
  }, [loadSpaces]);

  // ── the open space's message window ────────────────────────────
  const loadNewest = useCallback(async (id: string, quiet: boolean) => {
    if (!quiet) setMessagesLoading(true);
    try {
      const d = await apiJson<MessagesResponse>(`/api/chat/spaces/${id}/messages?take=${WINDOW_TAKE}`);
      if (spaceIdRef.current !== id) return; // the user moved on mid-flight
      const window = d.items.map(toStream).reverse(); // newest-first → ascending
      setNotMember(false);
      setMembers(d.members ?? []);
      setMessages((prev) => (quiet ? mergeNewestWindow(prev, window) : window));
      if (!quiet) setHasEarlier(d.items.length === WINDOW_TAKE);
    } catch (e) {
      if (spaceIdRef.current !== id) return;
      const msg = (e as Error).message;
      if (/not a member/i.test(msg)) setNotMember(true);
      else toast(msg, "danger");
    } finally {
      if (spaceIdRef.current === id) setMessagesLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    setMessages([]);
    setMembers([]);
    setHasEarlier(false);
    setNotMember(false);
    if (spaceId) void loadNewest(spaceId, false);
  }, [spaceId, loadNewest]);

  const loadEarlier = useCallback(async () => {
    const id = spaceIdRef.current;
    const oldest = messages.find((m) => !m.pending);
    if (!id || !oldest || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const d = await apiJson<MessagesResponse>(`/api/chat/spaces/${id}/messages?before=${oldest.id}&take=${WINDOW_TAKE}`);
      if (spaceIdRef.current !== id) return;
      const page = d.items.map(toStream).reverse();
      setMessages((prev) => {
        const known = new Set(prev.map((m) => m.id));
        return [...page.filter((m) => !known.has(m.id)), ...prev];
      });
      setHasEarlier(d.items.length === WINDOW_TAKE);
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setLoadingEarlier(false);
    }
  }, [messages, loadingEarlier, toast]);

  // ── FC3: the open thread's reply window ────────────────────────
  const loadThread = useCallback(
    async (sid: string, rootId: string, quiet: boolean) => {
      if (!quiet) setThreadLoading(true);
      try {
        const d = await apiJson<ThreadResponse>(`/api/chat/spaces/${sid}/threads/${rootId}?take=${WINDOW_TAKE}`);
        if (spaceIdRef.current !== sid || threadIdRef.current !== rootId) return;
        const window = d.items.map(toStream).reverse();
        setThread((prev) => ({
          rootId,
          root: toStream(d.root),
          replies: quiet && prev?.rootId === rootId ? mergeNewestWindow(prev.replies, window) : window,
          replyCount: d.replyCount,
          following: d.following,
          hasEarlier: quiet && prev?.rootId === rootId ? prev.hasEarlier : d.items.length === WINDOW_TAKE,
        }));
      } catch (e) {
        if (spaceIdRef.current !== sid || threadIdRef.current !== rootId) return;
        const msg = (e as Error).message;
        if (/not a member/i.test(msg)) return; // the space view already explains
        toast(msg, "danger");
        open(sid, null); // dead deep link — close the panel, keep the space
      } finally {
        if (threadIdRef.current === rootId) setThreadLoading(false);
      }
    },
    [toast, open],
  );

  useEffect(() => {
    setThread(null);
    if (spaceId && threadId) void loadThread(spaceId, threadId, false);
  }, [spaceId, threadId, loadThread]);

  const loadEarlierReplies = useCallback(async () => {
    const sid = spaceIdRef.current;
    const rootId = threadIdRef.current;
    const oldest = thread?.replies.find((m) => !m.pending);
    if (!sid || !rootId || !oldest || loadingEarlierReplies) return;
    setLoadingEarlierReplies(true);
    try {
      const d = await apiJson<ThreadResponse>(`/api/chat/spaces/${sid}/threads/${rootId}?before=${oldest.id}&take=${WINDOW_TAKE}`);
      if (threadIdRef.current !== rootId) return;
      const page = d.items.map(toStream).reverse();
      setThread((prev) => {
        if (!prev || prev.rootId !== rootId) return prev;
        const known = new Set(prev.replies.map((m) => m.id));
        return {
          ...prev,
          replies: [...page.filter((m) => !known.has(m.id)), ...prev.replies],
          hasEarlier: d.items.length === WINDOW_TAKE,
        };
      });
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setLoadingEarlierReplies(false);
    }
  }, [thread, loadingEarlierReplies, toast]);

  // ── live: chat events refetch the rail + the open window(s) ────
  useFactoryEvents(
    ["chat.message", "chat.space"],
    () => {
      void loadSpaces();
      const id = spaceIdRef.current;
      if (id) void loadNewest(id, true);
      const rootId = threadIdRef.current;
      if (id && rootId) void loadThread(id, rootId, true);
    },
    { debounceMs: 1000 },
  );

  // ── FC4: presence — GET seed, then ephemeral chat.presence payloads ──
  const [online, setOnline] = useState<string[]>([]);
  const loadPresence = useCallback(async () => {
    try {
      const d = await apiJson<{ online: string[] }>("/api/chat/presence");
      setOnline(d.online);
    } catch {
      /* presence is decorative — never toast over it */
    }
  }, []);
  useEffect(() => {
    void loadPresence();
  }, [loadPresence]);
  useFactoryEventData(["chat.presence"], (e) => {
    if (e.type === "chat.presence") {
      setOnline((prev) => foldPresence(prev, e.payload));
      void loadSpaces(); // the rail's onlineOthers dots are server-computed
    } else {
      void loadPresence(); // resync — re-seed the snapshot
    }
  });
  const onlineIds = useMemo<ReadonlySet<string>>(() => new Set(online), [online]);

  // ── FC4: typing — ephemeral chat.typing in, 4s prune tick, ≤1/2s publish out ──
  const [typists, setTypists] = useState<Typist[]>([]);
  useEffect(() => {
    setTypists([]); // a new space starts quiet
  }, [spaceId]);
  useFactoryEventData(["chat.typing"], (e) => {
    if (e.type !== "chat.typing") return;
    const p = e.payload as { spaceId?: string; userId?: string; name?: string } | undefined;
    if (!p?.spaceId || !p.userId || p.spaceId !== spaceIdRef.current) return;
    if (p.userId === user?.id) return; // own echo
    setTypists((prev) => typingUpsert(prev, { userId: p.userId!, name: p.name ?? "Someone" }, Date.now()));
  });
  const anyTyping = typists.length > 0;
  useEffect(() => {
    if (!anyTyping) return;
    const t = setInterval(() => setTypists((prev) => typingPrune(prev, Date.now())), 1000);
    return () => clearInterval(t);
  }, [anyTyping]);

  const typingSentAt = useRef(0);
  const publishTyping = useCallback(() => {
    const id = spaceIdRef.current;
    const now = Date.now();
    if (!id || !shouldPublishTyping(typingSentAt.current, now)) return;
    typingSentAt.current = now;
    void apiJson(`/api/chat/spaces/${id}/typing`, { method: "POST" }).catch(() => {
      typingSentAt.current = 0; // let the next keystroke retry
    });
  }, []);

  // ── read cursor: on open + when a new message becomes visible ──
  // FC3 — with the panel open the cursor follows thread replies too (the
  // newest thing the reader can actually see, by timestamp).
  const activeSpace = useMemo(() => spaces?.find((s) => s.id === spaceId), [spaces, spaceId]);
  const newestRealId = useMemo(() => {
    let best: StreamMessage | null = null;
    for (const list of [messages, thread?.replies ?? []]) {
      for (const m of list) {
        if (m.pending) continue;
        if (!best || new Date(m.createdAt).getTime() > new Date(best.createdAt).getTime()) best = m;
      }
    }
    return best?.id ?? null;
  }, [messages, thread]);
  const postedRead = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!spaceId || !newestRealId || notMember) return;
    const post = () => {
      if (document.visibilityState !== "visible") return;
      if (postedRead.current[spaceId] === newestRealId) return;
      postedRead.current[spaceId] = newestRealId;
      apiJson(`/api/chat/spaces/${spaceId}/read`, { method: "POST", body: JSON.stringify({ messageId: newestRealId }) })
        .then(() => void loadSpaces()) // the unread badge clears from the rail fetch
        .catch(() => {
          delete postedRead.current[spaceId];
        });
    };
    post();
    document.addEventListener("visibilitychange", post);
    return () => document.removeEventListener("visibilitychange", post);
  }, [spaceId, newestRealId, notMember, loadSpaces]);

  // ── composer actions (optimistic append + reconcile) ───────────
  const send = useCallback(
    async (body: string): Promise<boolean> => {
      const id = spaceIdRef.current;
      if (!id || !user) return false;
      const temp: StreamMessage = {
        id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        authorId: user.id,
        authorName: user.displayName,
        kind: "MESSAGE",
        body,
        createdAt: new Date().toISOString(),
        pending: true,
      };
      setMessages((prev) => [...prev, temp]);
      try {
        const d = await apiJson<{ message: { id: string } }>(`/api/chat/spaces/${id}/messages`, {
          method: "POST",
          body: JSON.stringify({ body }),
        });
        setMessages((prev) => prev.map((m) => (m.id === temp.id ? { ...m, id: d.message.id, pending: false } : m)));
        void loadNewest(id, true); // reconcile the server truth (timestamps, mentions)
        void loadSpaces();
        return true;
      } catch (e) {
        setMessages((prev) => prev.filter((m) => m.id !== temp.id));
        toast((e as Error).message, "danger");
        return false;
      }
    },
    [user, loadNewest, loadSpaces, toast],
  );

  // FC3 — reply into the open thread (optimistic, replying auto-follows server-side)
  const sendReply = useCallback(
    async (body: string): Promise<boolean> => {
      const id = spaceIdRef.current;
      const rootId = threadIdRef.current;
      if (!id || !rootId || !user) return false;
      const temp: StreamMessage = {
        id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        authorId: user.id,
        authorName: user.displayName,
        kind: "MESSAGE",
        body,
        createdAt: new Date().toISOString(),
        pending: true,
      };
      setThread((prev) => (prev && prev.rootId === rootId ? { ...prev, replies: [...prev.replies, temp] } : prev));
      try {
        const d = await apiJson<{ message: { id: string } }>(`/api/chat/spaces/${id}/messages`, {
          method: "POST",
          body: JSON.stringify({ body, threadRootId: rootId }),
        });
        setThread((prev) =>
          prev && prev.rootId === rootId
            ? {
                ...prev,
                replies: prev.replies.map((m) => (m.id === temp.id ? { ...m, id: d.message.id, pending: false } : m)),
                following: true, // replying auto-follows (the Google rule)
              }
            : prev,
        );
        void loadThread(id, rootId, true); // reconcile server truth
        void loadNewest(id, true); // the root's thread bar (count/facepile) lives here
        void loadSpaces();
        return true;
      } catch (e) {
        setThread((prev) => (prev && prev.rootId === rootId ? { ...prev, replies: prev.replies.filter((m) => m.id !== temp.id) } : prev));
        toast((e as Error).message, "danger");
        return false;
      }
    },
    [user, loadThread, loadNewest, loadSpaces, toast],
  );

  const refetchOpenWindows = useCallback(() => {
    const id = spaceIdRef.current;
    if (id) void loadNewest(id, true);
    const rootId = threadIdRef.current;
    if (id && rootId) void loadThread(id, rootId, true);
  }, [loadNewest, loadThread]);

  const edit = useCallback(
    async (messageId: string, body: string): Promise<boolean> => {
      try {
        await apiJson(`/api/chat/messages/${messageId}`, { method: "PATCH", body: JSON.stringify({ body }) });
        refetchOpenWindows();
        return true;
      } catch (e) {
        toast((e as Error).message, "danger");
        return false;
      }
    },
    [refetchOpenWindows, toast],
  );

  const remove = useCallback(
    async (messageId: string): Promise<void> => {
      try {
        await apiJson(`/api/chat/messages/${messageId}`, { method: "DELETE" });
        toast("Deleted — a tombstone stays, the audit log keeps the original", "info");
        refetchOpenWindows();
      } catch (e) {
        toast((e as Error).message, "danger");
      }
    },
    [refetchOpenWindows, toast],
  );

  // FC4 — optimistic reaction toggle (main stream + thread root + replies);
  // the server's chat.message event reconciles everyone else, an error
  // reverts via refetch.
  const toggleReactionOn = useCallback(
    async (messageId: string, emoji: string) => {
      const me = user?.id;
      if (!me) return;
      const current =
        messages.find((m) => m.id === messageId) ??
        (thread?.root?.id === messageId ? thread.root : undefined) ??
        thread?.replies.find((m) => m.id === messageId);
      if (!current || current.pending) return;
      const { next, added } = toggleReaction(current.reactions, me, emoji);
      const patch = (m: StreamMessage) => (m.id === messageId ? { ...m, reactions: next } : m);
      setMessages((prev) => prev.map(patch));
      setThread((prev) =>
        prev ? { ...prev, root: prev.root ? patch(prev.root) : prev.root, replies: prev.replies.map(patch) } : prev,
      );
      try {
        if (added) {
          await apiJson(`/api/chat/messages/${messageId}/reactions`, { method: "POST", body: JSON.stringify({ emoji }) });
        } else {
          await apiJson(`/api/chat/messages/${messageId}/reactions?emoji=${encodeURIComponent(emoji)}`, { method: "DELETE" });
        }
      } catch (e) {
        toast((e as Error).message, "danger");
        refetchOpenWindows(); // revert to server truth
      }
    },
    [messages, thread, user, toast, refetchOpenWindows],
  );

  // FC4 — the bell menu: my notification level for the open space
  const setNotifyLevel = useCallback(
    async (level: "ALL" | "MENTIONS" | "OFF") => {
      const id = spaceIdRef.current;
      if (!id) return;
      try {
        await apiJson(`/api/chat/spaces/${id}/notify`, { method: "POST", body: JSON.stringify({ level }) });
        toast(
          level === "ALL"
            ? "Notifications: all activity in this space"
            : level === "MENTIONS"
              ? "Notifications: only @mentions in this space"
              : "Notifications off for this space",
          "success",
        );
        void loadSpaces(); // notifyLevel rides the spaces payload
      } catch (e) {
        toast((e as Error).message, "danger");
      }
    },
    [loadSpaces, toast],
  );

  // FC3 — follow/unfollow the open thread
  const toggleFollow = useCallback(async () => {
    const id = spaceIdRef.current;
    const rootId = threadIdRef.current;
    if (!id || !rootId || !thread || followBusy) return;
    setFollowBusy(true);
    try {
      const d = await apiJson<{ following: boolean }>(`/api/chat/spaces/${id}/threads/${rootId}`, {
        method: thread.following ? "DELETE" : "POST",
      });
      setThread((prev) => (prev && prev.rootId === rootId ? { ...prev, following: d.following } : prev));
      void loadSpaces(); // the rail's Threads section follows the follow list
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setFollowBusy(false);
    }
  }, [thread, followBusy, loadSpaces, toast]);

  // ── CUSTOM space creation (chat.spaces.create) ─────────────────
  const create = async () => {
    const name = newName.trim();
    if (!name || createBusy) return;
    setCreateBusy(true);
    try {
      const d = await apiJson<{ space: { id: string } }>("/api/chat/spaces", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setCreating(false);
      setNewName("");
      toast("Space created — you're its manager", "success");
      await loadSpaces();
      open(d.space.id);
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setCreateBusy(false);
    }
  };

  const copyLink = useCallback(() => {
    if (!spaceIdRef.current) return;
    void navigator.clipboard
      ?.writeText(`${window.location.origin}${chatUrl(spaceIdRef.current, threadIdRef.current)}`)
      .then(() => toast("Link copied", "success"))
      .catch(() => toast("Couldn't copy — the address bar has the same link", "warning"));
  }, [toast]);

  const threadOpen = !!(spaceId && threadId) && !notMember;
  const gridColumns = threadOpen
    ? `${panes.widths[0]}px 6px minmax(0, 1fr) 6px ${threadPanes.widths[0]}px`
    : `${panes.widths[0]}px 6px minmax(0, 1fr)`;

  return (
    <div
      className="fc2-chat"
      // Esc: close the thread panel first; otherwise return focus to the rail —
      // unless a consumer already claimed the key (mention popover, inline edit).
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented || creating) return;
        if (threadIdRef.current) open(spaceIdRef.current, null);
        else railRef.current?.focus();
      }}
      style={{
        height: "calc(100dvh - 52px)",
        display: "grid",
        gridTemplateColumns: gridColumns,
        gridTemplateRows: "minmax(0, 1fr)",
        border: "1px solid var(--h10-border)",
        borderRadius: 12,
        background: "var(--h10-surface)",
        overflow: "hidden",
      }}
    >
      <SpaceRail
        railRef={railRef}
        spaces={spaces}
        threads={followedThreads}
        error={spacesError}
        onRetry={() => void loadSpaces()}
        activeId={spaceId}
        onOpen={(id) => open(id)}
        onOpenThread={(sid, rootId) => open(sid, rootId)}
        canCreate={canCreate}
        onCreate={() => setCreating(true)}
      />
      <PaneHandle {...panes.handleProps(0)} label="Resize spaces rail" />
      <SpaceView
        spaceId={spaceId}
        space={activeSpace}
        messages={messages}
        members={members}
        loading={messagesLoading}
        notMember={notMember}
        hasEarlier={hasEarlier}
        loadingEarlier={loadingEarlier}
        onLoadEarlier={() => void loadEarlier()}
        meId={user?.id ?? null}
        canPost={canPost}
        onSend={send}
        onEdit={edit}
        onDelete={remove}
        onCopyLink={copyLink}
        onOpenThread={(rootId) => open(spaceIdRef.current, rootId)}
        onToggleReaction={(messageId, emoji) => void toggleReactionOn(messageId, emoji)}
        onlineIds={onlineIds}
        typists={typists}
        onTyping={publishTyping}
        onSetNotifyLevel={(level) => void setNotifyLevel(level)}
      />
      {threadOpen && (
        <>
          <PaneHandle {...threadPanes.handleProps(0)} label="Resize thread panel" />
          <ThreadPanel
            spaceId={spaceId!}
            rootId={threadId!}
            root={thread?.root ?? null}
            replies={thread?.replies ?? []}
            replyCount={thread?.replyCount ?? 0}
            loading={threadLoading}
            hasEarlier={thread?.hasEarlier ?? false}
            loadingEarlier={loadingEarlierReplies}
            onLoadEarlier={() => void loadEarlierReplies()}
            following={thread?.following ?? false}
            followBusy={followBusy}
            onToggleFollow={() => void toggleFollow()}
            onClose={() => open(spaceIdRef.current, null)}
            meId={user?.id ?? null}
            members={members}
            canPost={canPost}
            onSendReply={sendReply}
            onEdit={edit}
            onDelete={remove}
            onToggleReaction={(messageId, emoji) => void toggleReactionOn(messageId, emoji)}
            onlineIds={onlineIds}
            onTyping={publishTyping}
          />
        </>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New space"
        subtitle="A custom room — order spaces create themselves when an order is born."
        size="sm"
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void create()} disabled={createBusy || !newName.trim()}>
              {createBusy ? "Creating…" : "Create space"}
            </Button>
          </>
        }
      >
        <Input
          value={newName}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewName(e.target.value)}
          placeholder="e.g. Cutting room"
          maxLength={80}
          autoFocus
          onKeyDown={(e: React.KeyboardEvent) => {
            if (e.key === "Enter") void create();
          }}
        />
      </Modal>
    </div>
  );
}

export function ChatClient() {
  return (
    <Suspense fallback={null}>
      <ChatInner />
    </Suspense>
  );
}
