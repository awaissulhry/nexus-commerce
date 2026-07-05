/**
 * FP2.4 — price lists (FD7). Grid + sparse-override detail: a list starts empty
 * (= Listino base) and grows only the lines you negotiate — a per-template base
 * override and/or per-option delta overrides — plus the parties it applies to.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { Card, DataGrid, Modal, MultiSelect, useToast } from "@/design-system/components";
import { Listbox } from "@/design-system/components";
import { Button, Input, Pill } from "@/design-system/primitives";
import { apiFetch, apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { DeltaInput, EuroInput } from "./money";
import type { PriceListRow, TemplateDetail, TemplateRow } from "./types";

export function PriceListsTab() {
  const { toast } = useToast();
  const canManage = usePermission("pricelists.manage");
  const [rows, setRows] = useState<PriceListRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows((await apiJson<{ lists: PriceListRow[] }>("/api/pricelists")).lists);
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const d = await apiJson<{ list: { id: string } }>("/api/pricelists", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      setCreating(false); setName("");
      await load();
      setOpenId(d.list.id);
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  if (openId) return <PriceListDetail listId={openId} onBack={() => { setOpenId(null); void load(); }} />;

  return (
    <Card padded>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        <div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>Price lists</div>
        {canManage && <Button variant="primary" onClick={() => setCreating(true)}><Plus size={13} /> New list</Button>}
      </div>
      <div style={{ fontSize: 12, color: "var(--h10-text-3)", marginBottom: 10 }}>
        A new list inherits everything from <b>Listino base</b> — you only add the lines you negotiated (a discounted base, a cheaper option). Assign it to the brands/customers who get it.
      </div>
      <DataGrid
        columns={[
          { key: "name", label: "List", render: (r: PriceListRow) => <button type="button" onClick={() => setOpenId(r.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", fontWeight: 700, color: "var(--h10-text-link)" }}>{r.name}</button> },
          { key: "kind", label: "Kind", render: (r: PriceListRow) => <Pill tone={r.kind === "DEFAULT" ? "neutral" : "info"}>{r.kind === "DEFAULT" ? "default" : "party tier"}</Pill> },
          { key: "entries", label: "Overrides", align: "right" as const, render: (r: PriceListRow) => r.entryCount },
          { key: "parties", label: "Parties", align: "right" as const, render: (r: PriceListRow) => r.partyCount },
        ]}
        rows={rows}
        rowKey={(r: PriceListRow) => r.id}
        emptyState="No lists yet — Listino base is seeded and covers everyone by default."
      />
      <Modal open={creating} onClose={() => setCreating(false)} title="New price list" size="sm" footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={!name.trim() || busy}>Create</Button></>}>
        <Input placeholder="List name (e.g. Listino B2B)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Modal>
    </Card>
  );
}

type ListDetailData = {
  id: string;
  kind: string;
  name: string;
  notes: string | null;
  entries: { templateId: string | null; optionId: string | null; basePriceCents: number | null; priceDeltaMode: "ABSOLUTE" | "PERCENT" | null; priceDelta: number | null }[];
  parties: { id: string; name: string; kind: string }[];
};

function PriceListDetail({ listId, onBack }: { listId: string; onBack: () => void }) {
  const { toast } = useToast();
  const [list, setList] = useState<ListDetailData | null>(null);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [parties, setParties] = useState<{ id: string; name: string; kind: string }[]>([]);
  const [details, setDetails] = useState<Record<string, TemplateDetail>>({});
  const [baseOv, setBaseOv] = useState<Record<string, number>>({}); // templateId → basePriceCents
  const [optOv, setOptOv] = useState<Record<string, { mode: "ABSOLUTE" | "PERCENT"; delta: number }>>({}); // optionId → override
  const [assigned, setAssigned] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const loadTemplateDetail = useCallback(async (tid: string) => {
    if (details[tid]) return;
    try {
      const d = await apiJson<{ template: TemplateDetail }>(`/api/products/templates/${tid}`);
      setDetails((prev) => ({ ...prev, [tid]: d.template }));
    } catch { /* ignore */ }
  }, [details]);

  const load = useCallback(async () => {
    const [l, t, p] = await Promise.all([
      apiJson<{ list: ListDetailData }>(`/api/pricelists/${listId}`),
      apiJson<{ templates: TemplateRow[] }>("/api/products/templates"),
      apiJson<{ parties: { id: string; name: string; kind: string }[] }>("/api/parties-lite"),
    ]);
    setList(l.list);
    setTemplates(t.templates);
    setParties(p.parties);
    setAssigned(l.list.parties.map((x) => x.id));
    const b: Record<string, number> = {};
    const o: Record<string, { mode: "ABSOLUTE" | "PERCENT"; delta: number }> = {};
    const tids = new Set<string>();
    for (const e of l.list.entries) {
      if (e.templateId && e.optionId == null && e.basePriceCents != null) { b[e.templateId] = e.basePriceCents; tids.add(e.templateId); }
      if (e.optionId && e.priceDelta != null) o[e.optionId] = { mode: e.priceDeltaMode ?? "ABSOLUTE", delta: e.priceDelta };
    }
    setBaseOv(b); setOptOv(o);
    for (const tid of tids) void loadTemplateDetail(tid);
    // option overrides: find which templates own them (fetch all referenced templates)
    for (const t2 of t.templates) if (l.list.entries.some((e) => e.optionId)) void loadTemplateDetail(t2.id);
  }, [listId, loadTemplateDetail]);

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [listId]);

  const save = async () => {
    setBusy(true);
    try {
      const entries: ListDetailData["entries"] = [];
      for (const [tid, cents] of Object.entries(baseOv)) entries.push({ templateId: tid, optionId: null, basePriceCents: cents, priceDeltaMode: null, priceDelta: null });
      for (const [oid, ov] of Object.entries(optOv)) entries.push({ templateId: null, optionId: oid, basePriceCents: null, priceDeltaMode: ov.mode, priceDelta: ov.delta });
      await apiJson(`/api/pricelists/${listId}/entries`, { method: "PUT", body: JSON.stringify({ entries }) });
      await apiJson(`/api/pricelists/${listId}/parties`, { method: "PUT", body: JSON.stringify({ partyIds: assigned }) });
      toast("Price list saved", "success");
      await load();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  if (!list) return <Card padded><Button onClick={onBack}><ArrowLeft size={13} /> Back</Button></Card>;
  const isDefault = list.kind === "DEFAULT";
  const shownTemplateIds = [...new Set([...Object.keys(baseOv), ...Object.values(details).map((d) => d.id)])];
  const addable = templates.filter((t) => !details[t.id]);

  return (
    <Card padded>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
        <Button onClick={onBack}><ArrowLeft size={13} /> Lists</Button>
        <div style={{ fontSize: 17, fontWeight: 700 }}>{list.name}</div>
        <Pill tone={isDefault ? "neutral" : "info"}>{isDefault ? "default" : "party tier"}</Pill>
        <div style={{ marginLeft: "auto" }}>
          <Button variant="primary" onClick={save} disabled={busy || isDefault}>Save list</Button>
        </div>
      </div>

      {isDefault ? (
        <div style={{ fontSize: 13, color: "var(--h10-text-2)" }}>
          This is <b>Listino base</b> — the fallback everyone inherits. It has no overrides by design; set base
          prices on the templates themselves. Create a party-tier list to override for specific brands/customers.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          <section>
            <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>Applies to</div>
            <MultiSelect
              options={parties.map((p) => ({ value: p.id, label: `${p.name} (${p.kind})` }))}
              value={assigned}
              onChange={setAssigned}
              placeholder="Assign brands / customers…"
            />
          </section>

          <section>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700 }}>Overrides</div>
              {addable.length > 0 && (
                <Listbox
                  ariaLabel="Add template to override"
                  options={[{ value: "", label: "+ Override a template…" }, ...addable.map((t) => ({ value: t.id, label: t.name }))]}
                  value=""
                  onChange={(v) => v && void loadTemplateDetail(v)}
                />
              )}
            </div>
            {shownTemplateIds.length === 0 && <div style={{ fontSize: 12.5, color: "var(--h10-text-3)" }}>No overrides — this list currently equals Listino base. Add a template above.</div>}
            <div style={{ display: "grid", gap: 12 }}>
              {shownTemplateIds.map((tid) => {
                const d = details[tid];
                const tRow = templates.find((t) => t.id === tid);
                return (
                  <div key={tid} style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 8, padding: 12 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                      <b style={{ fontSize: 13 }}>{d?.name ?? tRow?.name ?? tid}</b>
                      <span style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>base {tRow ? `€${(tRow.basePriceCents / 100).toFixed(2)}` : ""}</span>
                      <button type="button" title="Remove overrides for this template" onClick={() => { setBaseOv((b) => { const n = { ...b }; delete n[tid]; return n; }); setOptOv((o) => { const n = { ...o }; for (const g of d?.optionGroups ?? []) for (const opt of g.options) delete n[opt.id]; return n; }); setDetails((dd) => { const n = { ...dd }; delete n[tid]; return n; }); }} style={{ marginLeft: "auto", border: "none", background: "none", cursor: "pointer", color: "var(--h10-danger)", display: "inline-flex", padding: 2 }}><Trash2 size={13} /></button>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, fontSize: 12 }}>
                      <span>Base price override:</span>
                      {baseOv[tid] != null ? (
                        <>
                          <EuroInput cents={baseOv[tid]} onCommit={(c) => setBaseOv((b) => ({ ...b, [tid]: c }))} ariaLabel="Base override" width={82} />
                          <button type="button" onClick={() => setBaseOv((b) => { const n = { ...b }; delete n[tid]; return n; })} style={{ background: "none", border: "none", color: "var(--h10-text-link)", cursor: "pointer", fontSize: 11.5 }}>clear</button>
                        </>
                      ) : (
                        <button type="button" onClick={() => setBaseOv((b) => ({ ...b, [tid]: tRow?.basePriceCents ?? 0 }))} style={{ background: "none", border: "1px dashed var(--h10-border)", borderRadius: 6, cursor: "pointer", fontSize: 11.5, padding: "3px 8px", color: "var(--h10-text-2)" }}>+ override base</button>
                      )}
                    </div>
                    {d?.optionGroups.flatMap((g) => g.options).length ? (
                      <div style={{ display: "grid", gap: 4 }}>
                        {d.optionGroups.flatMap((g) => g.options.map((opt) => ({ g, opt }))).map(({ g, opt }) => (
                          <div key={opt.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                            <span style={{ minWidth: 200, color: "var(--h10-text-2)" }}>{g.name}: {opt.name}</span>
                            {optOv[opt.id] ? (
                              <>
                                <DeltaInput mode={optOv[opt.id].mode} value={optOv[opt.id].delta} baseCents={tRow?.basePriceCents} onChange={(next) => setOptOv((o) => ({ ...o, [opt.id]: { mode: next.mode, delta: next.value } }))} ariaLabel={`${opt.name} override`} />
                                <button type="button" onClick={() => setOptOv((o) => { const n = { ...o }; delete n[opt.id]; return n; })} style={{ background: "none", border: "none", color: "var(--h10-text-link)", cursor: "pointer", fontSize: 11 }}>clear</button>
                              </>
                            ) : (
                              <button type="button" onClick={() => setOptOv((o) => ({ ...o, [opt.id]: { mode: opt.priceDeltaMode, delta: opt.priceDelta } }))} style={{ background: "none", border: "1px dashed var(--h10-border)", borderRadius: 6, cursor: "pointer", fontSize: 11, padding: "2px 7px", color: "var(--h10-text-3)" }}>+ override</button>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </Card>
  );
}
