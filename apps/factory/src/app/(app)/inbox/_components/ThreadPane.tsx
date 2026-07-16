/**
 * FP1.3 → EPI1.3 — the thread pane: ONE timeline (Odoo-chatter verdict)
 * merging messages, amber internal comments and audit events chronologically,
 * with the Reply|Comment composer at the bottom (Missive's unmistakable-
 * distinction rule) and the per-conversation remote-images toggle.
 * EPI1.3: composer modes are permission-gated client-side (mirroring the
 * server guards), forwarded attachment chips dedupe, the header never wraps,
 * and the composer height persists per browser.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Image as ImageIcon, Lock, Paperclip, Send, X } from "lucide-react";
import { useToast } from "@/design-system/components";
import { Button, SegmentedControl, Pill, Skeleton } from "@/design-system/primitives";
import { apiFetch, apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { repeatedAttachmentIds } from "@/lib/inbox/attachments";
import { MessageBubble } from "./MessageBubble";
import { EVENT_LABELS, ago, type ThreadResponse } from "./types";

const COMPOSER_H_KEY = "factory.inbox.composerHeight";

type TimelineEntry =
  | { kind: "message"; at: number; message: ThreadResponse["messages"][number] }
  | { kind: "comment"; at: number; comment: ThreadResponse["comments"][number] }
  | { kind: "event"; at: number; event: ThreadResponse["events"][number] };

export function ThreadPane({
  thread,
  loading,
  onMutated,
  composerRef,
}: {
  thread: ThreadResponse | null;
  loading: boolean;
  onMutated: () => void;
  composerRef?: React.RefObject<HTMLTextAreaElement>;
}) {
  const { toast } = useToast();
  const canSend = usePermission("inbox.send");
  const canComment = usePermission("comments.create");
  const [mode, setMode] = useState<"reply" | "comment">("reply");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [allowImages, setAllowImages] = useState(false);
  const [composerH, setComposerH] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const conversationId = thread?.conversation.id;
  useEffect(() => {
    setAllowImages(false);
    setText("");
    setFiles([]);
    setMode(canSend ? "reply" : "comment");
  }, [conversationId, canSend]);

  // EPI1.4 — the composer keeps the height you drag it to (native resize
  // handle; we just remember the result per browser).
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(COMPOSER_H_KEY));
      if (Number.isFinite(saved) && saved >= 60 && saved <= 600) setComposerH(saved);
    } catch {
      /* default rows stand */
    }
  }, []);
  const persistComposerH = (el: HTMLTextAreaElement) => {
    const h = el.offsetHeight;
    if (h >= 60 && h <= 600 && h !== composerH) {
      setComposerH(h);
      try {
        localStorage.setItem(COMPOSER_H_KEY, String(h));
      } catch {
        /* session-only */
      }
    }
  };

  const timeline = useMemo<TimelineEntry[]>(() => {
    if (!thread) return [];
    const entries: TimelineEntry[] = [
      ...thread.messages.map((m) => ({ kind: "message" as const, at: new Date(m.sentAt).getTime(), message: m })),
      ...thread.comments.map((c) => ({ kind: "comment" as const, at: new Date(c.createdAt).getTime(), comment: c })),
      ...thread.events
        .filter((e) => e.action !== "comment.created" && e.action !== "replied")
        .map((e) => ({ kind: "event" as const, at: new Date(e.createdAt).getTime(), event: e })),
    ];
    return entries.sort((a, b) => a.at - b.at);
  }, [thread]);

  // EPI1.3 (D6) — chips repeated from an earlier message collapse per bubble
  const repeatedIds = useMemo(() => repeatedAttachmentIds(thread?.messages ?? []), [thread]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [timeline.length, conversationId, loading]);

  const submit = async () => {
    if (!conversationId || !text.trim() || busy) return;
    setBusy(true);
    try {
      if (mode === "comment") {
        await apiJson("/api/comments", {
          method: "POST",
          body: JSON.stringify({
            entityType: "conversation",
            entityId: conversationId,
            body: text.trim(),
            href: `/inbox?focus=${conversationId}`,
          }),
        });
      } else {
        const form = new FormData();
        form.set("body", text.trim());
        for (const f of files) form.append("files", f);
        const res = await apiFetch(`/api/inbox/${conversationId}/reply`, { method: "POST", body: form });
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) throw new Error(payload?.error ?? "Send failed");
        toast("Sent — it threads in Gmail too", "success");
      }
      setText("");
      setFiles([]);
      onMutated();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  if (loading && !thread) {
    return (
      <div style={{ padding: 20, display: "grid", gap: 12 }}>
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </div>
    );
  }
  if (!thread) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--h10-text-3)", fontSize: 13 }}>
        Select a conversation — j/k to move, Enter to open.
      </div>
    );
  }

  const hasHtml = thread.messages.some((m) => m.bodyHtml && /<img/i.test(m.bodyHtml));
  const modeOptions = [
    ...(canSend ? [{ value: "reply", label: "Reply" }] : []),
    ...(canComment ? [{ value: "comment", label: "Internal comment" }] : []),
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          padding: "10px 16px",
          borderBottom: "1px solid var(--h10-border-subtle)",
        }}
      >
        <div
          title={thread.conversation.subject ?? undefined}
          style={{ fontSize: 14.5, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}
        >
          {thread.conversation.subject ?? "(no subject)"}
        </div>
        <Pill tone={thread.conversation.state === "OPEN" ? "info" : thread.conversation.state === "SNOOZED" ? "warning" : "neutral"}>
          {thread.conversation.state}
        </Pill>
        {hasHtml && (
          <button
            type="button"
            onClick={() => setAllowImages((v) => !v)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              flexShrink: 0,
              whiteSpace: "nowrap",
              background: "none",
              border: "1px solid var(--h10-border)",
              borderRadius: 8,
              padding: "4px 9px",
              fontSize: 11.5,
              cursor: "pointer",
              color: allowImages ? "var(--h10-primary)" : "var(--h10-text-2)",
            }}
          >
            <ImageIcon size={13} />
            {allowImages ? "Images loaded" : "Load remote images"}
          </button>
        )}
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 16, display: "grid", gap: 10, alignContent: "start" }}>
        {timeline.map((entry) =>
          entry.kind === "message" ? (
            <MessageBubble
              key={`m-${entry.message.id}`}
              message={entry.message}
              conversationId={thread.conversation.id}
              allowImages={allowImages}
              repeatedIds={repeatedIds}
            />
          ) : entry.kind === "comment" ? (
            <div
              key={`c-${entry.comment.id}`}
              style={{
                border: "1px solid var(--h10-warning-soft)",
                background: "var(--h10-warning-soft)",
                borderRadius: 12,
                padding: "8px 12px",
                fontSize: 12.5,
              }}
            >
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 3, color: "var(--h10-amber-text, #9a6700)" }}>
                <Lock size={11} />
                <b>{entry.comment.author?.displayName ?? "Internal"}</b>
                <span style={{ fontSize: 11.5 }}>Internal — never sent</span>
                <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--h10-text-3)" }}>{ago(entry.comment.createdAt)} ago</span>
              </div>
              <div style={{ whiteSpace: "pre-wrap" }}>{entry.comment.body}</div>
            </div>
          ) : (
            <div key={`e-${entry.event.id}`} style={{ textAlign: "center", fontSize: 11.5, color: "var(--h10-text-3)" }}>
              {entry.event.actor?.displayName ?? "System"} {EVENT_LABELS[entry.event.action] ?? entry.event.action} · {ago(entry.event.createdAt)} ago
            </div>
          ),
        )}
      </div>

      {modeOptions.length === 0 ? (
        <div style={{ borderTop: "1px solid var(--h10-border)", padding: 12, fontSize: 12.5, color: "var(--h10-text-3)" }}>
          Your role can read this thread but not reply or comment.
        </div>
      ) : (
        <div style={{ borderTop: "1px solid var(--h10-border)", padding: 12, display: "grid", gap: 8, background: mode === "comment" ? "var(--h10-warning-soft)" : "var(--h10-surface)" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <SegmentedControl
              options={modeOptions}
              value={mode}
              onChange={(v: string) => setMode(v as "reply" | "comment")}
            />
            {mode === "comment" && (
              <span style={{ fontSize: 11.5, color: "var(--h10-amber-text, #9a6700)" }}>
                Amber = internal. @mention a teammate to notify them.
              </span>
            )}
          </div>
          <textarea
            ref={composerRef ?? undefined}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPointerUp={(e) => persistComposerH(e.currentTarget)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={mode === "reply" ? "Reply — sends from your Gmail into this thread…" : "Internal note — the customer never sees this…"}
            rows={3}
            style={{
              width: "100%",
              resize: "vertical",
              ...(composerH ? { height: composerH } : {}),
              border: "1px solid var(--h10-border)",
              borderRadius: 8,
              padding: 10,
              font: "13px var(--font-sans), sans-serif",
              background: "var(--h10-surface)",
              color: "var(--h10-text)",
            }}
          />
          {files.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {files.map((f, i) => (
                <span key={`${f.name}-${i}`} style={{ fontSize: 11.5, border: "1px solid var(--h10-border)", borderRadius: 8, padding: "3px 8px", display: "inline-flex", gap: 5, alignItems: "center" }}>
                  <Paperclip size={11} /> {f.name}
                  <button type="button" onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "inline-flex" }}>
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {mode === "reply" && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => setFiles((fs) => [...fs, ...Array.from(e.target.files ?? [])])}
                />
                <Button onClick={() => fileInputRef.current?.click()}>
                  <Paperclip size={13} /> Attach
                </Button>
              </>
            )}
            <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--h10-text-3)" }}>⌘⏎ to send</span>
            <Button variant="primary" onClick={() => void submit()} disabled={busy || !text.trim()}>
              <Send size={13} /> {busy ? "Sending…" : mode === "reply" ? "Send reply" : "Add note"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
