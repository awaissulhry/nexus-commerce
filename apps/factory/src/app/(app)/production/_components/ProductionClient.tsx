/**
 * FP6 — the production floor board: the pipeline stages as columns, each active
 * Work Order sitting in its current stage with a live timer and Start / Pause /
 * Resume / Finish. Assign a stage to a worker; open a card for the full stage
 * timeline. Coverage traffic-lights + priority drag arrive in FP6.3; the cost-
 * blind Worker kiosk in FP6.5.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Play, Pause, Check, User } from "lucide-react";
import { PageHeader } from "@/design-system/patterns";
import { Drawer, Menu, useToast } from "@/design-system/components";
import { Button, Pill } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { StageTimer } from "./StageTimer";
import { STAGE_LABEL, type ProductionResponse, type WOCard } from "./types";

const STATUS_TONE = { running: "info", paused: "warning", not_started: "neutral", done: "success" } as const;

export function ProductionClient() {
  const { toast } = useToast();
  const canAdvance = usePermission("workorders.advance");
  const canAssign = usePermission("workorders.assign");
  const [data, setData] = useState<ProductionResponse | null>(null);
  const [openWo, setOpenWo] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ wo: WoDetail } | null>(null);

  const load = useCallback(async () => {
    try { setData(await apiJson<ProductionResponse>("/api/production")); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [toast]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 15000); return () => clearInterval(t); }, [load]);

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

  const columns = [...(data?.pipeline ?? []), "DONE"];
  const byCol = (col: string) => (data?.workOrders ?? []).filter((w) => w.column === col);

  const StageButtons = ({ w }: { w: WOCard }) => {
    if (!w.current || !canAdvance) return null;
    if (w.state === "BLOCKED") return <Pill tone="warning">{w.blockedReason ?? "blocked"}</Pill>;
    const c = w.current;
    return (
      <div style={{ display: "flex", gap: 6 }} onClick={(e) => e.stopPropagation()}>
        {c.status === "not_started" && <Button size="sm" variant="primary" onClick={() => void act(c.id, "start")}><Play size={12} /> Start</Button>}
        {c.status === "running" && <><Button size="sm" onClick={() => void act(c.id, "pause")}><Pause size={12} /></Button><Button size="sm" variant="primary" onClick={() => void act(c.id, "finish")}><Check size={12} /> Finish</Button></>}
        {c.status === "paused" && <><Button size="sm" onClick={() => void act(c.id, "resume")}><Play size={12} /> Resume</Button><Button size="sm" variant="primary" onClick={() => void act(c.id, "finish")}><Check size={12} /> Finish</Button></>}
      </div>
    );
  };

  return (
    <div className="factory-page">
      <PageHeader eyebrow="Factory OS" title="Production" subtitle="The five-stage floor: run each work order stage by stage, with live timers and material coverage." />
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
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--h10-text-link)" }}>{w.number}</span>
                      {w.estCostCents != null && <span style={{ fontSize: 11, color: "var(--h10-text-3)", fontFamily: "ui-monospace, monospace" }}>{eur(w.estCostCents)}</span>}
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
                          <Menu align="right" label={<span style={{ display: "inline-flex", gap: 3, alignItems: "center", fontSize: 11 }}><User size={11} />{w.current.assignee?.displayName?.split(" ")[0] ?? "assign"}</span>}
                            triggerProps={{ style: { background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--h10-text-3)" }, onClick: (e: React.MouseEvent) => e.stopPropagation() }}
                            items={[{ id: "none", label: "Unassign", onSelect: () => void assign(w.current!.id, null) }, ...(data?.workers ?? []).map((u) => ({ id: u.id, label: u.displayName, onSelect: () => void assign(w.current!.id, u.id) }))]} />
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

      <Drawer open={!!openWo} onClose={() => setOpenWo(null)} title={detail?.wo.number ?? "Work order"}>
        {detail && (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>{detail.wo.orderNumber} · {detail.wo.party}{detail.wo.label ? ` · ${detail.wo.label}` : ""}</div>
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
                  {s.scrapNotes && <div style={{ fontSize: 11.5, color: "var(--h10-danger)", marginTop: 3 }}>Scrap: {s.scrapNotes}</div>}
                </div>
              ))}
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

type WoDetail = {
  id: string; number: string; label: string | null; orderNumber: string; party: string; priority: number; state: string; blockedReason: string | null; estCostCents?: number; actualCostCents?: number;
  stages: { id: string; stage: string; sort: number; status: "not_started" | "running" | "paused" | "done"; isCurrent: boolean; startedAt: string | null; pausedMs: number; pausedAt: string | null; finishedAt: string | null; assignee: { id: string; displayName: string } | null; scrapNotes: string | null }[];
};
