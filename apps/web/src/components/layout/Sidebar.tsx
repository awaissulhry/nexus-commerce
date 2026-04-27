"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import type { NavSectionConfig } from "@/types/navigation";
import SidebarSection from "./SidebarSection";

/* ------------------------------------------------------------------ */
/*  Complete Amazon Seller Central navigation configuration             */
/* ------------------------------------------------------------------ */

const NAV_SECTIONS: NavSectionConfig[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: "📊",
    items: [
      { label: "Overview", href: "/dashboard/overview", icon: "🏠" },
      { label: "Analytics", href: "/dashboard/analytics", icon: "📈" },
      { label: "Revenue", href: "/dashboard/analytics/revenue", icon: "💰" },
      { label: "Inventory Analytics", href: "/dashboard/analytics/inventory", icon: "📦" },
      { label: "Channel Performance", href: "/dashboard/analytics/channels", icon: "🔗" },
      { label: "Reports", href: "/dashboard/reports", icon: "📋" },
    ],
  },
  {
    id: "inventory",
    label: "Inventory",
    icon: "📋",
    items: [
      { label: "Manage All Inventory", href: "/inventory", icon: "📊" },
      { label: "Manage FBA Inventory", href: "/inventory/fba", icon: "🏭" },
      { label: "FBA Shipments", href: "/inventory/shipments", icon: "🚚", disabled: true },
      { label: "Stranded Inventory", href: "/inventory/stranded", icon: "⚠️" },
      { label: "Inventory Planning", href: "/inventory/planning", icon: "📈", disabled: true },
      { label: "Restock Inventory", href: "/inventory/restock", icon: "🔄", disabled: true },
      { label: "Inventory Age", href: "/inventory/age", icon: "📅", disabled: true },
      { label: "Inventory Health", href: "/inventory/health", icon: "💚", disabled: true },
      { label: "Multi-Channel Fulfillment", href: "/inventory/mcf", icon: "🌐", disabled: true },
      { label: "Removal Orders", href: "/inventory/removals", icon: "🗑️", disabled: true },
      { label: "Global Selling", href: "/inventory/global", icon: "🌍", disabled: true },
    ],
  },
  {
    id: "pricing",
    label: "Pricing",
    icon: "💰",
    items: [
      { label: "Automate Pricing", href: "/pricing/automate", icon: "🤖", disabled: true },
      { label: "Manage Pricing", href: "/pricing", icon: "💲" },
      { label: "Fix Price Alerts", href: "/pricing/alerts", icon: "🔔" },
      { label: "Sale Dashboard", href: "/pricing/sales", icon: "🏷️", disabled: true },
    ],
  },
  {
    id: "orders",
    label: "Orders",
    icon: "🛒",
    items: [
      { label: "Manage Orders", href: "/orders", icon: "📋" },
      { label: "Order Reports", href: "/orders/reports", icon: "📊", disabled: true },
      { label: "Upload Order Files", href: "/orders/upload", icon: "📤", disabled: true },
      { label: "Returns", href: "/orders/returns", icon: "↩️" },
      { label: "A-to-Z Claims", href: "/orders/claims", icon: "🛡️", disabled: true },
    ],
  },
  {
    id: "advertising",
    label: "Advertising",
    icon: "📢",
    items: [
      { label: "Campaign Manager", href: "/advertising/campaigns", icon: "🎯", disabled: true },
      { label: "Stores", href: "/advertising/stores", icon: "🏪", disabled: true },
      { label: "A+ Content", href: "/advertising/aplus", icon: "✨", disabled: true },
      { label: "Brand Analytics", href: "/advertising/analytics", icon: "📈", disabled: true },
      { label: "Deals", href: "/advertising/deals", icon: "⚡", disabled: true },
      { label: "Coupons", href: "/advertising/coupons", icon: "🎟️", disabled: true },
      { label: "Vine", href: "/advertising/vine", icon: "🌿", disabled: true },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    icon: "📊",
    items: [
      { label: "Business Reports", href: "/reports/business", icon: "💼" },
      { label: "Fulfillment Reports", href: "/reports/fulfillment", icon: "📦", disabled: true },
      { label: "Payments", href: "/reports/payments", icon: "💳", disabled: true },
      { label: "Return Reports", href: "/reports/returns", icon: "↩️", disabled: true },
      { label: "Tax Document Library", href: "/reports/tax", icon: "🧾", disabled: true },
      { label: "Custom Reports", href: "/reports/custom", icon: "🔧", disabled: true },
    ],
  },
  {
    id: "performance",
    label: "Performance",
    icon: "⚡",
    items: [
      { label: "Account Health", href: "/performance/health", icon: "💚" },
      { label: "Feedback", href: "/performance/feedback", icon: "⭐" },
      { label: "Voice of the Customer", href: "/performance/voc", icon: "🗣️", disabled: true },
    ],
  },
  {
    id: "b2b",
    label: "B2B",
    icon: "🏢",
    items: [
      { label: "Manage Quotes", href: "/b2b/quotes", icon: "📄", disabled: true },
      { label: "B2B Opportunities", href: "/b2b/opportunities", icon: "💡", disabled: true },
    ],
  },
  {
    id: "apps",
    label: "Apps & Services",
    icon: "🔌",
    items: [
      { label: "Marketplace Appstore", href: "/apps", icon: "🛍️", disabled: true },
      { label: "Selling Partner API", href: "/apps/api", icon: "🔗", disabled: true },
    ],
  },
  {
    id: "engine",
    label: "Nexus Engine",
    icon: "⚙️",
    items: [
      { label: "Sync Logs", href: "/engine/logs", icon: "📜" },
      { label: "eBay Sync Control", href: "/engine/ebay", icon: "🔄" },
      { label: "AI Listing Generator", href: "/engine/ai", icon: "🤖" },
      { label: "Channel Connections", href: "/engine/channels", icon: "🔗" },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    icon: "🔐",
    items: [
      { label: "Data Validation", href: "/admin", icon: "✓" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    icon: "⚙️",
    items: [
      { label: "Account", href: "/settings/account", icon: "🏢" },
      { label: "Notifications", href: "/settings/notifications", icon: "🔔" },
      { label: "API Keys", href: "/settings/api-keys", icon: "🔑" },
      { label: "Profile", href: "/settings/profile", icon: "👤" },
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  Sidebar Component                                                   */
/* ------------------------------------------------------------------ */

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);

  // Persist collapsed state
  useEffect(() => {
    const stored = localStorage.getItem("sidebar-collapsed");
    if (stored !== null) {
      setCollapsed(stored === "true");
    }
  }, []);

  const toggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem("sidebar-collapsed", String(next));
  };

  return (
    <aside
      className={`
        flex flex-col bg-gray-900 text-white shadow-lg transition-all duration-300 h-screen
        ${collapsed ? "w-16" : "w-64"}
      `}
    >
      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-gray-800">
        {!collapsed && (
          <Link href="/dashboard/overview" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-sm">
              N
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight">Nexus</h1>
              <p className="text-[10px] text-gray-400 leading-tight">
                Commerce Dashboard
              </p>
            </div>
          </Link>
        )}
        {collapsed && (
          <Link href="/dashboard/overview" className="mx-auto">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-sm">
              N
            </div>
          </Link>
        )}
      </div>

      {/* ── Scrollable sections ─────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent">
        <div className="divide-y divide-gray-800/50">
          {NAV_SECTIONS.map((section) => (
            <SidebarSection
              key={section.id}
              section={section}
              collapsed={collapsed}
            />
          ))}
        </div>
      </nav>

      {/* ── Footer: Collapse toggle ────────────────────────── */}
      <div className="border-t border-gray-800 px-2 py-3">
        <button
          onClick={toggleCollapse}
          className={`
            flex items-center gap-3 px-3 py-2 rounded-md text-sm text-gray-400
            hover:bg-gray-800 hover:text-white transition-colors w-full
            ${collapsed ? "justify-center" : ""}
          `}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <svg
            className={`w-4 h-4 transition-transform duration-300 ${
              collapsed ? "rotate-180" : ""
            }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
            />
          </svg>
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
