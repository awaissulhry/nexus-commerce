/**
 * F1 — the factory frame: DS AppShell rail (66→344px hover-expand, blue-fill
 * active — the pattern the Owner loves) with the 11 F0-IA pages, filtered by
 * page permission (a Worker's nav simply lacks Quotes/Products/Financials —
 * FD9's strongest zero-training move). Rail footer: notifications + user chip.
 */
"use client";

import { usePathname } from "next/navigation";
import {
  BarChart3,
  ClipboardList,
  Euro,
  FileText,
  Hammer,
  Inbox,
  Layers,
  Package,
  Settings,
  Truck,
  Users,
} from "lucide-react";
import { AppShell } from "@/design-system/patterns";
import type { ShellNavEntry } from "@/design-system/patterns/AppShell";
import { useAuth } from "@/lib/auth/client";
import { FACTORY_PAGES, pageForPath, type FactoryPage } from "@/lib/nav";
import { NotificationBell } from "@/components/NotificationBell";
import { CommandPalette } from "@/components/CommandPalette";

const ICONS: Record<FactoryPage["icon"], React.ComponentType<{ size?: number | string }>> = {
  inbox: Inbox,
  "file-text": FileText,
  "clipboard-list": ClipboardList,
  hammer: Hammer,
  layers: Layers,
  package: Package,
  users: Users,
  truck: Truck,
  euro: Euro,
  "bar-chart-3": BarChart3,
  settings: Settings,
};

function Forbidden({ page }: { page: FactoryPage }) {
  return (
    <div className="factory-coming" style={{ paddingTop: 40 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700 }}>Access denied</h1>
      <p style={{ fontSize: 13, color: "var(--h10-text-2)" }}>
        Your role does not include <b>{page.label}</b>. The server enforces this too — ask the Owner if
        you need access.
      </p>
    </div>
  );
}

export function FactoryShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, has, logout, status } = useAuth();

  if (status !== "authed") return null; // AuthProvider is redirecting

  const nav: ShellNavEntry[] = FACTORY_PAGES.filter((p) => has(p.permission)).map((p) => {
    const Icon = ICONS[p.icon];
    return {
      id: p.id,
      label: p.label,
      href: p.href,
      icon: <Icon size={20} />,
      active: pathname === p.href || pathname.startsWith(p.href + "/"),
    };
  });

  const current = pageForPath(pathname);
  const allowed = !current || has(current.permission);

  return (
    <div className="factory-frame">
      <CommandPalette />
      <AppShell
        brand={{
          mark: "N",
          name: (
            <>
              Nexus <b style={{ color: "var(--h10-primary)" }}>Factory</b>
            </>
          ),
        }}
        nav={nav}
        footer={
          <div className="factory-railuser">
            <NotificationBell />
            <span className="who" title={user?.email}>
              {user?.displayName}
            </span>
            <button type="button" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        }
      >
        {allowed ? children : current ? <Forbidden page={current} /> : children}
      </AppShell>
    </div>
  );
}
