/**
 * FP6 — the production floor board: the pipeline stages as columns, each active
 * Work Order sitting in its current stage with a live timer and Start / Pause /
 * Resume / Finish. Assign a stage to a worker; open a card for the full stage
 * timeline. Coverage traffic-lights + priority drag arrive in FP6.3; the cost-
 * blind Worker kiosk in FP6.5.
 */
"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Play, Pause, Check, User, ChevronUp, ChevronDown } from "lucide-react";
import { PageHeader } from "@/design-system/patterns";
import { Drawer, Modal, useToast } from "@/design-system/components";
import { Button, Pill } from "@/design-system/primitives";
import { AsyncCombobox, type SearchLoader } from "@/components/AsyncCombobox"; // FS3 — paged type-to-find worker assign
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import { useFactoryEvents } from "@/lib/use-factory-events";
import { usePermission } from "@/lib/auth/client";
import { StageTimer } from "./StageTimer";
import { QCChecklist } from "./QCChecklist";
import { STAGE_LABEL, type ProductionResponse, type WOCard } from "./types";

const STATUS_TONE = { running: "info", paused: "warning", not_started: "neutral", done: "success" } as const;
const COVER = { OK: { c: "var(--h10-success)", t: "covered" }, PARTIAL: { c: "var(--h10-warning, #e9a100)", t: "partly short" }, SHORT: { c: "var(--h10-danger)", t: "short" } } as const;
const kioskBtn = (primary: boolean): React.CSSProperties => ({ flex: 1, display: "inline-flex", gap: 8, alignItems: "center", justifyContent: "center", padding: "14px 20px", fontSize: 16, fontWeight: 700, borderRadius: 12, cursor: "pointer", border: primary ? "none" : "1px solid var(--h10-border)", background: primary ? "var(--h10-primary)" : "var(--h10-surface)", color: primary ? "#fff" : "var(--h10-text)" });

// FS3 — the worker-assign picker: the old whole-list Menu became a paged,
// type-to-find AsyncCombobox on /api/users-lite?q= (500 users stay pickable).
const loadAssignableUsers: SearchLoader = async (q, cursor) => {
  const usp = new URLSearchParams({ q });
  if (cursor) usp.set("cursor", cursor);
  const d = await apiJson<{ users: { id: string; displayName: string }[]; nextCursor?: string | null }>(`/api/users-lite?${usp}`);
  const options = d.users.map((u) => ({ value: u.id, label: u.displayName }));
  // browsing page 1 exposes an explicit Unassign row (typing filters it away)
  return { options: !q && !cursor ? [{ value: "", label: "Unassign" }, ...options] : options, nextCursor: d.nextCursor ?? null };
};

function AssignPicker({ assignee, onAssign }: { assignee: { id: string; displayName: string } | null; onAssign: (id: string | null) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--h10-text-3)" }}
      >
        <span style={{ display: "inline-flex", gap: 3, alignItems: "center", fontSize: 11 }}><User size={11} />{assignee?.displayName?.split(" ")[0] ?? "assign"}</span>
      </button>
    );
  }
  return (
    <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-block" }}>
      <AsyncCombobox
        className="fs3-combo-compact"
        loader={loadAssignableUsers}
        value={assignee?.id}
        valueLabel={assignee?.displayName}
        placeholder="Assign…"
        autoFocus
        ariaLabel="Assign worker"
        onChange={(v) => { onAssign(v || null); setOpen(false); }}
        onDismiss={() => setOpen(false)}
      />
    </span>
  );
}

function CoverageDot({ w }: { w: WOCard }) {
  if (!w.coverage) return null;
  const cov = COVER[w.coverage];
  return <span title={w.shortMaterials?.length ? `${cov.t}: ${w.shortMaterials.join(", ")}` : cov.t} style={{ width: 9, height: 9, borderRadius: 999, background: cov.c, display: "inline-block", flex: "0 0 auto" }} />;
}

