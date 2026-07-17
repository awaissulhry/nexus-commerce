/**
 * FC2 — the /chat workspace container (Google-Chat anatomy on the FS3
 * substrate): resizable rail + space view (useResizablePanes, key
 * factory.chat.paneWidths), ?space= deep links via the house URL law
 * (replaceState + PopStateEvent), live refetch on chat.* SSE events
 * (debounce 1000), read cursor POSTed on space open and on new-message
 * visibility, windowed message paging accumulated here, CUSTOM space
 * creation behind chat.spaces.create. Keyboard: j/k or ↑/↓ move the rail
 * selection while the rail is focused; Esc anywhere returns focus to it.
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
import { useFactoryEvents } from "@/lib/use-factory-events";
import { chatUrl, mergeNewestWindow, sortSpacesByActivity, type StreamMessage } from "@/lib/chat/ui";
import { SpaceRail } from "./SpaceRail";
import { SpaceView } from "./SpaceView";
import type { ApiMessage, MessagesResponse, SpaceItem, SpacesResponse } from "./types";

const PANES_KEY = "factory.chat.paneWidths";
const PANE_DEFS: PaneDef[] = [{ min: 240, max: 520, defaultSize: 300 }]; // the left rail
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
});

function ChatInner() {
  const params = useSearchParams();
  const { toast } = useToast();
  const { user } = useAuth();
  const canCreate = usePermission("chat.spaces.create");
  const canPost = usePermission("chat.post");

  const spaceId = params.get("space");
  const spaceIdRef = useRef(spaceId);
  spaceIdRef.current = spaceId;

  const [spaces, setSpaces] = useState<SpaceItem[] | null>(null);
  const [spacesError, setSpacesError] = useState<string | null>(null);
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [notMember, setNotMember] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);

  const railRef = useRef<HTMLDivElement>(null);
  const panes = useResizablePanes(PANES_KEY, PANE_DEFS);

  // ── rail ───────────────────────────────────────────────────────
  const loadSpaces = useCallback(async () => {
    try {
      const d = await apiJson<SpacesResponse>("/api/chat/spaces");
      setSpaces(sortSpacesByActivity(d.items));
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

  // ── live: chat events refetch the rail + the open window ───────
  useFactoryEvents(
    ["chat.message", "chat.space"],
    () => {
      void loadSpaces();
      const id = spaceIdRef.current;
      if (id) void loadNewest(id, true);
    },
    { debounceMs: 1000 },
  );

  // ── read cursor: on open + when a new message becomes visible ──
  const activeSpace = useMemo(() => spaces?.find((s) => s.id === spaceId), [spaces, spaceId]);
  const newestRealId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (!messages[i].pending) return messages[i].id;
    return null;
  }, [messages]);
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

  // ── URL law (quotes/orders pattern) ────────────────────────────
  const open = useCallback((id: string | null) => {
    window.history.replaceState(null, "", chatUrl(id));
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

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

  const edit = useCallback(
    async (messageId: string, body: string): Promise<boolean> => {
      const id = spaceIdRef.current;
      try {
        await apiJson(`/api/chat/messages/${messageId}`, { method: "PATCH", body: JSON.stringify({ body }) });
        if (id) void loadNewest(id, true);
        return true;
      } catch (e) {
        toast((e as Error).message, "danger");
        return false;
      }
    },
    [loadNewest, toast],
  );

  const remove = useCallback(
    async (messageId: string): Promise<void> => {
      const id = spaceIdRef.current;
      try {
        await apiJson(`/api/chat/messages/${messageId}`, { method: "DELETE" });
        toast("Deleted — a tombstone stays, the audit log keeps the original", "info");
        if (id) void loadNewest(id, true);
      } catch (e) {
        toast((e as Error).message, "danger");
      }
    },
    [loadNewest, toast],
  );

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
      ?.writeText(`${window.location.origin}${chatUrl(spaceIdRef.current)}`)
      .then(() => toast("Space link copied", "success"))
      .catch(() => toast("Couldn't copy — the address bar has the same link", "warning"));
  }, [toast]);

  return (
    <div
      className="fc2-chat"
      // Esc returns focus to the rail — unless a consumer already claimed the
      // key (the mention popover preventDefaults its Escape).
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented && !creating) railRef.current?.focus();
      }}
      style={{
        height: "calc(100dvh - 52px)",
        display: "grid",
        gridTemplateColumns: `${panes.widths[0]}px 6px minmax(0, 1fr)`,
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
        error={spacesError}
        onRetry={() => void loadSpaces()}
        activeId={spaceId}
        onOpen={(id) => open(id)}
        canCreate={canCreate}
        onCreate={() => setCreating(true)}
      />
      <PaneHandle {...panes.handleProps(0)} label="Resize spaces rail" />
      <SpaceView
        spaceId={spaceId}
        space={activeSpace}
        messages={messages}
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
      />

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
