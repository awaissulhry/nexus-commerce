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
import { Download, Image as ImageIcon, Lock, Paperclip, Send, X } from "lucide-react";
import { useToast } from "@/design-system/components";
import { Button, SegmentedControl, Pill, Skeleton } from "@/design-system/primitives";
import { MentionTextarea } from "@/components/MentionTextarea";
import type { SearchLoader } from "@/lib/virtual/async-search";
import { apiFetch, apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { repeatedAttachmentIds } from "@/lib/inbox/attachments";
import { countRemoteImages } from "@/lib/inbox/preview";
import { Lightbox, type LightboxItem } from "./Lightbox";
import { MessageBubble } from "./MessageBubble";
import { EVENT_LABELS, ago, type ThreadResponse } from "./types";

const COMPOSER_H_KEY = "factory.inbox.composerHeight";

// EPI2.4 — @mention autocomplete (FS3 adoption): the user list is tiny, so
// one fetch + client filter; option.value is the email = a resolvable handle.
const mentionLoader: SearchLoader = async (q) => {
  const d = await apiJson<{ users: { id: string; displayName: string; email: string }[] }>("/api/users-lite");
  const needle = q.toLowerCase();
  return {
    options: d.users
      .filter((u) => !needle || u.displayName.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle))
      .map((u) => ({ value: u.email, label: u.displayName, hint: u.email })),
    nextCursor: null,
  };
};

type TimelineEntry =
  | { kind: "message"; at: number; message: ThreadResponse["messages"][number] }
  | { kind: "comment"; at: number; comment: ThreadResponse["comments"][number] }
  | { kind: "event"; at: number; event: ThreadResponse["events"][number] };

