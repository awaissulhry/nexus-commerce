"use client";

import { useState, useEffect } from "react";
import type { NavSectionConfig } from "@/types/navigation";
import NavItem from "./NavItem";

interface SidebarSectionProps {
  section: NavSectionConfig;
  collapsed?: boolean;
}

export default function SidebarSection({
  section,
  collapsed,
}: SidebarSectionProps) {
  const storageKey = `sidebar-section-${section.id}`;

  const [isOpen, setIsOpen] = useState(true);

  // Persist expanded/collapsed state in localStorage
  useEffect(() => {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) {
      setIsOpen(stored === "true");
    }
  }, [storageKey]);

  const toggle = () => {
    const next = !isOpen;
    setIsOpen(next);
    localStorage.setItem(storageKey, String(next));
  };

  // When sidebar is collapsed, show only the section icon
  if (collapsed) {
    return (
      <div className="py-2">
        <div
          className="flex items-center justify-center px-2 py-1.5 text-gray-500"
          title={section.label}
        >
          <span className="text-base">{section.icon}</span>
        </div>
        <div className="space-y-0.5 px-2">
          {section.items.map((item) => (
            <NavItem key={item.href} item={item} collapsed />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="py-1">
      {/* Section header — clickable to collapse */}
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2 px-4 py-2 text-sm font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-300 transition-colors"
      >
        <span className="text-sm">{section.icon}</span>
        <span className="flex-1 text-left">{section.label}</span>
        <svg
          className={`w-3 h-3 transition-transform duration-200 ${
            isOpen ? "rotate-0" : "-rotate-90"
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {/* Section items */}
      {isOpen && (
        <div className="space-y-0.5 px-2 pb-1">
          {section.items.map((item) => (
            <NavItem key={item.href} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
