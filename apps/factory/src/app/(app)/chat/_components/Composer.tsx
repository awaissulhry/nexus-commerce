/**
 * FC2 — the composer: FS3 MentionTextarea over the paged /api/users-lite?q=
 * loader (picking inserts the @handle the server's resolveMentions matches —
 * mention notifications keep working with zero client logic). Enter sends,
 * Shift+Enter newlines; the mention popover consumes its own keys first.
 * Posting is chat.post-gated — a read-only role sees an honest line instead.
 */
"use client";

import { useCallback, useRef, useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/design-system/primitives";
import { MentionTextarea } from "@/components/MentionTextarea";
import type { SearchLoader } from "@/lib/virtual/async-search";
import { apiJson } from "@/lib/api-client";

export function Composer({
  composerKey,
  canPost,
  onSend,
  placeholder = "Message the space — @ to mention…",
}: {
  /** draft scope — a new key starts a fresh draft (space id, or space+thread in the FC3 panel) */
  composerKey: string;
  canPost: boolean;
  onSend: (body: string) => Promise<boolean>;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // FS3 lite-search grammar; a role without the users-lite permission just
  // gets an empty popover — never a broken composer.
  const loader = useCallback<SearchLoader>(async (q, cursor) => {
    try {
      const usp = new URLSearchParams({ q });
      if (cursor) usp.set("cursor", cursor);
      const d = await apiJson<{ users: { id: string; displayName: string }[]; nextCursor: string | null }>(
        `/api/users-lite?${usp}`,
      );
      return { options: d.users.map((u) => ({ value: u.id, label: u.displayName })), nextCursor: d.nextCursor };
    } catch {
      return { options: [], nextCursor: null };
    }
  }, []);

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setText("");
    const ok = await onSend(body);
    setBusy(false);
    if (!ok) setText(body); // give the words back on failure
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  if (!canPost) {
    return (
      <div style={{ borderTop: "1px solid var(--h10-border)", padding: 12, fontSize: 12.5, color: "var(--h10-text-3)" }}>
        Your role can read this space but not post.
      </div>
    );
  }

  return (
    <div style={{ borderTop: "1px solid var(--h10-border)", padding: 12, display: "grid", gap: 8 }}>
      <MentionTextarea
        key={composerKey} /* a fresh space (or thread) starts a fresh draft */
        value={text}
        onChange={setText}
        loader={loader}
        rows={2}
        placeholder={placeholder}
        ariaLabel="Message"
        textareaRef={(el) => {
          textareaRef.current = el;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
        style={{
          width: "100%",
          resize: "vertical",
          border: "1px solid var(--h10-border)",
          borderRadius: 8,
          padding: 10,
          font: "13px var(--font-sans), sans-serif",
          background: "var(--h10-surface)",
          color: "var(--h10-text)",
        }}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>Enter sends · Shift+Enter for a new line</span>
        <span style={{ marginLeft: "auto" }}>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !text.trim()}>
            <Send size={13} /> {busy ? "Sending…" : "Send"}
          </Button>
        </span>
      </div>
    </div>
  );
}
