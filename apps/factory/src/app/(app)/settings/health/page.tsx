/**
 * F1 — Health: local-first means WE are the ops team, so it's a panel, not a
 * mystery. Worker heartbeat, DB reachability, RBAC mode, sync freshness.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/design-system/patterns";
import { Card } from "@/design-system/components";
import { Pill } from "@/design-system/primitives";
import { apiJson } from "@/lib/api-client";

type Health = { ok: boolean; db: boolean; workerBeatAgoMs: number | null; rbacMode: string };

export default function HealthPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const load = useCallback(() => {
    apiJson<Health>("/api/health").then(setHealth).catch(() => setHealth(null));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const beat = health?.workerBeatAgoMs;
  const workerOk = beat != null && beat < 90_000;

  return (
    <div className="factory-coming">
      <PageHeader eyebrow="Settings" title="Health" subtitle="The machine this factory runs on, at a glance." />
      <Card padded>
        <div style={{ display: "grid", gap: 10, fontSize: 13 }}>
          <div>
            <Pill tone={health?.db ? "success" : "danger"}>{health?.db ? "OK" : "DOWN"}</Pill>{" "}
            <b>Database</b> — SQLite (WAL), file-based, backed up by the worker's nightly snapshot.
          </div>
          <div>
            <Pill tone={workerOk ? "success" : "warning"}>
              {workerOk ? "ALIVE" : beat == null ? "NOT SEEN" : "STALE"}
            </Pill>{" "}
            <b>Worker</b> —{" "}
            {beat == null
              ? "no heartbeat yet: start it with `npm run dev -w @nexus/factory` (it runs alongside the web process)"
              : `last heartbeat ${Math.round(beat / 1000)}s ago (Gmail poll · tracking poll · reminders · snapshots)`}
          </div>
          <div>
            <Pill tone={health?.rbacMode === "enforce" ? "success" : "warning"}>
              {health?.rbacMode?.toUpperCase() ?? "?"}
            </Pill>{" "}
            <b>RBAC mode</b> —{" "}
            {health?.rbacMode === "enforce"
              ? "denials are enforced and audited."
              : "shadow: would-be denials are logged but allowed. Flip FACTORY_RBAC_MODE=enforce before a second person gets a login."}
          </div>
        </div>
      </Card>
    </div>
  );
}
