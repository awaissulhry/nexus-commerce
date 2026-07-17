/**
 * FP1.3 → EPI1.3 — the context rail: party card (grain-gated fields simply
 * absent), create-party-from-sender with domain matching, LINK-EXISTING
 * contact (the server always supported it; the UI now does too, G4),
 * assignment/state/snooze/follow-up permission-gated client-side (G7),
 * an intentional empty state instead of a blank column (D7), and the
 * reserved slot for FP3/FP4 linked objects.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Crosshair, Download, FileText, Inbox } from "lucide-react";
import { Banner, Card, DateField, EmptyState, Listbox, useToast } from "@/design-system/components";
import { Button, Checkbox, Input, Pill } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { AsyncCombobox, type SearchLoader } from "@/components/AsyncCombobox";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { previewKind } from "@/lib/inbox/preview";
import type { ThreadResponse, UserLite } from "./types";

const QUOTE_TONE: Record<string, "neutral" | "info" | "success" | "danger" | "warning"> = { DRAFT: "neutral", SENT: "info", ACCEPTED: "success", REJECTED: "danger", EXPIRED: "warning" };

// EPI1.3 (G4) — consumes the Contacts page's own list API (EP rule 3)
const loadContacts: SearchLoader = async (q) => {
  const d = await apiJson<{ contacts: { id: string; name: string; kind: string; primaryEmail: string | null }[] }>(
    `/api/contacts?q=${encodeURIComponent(q)}`,
  );
  return {
    options: d.contacts.map((c) => ({ value: c.id, label: `${c.name} (${c.kind})`, hint: c.primaryEmail ?? undefined })),
    nextCursor: null,
  };
};

export function ContextRail({
  thread,
  onMutated,
  onFileOpen,
}: {
  thread: ThreadResponse | null;
  onMutated: () => void;
  /** EPI2.3 — open the conversation lightbox at this attachment */
  onFileOpen?: (attId: string) => void;
}) {
  const { toast } = useToast();
  const canAssign = usePermission("inbox.assign");
  const canContacts = usePermission("contacts.manage");
  const [users, setUsers] = useState<UserLite[]>([]);
  const [creating, setCreating] = useState(false);
  const [linking, setLinking] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("CUSTOMER");
  const [matchDomain, setMatchDomain] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!canAssign) return;
    apiJson<{ users: UserLite[] }>("/api/users-lite")
      .then((d) => setUsers(d.users))
      .catch(() => {});
  }, [canAssign]);

  const conversation = thread?.conversation;
  useEffect(() => {
    setCreating(false);
    setLinking(false);
    setName("");
    setMatchDomain(false);
  }, [conversation?.id]);

  if (!conversation) {
    // EPI1.3 (D7) — a blank bordered column read as a defect; say what goes here
    return (
      <div style={{ height: "100%", display: "grid", alignContent: "center", padding: 16 }}>
        <EmptyState
          icon={<Inbox size={18} />}
          title="No conversation selected"
          description="Pick a thread to see its contact, status and linked quotes. j/k to move · Enter to open."
        />
      </div>
    );
  }
  const party = conversation.party;
  const senderEmail = thread?.messages.filter((m) => m.direction === "INBOUND").at(-1)?.fromAddress ?? null;

  const patch = async (data: Record<string, unknown>, busyKey: string) => {
    setBusy(busyKey);
    try {
      await apiJson(`/api/inbox/${conversation.id}`, { method: "PATCH", body: JSON.stringify(data) });
      onMutated();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
    }
  };

  const linkParty = async (body: Record<string, unknown>, successFallback: string) => {
    setBusy("party");
    try {
      const res = await apiJson<{ linkedConversations: number }>(`/api/inbox/${conversation.id}/link-party`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      toast(
        res.linkedConversations > 1 ? `${successFallback} — ${res.linkedConversations} threads linked` : `${successFallback} and linked`,
        "success",
      );
      onMutated();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
    }
  };

  const isoDate = (d: string | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");
  const label = (text: string) => (
    <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--h10-text-3)", textTransform: "uppercase" }}>{text}</span>
  );

  return (
    <div style={{ height: "100%", overflowY: "auto", display: "grid", gap: 10, alignContent: "start", padding: 12 }}>
      <Card padded header="Contact">
        {party ? (
          <div style={{ display: "grid", gap: 6, fontSize: 12.5 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <b style={{ fontSize: 13 }}>{party.name}</b>
              <Pill tone="info">{party.kind}</Pill>
            </div>
            {party.emails.map((e) => (
              <div key={e.email} style={{ color: "var(--h10-text-2)" }}>
                {e.email}
                {e.matchDomain && <span style={{ color: "var(--h10-text-3)" }}> · matches @domain</span>}
              </div>
            ))}
            {"paymentTerms" in party && party.paymentTerms && (
              <div>
                Terms: <b>{party.paymentTerms}</b>
              </div>
            )}
            {party.priceList && (
              <div>
                Price list: <b>{party.priceList.name}</b>
              </div>
            )}
            {party.notes && <div style={{ color: "var(--h10-text-2)" }}>{party.notes}</div>}
          </div>
        ) : creating ? (
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>from {senderEmail ?? "sender"}</div>
            <Input placeholder="Name (person or company)" value={name} onChange={(e) => setName(e.target.value)} />
            <Listbox
              ariaLabel="Kind"
              options={[
                { value: "CUSTOMER", label: "Customer" },
                { value: "BRAND", label: "Brand (B2B)" },
                { value: "SUPPLIER", label: "Supplier" },
              ]}
              value={kind}
              onChange={setKind}
            />
            <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 12.5 }}>
              <Checkbox checked={matchDomain} onChange={(e) => setMatchDomain(e.target.checked)} aria-label="Match domain" />
              Match everyone @{senderEmail?.split("@")[1] ?? "domain"}
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              <Button
                variant="primary"
                onClick={() => void linkParty({ create: { name: name.trim(), kind, matchDomain } }, "Contact created")}
                disabled={!name.trim() || busy === "party"}
              >
                {busy === "party" ? "Creating…" : "Create & link"}
              </Button>
              <Button onClick={() => setCreating(false)}>Cancel</Button>
            </div>
          </div>
        ) : linking ? (
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>
              Link {senderEmail ?? "this sender"} to an existing contact — it learns the email and back-matches their other threads.
            </div>
            <AsyncCombobox
              loader={loadContacts}
              placeholder="Search contacts…"
              ariaLabel="Link to existing contact"
              autoFocus
              onChange={(id) => void linkParty({ partyId: id }, "Contact matched")}
              onDismiss={() => setLinking(false)}
            />
            <div>
              <Button onClick={() => setLinking(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            <Banner tone="info" title="Unmatched sender">
              {senderEmail ?? "This thread"} isn't a contact yet — matching links every past and future
              thread automatically.
            </Banner>
            {canContacts && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <Button
                  variant="primary"
                  onClick={() => {
                    const guess = senderEmail
                      ? senderEmail.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
                      : "";
                    setName(guess);
                    setCreating(true);
                  }}
                  disabled={!senderEmail}
                >
                  Create contact from sender
                </Button>
                <Button onClick={() => setLinking(true)} disabled={!senderEmail}>
                  Link existing contact
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card padded header="Conversation">
        {canAssign ? (
          <div style={{ display: "grid", gap: 10, fontSize: 12.5 }}>
            <div style={{ display: "grid", gap: 4 }}>
              {label("Assignee")}
              <Listbox
                ariaLabel="Assignee"
                options={[{ value: "", label: "Unassigned" }, ...users.map((u) => ({ value: u.id, label: u.displayName }))]}
                value={conversation.assignee?.id ?? ""}
                onChange={(v) => void patch({ assigneeId: v || null }, "assign")}
                disabled={busy === "assign"}
              />
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {conversation.state !== "CLOSED" ? (
                <Button onClick={() => void patch({ state: "CLOSED" }, "state")} disabled={busy === "state"}>
                  Close — work done
                </Button>
              ) : (
                <Button onClick={() => void patch({ state: "OPEN" }, "state")} disabled={busy === "state"}>
                  Reopen
                </Button>
              )}
            </div>
            <div style={{ display: "grid", gap: 4 }}>
              {label("Snooze until")}
              <DateField
                ariaLabel="Snooze until"
                value={isoDate(conversation.snoozeUntil)}
                min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
                onChange={(v) => void patch({ snoozeUntil: v ? new Date(`${v}T08:00:00`).toISOString() : null }, "snooze")}
              />
              <span style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>Any reply un-snoozes automatically.</span>
            </div>
            <div style={{ display: "grid", gap: 4 }}>
              {label("Follow-up reminder")}
              <DateField
                ariaLabel="Follow up on"
                value={isoDate(conversation.followUpAt)}
                min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
                onChange={(v) => void patch({ followUpAt: v ? new Date(`${v}T08:00:00`).toISOString() : null }, "follow")}
              />
              <span style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>Cancels itself if they reply first — no double-chasing.</span>
            </div>
          </div>
        ) : (
          // EPI1.3 (G7) — read-only rows for roles without inbox.assign:
          // no dead controls whose only outcome is a 403 toast.
          <div style={{ display: "grid", gap: 6, fontSize: 12.5 }}>
            <div>
              Assignee: <b>{conversation.assignee?.displayName ?? "Unassigned"}</b>
            </div>
            {conversation.snoozeUntil && <div>Snoozed until {new Date(conversation.snoozeUntil).toLocaleDateString()}</div>}
            {conversation.followUpAt && <div>Follow-up {new Date(conversation.followUpAt).toLocaleDateString()}</div>}
            <div style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>Your role can't change assignment or status.</div>
          </div>
        )}
      </Card>

      <FilesCard thread={thread} onFileOpen={onFileOpen} />

      <Card padded header="Quotes">
        <LinkedQuotes thread={thread} onToast={(m, t) => toast(m, t)} />
      </Card>
    </div>
  );
}

/** EPI2.3 — every file in the conversation, previewable + jumpable (Missive's
 * Files-sidebar verdict). Renders nothing when the thread carries no files. */
function FilesCard({ thread, onFileOpen }: { thread: ThreadResponse; onFileOpen?: (attId: string) => void }) {
  const items = useMemo(
    () =>
      thread.messages.flatMap((m) =>
        m.attachments.map((a) => ({ ...a, messageId: m.id, sentAt: m.sentAt })),
      ),
    [thread],
  );
  if (items.length === 0) return null;
  const images = items.filter((a) => previewKind(a.mimeType) === "image");
  const files = items.filter((a) => previewKind(a.mimeType) !== "image");
  const kb = (n: number | null) => (n == null ? "" : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const showInConversation = (messageId: string) => {
    const el = document.querySelector(`[data-msg="${messageId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    (el as HTMLElement).animate(
      [{ boxShadow: "0 0 0 2px var(--h10-primary)" }, { boxShadow: "0 0 0 2px transparent" }],
      { duration: 1400 },
    );
  };

  return (
    <Card padded header={`Files (${items.length})`}>
      <div style={{ display: "grid", gap: 8 }}>
        {images.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {images.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => onFileOpen?.(a.id)}
                title={`${a.filename} · ${kb(a.sizeBytes)}`}
                style={{ padding: 0, border: "1px solid var(--h10-border)", borderRadius: 8, overflow: "hidden", width: 56, height: 56, cursor: "zoom-in", background: "var(--h10-surface)" }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/inbox/${thread.conversation.id}/attachments/${a.id}?inline=1`}
                  alt={a.filename}
                  loading="lazy"
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                />
              </button>
            ))}
          </div>
        )}
        {files.map((a) => {
          const canPreview = previewKind(a.mimeType) !== "none";
          return (
            <div key={a.id} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, minWidth: 0 }}>
              <FileText size={13} style={{ color: "var(--h10-text-3)", flexShrink: 0 }} />
              {canPreview && onFileOpen ? (
                <button
                  type="button"
                  onClick={() => onFileOpen(a.id)}
                  title="Preview"
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0, font: "inherit", color: "var(--h10-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1, textAlign: "left" }}
                >
                  {a.filename}
                </button>
              ) : (
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>{a.filename}</span>
              )}
              <span style={{ fontSize: 11.5, color: "var(--h10-text-3)", flexShrink: 0 }}>{kb(a.sizeBytes)}</span>
              <a href={`/api/inbox/${thread.conversation.id}/attachments/${a.id}`} title="Download" style={{ display: "inline-flex", color: "var(--h10-text-3)", flexShrink: 0 }}>
                <Download size={12} />
              </a>
              <button
                type="button"
                onClick={() => showInConversation(a.messageId)}
                title="Show in conversation"
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "inline-flex", color: "var(--h10-text-3)", flexShrink: 0 }}
              >
                <Crosshair size={12} />
              </button>
            </div>
          );
        })}
        {images.length > 0 && files.length === 0 && (
          <span style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>Click a thumbnail to preview · images jump via the thread</span>
        )}
      </div>
    </Card>
  );
}

