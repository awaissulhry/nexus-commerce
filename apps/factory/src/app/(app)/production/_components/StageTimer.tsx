/** FP6 — a live stage timer: ticks each second while running, frozen when paused. */
"use client";

import { useEffect, useState } from "react";
import { elapsedMs, type StageTiming } from "@/lib/production/stage-timer";
import type { CurrentStage } from "./types";

const fmt = (msTotal: number) => {
  const s = Math.floor(msTotal / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(sec).padStart(2, "0")}`;
};

export function StageTimer({ cur }: { cur: CurrentStage }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (cur.status !== "running") return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [cur.status]);
  const timing: StageTiming = { startedAt: cur.startedAt, pausedMs: cur.pausedMs, pausedAt: cur.pausedAt, finishedAt: null };
  const active = elapsedMs(timing, Date.now());
  const color = cur.status === "running" ? "var(--h10-primary)" : cur.status === "paused" ? "var(--h10-warning, #9a6700)" : "var(--h10-text-3)";
  return <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, fontWeight: 700, color }}>{cur.status === "not_started" ? "—" : fmt(active)}</span>;
}
