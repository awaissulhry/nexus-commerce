"use client";

import { useState } from "react";
import Link from "next/link";

export default function TopBar() {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);

  return (
    <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-6 flex-shrink-0">
      {/* ── Left: Global Search ─────────────────────────────── */}
      <div className="flex items-center gap-4 flex-1 max-w-xl">
        <div
          className={`
            relative flex items-center flex-1 transition-all
            ${searchFocused ? "ring-2 ring-blue-500" : ""}
            border border-gray-300 rounded-lg bg-gray-50
          `}
        >
          <svg
            className="absolute left-3 w-4 h-4 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            placeholder="Search by SKU, ASIN, product name, or order ID…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            className="w-full pl-10 pr-4 py-2 text-sm bg-transparent border-none outline-none placeholder-gray-400"
          />
          <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 mr-2 text-[10px] font-mono text-gray-400 bg-gray-200 rounded">
            ⌘K
          </kbd>
        </div>
      </div>

      {/* ── Right: Actions ──────────────────────────────────── */}
      <div className="flex items-center gap-3 ml-4">
        {/* Marketplace status indicators */}
        <div className="hidden md:flex items-center gap-2 mr-2">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-orange-50 border border-orange-200">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-[11px] font-medium text-orange-800">
              Amazon IT
            </span>
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 border border-blue-200">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-[11px] font-medium text-blue-800">eBay</span>
          </div>
        </div>

        {/* Notification bell */}
        <button
          className="relative p-2 rounded-lg hover:bg-gray-100 transition-colors"
          title="Notifications"
        >
          <svg
            className="w-5 h-5 text-gray-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
            />
          </svg>
          {/* Badge dot */}
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full" />
        </button>

        {/* Help */}
        <button
          className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
          title="Help"
        >
          <svg
            className="w-5 h-5 text-gray-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </button>

        {/* Settings */}
        <Link
          href="/engine/channels"
          className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
          title="Settings"
        >
          <svg
            className="w-5 h-5 text-gray-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
        </Link>
      </div>
    </header>
  );
}
