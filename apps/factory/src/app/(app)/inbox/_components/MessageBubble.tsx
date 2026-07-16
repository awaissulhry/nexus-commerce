/**
 * FP1.3 → EPI1.3 — one email message. Sanitized-at-write HTML renders inside
 * a sandboxed iframe (no allow-scripts) whose CSP blocks remote images until
 * the user opts in per conversation — layer 2+3 of the security boundary
 * (layer 1 is src/lib/sanitize-email.ts). Height auto-fits via
 * contentDocument measurement (allow-same-origin is safe: nothing executes).
 * EPI1.3: blocked images HIDE (no raw broken boxes, D1) behind a styled
 * "n images hidden" line; chips repeated from an earlier message collapse
 * behind a "repeated" expander (D6).
 */
"use client";

import { useCallback, useRef, useState } from "react";
import { Download, HardDriveUpload, ImageOff } from "lucide-react";
import { useToast } from "@/design-system/components";
import { apiJson } from "@/lib/api-client";
import { ago, type ThreadMessage } from "./types";

const kb = (n: number | null) => (n == null ? "" : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function buildSrcDoc(bodyHtml: string, allowImages: boolean): string {
  const img = allowImages ? "https: data: cid:" : "'none'";
  // D1 — when blocked, images are hidden entirely (the CSP alone leaves the
  // browser's raw broken-image boxes); the bubble shows a styled notice.
  const hideImages = allowImages ? "" : "img { display: none !important; }";
  return `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${img}">
<style>
  body { margin: 0; font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; font-size: 13px; color: #1c2530; word-break: break-word; }
  img { max-width: 100%; height: auto; }
  ${hideImages}
  blockquote { border-left: 3px solid #d8dde4; margin: 6px 0; padding-left: 10px; color: #5b6573; }
  table { max-width: 100%; }
</style></head><body>${bodyHtml}</body></html>`;
}

export function MessageBubble({
  message,
  conversationId,
  allowImages,
  repeatedIds,
}: {
  message: ThreadMessage;
  conversationId: string;
  allowImages: boolean;
  repeatedIds?: Set<string>;
}) {
  const { toast } = useToast();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(80);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [showRepeats, setShowRepeats] = useState(false);
  const outbound = message.direction === "OUTBOUND";

  const fit = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (doc?.body) setHeight(Math.min(Math.max(doc.body.scrollHeight + 24, 40), 2400));
  }, []);

  const saveToDrive = async (attId: string) => {
    setSavingId(attId);
    try {
      const res = await apiJson<{ webViewLink?: string }>(
        `/api/inbox/${conversationId}/attachments/${attId}/save-to-drive`,
        { method: "POST" },
      );
      toast(res.webViewLink ? "Saved to Drive" : "Saved", "success");
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setSavingId(null);
    }
  };

  const hiddenImgCount = !allowImages && message.bodyHtml ? (message.bodyHtml.match(/<img/gi)?.length ?? 0) : 0;
  const fresh = message.attachments.filter((a) => !repeatedIds?.has(a.id));
  const repeats = message.attachments.filter((a) => repeatedIds?.has(a.id));

  const chip = (att: ThreadMessage["attachments"][number], muted = false) => (
    <span
      key={att.id}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        border: "1px solid var(--h10-border)",
        borderRadius: 8,
        padding: "4px 8px",
        background: "var(--h10-surface-raised)",
        opacity: muted ? 0.7 : 1,
      }}
    >
      <a
        href={`/api/inbox/${conversationId}/attachments/${att.id}`}
        title="Download"
        style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--h10-text)" }}
      >
        <Download size={13} />
        {att.filename}
        <span style={{ color: "var(--h10-text-3)" }}>{kb(att.sizeBytes)}</span>
      </a>
      {att.webViewLink ? (
        <a href={att.webViewLink} target="_blank" rel="noopener noreferrer" style={{ color: "var(--h10-text-link)", fontSize: 11.5 }}>
          in Drive
        </a>
      ) : (
        <button
          type="button"
          onClick={() => void saveToDrive(att.id)}
          disabled={savingId === att.id}
          title="Save to Drive"
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--h10-text-link)", display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11.5, padding: 0 }}
        >
          <HardDriveUpload size={12} />
          {savingId === att.id ? "Saving…" : "Drive"}
        </button>
      )}
    </span>
  );

  return (
    <div
      style={{
        border: "1px solid var(--h10-border-subtle)",
        borderRadius: 12,
        background: outbound ? "var(--h10-wash-primary)" : "var(--h10-surface)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "baseline",
          padding: "8px 14px",
          borderBottom: "1px solid var(--h10-border-subtle)",
          fontSize: 11.5,
        }}
      >
        <b style={{ fontSize: 12.5 }}>{outbound ? "You" : message.fromAddress}</b>
        <span style={{ color: "var(--h10-text-3)" }}>
          {new Date(message.sentAt).toLocaleString()} · {ago(message.sentAt)} ago
        </span>
      </div>
      {hiddenImgCount > 0 && (
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            padding: "6px 14px",
            fontSize: 11.5,
            color: "var(--h10-text-3)",
            background: "var(--h10-surface-raised)",
            borderBottom: "1px solid var(--h10-border-subtle)",
          }}
        >
          <ImageOff size={12} />
          {hiddenImgCount} remote image{hiddenImgCount === 1 ? "" : "s"} hidden — use "Load remote images" above
        </div>
      )}
      {message.bodyHtml ? (
        <iframe
          ref={iframeRef}
          title={`message-${message.id}`}
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          srcDoc={buildSrcDoc(message.bodyHtml, allowImages)}
          onLoad={fit}
          style={{ width: "100%", height, border: "none", display: "block", background: "#fff" }}
        />
      ) : (
        <div style={{ padding: "10px 14px", fontSize: 13, color: "var(--h10-text-2)", whiteSpace: "pre-wrap" }}>
          {message.bodyText ?? message.snippet ?? "(empty message)"}
        </div>
      )}
      {message.attachments.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "8px 14px", borderTop: "1px solid var(--h10-border-subtle)" }}>
          {fresh.map((att) => chip(att))}
          {repeats.length > 0 && !showRepeats && (
            <button
              type="button"
              onClick={() => setShowRepeats(true)}
              style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11.5, color: "var(--h10-text-3)", padding: 0 }}
            >
              {repeats.length} file{repeats.length === 1 ? "" : "s"} repeated from earlier · show
            </button>
          )}
          {showRepeats && repeats.map((att) => chip(att, true))}
        </div>
      )}
    </div>
  );
}
