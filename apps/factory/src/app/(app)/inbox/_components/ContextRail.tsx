/**
 * FP1.3 — the context rail: party card (grain-gated fields simply absent),
 * create-party-from-sender with domain matching, assignment, state/snooze/
 * follow-up controls, and the reserved slot for FP3/FP4 linked objects.
 */
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText } from "lucide-react";
import { Banner, Card, DateField, Listbox, useToast } from "@/design-system/components";
import { Button, Checkbox, Input, Pill } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import type { ThreadResponse, UserLite } from "./types";

const QUOTE_TONE: Record<string, "neutral" | "info" | "success" | "danger" | "warning"> = { DRAFT: "neutral", SENT: "info", ACCEPTED: "success", REJECTED: "danger", EXPIRED: "warning" };

export function ContextRail({
  thread,
  onMutated,
}: {
  thread: ThreadResponse | null;
  onMutated: () => void;
}) {
  const { toast } = useToast();
  const [users, setUsers] = useState<UserLite[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("CUSTOMER");
  const [matchDomain, setMatchDomain] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    apiJson<{ users: UserLite[] }>("/api/users-lite")
      .then((d) => setUsers(d.users))
      .catch(() => {});
  }, []);

  const conversation = thread?.conversation;
  useEffect(() => {
    setCreating(false);
    setName("");
    setMatchDomain(false);
  }, [conversation?.id]);

  if (!conversation) return null;
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

  const createParty = async () => {
    setBusy("party");
    try {
      const res = await apiJson<{ linkedConversations: number }>(`/api/inbox/${conversation.id}/link-party`, {
        method: "POST",
        body: JSON.stringify({ create: { name: name.trim(), kind, matchDomain } }),
      });
      toast(
        res.linkedConversations > 1
          ? `Contact created — ${res.linkedConversations} threads linked`
          : "Contact created and linked",
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
            <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 12 }}>
              <Checkbox checked={matchDomain} onChange={(e) => setMatchDomain(e.target.checked)} aria-label="Match domain" />
              Match everyone @{senderEmail?.split("@")[1] ?? "domain"}
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              <Button variant="primary" onClick={() => void createParty()} disabled={!name.trim() || busy === "party"}>
                {busy === "party" ? "Creating…" : "Create & link"}
              </Button>
              <Button onClick={() => setCreating(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            <Banner tone="info" title="Unmatched sender">
              {senderEmail ?? "This thread"} isn't a contact yet — matching links every past and future
              thread automatically.
            </Banner>
            <div>
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
            </div>
          </div>
        )}
      </Card>

      <Card padded header="Conversation">
        <div style={{ display: "grid", gap: 10, fontSize: 12.5 }}>
          <div style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--h10-text-3)", textTransform: "uppercase" }}>Assignee</span>
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
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--h10-text-3)", textTransform: "uppercase" }}>Snooze until</span>
            <DateField
              ariaLabel="Snooze until"
              value={isoDate(conversation.snoozeUntil)}
              min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
              onChange={(v) => void patch({ snoozeUntil: v ? new Date(`${v}T08:00:00`).toISOString() : null }, "snooze")}
            />
            <span style={{ fontSize: 11, color: "var(--h10-text-3)" }}>Any reply un-snoozes automatically.</span>
          </div>
          <div style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--h10-text-3)", textTransform: "uppercase" }}>Follow-up reminder</span>
            <DateField
              ariaLabel="Follow up on"
              value={isoDate(conversation.followUpAt)}
              min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
              onChange={(v) => void patch({ followUpAt: v ? new Date(`${v}T08:00:00`).toISOString() : null }, "follow")}
            />
            <span style={{ fontSize: 11, color: "var(--h10-text-3)" }}>Cancels itself if they reply first — no double-chasing.</span>
          </div>
        </div>
      </Card>

      <Card padded header="Quotes">
        <LinkedQuotes thread={thread} onToast={(m, t) => toast(m, t)} />
      </Card>
    </div>
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
              <b style={{ fontSize: 12 }}>{q.number}</b>
              <Pill tone={QUOTE_TONE[q.state]}>{q.state}</Pill>
              {q.convertedOrderId && <Pill tone="success">order</Pill>}
              <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--h10-text-2)", fontFamily: "var(--font-mono)" }}>
                {eur(q.netCents)}{canMargin ? ` · ${q.netCents ? Math.round((q.marginCents / q.netCents) * 100) : 0}%` : ""}
              </span>
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
