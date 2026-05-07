'use client'

/**
 * H.9 — mobile-only top bar.
 *
 * Renders below md (≥768px hides it). Holds the hamburger that
 * dispatches `nexus:toggle-sidebar` (AppSidebar listens) plus the
 * Nexus logo so the user always knows where they are.
 *
 * Sits above main content with the same height as the sidebar's
 * logo strip (h-14) so when the user opens the drawer the top edges
 * align — small but the visual continuity matters.
 *
 * Notifications bell is intentionally elsewhere (top-right floating)
 * so the hamburger has the left-thumb zone to itself on phones.
 */

import Link from 'next/link'
import { Menu } from 'lucide-react'

export default function MobileTopBar() {
  const onToggle = () => {
    window.dispatchEvent(new CustomEvent('nexus:toggle-sidebar'))
  }
  return (
    <div className="md:hidden h-12 bg-slate-900 border-b border-slate-800 flex items-center px-3 sticky top-0 z-20 flex-shrink-0">
      <button
        type="button"
        onClick={onToggle}
        aria-label="Open navigation"
        className="text-slate-300 hover:text-white p-1.5 rounded hover:bg-slate-800"
      >
        <Menu className="w-5 h-5" />
      </button>
      <Link href="/" className="ml-2 inline-flex items-center gap-2">
        <div className="w-6 h-6 bg-blue-600 rounded flex items-center justify-center">
          <span className="text-white text-sm font-bold leading-none">N</span>
        </div>
        <span className="text-md font-semibold text-white">Nexus</span>
      </Link>
    </div>
  )
}
