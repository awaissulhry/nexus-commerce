/**
 * FP4.4 — the kanban board: lanes by live state, drag = a VALIDATED command
 * (never a silent field write). The drop is attempted server-side via onMove;
 * an illegal move is rejected there and the card snaps back (we re-render from
 * the server list). CONFIRMED→In production routes through Start production.
 */
"use client";

import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, useDraggable, useDroppable, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { useState } from "react";
import { Pill } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { BOARD_LANES, ORDER_STATE_LABEL, type OrderState } from "@/lib/orders/transitions";
import { type OrderRow } from "./types";

function DepositDot({ r }: { r: OrderRow }) {
  if (!r.depositRequiredCents) return null;
  const met = (r.depositPaidCents ?? 0) >= r.depositRequiredCents;
  return <Pill tone={met ? "success" : "warning"}>{met ? "deposit paid" : "deposit due"}</Pill>;
}

function CardBody({ r, onOpen }: { r: OrderRow; onOpen?: (id: string) => void }) {
  return (
    <div style={{ display: "grid", gap: 5 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
        <button type="button" onMouseDown={(e) => e.stopPropagation()} onClick={() => onOpen?.(r.id)} style={{ background: "none", border: "none", padding: 0, cursor: onOpen ? "pointer" : "grab", font: "inherit", fontWeight: 700, color: "var(--h10-text-link)" }}>{r.number}</button>
        {r.netCents != null && <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, fontWeight: 600 }}>{eur(r.netCents)}</span>}
      </div>
      <div style={{ fontSize: 12, color: "var(--h10-text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.party.name}</div>
      <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
        <DepositDot r={r} />
        {r.woBlocked && <Pill tone="warning">blocked</Pill>}
        {r.promiseDateAt && <span style={{ fontSize: 11, color: r.overdue ? "var(--h10-danger)" : "var(--h10-text-3)", fontWeight: r.overdue ? 700 : 400 }}>{new Date(r.promiseDateAt).toLocaleDateString()}</span>}
      </div>
    </div>
  );
}

function DraggableCard({ r, onOpen }: { r: OrderRow; onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: r.id, data: { from: r.state } });
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 10, background: "var(--h10-surface)", padding: 10, cursor: "grab", opacity: isDragging ? 0.35 : 1, boxShadow: "0 1px 2px rgb(20 28 38 / 0.04)" }}>
      <CardBody r={r} onOpen={onOpen} />
    </div>
  );
}

function Lane({ state, orders, total, hasMore, onLoadMore, onOpen }: { state: OrderState; orders: OrderRow[]; total: number; hasMore: boolean; onLoadMore: () => void; onOpen: (id: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: state });
  return (
    <div style={{ flex: "1 0 220px", minWidth: 220, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 4px 8px" }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>
          {ORDER_STATE_LABEL[state]}
          {/* EPO1.4 (C1) — this lane is label-driven: dropping here routes to the buy flow */}
          {state === "SHIPPED" && <span style={{ fontWeight: 400, fontSize: 10.5, color: "var(--h10-text-3)", marginLeft: 5 }}>via label</span>}
        </span>
        {/* FS1 (C-1) — the TRUE lane count, never just the loaded page */}
        <span style={{ fontSize: 11, color: "var(--h10-text-3)" }}>{orders.length < total ? `${orders.length} of ${total}` : total}</span>
      </div>
      <div ref={setNodeRef} style={{ flex: 1, minHeight: 120, display: "grid", gap: 8, alignContent: "start", padding: 8, borderRadius: 12, background: isOver ? "var(--h10-wash-primary, rgba(31,111,222,0.06))" : "var(--h10-bg-subtle, rgba(20,28,38,0.02))", outline: isOver ? "1px dashed var(--h10-primary)" : "1px solid transparent", transition: "background 0.12s" }}>
        {orders.map((r) => <DraggableCard key={r.id} r={r} onOpen={onOpen} />)}
        {orders.length === 0 && <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", textAlign: "center", padding: "12px 0" }}>—</div>}
        {hasMore && (
          <button type="button" onClick={onLoadMore} style={{ border: "1px dashed var(--h10-border)", borderRadius: 8, background: "none", padding: "7px 0", fontSize: 11.5, color: "var(--h10-text-2)", cursor: "pointer" }}>
            Load {Math.min(100, total - orders.length)} more
          </button>
        )}
      </div>
    </div>
  );
}

export type LaneData = { rows: OrderRow[]; total: number; nextCursor: string | null };

// FS1 (C-1) — lanes arrive individually bounded + cursored; the board never
// silently drops an order past a fetch cap again.
export function KanbanBoard({ lanes, onLoadMore, onMove, onOpen }: { lanes: Record<string, LaneData>; onLoadMore: (state: OrderState) => void; onMove: (r: OrderRow, to: OrderState) => void; onOpen: (id: string) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [dragging, setDragging] = useState<OrderRow | null>(null);
  const findRow = (id: unknown) => {
    for (const l of Object.values(lanes)) { const r = l.rows.find((o) => o.id === id); if (r) return r; }
    return null;
  };
  const onStart = (e: DragStartEvent) => setDragging(findRow(e.active.id));
  const onEnd = (e: DragEndEvent) => {
    setDragging(null);
    const to = e.over?.id as OrderState | undefined;
    const r = findRow(e.active.id);
    if (r && to && to !== r.state) onMove(r, to);
  };
  return (
    <DndContext sensors={sensors} onDragStart={onStart} onDragEnd={onEnd} onDragCancel={() => setDragging(null)}>
      <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 6 }}>
        {BOARD_LANES.map((state) => {
          const lane = lanes[state] ?? { rows: [], total: 0, nextCursor: null };
          return (
            <Lane key={state} state={state} orders={lane.rows} total={lane.total} hasMore={!!lane.nextCursor} onLoadMore={() => onLoadMore(state)} onOpen={onOpen} />
          );
        })}
      </div>
      <DragOverlay>{dragging ? <div style={{ border: "1px solid var(--h10-primary)", borderRadius: 10, background: "var(--h10-surface)", padding: 10, width: 220, boxShadow: "0 8px 24px rgb(20 28 38 / 0.18)" }}><CardBody r={dragging} /></div> : null}</DragOverlay>
    </DndContext>
  );
}
