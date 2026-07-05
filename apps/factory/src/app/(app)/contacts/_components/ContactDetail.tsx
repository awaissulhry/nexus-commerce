/**
 * FP5 — one contact: identity + emails + price list on Overview (inline
 * autosave), with Measurements (FP5.2) and History (FP5.3) tabs. Rail carries
 * the commercial summary + relationship counts. Centered (detail archetype).
 * Commercial fields arrive already grain-stripped from the API.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, ArchiveRestore, Plus, X } from "lucide-react";
import { DetailHeader } from "@/design-system/patterns";
import { Card, Listbox, useToast } from "@/design-system/components";
import { Button, Input, Pill } from "@/design-system/primitives";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { ContactMeasurements } from "./ContactMeasurements";
import { ContactHistory } from "./ContactHistory";
import { KIND_LABEL, KIND_TONE, type ContactDetailResponse } from "./types";

const inp: React.CSSProperties = { width: "100%", border: "1px solid var(--h10-border)", borderRadius: 8, padding: "7px 9px", fontSize: 12.5, background: "var(--h10-surface)", color: "var(--h10-text)" };
const lbl: React.CSSProperties = { fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 3 };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div style={lbl}>{label}</div>{children}</div>;
}

export function ContactDetail({ contactId, onBack }: { contactId: string; onBack: () => void }) {
  const { toast } = useToast();
  const canManage = usePermission("contacts.manage");
  const canTerms = usePermission("financials.suppliers.view");
  const canDeposit = usePermission("financials.prices.view");
  const [d, setD] = useState<ContactDetailResponse | null>(null);
  const [tab, setTab] = useState<"overview" | "measurements" | "history">("overview");
  const [draft, setDraft] = useState<{ name: string; currency: string; paymentTerms: string; depositDefaultPct: string; notes: string }>({ name: "", currency: "", paymentTerms: "", depositDefaultPct: "", notes: "" });
  const [priceLists, setPriceLists] = useState<{ id: string; name: string }[]>([]);
  const [newEmail, setNewEmail] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await apiJson<ContactDetailResponse>(`/api/contacts/${contactId}`);
      setD(data);
      const c = data.contact;
      setDraft({ name: c.name, currency: c.currency, paymentTerms: c.paymentTerms ?? "", depositDefaultPct: c.depositDefaultPct != null ? String(c.depositDefaultPct) : "", notes: c.notes ?? "" });
    } catch (e) { toast((e as Error).message, "danger"); }
  }, [contactId, toast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { apiJson<{ lists: { id: string; name: string }[] }>("/api/pricelists").then((r) => setPriceLists(r.lists ?? [])).catch(() => {}); }, []);

  const patch = async (body: Record<string, unknown>, quiet = false) => {
    try { const data = await apiJson<ContactDetailResponse>(`/api/contacts/${contactId}`, { method: "PATCH", body: JSON.stringify(body) }); setD(data); if (!quiet) toast("Saved", "success"); }
    catch (e) { toast((e as Error).message, "danger"); void load(); }
  };
  const saveField = (key: string, value: string, kind: "text" | "number" = "text") => {
    const c = d!.contact;
    const cur = key === "depositDefaultPct" ? (c.depositDefaultPct != null ? String(c.depositDefaultPct) : "") : ((c as unknown as Record<string, string | null>)[key] ?? "");
    if (value === cur) return;
    if (kind === "number") { const n = value.trim() === "" ? null : Number(value); void patch({ [key]: n }); }
    else void patch({ [key]: value.trim() === "" ? null : value.trim() });
  };

  const addEmail = async () => {
    if (!newEmail.trim()) return;
    try { await apiJson(`/api/contacts/${contactId}/emails`, { method: "POST", body: JSON.stringify({ email: newEmail.trim() }) }); setNewEmail(""); await load(); }
    catch (e) { toast((e as Error).message, "danger"); }
  };
  const patchEmail = async (eid: string, body: Record<string, unknown>) => {
    try { await apiJson(`/api/contacts/${contactId}/emails/${eid}`, { method: "PATCH", body: JSON.stringify(body) }); await load(); }
    catch (e) { toast((e as Error).message, "danger"); }
  };
  const removeEmail = async (eid: string) => {
    try { await apiJson(`/api/contacts/${contactId}/emails/${eid}`, { method: "DELETE" }); await load(); }
    catch (e) { toast((e as Error).message, "danger"); }
  };

  if (!d) return <div className="factory-page--centered"><Card padded><Button onClick={onBack}>Back</Button></Card></div>;
  const c = d.contact;
  const archived = !!c.archivedAt;

  return (
    <div className="factory-page--centered">
      <DetailHeader
        backLabel="All contacts"
        onBack={onBack}
        title={<span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>{c.name}<Pill tone={KIND_TONE[c.kind]}>{KIND_LABEL[c.kind]}</Pill>{archived && <Pill tone="neutral">archived</Pill>}</span>}
        actions={canManage ? (
          <Button onClick={() => void patch({ archived: !archived })}>{archived ? <><ArchiveRestore size={13} /> Restore</> : <><Archive size={13} /> Archive</>}</Button>
        ) : undefined}
      />

      <div style={{ display: "flex", gap: 4, margin: "6px 0 14px", borderBottom: "1px solid var(--h10-border-subtle)" }}>
        {([["overview", "Overview"], ["measurements", `Measurements${c.measurements.length ? ` (${new Set(c.measurements.map((m) => m.garmentType)).size})` : ""}`], ["history", "History"]] as const).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setTab(id)} style={{ border: "none", background: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, padding: "8px 12px", color: tab === id ? "var(--h10-primary)" : "var(--h10-text-2)", borderBottom: tab === id ? "2px solid var(--h10-primary)" : "2px solid transparent", marginBottom: -1 }}>{label}</button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 320px", gap: 16 }}>
        <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
          {tab === "overview" && (
            <>
              <Card padded>
                <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 10 }}>Identity</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <Field label="Name"><input style={inp} value={draft.name} disabled={!canManage} onChange={(e) => setDraft((f) => ({ ...f, name: e.target.value }))} onBlur={(e) => saveField("name", e.target.value)} /></Field>
                  <Field label="Currency"><input style={inp} value={draft.currency} disabled={!canManage} onChange={(e) => setDraft((f) => ({ ...f, currency: e.target.value }))} onBlur={(e) => saveField("currency", e.target.value)} /></Field>
                  {canTerms && <Field label="Payment terms"><input style={inp} value={draft.paymentTerms} disabled={!canManage} onChange={(e) => setDraft((f) => ({ ...f, paymentTerms: e.target.value }))} onBlur={(e) => saveField("paymentTerms", e.target.value)} placeholder="e.g. 30 days" /></Field>}
                  {canDeposit && <Field label="Default deposit %"><input style={inp} type="number" min="0" max="100" value={draft.depositDefaultPct} disabled={!canManage} onChange={(e) => setDraft((f) => ({ ...f, depositDefaultPct: e.target.value }))} onBlur={(e) => saveField("depositDefaultPct", e.target.value, "number")} /></Field>}
                  <div style={{ gridColumn: "1 / -1" }}><Field label="Notes"><textarea style={{ ...inp, fontFamily: "inherit", minHeight: 60 }} value={draft.notes} disabled={!canManage} onChange={(e) => setDraft((f) => ({ ...f, notes: e.target.value }))} onBlur={(e) => saveField("notes", e.target.value)} /></Field></div>
                </div>
              </Card>

              <Card padded>
                <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>Emails</div>
                <div style={{ display: "grid", gap: 6 }}>
                  {c.emails.map((em) => (
                    <div key={em.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "5px 0", borderBottom: "1px solid var(--h10-border-subtle)" }}>
                      <span style={{ fontSize: 12.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{em.email}{em.label ? <span style={{ color: "var(--h10-text-3)" }}> · {em.label}</span> : null}</span>
                      <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flex: "0 0 auto" }}>
                        <label style={{ fontSize: 11.5, color: "var(--h10-text-3)", display: "inline-flex", gap: 4, alignItems: "center", cursor: canManage ? "pointer" : "default" }} title="Match any sender at this email's domain to this contact">
                          <input type="checkbox" checked={em.matchDomain} disabled={!canManage} onChange={(e) => void patchEmail(em.id, { matchDomain: e.target.checked })} /> match domain
                        </label>
                        {canManage && <button type="button" onClick={() => void removeEmail(em.id)} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--h10-text-3)", display: "grid", placeItems: "center" }}><X size={14} /></button>}
                      </span>
                    </div>
                  ))}
                  {c.emails.length === 0 && <div style={{ fontSize: 12, color: "var(--h10-text-3)" }}>No emails yet.</div>}
                  {canManage && (
                    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                      <Input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="add email…" onKeyDown={(e) => { if (e.key === "Enter") void addEmail(); }} />
                      <Button onClick={addEmail} disabled={!newEmail.trim()}><Plus size={13} /> Add</Button>
                    </div>
                  )}
                </div>
              </Card>
            </>
          )}
          {tab === "measurements" && <ContactMeasurements contactId={contactId} measurements={c.measurements} canManage={canManage} onChanged={load} />}
          {tab === "history" && <ContactHistory history={d.history} />}
        </div>

        <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
          <Card padded>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Price list</div>
            <Listbox ariaLabel="Price list" options={[{ value: "", label: "Listino base" }, ...priceLists.map((l) => ({ value: l.id, label: l.name }))]} value={c.priceListId ?? ""} onChange={(v) => canManage && void patch({ priceListId: v || null })} />
            {(canTerms || canDeposit) && (
              <div style={{ marginTop: 10, display: "grid", gap: 3 }}>
                {canTerms && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}><span style={{ color: "var(--h10-text-3)" }}>Terms</span><span style={{ fontWeight: 600 }}>{c.paymentTerms || "—"}</span></div>}
                {canDeposit && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}><span style={{ color: "var(--h10-text-3)" }}>Deposit</span><span style={{ fontWeight: 600 }}>{c.depositDefaultPct != null ? `${c.depositDefaultPct}%` : "—"}</span></div>}
              </div>
            )}
          </Card>
          <Card padded>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Relationship</div>
            <div style={{ display: "grid", gap: 3, fontSize: 12.5 }}>
              {([["Conversations", d.counts.conversations], ["Quotes", d.counts.quotes], ["Orders", d.counts.orders], ["Reviews", d.counts.reviews]] as const).map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--h10-text-3)" }}>{k}</span><span style={{ fontWeight: 600 }}>{v}</span></div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
