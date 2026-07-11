/**
 * FP5 — the contacts workspace: parties by kind (Customers · Suppliers ·
 * Brands), search, and a full-width grid (name absorbs the slack). Clicking a
 * name opens the ContactDetail; New contact promotes one directly. Commercial
 * columns are grain-gated. Deep-linkable via ?c=.
 */
"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { PageHeader } from "@/design-system/patterns";
import { Card, Modal, useToast, Listbox } from "@/design-system/components";
import { Button, Input, Pill } from "@/design-system/primitives";
import { VirtualDataGrid } from "@/components/VirtualDataGrid"; // FS3 — windowed rows, DS-grid parity
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { ContactDetail } from "./ContactDetail";
import { ComparePricing } from "./ComparePricing";
import { KIND_LABEL, KIND_TONE, type ContactRow, type ContactsResponse, type PartyKind } from "./types";

const TABS: { id: string; label: string; kind?: PartyKind }[] = [
  { id: "all", label: "All" },
  { id: "customer", label: "Customers", kind: "CUSTOMER" },
  { id: "supplier", label: "Suppliers", kind: "SUPPLIER" },
  { id: "brand", label: "Brands", kind: "BRAND" },
];

function PipelineInner() {
  const params = useSearchParams();
  const { toast } = useToast();
  const canManage = usePermission("contacts.manage");
  const canTerms = usePermission("financials.suppliers.view");
  const canDeposit = usePermission("financials.prices.view");
  const canCompare = usePermission("financials.prices.view");
  const [data, setData] = useState<ContactsResponse | null>(null);
  const [tab, setTab] = useState("all");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [form, setForm] = useState<{ kind: PartyKind; name: string; email: string }>({ kind: "CUSTOMER", name: "", email: "" });
  const [busy, setBusy] = useState(false);

  const openId = params.get("c");

  const load = useCallback(async () => {
    try {
      const usp = new URLSearchParams();
      if (tab !== "all") usp.set("kind", tab);
      if (q.trim()) usp.set("q", q.trim());
      setData(await apiJson<ContactsResponse>(`/api/contacts?${usp}`));
    } catch (e) { toast((e as Error).message, "danger"); }
  }, [tab, q, toast]);
  useEffect(() => { const t = setTimeout(() => void load(), 200); return () => clearTimeout(t); }, [load]);

  const openDetail = (id: string) => { window.history.replaceState(null, "", `/contacts?c=${id}`); window.dispatchEvent(new PopStateEvent("popstate")); };
  const closeDetail = () => { window.history.replaceState(null, "", "/contacts"); window.dispatchEvent(new PopStateEvent("popstate")); void load(); };

  const create = async () => {
    if (!form.name.trim()) return;
    setBusy(true);
    try {
      const d = await apiJson<{ contact: { id: string } }>("/api/contacts", { method: "POST", body: JSON.stringify({ kind: form.kind, name: form.name.trim(), email: form.email.trim() || undefined }) });
      setCreating(false); setForm({ kind: "CUSTOMER", name: "", email: "" });
      openDetail(d.contact.id);
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };

  if (openId) return <ContactDetail contactId={openId} onBack={closeDetail} />;
  if (comparing) return <ComparePricing onBack={() => setComparing(false)} />;

  return (
    <div className="factory-page factory-grid-grow-1">
      <PageHeader eyebrow="Factory OS" title="Contacts" subtitle="The relationship workspace: identity, emails, price lists, measurements, and the whole history for every party." />
      <Card padded>
        <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 4 }}>
            {TABS.map((t) => (
              <button key={t.id} type="button" onClick={() => setTab(t.id)} style={{ border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 600, padding: "5px 10px", borderRadius: 8, background: tab === t.id ? "var(--h10-primary)" : "transparent", color: tab === t.id ? "#fff" : "var(--h10-text-2)" }}>
                {t.label}{t.kind && data?.counts[t.kind] ? <span style={{ marginLeft: 5, fontSize: 10.5, opacity: 0.85 }}>{data.counts[t.kind]}</span> : null}
              </button>
            ))}
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
            <a href="/api/exports/parties" style={{ fontSize: 12, color: "var(--h10-text-link)" }}>Export CSV</a>
            {canCompare && <Button onClick={() => setComparing(true)}>Compare pricing</Button>}
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email…" style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: "5px 9px", fontSize: 12.5, outline: "none", background: "var(--h10-surface)", color: "var(--h10-text)", minWidth: 220 }} />
            {canManage && <Button variant="primary" onClick={() => setCreating(true)}><Plus size={13} /> New contact</Button>}
          </div>
        </div>
        <VirtualDataGrid
          height="calc(100dvh - 300px)"
          columns={[
            { key: "name", label: "Name", render: (r: ContactRow) => <button type="button" onClick={() => openDetail(r.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", fontWeight: 700, color: "var(--h10-text-link)" }}>{r.name}</button> },
            { key: "kind", label: "Kind", render: (r: ContactRow) => <Pill tone={KIND_TONE[r.kind]}>{KIND_LABEL[r.kind]}</Pill> },
            { key: "emails", label: "Emails", align: "right" as const, render: (r: ContactRow) => (r.emailCount ? r.emailCount : "—") },
            { key: "list", label: "Price list", render: (r: ContactRow) => r.priceList?.name ?? <span style={{ color: "var(--h10-text-3)" }}>base</span> },
            ...(canTerms ? [{ key: "terms", label: "Terms", render: (r: ContactRow) => r.paymentTerms || <span style={{ color: "var(--h10-text-3)" }}>—</span> }] : []),
            ...(canDeposit ? [{ key: "deposit", label: "Deposit", align: "right" as const, render: (r: ContactRow) => (r.depositDefaultPct != null ? `${r.depositDefaultPct}%` : "—") }] : []),
            { key: "quotes", label: "Quotes", align: "right" as const, render: (r: ContactRow) => (r.quoteCount ? r.quoteCount : "—") },
            { key: "orders", label: "Orders", align: "right" as const, render: (r: ContactRow) => (r.orderCount ? r.orderCount : "—") },
            { key: "updated", label: "Updated", render: (r: ContactRow) => new Date(r.updatedAt).toLocaleDateString() },
          ]}
          rows={data?.contacts ?? []}
          rowKey={(r: ContactRow) => r.id}
          emptyState="No contacts yet — they appear as you match senders, import, or add one."
        />
      </Card>

      <Modal open={creating} onClose={() => setCreating(false)} title="New contact" size="sm"
        footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={!form.name.trim() || busy}>Create</Button></>}>
        <div style={{ display: "grid", gap: 10 }}>
          <div>
            <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 3 }}>Kind</div>
            <Listbox ariaLabel="Kind" options={[{ value: "CUSTOMER", label: "Customer" }, { value: "SUPPLIER", label: "Supplier" }, { value: "BRAND", label: "Brand" }]} value={form.kind} onChange={(v) => setForm((f) => ({ ...f, kind: v as PartyKind }))} />
          </div>
          <div>
            <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 3 }}>Name</div>
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Bartoccetti Moto SRL" />
          </div>
          <div>
            <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 3 }}>Email (optional)</div>
            <Input value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder="orders@brand.it" />
          </div>
        </div>
      </Modal>
    </div>
  );
}

export function ContactsClient() {
  return <Suspense fallback={null}><PipelineInner /></Suspense>;
}
