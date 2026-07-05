/** F1 — Settings landing: the live F1 sections + what FP11 adds. */
"use client";

import Link from "next/link";
import { PageHeader } from "@/design-system/patterns";
import { Card } from "@/design-system/components";

const SECTIONS = [
  {
    href: "/settings/integrations",
    title: "Integrations",
    body: "Gmail (the front door), Google Drive, and the connect-a-courier wizard (Sendcloud first). Live in F1.",
    live: true,
  },
  {
    href: "/settings/import-export",
    title: "Import / Export",
    body: "CSV templates per entity with dry-run diff preview before anything applies. Party import is live; more entities land with their pages.",
    live: true,
  },
  {
    href: "/settings/health",
    title: "Health",
    body: "Worker heartbeat, database size, sync freshness, RBAC mode. Local-first means we are the ops team — so it's visible.",
    live: true,
  },
  {
    href: "/settings/team",
    title: "Team & roles",
    body: "Invite users, assign OWNER/WORKER, edit custom roles with the permission matrix. The last owner is protected; system roles are locked.",
    live: true,
  },
  {
    href: "/settings/config",
    title: "Configuration",
    body: "The stage pipeline, pricing defaults (margin floor, deposit), the VAT display rate, and nightly backup snapshots.",
    live: true,
  },
] as const;

export default function SettingsPage() {
  return (
    <div className="factory-coming">
      <PageHeader
        eyebrow="Factory OS"
        title="Settings"
        subtitle="Integrations, team & roles, import/export center, pricing defaults, stage configuration, backup health."
      />
      <div style={{ display: "grid", gap: 12 }}>
        {SECTIONS.map((s) => (
          <Link key={s.title} href={s.href} style={{ display: "block" }}>
            <Card padded>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{s.title}</div>
                  <div style={{ fontSize: 12.5, color: "var(--h10-text-2)", marginTop: 4 }}>{s.body}</div>
                </div>
                <span
                  className="fp-chip"
                  style={{ marginBottom: 0, opacity: s.live ? 1 : 0.75 }}
                >
                  {s.live ? "Live" : "FP11"}
                </span>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
