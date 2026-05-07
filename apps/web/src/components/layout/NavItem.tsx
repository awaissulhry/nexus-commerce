"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavItemConfig } from "@/types/navigation";

interface NavItemProps {
  item: NavItemConfig;
  collapsed?: boolean;
}

export default function NavItem({ item, collapsed }: NavItemProps) {
  const pathname = usePathname();

  // Active if exact match or starts with href (for nested routes)
  const isActive =
    pathname === item.href ||
    (item.href !== "/" && pathname.startsWith(item.href));

  if (item.disabled) {
    return (
      <div
        className={`
          flex items-center gap-3 px-3 py-2 rounded-md text-sm
          text-gray-500 cursor-not-allowed opacity-50
          ${collapsed ? "justify-center" : ""}
        `}
        title={collapsed ? item.label : undefined}
      >
        {item.icon && <span className="text-base flex-shrink-0">{item.icon}</span>}
        {!collapsed && (
          <span className="truncate flex-1">{item.label}</span>
        )}
        {!collapsed && (
          <span className="text-xs bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded-full">
            Soon
          </span>
        )}
      </div>
    );
  }

  return (
    <Link
      href={item.href}
      className={`
        flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors
        ${collapsed ? "justify-center" : ""}
        ${
          isActive
            ? "bg-blue-600/20 text-blue-400 font-medium"
            : "text-gray-300 hover:bg-gray-800 hover:text-white"
        }
      `}
      title={collapsed ? item.label : undefined}
    >
      {item.icon && <span className="text-base flex-shrink-0">{item.icon}</span>}
      {!collapsed && (
        <>
          <span className="truncate flex-1">{item.label}</span>
          {item.badge !== undefined && item.badge > 0 && (
            <span className="min-w-[20px] h-5 flex items-center justify-center text-xs font-bold bg-red-500 text-white rounded-full px-1.5">
              {item.badge > 99 ? "99+" : item.badge}
            </span>
          )}
        </>
      )}
    </Link>
  );
}