function LinkedQuotes({ thread, onToast }: { thread: ThreadResponse; onToast: (m: string, t: "success" | "danger") => void }) {
  const router = useRouter();
  const canQuote = usePermission("quotes.create");
  const canMargin = usePermission("financials.margins.view");
  const [busy, setBusy] = useState(false);
  const conversation = thread.conversation;
  const party = conversation.party;
  const quotes = thread.quotes ?? [];

  const newQuote = async () => {
    if (!party) return;
    setBusy(true);
    try {
      const d = await apiJson<{ quote: { id: string } }>("/api/quotes", { method: "POST", body: JSON.stringify({ partyId: party.id, conversationId: conversation.id }) });
      router.push(`/quotes?q=${d.quote.id}`);
    } catch (e) {
      onToast((e as Error).message, "danger");
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {quotes.length > 0 && (
        <div style={{ display: "grid", gap: 5 }}>
          {quotes.map((q) => (
            <button key={q.id} type="button" onClick={() => router.push(`/quotes?q=${q.id}`)} style={{ display: "flex", gap: 6, alignItems: "center", border: "1px solid var(--h10-border-subtle)", borderRadius: 8, padding: "6px 8px", background: "var(--h10-surface)", cursor: "pointer", textAlign: "left" }}>
              <FileText size={13} style={{ color: "var(--h10-text-3)" }} />
              <b style={{ fontSize: 12.5 }}>{q.number}</b>
              <Pill tone={QUOTE_TONE[q.state]}>{q.state}</Pill>
              {q.convertedOrderId && <Pill tone="success">order</Pill>}
              {q.state === "DRAFT" && q.netCents === 0 ? (
                // EPI1.3 (D8) — "€0.00 · 0%" on an unpriced draft read as data
                <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--h10-text-3)" }}>not priced yet</span>
              ) : (
                <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--h10-text-2)", fontFamily: "var(--font-mono)" }}>
                  {eur(q.netCents)}{canMargin ? ` · ${q.netCents ? Math.round((q.marginCents / q.netCents) * 100) : 0}%` : ""}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {canQuote && (
        party ? (
          <Button onClick={() => void newQuote()} disabled={busy}><FileText size={13} /> {quotes.length ? "Another quote" : "New quote"}</Button>
        ) : (
          <div style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>Match this thread to a contact first, then quote them.</div>
        )
      )}
    </div>
  );
}