function ProductionInner() {
  const { toast } = useToast();
  const params = useSearchParams();
  const canAdvance = usePermission("workorders.advance");
  const canAssign = usePermission("workorders.assign");
  const canMaterials = usePermission("materials.consume");
  const [data, setData] = useState<ProductionResponse | null>(null);
  const [openWo, setOpenWo] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ wo: WoDetail } | null>(null);

  // EPO.3 (D-1) — /production?wo=<workOrderId> deep-link: the Orders page's WO
  // rows and timeline land here with the drawer already open. Mount-only read.
  useEffect(() => {
    const wo = params.get("wo");
    if (wo) { setOpenWo(wo); setDetail(null); void (async () => { try { setDetail(await apiJson<{ wo: WoDetail }>(`/api/production/wo/${wo}`)); } catch { /* stale link — board still renders */ } })(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    try { setData(await apiJson<ProductionResponse>("/api/production")); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [toast]);
  // FS2 — event-driven board: stage actions/priority/scrap/consume/payments
  // arrive via SSE (S-6's client half); the old 15s blind poll — which re-ran
  // the whole board+coverage query per open tab — becomes a 120s safety net.
  useEffect(() => { void load(); const t = setInterval(() => void load(), 120_000); return () => clearInterval(t); }, [load]);
  useFactoryEvents(["workorder.created", "workorder.updated", "order.updated", "pricing.updated"], load, { debounceMs: 1500 });

  const act = async (stageId: string, action: "start" | "pause" | "resume" | "finish") => {
    try {
      const r = await apiJson<{ woDone: boolean }>(`/api/production/stages/${stageId}`, { method: "POST", body: JSON.stringify({ action }) });
      void load(); if (openWo) void loadDetail(openWo);
      if (r.woDone) toast("Work order complete", "success");
    } catch (e) { toast((e as Error).message, "danger"); }
  };
  const assign = async (stageId: string, assigneeId: string | null) => {
    try { await apiJson(`/api/production/stages/${stageId}`, { method: "PATCH", body: JSON.stringify({ assigneeId }) }); void load(); if (openWo) void loadDetail(openWo); }
    catch (e) { toast((e as Error).message, "danger"); }
  };
  const loadDetail = useCallback(async (id: string) => {
    try { setDetail(await apiJson<{ wo: WoDetail }>(`/api/production/wo/${id}`)); } catch { /* ignore */ }
  }, []);
  const open = (id: string) => { setOpenWo(id); setDetail(null); void loadDetail(id); };

  const [material, setMaterial] = useState<WOCard | null>(null);
  const [reserved, setReserved] = useState<{ materialId: string; name: string; unit: string; reservedQty: number }[]>([]);
  const [useVals, setUseVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const openMaterial = async (w: WOCard) => {
    if (!w.current) return;
    try {
      const r = await apiJson<{ reserved: typeof reserved }>(`/api/production/stages/${w.current.id}/materials`);
      setReserved(r.reserved);
      setUseVals(Object.fromEntries(r.reserved.map((m) => [m.materialId, String(m.reservedQty)])));
      setMaterial(w);
    } catch (e) { toast((e as Error).message, "danger"); }
  };
  const submitMaterial = async () => {
    if (!material?.current) return;
    setBusy(true);
    try {
      const use = Object.fromEntries(Object.entries(useVals).map(([k, v]) => [k, Number(v) || 0]));
      await apiJson(`/api/production/stages/${material.current.id}/materials`, { method: "POST", body: JSON.stringify({ use }) });
      await apiJson(`/api/production/stages/${material.current.id}`, { method: "POST", body: JSON.stringify({ action: "finish" }) });
      setMaterial(null); void load(); toast("Cutting finished — material consumed", "success");
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };
  const onFinish = (w: WOCard) => {
    if (!w.current) return;
    if (w.current.stage === "CUTTING") void openMaterial(w);
    else void act(w.current.id, "finish");
  };
  const bumpPriority = async (w: WOCard, delta: number) => {
    try { await apiJson(`/api/production/wo/${w.id}/priority`, { method: "PATCH", body: JSON.stringify({ priority: w.priority + delta }) }); void load(); }
    catch (e) { toast((e as Error).message, "danger"); }
  };

  const [scrap, setScrap] = useState<{ stageId: string } | null>(null);
  const [scrapReason, setScrapReason] = useState("");
  const submitScrap = async () => {
    if (!scrap || !scrapReason.trim()) return;
    try { await apiJson(`/api/production/stages/${scrap.stageId}/scrap`, { method: "POST", body: JSON.stringify({ reason: scrapReason.trim() }) }); setScrap(null); setScrapReason(""); if (openWo) void loadDetail(openWo); void load(); toast("Scrap recorded", "info"); }
    catch (e) { toast((e as Error).message, "danger"); }
  };

  const columns = [...(data?.pipeline ?? []), "DONE"];
  const byCol = (col: string) => (data?.workOrders ?? []).filter((w) => w.column === col);

  const StageButtons = ({ w }: { w: WOCard }) => {
    if (!w.current || !canAdvance) return null;
    if (w.state === "BLOCKED") return <Pill tone="warning">{w.blockedReason ?? "blocked"}</Pill>;
    const c = w.current;
    return (
      <div style={{ display: "flex", gap: 6 }} onClick={(e) => e.stopPropagation()}>
        {c.status === "not_started" && <Button size="sm" variant="primary" onClick={() => void act(c.id, "start")}><Play size={12} /> Start</Button>}
        {c.status === "running" && <><Button size="sm" onClick={() => void act(c.id, "pause")}><Pause size={12} /></Button><Button size="sm" variant="primary" onClick={() => onFinish(w)}><Check size={12} /> Finish</Button></>}
        {c.status === "paused" && <><Button size="sm" onClick={() => void act(c.id, "resume")}><Play size={12} /> Resume</Button><Button size="sm" variant="primary" onClick={() => onFinish(w)}><Check size={12} /> Finish</Button></>}
      </div>
    );
  };

  return (
    <div className="factory-page">
      <PageHeader eyebrow="Factory OS" title="Production" subtitle={data?.worker ? "Your work queue — your next task is the top card." : "The five-stage floor: run each work order stage by stage, with live timers and material coverage."} />

      {data?.worker ? (
        <div style={{ maxWidth: 640, margin: "0 auto", display: "grid", gap: 14 }}>
          {(data.workOrders ?? []).map((w, i) => (
            <div key={w.id} style={{ border: i === 0 ? "2px solid var(--h10-primary)" : "1px solid var(--h10-border)", borderRadius: 16, padding: 18, background: "var(--h10-surface)", boxShadow: i === 0 ? "0 4px 16px rgb(31 111 222 / 0.12)" : "0 1px 2px rgb(20 28 38 / 0.05)" }}>
              {i === 0 && <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, color: "var(--h10-primary)", marginBottom: 8 }}>YOUR NEXT TASK</div>}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 20, fontWeight: 800 }}>{w.number}</span>
                <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}><CoverageDot w={w} />{w.current && <Pill tone={STATUS_TONE[w.current.status]}>{STAGE_LABEL(w.current.stage)}</Pill>}</span>
              </div>
              <div style={{ fontSize: 15, color: "var(--h10-text-2)", marginTop: 2 }}>{w.party}{w.label ? ` · ${w.label}` : ""}</div>
              {w.current && <div style={{ fontSize: 13, color: "var(--h10-text-3)", marginTop: 4 }}>{w.doneCount}/{w.stageCount} stages · <StageTimer cur={w.current} /></div>}
              {w.shortMaterials && w.shortMaterials.length > 0 && <div style={{ fontSize: 12.5, color: "var(--h10-danger)", marginTop: 4 }}>⚠ short: {w.shortMaterials.join(", ")}</div>}
              {canAdvance && w.current && (
                <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                  {w.current.status === "not_started" && <button type="button" onClick={() => void act(w.current!.id, "start")} style={kioskBtn(true)}><Play size={18} /> Start</button>}
                  {w.current.status === "running" && <><button type="button" onClick={() => void act(w.current!.id, "pause")} style={kioskBtn(false)}><Pause size={18} /> Pause</button><button type="button" onClick={() => onFinish(w)} style={kioskBtn(true)}><Check size={18} /> Finish</button></>}
                  {w.current.status === "paused" && <><button type="button" onClick={() => void act(w.current!.id, "resume")} style={kioskBtn(false)}><Play size={18} /> Resume</button><button type="button" onClick={() => onFinish(w)} style={kioskBtn(true)}><Check size={18} /> Finish</button></>}
                </div>
              )}
            </div>
          ))}
          {data.workOrders.length === 0 && <div style={{ fontSize: 15, color: "var(--h10-text-3)", textAlign: "center", padding: "40px 0" }}>No tasks — you&rsquo;re all caught up. 👍</div>}
        </div>
      ) : (<>
      <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 8 }}>
        {columns.map((col) => {
          const cards = byCol(col);
          return (
            <div key={col} style={{ flex: "1 0 240px", minWidth: 240 }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "0 4px 8px" }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>{col === "DONE" ? "Done" : STAGE_LABEL(col)}</span>
                <span style={{ fontSize: 11, color: "var(--h10-text-3)" }}>{cards.length}</span>
              </div>
              <div style={{ display: "grid", gap: 8, alignContent: "start", background: "var(--h10-bg-subtle, rgba(20,28,38,0.02))", borderRadius: 12, padding: 8, minHeight: 100 }}>
                {cards.map((w) => (
                  <div key={w.id} onClick={() => open(w.id)} style={{ cursor: "pointer", border: "1px solid var(--h10-border-subtle)", borderRadius: 10, background: "var(--h10-surface)", padding: 10, boxShadow: "0 1px 2px rgb(20 28 38 / 0.04)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                      <span style={{ display: "inline-flex", gap: 6, alignItems: "center", minWidth: 0 }}>
                        <CoverageDot w={w} />
                        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--h10-text-link)" }}>{w.number}</span>
                      </span>
                      <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
                        {canAdvance && (
                          <span style={{ display: "inline-flex" }}>
                            <button type="button" title="raise priority" onClick={() => void bumpPriority(w, 1)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "var(--h10-text-3)", lineHeight: 0 }}><ChevronUp size={13} /></button>
                            <button type="button" title="lower priority" onClick={() => void bumpPriority(w, -1)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "var(--h10-text-3)", lineHeight: 0 }}><ChevronDown size={13} /></button>
                          </span>
                        )}
                        {w.estCostCents != null && <span style={{ fontSize: 11, color: "var(--h10-text-3)", fontFamily: "ui-monospace, monospace" }}>{eur(w.estCostCents)}</span>}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--h10-text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.party}{w.label ? ` · ${w.label}` : ""}</div>
                    <div style={{ fontSize: 11, color: "var(--h10-text-3)", marginTop: 2 }}>{w.orderNumber} · {w.doneCount}/{w.stageCount} stages{w.promiseDateAt ? ` · due ${new Date(w.promiseDateAt).toLocaleDateString()}` : ""}</div>
                    {w.current && (
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, gap: 6 }}>
                        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          <Pill tone={STATUS_TONE[w.current.status]}>{w.current.status.replace("_", " ")}</Pill>
                          <StageTimer cur={w.current} />
                        </span>
                        {canAssign && (
                          <AssignPicker assignee={w.current.assignee} onAssign={(id) => void assign(w.current!.id, id)} />
                        )}
                      </div>
                    )}
                    <div style={{ marginTop: 8 }}><StageButtons w={w} /></div>
                  </div>
                ))}
                {cards.length === 0 && <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", textAlign: "center", padding: "16px 0" }}>—</div>}
              </div>
            </div>
          );
        })}
      </div>
      {data && data.workOrders.length === 0 && <div style={{ fontSize: 13, color: "var(--h10-text-3)", marginTop: 20, textAlign: "center" }}>Nothing in production yet — Start production on a confirmed order.</div>}
      {data && (data.activeTotal ?? 0) > data.workOrders.length && (
        <div style={{ fontSize: 12, color: "var(--h10-text-2)", marginTop: 12, textAlign: "center" }}>
          Showing the {data.workOrders.length} highest-priority of {data.activeTotal} active work orders — raise a job&rsquo;s priority to surface it.
        </div>
      )}
      </>
      )}

      <Modal open={!!material} onClose={() => setMaterial(null)} title="Cutting done — material used" size="sm"
        footer={<><Button onClick={() => setMaterial(null)}>Cancel</Button><Button variant="primary" onClick={submitMaterial} disabled={busy}>Finish cutting</Button></>}>
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>Enter the real quantity used for <b>{material?.number}</b>. This consumes the material and frees the reservation; the diff vs the estimate is recorded.</div>
          {reserved.length === 0 && <div style={{ fontSize: 12.5, color: "var(--h10-text-3)" }}>No material was reserved for this work order.</div>}
          {reserved.map((m) => (
            <div key={m.materialId} style={{ display: "grid", gridTemplateColumns: "1fr 110px", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 12.5 }}>{m.name} <span style={{ color: "var(--h10-text-3)" }}>· est {m.reservedQty} {m.unit.toLowerCase()}</span></span>
              <input type="number" min="0" step="0.01" value={useVals[m.materialId] ?? ""} onChange={(e) => setUseVals((v) => ({ ...v, [m.materialId]: e.target.value }))} style={{ border: "1px solid var(--h10-border)", borderRadius: 7, padding: "6px 8px", fontSize: 12.5, fontFamily: "ui-monospace, monospace", background: "var(--h10-surface)", color: "var(--h10-text)" }} />
            </div>
          ))}
        </div>
      </Modal>

      <Modal open={!!scrap} onClose={() => setScrap(null)} title="Report scrap" size="sm"
        footer={<><Button onClick={() => setScrap(null)}>Cancel</Button><Button variant="primary" onClick={submitScrap} disabled={!scrapReason.trim()}>Record scrap</Button></>}>
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>What went wrong? A material write-off can be recorded from Materials (FP7).</div>
          <textarea value={scrapReason} onChange={(e) => setScrapReason(e.target.value)} rows={3} placeholder="e.g. hide flaw on the left front panel" style={{ border: "1px solid var(--h10-border)", borderRadius: 8, padding: 9, fontSize: 12.5, fontFamily: "inherit", background: "var(--h10-surface)", color: "var(--h10-text)" }} />
        </div>
      </Modal>

      <Drawer open={!!openWo} onClose={() => setOpenWo(null)} title={detail?.wo.number ?? "Work order"}>
        {detail && (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>{detail.wo.orderNumber} · {detail.wo.party}{detail.wo.label ? ` · ${detail.wo.label}` : ""}</div>
            {detail.wo.estCostCents != null && (
              <div style={{ display: "flex", gap: 18, fontSize: 12.5, padding: "8px 10px", background: "var(--h10-bg-subtle, rgba(20,28,38,0.03))", borderRadius: 8 }}>
                <span style={{ color: "var(--h10-text-3)" }}>Est. cost <b style={{ color: "var(--h10-text)", fontFamily: "ui-monospace, monospace" }}>{eur(detail.wo.estCostCents)}</b></span>
                <span style={{ color: "var(--h10-text-3)" }}>Actual material <b style={{ fontFamily: "ui-monospace, monospace", color: (detail.wo.actualMaterialCents ?? 0) > detail.wo.estCostCents ? "var(--h10-danger)" : "var(--h10-success)" }}>{eur(detail.wo.actualMaterialCents ?? 0)}</b></span>
              </div>
            )}
            <div style={{ display: "grid", gap: 8 }}>
              {detail.wo.stages.map((s) => (
                <div key={s.id} style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 8, padding: 10, background: s.isCurrent ? "var(--h10-wash-primary, rgba(31,111,222,0.05))" : undefined }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{STAGE_LABEL(s.stage)}</span>
                    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                      <Pill tone={STATUS_TONE[s.status]}>{s.status.replace("_", " ")}</Pill>
                      {s.isCurrent && s.status !== "done" && <StageTimer cur={{ id: s.id, stage: s.stage, status: s.status, startedAt: s.startedAt, pausedMs: s.pausedMs, pausedAt: s.pausedAt, assignee: s.assignee }} />}
                    </span>
                  </div>
                  {s.assignee && <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", marginTop: 3 }}>{s.assignee.displayName}</div>}
                  {s.scrapNotes && <div style={{ fontSize: 11.5, color: "var(--h10-danger)", marginTop: 3, whiteSpace: "pre-line" }}>Scrap: {s.scrapNotes}</div>}
                  {s.stage === "QC" && s.isCurrent && <QCChecklist stageId={s.id} canEdit={canAdvance} onChanged={() => detail && void loadDetail(detail.wo.id)} />}
                  {canMaterials && s.isCurrent && (s.status === "running" || s.status === "paused") && (
                    <button type="button" onClick={() => { setScrapReason(""); setScrap({ stageId: s.id }); }} style={{ marginTop: 6, background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 11.5, color: "var(--h10-text-3)" }}>Report scrap</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

/** EPO.3 — Suspense shell for the ?wo= deep-link reader (useSearchParams). */
export function ProductionClient() {
  return <Suspense fallback={null}><ProductionInner /></Suspense>;
}

type WoDetail = {
  id: string; number: string; label: string | null; orderNumber: string; party: string; priority: number; state: string; blockedReason: string | null; estCostCents?: number; actualMaterialCents?: number;
  stages: { id: string; stage: string; sort: number; status: "not_started" | "running" | "paused" | "done"; isCurrent: boolean; startedAt: string | null; pausedMs: number; pausedAt: string | null; finishedAt: string | null; assignee: { id: string; displayName: string } | null; scrapNotes: string | null }[];
};