export function ThreadPane({
  thread,
  loading,
  onMutated,
  composerRef,
  fileId,
  onFileChange,
}: {
  thread: ThreadResponse | null;
  loading: boolean;
  onMutated: () => void;
  composerRef?: React.RefObject<HTMLTextAreaElement>;
  /** EPI2.2 — ?file= deep link: the lightbox's active attachment */
  fileId?: string | null;
  onFileChange?: (id: string | null) => void;
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
  const [dragging, setDragging] = useState(false); // EPI2.4 — drop-to-attach overlay
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

  // EPI2.2 — the lightbox ring: every attachment in the conversation, in
  // order; EPI2.4 adds comment attachments to the same ring.
  const previewItems = useMemo<LightboxItem[]>(() => {
    const toItem = (a: { id: string; filename: string; mimeType: string | null; sizeBytes: number | null; webViewLink: string | null }) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      webViewLink: a.webViewLink,
    });
    return [
      ...(thread?.messages ?? []).flatMap((m) => m.attachments.map(toItem)),
      ...(thread?.comments ?? []).flatMap((c) => (c.attachments ?? []).map(toItem)),
    ];
  }, [thread]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [timeline.length, conversationId, loading]);

  const submit = async () => {
    if (!conversationId || !text.trim() || busy) return;
    setBusy(true);
    try {
      if (mode === "comment") {
        // EPI2.4 — comments with files go multipart; plain ones stay JSON
        if (files.length > 0) {
          const form = new FormData();
          form.set("entityType", "conversation");
          form.set("entityId", conversationId);
          form.set("body", text.trim());
          form.set("href", `/inbox?focus=${conversationId}`);
          for (const f of files) form.append("files", f);
          const res = await apiFetch("/api/comments", { method: "POST", body: form });
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          if (!res.ok) throw new Error(payload?.error ?? "Note failed");
        } else {
          await apiJson("/api/comments", {
            method: "POST",
            body: JSON.stringify({
              entityType: "conversation",
              entityId: conversationId,
              body: text.trim(),
              href: `/inbox?focus=${conversationId}`,
            }),
          });
        }
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

  // EPI2.1 — the toggle appears only when there are REMOTE images to gate
  // (embedded cid/data images render regardless, Gmail-style).
  const hasHtml = thread.messages.some((m) => m.bodyHtml && countRemoteImages(m.bodyHtml) > 0);
  const modeOptions = [
    ...(canSend ? [{ value: "reply", label: "Reply" }] : []),
    ...(canComment ? [{ value: "comment", label: "Internal comment" }] : []),
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}>
      {fileId && onFileChange && previewItems.some((i) => i.id === fileId) && (
        <Lightbox
          items={previewItems}
          activeId={fileId}
          conversationId={thread.conversation.id}
          onNavigate={onFileChange}
          onClose={() => onFileChange(null)}
        />
      )}
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
              onPreview={onFileChange ? (attId) => onFileChange(attId) : undefined}
            />
          ) : entry.kind === "comment" ? (
            <div
              key={`c-${entry.comment.id}`}
              data-msg={`c-${entry.comment.id}`} // EPI2.4 — Files-panel anchor
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
              {(entry.comment.attachments?.length ?? 0) > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                  {entry.comment.attachments!.map((a) => (
                    <span key={a.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, border: "1px solid var(--h10-border)", borderRadius: 8, padding: "3px 8px", background: "var(--h10-surface)" }}>
                      {onFileChange && countRemoteImages("") === 0 && ( // always true — inline guard keeps TS quiet
                        <button
                          type="button"
                          onClick={() => onFileChange(a.id)}
                          title="Preview"
                          style={{ background: "none", border: "none", cursor: "pointer", padding: 0, font: "inherit", color: "var(--h10-text)", display: "inline-flex", gap: 4, alignItems: "center" }}
                        >
                          <Paperclip size={11} /> {a.filename}
                        </button>
                      )}
                      <a href={`/api/inbox/${thread.conversation.id}/attachments/${a.id}`} title="Download" style={{ display: "inline-flex", color: "var(--h10-text-3)" }}>
                        <Download size={11} />
                      </a>
                    </span>
                  ))}
                </div>
              )}
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
        <div
          style={{ position: "relative", borderTop: "1px solid var(--h10-border)", padding: 12, display: "grid", gap: 8, background: mode === "comment" ? "var(--h10-warning-soft)" : "var(--h10-surface)" }}
          onDragOver={(e) => {
            // EPI2.4 — Gmail's drop-to-attach zone
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
          }}
          onDrop={(e) => {
            if (e.dataTransfer.files.length === 0) return;
            e.preventDefault();
            setDragging(false);
            setFiles((fs) => [...fs, ...Array.from(e.dataTransfer.files)]);
          }}
          onPaste={(e) => {
            // EPI2.4 — GitHub's paste-to-attach
            const pasted = Array.from(e.clipboardData?.files ?? []);
            if (pasted.length === 0) return;
            e.preventDefault();
            setFiles((fs) => [...fs, ...pasted]);
          }}
        >
          {dragging && (
            <div style={{ position: "absolute", inset: 4, zIndex: 5, display: "grid", placeItems: "center", borderRadius: 10, border: "2px dashed var(--h10-primary)", background: "var(--h10-wash-primary)", fontSize: 12.5, fontWeight: 600, color: "var(--h10-primary)", pointerEvents: "none" }}>
              Drop to attach
            </div>
          )}
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
          {mode === "comment" ? (
            // EPI2.4 — FS3 MentionTextarea adoption: typed @ autocompletes teammates
            <MentionTextarea
              value={text}
              onChange={setText}
              loader={mentionLoader}
              textareaRef={composerRef ?? undefined}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="Internal note — the customer never sees this…"
              rows={3}
              ariaLabel="Internal note"
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
          ) : (
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
              placeholder="Reply — sends from your Gmail into this thread…"
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
          )}
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
            {/* EPI2.4 — comments attach too (FP1 deferral closed) */}
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
            <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--h10-text-3)" }}>drop or paste files · ⌘⏎ to send</span>
            <Button variant="primary" onClick={() => void submit()} disabled={busy || !text.trim()}>
              <Send size={13} /> {busy ? "Sending…" : mode === "reply" ? "Send reply" : "Add note"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
